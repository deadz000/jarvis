/**
 * Master 决策平面（M4）：把「模型建议」变成「经校验的调度命令」。
 *
 * ## 为什么存在这一层
 * Master **只能提出意图**（SRS §2.1）：`MasterPort` 的返回值只能是文本，
 * 它没有任何写状态的通道。所有落地都必须经过本层逐动作校验后调用 Scheduler。
 *
 * ## 三条硬约束
 * 1. **不锁住世界等 LLM**：提示词用的是某一时刻的快照，但落地前用**当前**状态逐动作复核；
 * 2. **超时降级**：Master 超时 → 空计划，**不取消任何任务**（踩坑指南：超时 → 空计划）；
 * 3. **部分失效不牵连**：某个取消动作失效，不应丢掉计划内仍合法的启动动作。
 */
import type { WorldRevision } from "../../domain/decision/types.ts";
import type { Logger } from "../../observability/logger.ts";
import type { DialogueEntry, DialogueHistory } from "../interaction/dialogue-history.ts";
import type { PendingResult } from "../delivery/delivery-batcher.ts";
import type { DeliveryQueue } from "../delivery/delivery-queue.ts";
import type { InteractionFocusStore } from "../interaction/focus.ts";
import type { TaskScheduler } from "../scheduler/scheduler.ts";
import type { MasterContextView, WorldModel } from "./context-view.ts";
import { parseMasterDecision } from "./decision-parser.ts";
import { validateDecision, type CompiledCommand, type RejectedAction } from "./decision-validator.ts";

/** Master 端口：**只有产出建议的能力，没有写状态的通道**。 */
export interface MasterPort {
  proposeDecision(request: MasterRequest): Promise<MasterProposal>;
}

export interface MasterRequest {
  /**
   * `intent` = 用户输入触发（调度建议）；
   * `delivery` = 结果产出触发（交付建议）。
   */
  readonly mode: "intent" | "delivery";
  /** 有界世界快照。 */
  readonly view: MasterContextView;
  /** 最近对话历史（有界）。没有它，Master 不记得自己上一轮做了什么。 */
  readonly dialogue: readonly DialogueEntry[];
  /** 本批待交付结果（仅 delivery 模式非空）。 */
  readonly pendingResults: readonly PendingResult[];
  /** 超时或取消时用于中止模型调用，避免遗留运行中的 Session。 */
  readonly signal?: AbortSignal;
}

export type MasterProposal =
  | { readonly status: "ok"; readonly rawText: string }
  | { readonly status: "timeout" }
  | { readonly status: "error"; readonly reason: string };

export interface AppliedAction {
  readonly type: string;
  readonly detail: string;
}

export type DecisionCycleStatus =
  | "applied"
  | "empty_plan"
  | "apply_failed"
  | "parse_failed"
  | "timeout"
  | "master_error";

export interface DecisionCycleResult {
  readonly decisionId: string | null;
  readonly status: DecisionCycleStatus;
  readonly applied: readonly AppliedAction[];
  readonly rejected: readonly RejectedAction[];
  readonly droppedActions: readonly string[];
  readonly stale: boolean;
  readonly missedEvents: boolean;
  readonly revisionAtDecision: WorldRevision;
  readonly revisionAtCommit: WorldRevision;
  readonly elapsedMs: number;
  /** 降级/失败时的人类可读说明（用于日志与面板）。 */
  readonly note: string | null;
}

export interface DecisionPlaneOptions {
  readonly master: MasterPort;
  readonly scheduler: TaskScheduler;
  readonly world: WorldModel;
  readonly focus: InteractionFocusStore;
  readonly timeoutMs: number;
  /** 对话历史（有界）。省略时 Master 看不到任何历史。 */
  readonly dialogue?: DialogueHistory;
  /** 交付队列。交付决策的落地目标；省略时交付类动作无法执行。 */
  readonly delivery?: DeliveryQueue;
  readonly now?: () => number;
  readonly logger?: Logger;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          resolve(onTimeout());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class MasterDecisionPlane {
  private readonly master: MasterPort;
  private readonly scheduler: TaskScheduler;
  private readonly world: WorldModel;
  private readonly focus: InteractionFocusStore;
  private readonly timeoutMs: number;
  private readonly dialogue: DialogueHistory | undefined;
  private readonly delivery: DeliveryQueue | undefined;
  private readonly now: () => number;
  private readonly logger: Logger | undefined;

  public constructor(options: DecisionPlaneOptions) {
    this.master = options.master;
    this.scheduler = options.scheduler;
    this.world = options.world;
    this.focus = options.focus;
    this.timeoutMs = options.timeoutMs;
    this.dialogue = options.dialogue;
    this.delivery = options.delivery;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger;
  }

  /**
   * 跑一次完整决策周期。
   * `userInput` 会先计入 `eventSeq`（事件完整性），再构造快照。
   */
  public async decide(
    input: { readonly userInput?: string; readonly source?: string } = {},
  ): Promise<DecisionCycleResult> {
    return this.runCycle({ mode: "intent", pendingResults: [], input });
  }

  /**
   * 交付决策（结果产出后的第二种唤醒时机）。
   *
   * 关键不变量：**降级也不丢结果** —— 若交付决策超时/失败/解析失败，
   * 由确定性规则逐条兜底交付（踩坑指南铁律 7）。
   */
  public async decideDelivery(batch: readonly PendingResult[]): Promise<DecisionCycleResult> {
    if (batch.length === 0) {
      return this.noOp("empty_plan", this.world.revision(), 0, "交付批次为空，无需决策");
    }
    const result = await this.runCycle({ mode: "delivery", pendingResults: batch, input: {} });
    if (result.applied.some((action) => action.type === "deliver_results")) return result;
    return this.fallbackDeliver(batch, result);
  }

  private async runCycle(run: {
    readonly mode: "intent" | "delivery";
    readonly pendingResults: readonly PendingResult[];
    readonly input: { readonly userInput?: string; readonly source?: string };
  }): Promise<DecisionCycleResult> {
    const input = run.input;
    if (input.userInput !== undefined) {
      this.world.ingestInput({ source: input.source ?? "user", text: input.userInput });
    }

    const view = this.world.buildView();
    const revisionAtDecision = view.revision;
    const startedAt = this.now();

    const controller = new AbortController();
    let proposal: MasterProposal;
    try {
      proposal = await withTimeout(
        this.master.proposeDecision({
          mode: run.mode,
          view,
          dialogue: this.dialogueEntries(),
          pendingResults: run.pendingResults,
          signal: controller.signal,
        }),
        this.timeoutMs,
        () => {
          controller.abort("master_timeout");
          return { status: "timeout" } as const;
        },
      );
    } catch (error) {
      proposal = { status: "error", reason: error instanceof Error ? error.message : String(error) };
    }

    const elapsedMs = this.now() - startedAt;

    // ---------- 降级路径：一律不改动任何状态 ----------
    if (proposal.status === "timeout") {
      return this.noOp(
        "timeout",
        revisionAtDecision,
        elapsedMs,
        `Master 超时（>${this.timeoutMs}ms）：按降级策略不执行任何动作，不猜测意图`,
      );
    }
    if (proposal.status === "error") {
      return this.noOp("master_error", revisionAtDecision, elapsedMs, `Master 调用失败：${proposal.reason}`);
    }

    const parsed = parseMasterDecision(proposal.rawText);
    if (parsed.status === "invalid") {
      return this.noOp(
        "parse_failed",
        revisionAtDecision,
        elapsedMs,
        `决策输出无法解析，已安全降级为不执行：${parsed.reason}`,
        [],
      );
    }

    // ---------- 用「当前」状态逐动作复核（而不是提示词时刻的快照）----------
    const currentRevision = this.world.revision();
    const validation = validateDecision(parsed.decision, {
      getTask: (taskId) => this.scheduler.getTask(taskId),
      currentRevision,
    });

    const applied: AppliedAction[] = [];
    for (const command of validation.accepted) {
      try {
        applied.push(await this.commit(command));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.warn("master.commit_failed", {
          decisionId: validation.decisionId,
          command: command.type,
          error: message,
        });
      }
    }

    const status: DecisionCycleStatus =
      applied.length > 0
        ? "applied"
        : validation.accepted.length > 0
          ? "apply_failed"
          : "empty_plan";

    const result: DecisionCycleResult = {
      decisionId: validation.decisionId,
      status,
      applied,
      rejected: validation.rejected,
      droppedActions: parsed.droppedActions,
      stale: validation.stale,
      missedEvents: validation.missedEvents,
      revisionAtDecision,
      revisionAtCommit: this.world.revision(),
      elapsedMs,
      note: null,
    };

    this.logger?.info("master.decision_cycle", {
      decisionId: result.decisionId,
      status: result.status,
      applied: applied.map((action) => action.type),
      rejected: validation.rejected.map((action) => ({ action: action.action.type, reason: action.reason })),
      droppedActions: parsed.droppedActions,
      stale: result.stale,
      missedEvents: result.missedEvents,
      elapsedMs,
      revisionAtDecision,
      revisionAtCommit: result.revisionAtCommit,
    });

    return result;
  }

  private dialogueEntries(): readonly DialogueEntry[] {
    return this.dialogue?.recent() ?? [];
  }

  private noOp(
    status: DecisionCycleStatus,
    revisionAtDecision: WorldRevision,
    elapsedMs: number,
    note: string,
    droppedActions: readonly string[] = [],
  ): DecisionCycleResult {
    this.logger?.warn("master.decision_cycle_degraded", { status, note, elapsedMs });
    return {
      decisionId: null,
      status,
      applied: [],
      rejected: [],
      droppedActions,
      stale: false,
      missedEvents: false,
      revisionAtDecision,
      revisionAtCommit: this.world.revision(),
      elapsedMs,
      note,
    };
  }

  private async commit(command: CompiledCommand): Promise<AppliedAction> {
    switch (command.type) {
      case "start_task": {
        const outcome = this.scheduler.createTask({
          goal: command.goal,
          idempotencyKey: command.idempotencyKey,
          decisionId: command.decisionId,
          priority: command.priority,
        });
        if (outcome.status === "rejected") throw new Error(`创建任务被拒绝：${outcome.reason}`);
        return {
          type: "start_task",
          detail: `${outcome.status === "reused" ? "复用既有任务" : "创建任务"} ${outcome.task.taskId}（priority=${command.priority}）`,
        };
      }
      case "cancel_task": {
        const outcome = await this.scheduler.requestCancel(command.taskId, command.reason);
        if (outcome.status === "rejected") throw new Error(`取消被拒绝：${outcome.reason}`);
        return { type: "cancel_task", detail: `${command.taskId} → ${outcome.status}` };
      }
      case "set_focus": {
        const record = this.focus.set(command.taskId, {
          decisionId: command.decisionId,
          reason: `决策 ${command.decisionId} 建议焦点`,
        });
        return { type: "set_focus", detail: record.taskId ?? "(清空焦点)" };
      }
      case "deliver_results": {
        if (this.delivery === undefined) {
          throw new Error("未配置交付队列，无法执行 deliver_results");
        }
        const entry = this.delivery.enqueueBatch({
          taskIds: command.taskIds,
          text: command.text,
          priority: command.priority,
          // after_current：明确不允许抢占（即使被判为 urgent）
          allowPreemption: command.timing === "now",
        });
        return {
          type: "deliver_results",
          detail: `${command.taskIds.join("+")} → ${entry.id}（priority=${command.priority}, timing=${command.timing}）`,
        };
      }
    }
  }

  /** Master 不可用时的确定性兜底：结果必须被交付，不能因为模型失败而丢失。 */
  private fallbackDeliver(
    batch: readonly PendingResult[],
    result: DecisionCycleResult,
  ): DecisionCycleResult {
    if (this.delivery === undefined) return result;

    const applied: AppliedAction[] = batch.map((item) => {
      const entry = this.delivery?.enqueue({
        taskId: item.taskId,
        summary: item.spokenSummary,
        priority: item.priority,
      });
      return { type: "deliver_fallback", detail: `${item.taskId} → ${entry?.id ?? "?"}` };
    });

    const note = `${result.note ?? result.status}；已按确定性规则兜底交付 ${batch.length} 条结果（结果不会因 Master 失败而丢失）`;
    this.logger?.warn("master.delivery_fallback", { count: batch.length, reason: result.status });
    return { ...result, status: "applied", applied: [...result.applied, ...applied], note };
  }
}
