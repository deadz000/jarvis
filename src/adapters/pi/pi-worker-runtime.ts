/**
 * 真实 Pi Worker Runtime 适配器（实施计划 M2）。
 *
 * 把 `WorkerRuntime` 端口接到 Pi SDK 的 `AgentSession`：
 * - **每个 Task 一个独立 Session**，用 `SessionManager.inMemory()` 隔离对话历史
 *   （SRS §7.3：Worker 不共享可变任务历史）；
 * - SDK 事件映射为 Worker 事实事件，全部携带 `taskId` + `runGeneration` + 时间戳；
 * - 取消：`handle.cancel()` → `session.abort()`，并**记住「是谁发起了取消」**，
 *   因为实机已证实 abort 与真实失败的 stopReason 同形（ADR-001 §3.2.2）；
 * - 回收：退订 + `session.dispose()`。
 *
 * 端口是同步 `start()`，而 `createAgentSession()` 是异步的，因此：
 * Session 创建在内部异步完成，就绪后汇报 `worker_started`，创建失败汇报 `worker_failed`。
 * 在就绪之前到达的取消请求会被记住，就绪后立即执行。
 */
import { createAgentSession, SessionManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { WorkerEvent, WorkerHandle, WorkerRuntime, WorkerStartRequest } from "../../application/workers/ports.ts";
import type { ThinkingLevel } from "../../config/env.ts";
import type { Logger } from "../../observability/logger.ts";
import {
  classifySessionOutcome,
  readAssistantFinalMessage,
  type AssistantFinalMessage,
  type SessionOutcome,
} from "./session-outcome.ts";

type CreateAgentSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
/** Session 使用的模型对象类型，由 SDK 的选项类型推导，避免依赖内部类型路径。 */
export type PiModel = NonNullable<CreateAgentSessionOptions["model"]>;
type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

/** 结果摘要进入 Scheduler 前必须截断，避免把无界文本塞进状态与后续上下文。 */
export const MAX_RESULT_SUMMARY_LENGTH = 2000;

export interface PiWorkerRuntimeOptions {
  readonly modelRuntime: ModelRuntime;
  readonly model: PiModel;
  /** Worker Session 的工作目录。 */
  readonly workspace: string;
  readonly thinkingLevel?: ThinkingLevel;
  /** 可选的工具白名单；省略时使用 SDK 默认（内建 read/bash/edit/write）。 */
  readonly tools?: readonly string[];
  readonly now?: () => number;
  readonly logger?: Logger;
  readonly maxSummaryLength?: number;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…（已截断，原长 ${text.length}）`;
}

function readEventType(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const type = (value as Record<string, unknown>)["type"];
    if (typeof type === "string") return type;
  }
  return "unknown";
}

function readToolName(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const name = record["toolName"] ?? record["name"];
  return typeof name === "string" ? name : undefined;
}

/**
 * 纯函数：把终态判定映射为 Worker 终态事件（可单测，无需真实模型）。
 *
 * `unverified` 需要结合 `cancelRequested`：取消后的运行可能既没有正文也没有终态消息，
 * 若直接判失败会把「用户取消」误报为「任务失败」。
 */
export function buildTerminalEvent(
  outcome: SessionOutcome,
  base: { taskId: string; runGeneration: number; at: number },
  options: { cancelRequested: boolean; maxSummaryLength?: number },
): WorkerEvent {
  const limit = options.maxSummaryLength ?? MAX_RESULT_SUMMARY_LENGTH;

  switch (outcome.status) {
    case "succeeded":
      return { type: "worker_succeeded", ...base, summary: truncate(outcome.text, limit) };
    case "cancelled":
      return { type: "worker_cancelled", ...base, reason: outcome.errorMessage ?? outcome.reason };
    case "unverified":
      if (options.cancelRequested) {
        return { type: "worker_cancelled", ...base, reason: `已请求取消且未收到终态消息（${outcome.reason}）` };
      }
      return { type: "worker_failed", ...base, reason: outcome.reason };
    case "failed":
      return { type: "worker_failed", ...base, reason: outcome.errorMessage ?? outcome.reason };
  }
}

export class PiWorkerRuntime implements WorkerRuntime {
  private readonly listeners = new Set<(event: WorkerEvent) => void>();
  private readonly options: PiWorkerRuntimeOptions;
  private readonly now: () => number;

  public constructor(options: PiWorkerRuntimeOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }

  public subscribe(listener: (event: WorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public start(request: WorkerStartRequest): WorkerHandle {
    const { taskId, runGeneration, goal, signal } = request;
    const logger = this.options.logger;

    let session: PiSession | undefined;
    let unsubscribeSession: (() => void) | undefined;
    let cancelRequested = false;
    let abortIssued = false;
    let released = false;
    let finalAssistant: AssistantFinalMessage | undefined;
    let toolCallCount = 0;
    let turnCount = 0;

    const base = (): { taskId: string; runGeneration: number; at: number } => ({
      taskId,
      runGeneration,
      at: this.now(),
    });

    const dispatch = (event: WorkerEvent): void => {
      for (const listener of [...this.listeners]) listener(event);
    };

    const requestAbort = (reason: string): void => {
      cancelRequested = true;
      if (session === undefined || abortIssued) return;
      abortIssued = true;
      logger?.info("pi_worker.abort_requested", { taskId, runGeneration, reason });
      void session.abort().catch((error: unknown) => {
        logger?.warn("pi_worker.abort_failed", { taskId, runGeneration, error });
      });
    };

    signal.addEventListener("abort", () => {
      requestAbort(`协作式取消信号：${String(signal.reason)}`);
    }, { once: true });

    const mapSessionEvent = (event: unknown): void => {
      const type = readEventType(event);

      if (type === "tool_execution_start") {
        toolCallCount += 1;
        const toolName = readToolName(event) ?? "unknown";
        dispatch({ type: "worker_tool_call", ...base(), toolName });
        return;
      }
      if (type === "turn_start" || type === "turn_end") {
        turnCount += 1;
        dispatch({
          type: "worker_progress",
          ...base(),
          note: type === "turn_start" ? `turn ${turnCount} 开始` : `turn ${turnCount} 结束`,
        });
        return;
      }
      if (type === "message_end") {
        // message_end 才是权威的已完成消息（SR-ADR-001 §3.2）。
        const candidate = readAssistantFinalMessage((event as Record<string, unknown>)["message"]);
        if (candidate !== undefined) finalAssistant = candidate;
        return;
      }
      if (type === "message_update") {
        // 逐 token 增量属于高频通道，不进入 Scheduler 事件流（避免无界事件量）。
        return;
      }
      logger?.debug("pi_worker.session_event", { taskId, runGeneration, sessionEvent: type });
    };

    const run = async (): Promise<void> => {
      try {
        const created = await createAgentSession({
          cwd: this.options.workspace,
          modelRuntime: this.options.modelRuntime,
          model: this.options.model,
          sessionManager: SessionManager.inMemory(this.options.workspace),
          ...(this.options.thinkingLevel === undefined ? {} : { thinkingLevel: this.options.thinkingLevel }),
          ...(this.options.tools === undefined ? {} : { tools: [...this.options.tools] }),
        });

        session = created.session;
        if (released) {
          created.session.dispose();
          return;
        }

        unsubscribeSession = created.session.subscribe(mapSessionEvent);
        dispatch({ type: "worker_started", ...base() });

        if (cancelRequested) requestAbort("Session 就绪时已有待处理的取消请求");

        await created.session.prompt(goal);
        if (released) return;

        const outcome = classifySessionOutcome(finalAssistant, created.session.getLastAssistantText(), {
          cancelRequested,
        });
        dispatch(
          buildTerminalEvent(outcome, base(), {
            cancelRequested,
            ...(this.options.maxSummaryLength === undefined
              ? {}
              : { maxSummaryLength: this.options.maxSummaryLength }),
          }),
        );
      } catch (error) {
        if (released) return;
        const message = error instanceof Error ? error.message : String(error);
        logger?.warn("pi_worker.run_failed", { taskId, runGeneration, error });
        dispatch({ type: "worker_failed", ...base(), reason: `执行异常：${message}` });
      }
    };

    void run();

    return {
      taskId,
      runGeneration,
      cancel: async (reason: string): Promise<void> => {
        requestAbort(reason);
      },
      release: async (): Promise<void> => {
        released = true;
        unsubscribeSession?.();
        session?.dispose();
        logger?.debug("pi_worker.released", { taskId, runGeneration, toolCallCount, turnCount });
      },
    };
  }
}
