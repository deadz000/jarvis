/**
 * M4 端到端实测：**真实 Master** 产出结构化决策，经逐动作校验后落地。
 *
 * 用真实模型（不打桩）验证三件事：
 *   1. 「提示词要求 JSON + 严格解析与降级」这条决策在真实模型上是否成立；
 *   2. Master 的建议能否被逐动作校验后正确落地（取消一个任务、不动另一个、设置焦点）；
 *   3. Master 是否**只提出意图** —— 所有状态变更都出现在 DecisionCycleResult.applied 里，
 *      由 Scheduler 执行，Master 本身没有任何写状态通道。
 *
 * Worker 用确定性 FakeWorker：本脚本只验证决策平面，不调用真实 Worker，
 * 因此两个任务会一直停在 `running`，正好作为 Master 的观察对象。
 *
 * 用法：npm run example:master
 */
import { PiMasterAdapter } from "../../src/adapters/pi/pi-master.ts";
import { selectModel } from "../../src/adapters/pi/model-selection.ts";
import { FakeWorkerRuntime } from "../../src/adapters/workers/fake-worker.ts";
import { InteractionFocusStore } from "../../src/application/interaction/focus.ts";
import { WorldModel } from "../../src/application/master/context-view.ts";
import {
  MasterDecisionPlane,
  type MasterPort,
  type MasterProposal,
  type MasterRequest,
} from "../../src/application/master/decision-plane.ts";
import { TaskScheduler } from "../../src/application/scheduler/scheduler.ts";
import { assertModelCredentials, ConfigError, loadConfig } from "../../src/config/env.ts";
import { createLogger } from "../../src/observability/logger.ts";

/** 记录 Master 的原始输出，便于人工检查真实模型是否按要求产出 JSON。 */
class RecordingMaster implements MasterPort {
  public lastRawText: string | undefined;

  private readonly inner: MasterPort;

  public constructor(inner: MasterPort) {
    this.inner = inner;
  }

  public async proposeDecision(request: MasterRequest): Promise<MasterProposal> {
    const proposal = await this.inner.proposeDecision(request);
    if (proposal.status === "ok") this.lastRawText = proposal.rawText;
    return proposal;
  }
}

function createTask(scheduler: TaskScheduler, goal: string): string {
  const outcome = scheduler.createTask({ goal });
  if (outcome.status === "rejected") throw new Error(`创建任务被拒绝：${outcome.reason}`);
  return outcome.task.taskId;
}

async function run(): Promise<number> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, context: { component: "examples.sdk.master" } });
  assertModelCredentials(config);

  const selected = await selectModel(config);
  const runtime = new FakeWorkerRuntime();
  const scheduler = new TaskScheduler({ runtime, maxConcurrent: config.maxConcurrentTasks, logger: log });
  const world = new WorldModel({ scheduler });
  const focus = new InteractionFocusStore();
  const master = new RecordingMaster(
    new PiMasterAdapter({
      modelRuntime: selected.modelRuntime,
      model: selected.model,
      workspace: config.workspace,
      logger: log,
    }),
  );

  const plane = new MasterDecisionPlane({
    master,
    scheduler,
    world,
    focus,
    timeoutMs: config.masterTimeoutMs,
    logger: log,
  });

  const checks: Record<string, boolean> = {};

  try {
    // 预置两个正在运行的任务，模拟系统已有状态
    const weather = createTask(scheduler, "查询今天的天气");
    const git = createTask(scheduler, "总结最近三次 Git 提交");
    checks["预置两个任务均处于 running"] =
      scheduler.getTask(weather)?.state === "running" && scheduler.getTask(git)?.state === "running";

    const result = await plane.decide({
      userInput: "天气不用查了，取消它；Git 提交继续分析，并把焦点放在 Git 那个任务上。",
    });

    checks["决策输出可解析并落地"] = result.status === "applied";
    checks["天气任务收到取消请求"] = scheduler.getTask(weather)?.state === "cancel_requested";
    checks["Git 任务未受影响"] = scheduler.getTask(git)?.state === "running";
    checks["交互焦点指向 Git 任务"] = focus.focusedTaskId() === git;
    checks["状态变更全部经 Scheduler（applied 非空）"] = result.applied.length > 0;
    checks["未凭空创建多余任务"] = scheduler.stats().total === 2;

    const report = {
      model: `${selected.model.provider}/${selected.model.id}`,
      decisionId: result.decisionId,
      cycleStatus: result.status,
      elapsedMs: result.elapsedMs,
      applied: result.applied,
      rejected: result.rejected.map((action) => ({ type: action.action.type, reason: action.reason })),
      droppedActions: result.droppedActions,
      stale: result.stale,
      missedEvents: result.missedEvents,
      revisionAtDecision: result.revisionAtDecision,
      revisionAtCommit: result.revisionAtCommit,
      masterRawOutput: (master.lastRawText ?? "").slice(0, 1200),
      taskStates: scheduler.listTasks().map((task) => ({ taskId: task.taskId, goal: task.goal, state: task.state })),
      focus: focus.get() ?? null,
    };

    log.info("m4.verdict", report);

    const lines = [
      "",
      "===== M4 真实 Master 实测结论 =====",
      `模型：${report.model}  耗时 ${result.elapsedMs}ms  决策周期状态：${result.status}`,
      "",
      "--- Master 原始输出 ---",
      report.masterRawOutput,
      "",
      "--- 落地动作（全部经 Scheduler）---",
      ...result.applied.map((action) => `• ${action.type}：${action.detail}`),
      ...(result.rejected.length === 0
        ? []
        : ["", "--- 被拒绝的动作 ---", ...result.rejected.map((action) => `• ${action.action.type}：${action.reason}`)]),
      ...(result.droppedActions.length === 0
        ? []
        : ["", "--- 被丢弃的非法动作 ---", ...result.droppedActions.map((reason) => `• ${reason}`)]),
      "",
      "--- 检查项 ---",
      ...Object.entries(checks).map(([name, ok]) => `${ok ? "✅" : "❌"} ${name}`),
      "",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);

    return Object.values(checks).every(Boolean) ? 0 : 1;
  } finally {
    world.dispose();
    await scheduler.dispose("example_finished");
  }
}

try {
  process.exitCode = await run();
} catch (error) {
  const message =
    error instanceof ConfigError
      ? error.message
      : `M4 实测失败：${error instanceof Error ? error.message : String(error)}`;
  process.stderr.write(`[example-error] ${message}\n`);
  process.exitCode = 1;
}
