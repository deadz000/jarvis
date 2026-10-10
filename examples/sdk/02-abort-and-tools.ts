/**
 * M1 实测：自定义工具闭环 + 取消（abort）语义。
 *
 * 这是 SRS FR-07 验收项的实测脚本：
 *   「运行中的取消可被传递到 SDK 和自定义工具执行层，具体能力经 PoC 证明」
 *   「工具事件正确关联 Task ID 与执行代次」（此处先验证工具事件的可用性）
 *
 * 三个实验阶段：
 *   A. 自定义工具闭环：模型调用 `slow_probe`、工具返回、模型继续并给出最终答复。
 *   B. 取消传递：工具执行期间调用 `session.abort()`，观察
 *      - 工具收到的 AbortSignal 是否触发、延迟多少；
 *      - `prompt()` 是 resolve 还是 reject；
 *      - assistant 终态的 stopReason。
 *   C. steer/followUp：流式期间追加输入的返回契约。
 *
 * 用法：npm run example:abort
 * 前置：.env 中配置可用凭据（config/models.json 声明端点）。
 */
import {
  createAgentSession,
  defineTool,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { selectModel } from "../../src/adapters/pi/model-selection.ts";
import {
  classifySessionOutcome,
  readAssistantFinalMessage,
  type AssistantFinalMessage,
} from "../../src/adapters/pi/session-outcome.ts";
import { assertModelCredentials, ConfigError, loadConfig } from "../../src/config/env.ts";
import { createLogger } from "../../src/observability/logger.ts";

interface ToolObservation {
  called: number;
  lastParams: unknown;
  signalProvided: boolean;
  completedAfterMs: number | undefined;
  aborted: boolean;
  abortedAfterMs: number | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 轮询等待条件成立，超时返回 false（避免实验因模型不配合而永久挂起）。 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function readEventType(value: unknown): string {
  const record = asRecord(value);
  const type = record?.["type"];
  return typeof type === "string" ? type : "unknown";
}

function createSlowProbeTool(observation: ToolObservation) {
  return defineTool({
    name: "slow_probe",
    label: "慢速探针",
    description:
      "等待指定毫秒数后返回一段文本。用于验证工具调用闭环，以及取消信号是否能传递到工具执行层。无副作用。",
    parameters: Type.Object({
      ms: Type.Number({ description: "等待的毫秒数，例如 2000" }),
    }),
    execute: async (_toolCallId, params, signal) => {
      observation.called += 1;
      observation.lastParams = params;
      observation.signalProvided = signal !== undefined;

      const startedAt = Date.now();
      const requested = Number(params.ms);
      const ms = Number.isFinite(requested) ? Math.max(0, Math.min(requested, 60_000)) : 0;

      if (signal === undefined) {
        await sleep(ms);
        observation.completedAfterMs = Date.now() - startedAt;
      } else if (signal.aborted) {
        observation.aborted = true;
        observation.abortedAfterMs = 0;
      } else {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            observation.completedAfterMs = Date.now() - startedAt;
            resolve();
          }, ms);
          signal.addEventListener(
            "abort",
            () => {
              observation.aborted = true;
              observation.abortedAfterMs = Date.now() - startedAt;
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }

      const text = observation.aborted
        ? `slow_probe 在 ${observation.abortedAfterMs ?? 0}ms 后收到中止信号并退出`
        : `slow_probe 等待 ${ms}ms 后正常完成`;
      return {
        content: [{ type: "text" as const, text }],
        details: {
          requestedMs: ms,
          aborted: observation.aborted,
          abortedAfterMs: observation.abortedAfterMs ?? null,
        },
      };
    },
  });
}

async function run(): Promise<number> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, context: { component: "examples.sdk.abort" } });
  assertModelCredentials(config);

  const selected = await selectModel(config);
  const model = selected.model;

  const observation: ToolObservation = {
    called: 0,
    lastParams: undefined,
    signalProvided: false,
    completedAfterMs: undefined,
    aborted: false,
    abortedAfterMs: undefined,
  };

  const { session } = await createAgentSession({
    cwd: config.workspace,
    modelRuntime: selected.modelRuntime,
    model: selected.model,
    // 去掉内建工具，避免模型用 bash 绕过实验；保留自定义工具。
    noTools: "builtin",
    customTools: [createSlowProbeTool(observation)],
    sessionManager: SessionManager.inMemory(config.workspace),
  });

  const eventCounts = new Map<string, number>();
  let finalAssistant: AssistantFinalMessage | undefined;
  let toolStartedAt: number | undefined;
  let toolEventSample: Record<string, unknown> | undefined;

  const unsubscribe = session.subscribe((event) => {
    const type = readEventType(event);
    eventCounts.set(type, (eventCounts.get(type) ?? 0) + 1);

    if (type.startsWith("tool_")) {
      const record = asRecord(event);
      toolEventSample ??= { type, toolName: record?.["toolName"] ?? null };
      if (type.includes("start")) toolStartedAt = Date.now();
    }

    if (type === "message_update") {
      const messageEvent = asRecord((asRecord(event) ?? {})["assistantMessageEvent"]);
      if (messageEvent?.["type"] === "text_delta" && typeof messageEvent["delta"] === "string") {
        process.stdout.write(messageEvent["delta"]);
      }
    }
    if (type === "message_end") {
      const candidate = readAssistantFinalMessage((asRecord(event) ?? {})["message"]);
      if (candidate !== undefined) finalAssistant = candidate;
    }
  });

  const report: Record<string, unknown> = {
    model: `${model.provider}/${model.id}`,
  };

  try {
    // ---------------- 阶段 A：自定义工具闭环 ----------------
    const phaseAStartedAt = Date.now();
    finalAssistant = undefined;
    let phaseAError: string | undefined;
    try {
      await session.prompt(
        "请调用 slow_probe 工具，参数 ms 设为 2000。工具返回后，用一句话复述它的返回内容。",
      );
    } catch (error) {
      phaseAError = error instanceof Error ? error.message : String(error);
    }
    process.stdout.write("\n");
    const phaseAOutcome = classifySessionOutcome(finalAssistant, session.getLastAssistantText());
    report["phaseA"] = {
      toolCalled: observation.called >= 1,
      toolCallCount: observation.called,
      paramsReceived: observation.lastParams ?? null,
      signalProvidedToTool: observation.signalProvided,
      toolCompletedAfterMs: observation.completedAfterMs ?? null,
      promptElapsedMs: Date.now() - phaseAStartedAt,
      outcomeStatus: phaseAOutcome.status,
      stopReason: phaseAOutcome.stopReason ?? null,
      error: phaseAError ?? null,
    };

    // ---------------- 阶段 B：取消是否传递到工具执行层 ----------------
    observation.aborted = false;
    observation.abortedAfterMs = undefined;
    observation.completedAfterMs = undefined;
    toolStartedAt = undefined;
    finalAssistant = undefined;

    const promptB = session.prompt("请调用 slow_probe 工具，参数 ms 设为 30000。这是一次长任务测试。");
    const toolDidStart = await waitFor(() => toolStartedAt !== undefined, 30_000);

    let abortDurationMs: number | undefined;
    let abortError: string | undefined;
    let promptBOutcome = "pending";
    let promptBError: string | undefined;

    if (toolDidStart) {
      await sleep(1_200);
      const abortStartedAt = Date.now();
      try {
        await session.abort();
      } catch (error) {
        abortError = error instanceof Error ? error.message : String(error);
      }
      abortDurationMs = Date.now() - abortStartedAt;
    }

    try {
      await promptB;
      promptBOutcome = "resolved";
    } catch (error) {
      promptBOutcome = "rejected";
      promptBError = error instanceof Error ? error.message : String(error);
    }
    process.stdout.write("\n");

    // 关键：已发出取消请求 → 该次 error 应判定为「已取消」而不是「失败」。
    const phaseBOutcome = classifySessionOutcome(finalAssistant, session.getLastAssistantText(), {
      cancelRequested: true,
    });
    report["phaseB"] = {
      toolDidStart,
      abortIssuedAfterMs: 1_200,
      abortCallDurationMs: abortDurationMs ?? null,
      abortError: abortError ?? null,
      toolObservedAbort: observation.aborted,
      toolAbortLatencyMs: observation.abortedAfterMs ?? null,
      toolCompletedAfterMs: observation.completedAfterMs ?? null,
      promptSettledAs: promptBOutcome,
      promptError: promptBError ?? null,
      assistantStopReason: phaseBOutcome.stopReason ?? null,
      assistantErrorMessage: phaseBOutcome.errorMessage ?? null,
      outcomeStatus: phaseBOutcome.status,
    };

    // ---------------- 阶段 C：流式期间 steer / followUp 契约 ----------------
    finalAssistant = undefined;
    const promptC = session.prompt("请用三句话介绍你自己。");
    let steerResult: unknown;
    let steerError: string | undefined;
    try {
      steerResult = await session.steer("补充要求：第二句必须提到“调度”。");
    } catch (error) {
      steerError = error instanceof Error ? error.message : String(error);
    }
    await promptC.catch(() => undefined);
    const phaseCOutcome = classifySessionOutcome(finalAssistant, session.getLastAssistantText());
    report["phaseC"] = {
      steerResult: steerResult ?? null,
      steerError: steerError ?? null,
      outcomeStatus: phaseCOutcome.status,
    };

    report["eventTypes"] = Object.fromEntries([...eventCounts.entries()].sort());
    report["toolEventSample"] = toolEventSample ?? null;

    log.info("m1.verdict", report);

    // 人类可读摘要
    const lines = [
      "",
      "===== M1 实测结论 =====",
      `阶段 A 自定义工具闭环：${observation.called >= 1 ? "模型已调用工具" : "模型未调用工具（实验不成立）"}`,
      `  - 工具收到的 signal：${observation.signalProvided ? "有" : "无"}`,
      `  - prompt 终态：${String((report["phaseA"] as Record<string, unknown>)["outcomeStatus"])}`,
      `阶段 B 取消传递：${toolDidStart ? "已发出 abort" : "工具未启动（实验不成立）"}`,
      `  - 工具观察到中止：${observation.aborted ? `是，${observation.abortedAfterMs}ms` : "否"}`,
      `  - abort() 耗时：${abortDurationMs ?? "n/a"}ms`,
      `  - prompt 结算方式：${promptBOutcome}${promptBError === undefined ? "" : `（${promptBError}）`}`,
      `  - assistant stopReason：${String((report["phaseB"] as Record<string, unknown>)["assistantStopReason"])}`,
      `阶段 C steer 返回：${JSON.stringify(steerResult)}${steerError === undefined ? "" : ` / 错误：${steerError}`}`,
      `观测到的事件类型：${[...eventCounts.keys()].sort().join(", ")}`,
      "",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } finally {
    unsubscribe();
    session.dispose();
  }
}

try {
  process.exitCode = await run();
} catch (error) {
  const message =
    error instanceof ConfigError
      ? error.message
      : `M1 实测失败：${error instanceof Error ? error.message : String(error)}`;
  process.stderr.write(`[example-error] ${message}\n`);
  process.exitCode = 1;
}
