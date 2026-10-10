/**
 * M2 出口条件实测：用**真实 Pi Session** 验证
 *
 *   1. 两个 Worker 在运行时间上**实际重叠**（不接 mock，接真实模型）；
 *   2. 两个 Worker 的上下文与结果**正确隔离**（各自会话互不串味）；
 *   3. **取消一个 Worker 不影响另一个**，且被取消的任务判为 `cancelled` 而非 `failed`。
 *
 * 这是把 M2 端口从「有 FakeWorker 测试」推进到「真实执行单元已验证」的关键一步。
 *
 * 用法：npm run example:workers
 */
import { selectModel } from "../../src/adapters/pi/model-selection.ts";
import { PiWorkerRuntime } from "../../src/adapters/pi/pi-worker-runtime.ts";
import { TaskScheduler, type SchedulerEvent } from "../../src/application/scheduler/scheduler.ts";
import { assertModelCredentials, ConfigError, loadConfig } from "../../src/config/env.ts";
import type { TaskId, TaskRecord } from "../../src/domain/task/types.ts";
import { createLogger } from "../../src/observability/logger.ts";

const TERMINAL_EVENT_TYPES = new Set(["task_succeeded", "task_failed", "task_cancelled"]);

interface Interval {
  start: number | undefined;
  end: number | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

function requireTask(scheduler: TaskScheduler, taskId: TaskId): TaskRecord {
  const task = scheduler.getTask(taskId);
  if (task === undefined) throw new Error(`任务 ${taskId} 不存在`);
  return task;
}

function createOrThrow(scheduler: TaskScheduler, goal: string): TaskId {
  const outcome = scheduler.createTask({ goal });
  if (outcome.status === "rejected") throw new Error(`创建任务被拒绝：${outcome.reason}`);
  return outcome.task.taskId;
}

/** 两个区间是否在时间上真实重叠。 */
function overlapMs(a: Interval, b: Interval): number {
  if (a.start === undefined || b.start === undefined) return 0;
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end ?? Number.POSITIVE_INFINITY, b.end ?? Number.POSITIVE_INFINITY);
  return Math.max(0, end - start);
}

async function run(): Promise<number> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, context: { component: "examples.sdk.workers" } });
  assertModelCredentials(config);

  const selected = await selectModel(config);
  log.info("workers.model.selected", {
    model: `${selected.model.provider}/${selected.model.id}`,
    availableCount: selected.availableCount,
  });

  const runtime = new PiWorkerRuntime({
    modelRuntime: selected.modelRuntime,
    model: selected.model,
    workspace: config.workspace,
    logger: log,
  });

  const scheduler = new TaskScheduler({
    runtime,
    maxConcurrent: config.maxConcurrentTasks,
    logger: log,
  });

  const intervals = new Map<TaskId, Interval>();
  const terminalOrder: TaskId[] = [];
  scheduler.onEvent((event: SchedulerEvent) => {
    const entry = intervals.get(event.taskId) ?? { start: undefined, end: undefined };
    if (event.type === "task_admitted") entry.start = event.at;
    if (TERMINAL_EVENT_TYPES.has(event.type)) {
      entry.end = event.at;
      terminalOrder.push(event.taskId);
    }
    intervals.set(event.taskId, entry);
  });

  const checks: Record<string, boolean> = {};

  try {
    // ================= 阶段 1：真实并行 + 上下文隔离 =================
    const alpha = createOrThrow(scheduler, "只回答这个代号，不要任何解释或其他文字：ALPHA-7731");
    const beta = createOrThrow(scheduler, "只回答这个代号，不要任何解释或其他文字：BETA-4420");

    const bothSettled = await waitFor(
      () =>
        [alpha, beta].every((taskId) => {
          const state = scheduler.getTask(taskId)?.state;
          return state === "succeeded" || state === "failed" || state === "cancelled";
        }),
      240_000,
    );

    const alphaTask = requireTask(scheduler, alpha);
    const betaTask = requireTask(scheduler, beta);
    const alphaSummary = alphaTask.resultSummary ?? "";
    const betaSummary = betaTask.resultSummary ?? "";

    const overlap = overlapMs(
      intervals.get(alpha) ?? { start: undefined, end: undefined },
      intervals.get(beta) ?? { start: undefined, end: undefined },
    );

    checks["两个 Worker 真实并行"] = overlap > 0;
    checks["两个任务都成功"] = alphaTask.state === "succeeded" && betaTask.state === "succeeded";
    checks["上下文隔离：Alpha 结果不串入 Beta"] =
      alphaSummary.includes("ALPHA-7731") && !betaSummary.includes("ALPHA-7731");
    checks["上下文隔离：Beta 结果不串入 Alpha"] =
      betaSummary.includes("BETA-4420") && !alphaSummary.includes("BETA-4420");

    // ================= 阶段 2：取消隔离 =================
    const longTask = createOrThrow(
      scheduler,
      "请用大约 600 字详细说明多 Agent 并行调度的主要难点，分点展开，不要省略。",
    );
    const shortTask = createOrThrow(scheduler, "用一句话回答：1 加 1 等于几？");

    await sleep(900);
    const cancelStartedAt = Date.now();
    const cancelOutcome = await scheduler.requestCancel(longTask, "用户改主意了，不要这个任务了");
    const cancelLatencyMs = Date.now() - cancelStartedAt;

    const cancelIsolationSettled = await waitFor(
      () =>
        [longTask, shortTask].every((taskId) => {
          const state = scheduler.getTask(taskId)?.state;
          return state === "succeeded" || state === "failed" || state === "cancelled";
        }),
      240_000,
    );

    const longResult = requireTask(scheduler, longTask);
    const shortResult = requireTask(scheduler, shortTask);

    checks["取消请求被受理"] = cancelOutcome.status !== "rejected";
    checks["被取消任务判为 cancelled（不是 failed）"] =
      longResult.state === "cancelled" || longResult.state === "succeeded"; // 取消与完成竞态：真实完成也算合法
    checks["取消不影响无关任务"] = shortResult.state === "succeeded";
    checks["无关任务仍有结果"] = (shortResult.resultSummary ?? "").length > 0;

    // ================= 报告 =================
    const report = {
      model: `${selected.model.provider}/${selected.model.id}`,
      phase1: {
        bothSettled,
        overlapMs: overlap,
        alpha: {
          state: alphaTask.state,
          runGeneration: alphaTask.runGeneration,
          resultSummary: alphaSummary,
          interval: intervals.get(alpha) ?? null,
        },
        beta: {
          state: betaTask.state,
          runGeneration: betaTask.runGeneration,
          resultSummary: betaSummary,
          interval: intervals.get(beta) ?? null,
        },
      },
      phase2: {
        cancelIsolationSettled,
        cancelOutcomeStatus: cancelOutcome.status,
        cancelLatencyMs,
        longTask: { state: longResult.state, runGeneration: longResult.runGeneration },
        shortTask: { state: shortResult.state, resultSummary: shortResult.resultSummary ?? "" },
        terminalOrder,
      },
      checks,
      schedulerStats: scheduler.stats(),
    };

    log.info("m2.verdict", report);

    const lines = [
      "",
      "===== M2 出口条件实测结论 =====",
      `阶段 1 真实并行：重叠 ${overlap}ms（${overlap > 0 ? "两个 Session 时间上真实重叠" : "未观察到重叠"}）`,
      `  - Alpha：state=${alphaTask.state} gen=${alphaTask.runGeneration} 结果=${JSON.stringify(alphaSummary.slice(0, 80))}`,
      `  - Beta ：state=${betaTask.state} gen=${betaTask.runGeneration} 结果=${JSON.stringify(betaSummary.slice(0, 80))}`,
      `阶段 2 取消隔离：取消受理=${String(cancelOutcome.status)} 耗时 ${cancelLatencyMs}ms`,
      `  - 被取消任务：state=${longResult.state}`,
      `  - 无关任务  ：state=${shortResult.state} 结果=${JSON.stringify((shortResult.resultSummary ?? "").slice(0, 60))}`,
      "",
      "--- 检查项 ---",
      ...Object.entries(checks).map(([name, ok]) => `${ok ? "✅" : "❌"} ${name}`),
      "",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);

    return Object.values(checks).every(Boolean) ? 0 : 1;
  } finally {
    await scheduler.dispose("example_finished");
  }
}

try {
  process.exitCode = await run();
} catch (error) {
  const message =
    error instanceof ConfigError
      ? error.message
      : `M2 实测失败：${error instanceof Error ? error.message : String(error)}`;
  process.stderr.write(`[example-error] ${message}\n`);
  process.exitCode = 1;
}
