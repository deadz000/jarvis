import { describe, expect, it } from "vitest";

import { FakeWorkerRuntime } from "../../src/adapters/workers/fake-worker.ts";
import { TaskScheduler, type SchedulerEvent } from "../../src/application/scheduler/scheduler.ts";
import type { TaskId } from "../../src/domain/task/types.ts";
import type { WorkerRuntime } from "../../src/application/workers/ports.ts";

interface Harness {
  readonly scheduler: TaskScheduler;
  readonly runtime: FakeWorkerRuntime;
  readonly events: SchedulerEvent[];
  readonly advance: (ms?: number) => number;
  readonly clock: () => number;
  readonly dispose: () => Promise<void>;
}

function setup(options: { maxConcurrent?: number; activeViewLimit?: number } = {}): Harness {
  let now = 1_000;
  const clock = (): number => now;
  const runtime = new FakeWorkerRuntime({ now: clock });
  const scheduler = new TaskScheduler({
    runtime,
    maxConcurrent: options.maxConcurrent ?? 2,
    now: clock,
    ...(options.activeViewLimit === undefined ? {} : { activeViewLimit: options.activeViewLimit }),
  });
  const events: SchedulerEvent[] = [];
  const unsubscribe = scheduler.onEvent((event) => events.push(event));

  return {
    scheduler,
    runtime,
    events,
    clock,
    advance: (ms = 1) => {
      now += ms;
      return now;
    },
    dispose: async () => {
      unsubscribe();
      await scheduler.dispose();
    },
  };
}

/** 断言任务存在并返回快照，避免测试里到处写非空断言。 */
function requireTask(scheduler: TaskScheduler, taskId: TaskId) {
  const task = scheduler.getTask(taskId);
  if (task === undefined) throw new Error(`任务 ${taskId} 不存在`);
  return task;
}

function createOrThrow(scheduler: TaskScheduler, goal: string, idempotencyKey?: string): TaskId {
  const outcome = scheduler.createTask(idempotencyKey === undefined ? { goal } : { goal, idempotencyKey });
  if (outcome.status === "rejected") throw new Error(`创建任务被拒绝：${outcome.reason}`);
  return outcome.task.taskId;
}

function eventsOfType(events: readonly SchedulerEvent[], type: SchedulerEvent["type"]): SchedulerEvent[] {
  return events.filter((event) => event.type === type);
}

describe("TaskScheduler — 必备状态场景（实施计划 M3）", () => {
  it("场景 1：queued → running → succeeded，代次从 1 开始", async () => {
    const h = setup({ maxConcurrent: 1 });
    const taskId = createOrThrow(h.scheduler, "总结最近三次 Git 提交");

    const admitted = requireTask(h.scheduler, taskId);
    expect(admitted.state).toBe("running");
    expect(admitted.runGeneration).toBe(1);
    expect(admitted.startedAt).toBe(1000);
    expect(h.runtime.startRequests).toHaveLength(1);
    expect(h.runtime.startRequests[0]?.goal).toBe("总结最近三次 Git 提交");

    h.advance(50);
    h.runtime.emitSucceeded(taskId, "已总结 3 次提交");

    const final = requireTask(h.scheduler, taskId);
    expect(final.state).toBe("succeeded");
    expect(final.resultSummary).toBe("已总结 3 次提交");
    expect(final.terminalAt).toBe(1050);
    expect(eventsOfType(h.events, "task_created")).toHaveLength(1);
    expect(eventsOfType(h.events, "task_admitted")).toHaveLength(1);
    expect(eventsOfType(h.events, "task_succeeded")).toHaveLength(1);

    await h.dispose();
  });

  it("场景 2：queued → cancelled（未启动的任务直接取消，且不影响正在运行的任务）", async () => {
    const h = setup({ maxConcurrent: 1 });
    const runningId = createOrThrow(h.scheduler, "查询天气");
    const queuedId = createOrThrow(h.scheduler, "分析 Git");

    expect(requireTask(h.scheduler, queuedId).state).toBe("queued");

    const outcome = await h.scheduler.requestCancel(queuedId, "用户改主意了");

    expect(outcome.status).toBe("cancelled");
    const cancelled = requireTask(h.scheduler, queuedId);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.runGeneration).toBe(0);
    expect(cancelled.cancelReason).toBe("用户改主意了");
    // 队列中从未启动
    expect(h.runtime.startRequests.map((request) => request.taskId)).toEqual([runningId]);
    // 无关任务完全不受影响
    expect(requireTask(h.scheduler, runningId).state).toBe("running");
    expect(h.runtime.cancelRequests).toHaveLength(0);

    await h.dispose();
  });

  it("场景 3：running → cancel_requested → cancelled，且中止协作式取消信号", async () => {
    const h = setup();
    const taskId = createOrThrow(h.scheduler, "长任务");

    const outcome = await h.scheduler.requestCancel(taskId, "用户要求停止");

    expect(outcome.status).toBe("cancel_requested");
    expect(requireTask(h.scheduler, taskId).state).toBe("cancel_requested");
    // 关键：取消请求 ≠ 已取消
    expect(requireTask(h.scheduler, taskId).terminalAt).toBeUndefined();
    expect(h.runtime.cancelRequests).toHaveLength(1);
    expect(h.runtime.cancelRequests[0]?.reason).toBe("用户要求停止");
    expect(h.runtime.cancelRequests[0]?.signalAborted).toBe(true);

    h.advance(30);
    h.runtime.emitCancelled(taskId, "已中止");

    const final = requireTask(h.scheduler, taskId);
    expect(final.state).toBe("cancelled");
    expect(final.cancelReason).toBe("已中止");
    expect(final.terminalAt).toBe(1030);
    // 终态后执行资源被回收
    expect(h.runtime.releases.map((release) => release.taskId)).toEqual([taskId]);

    await h.dispose();
  });

  it("场景 4a：cancel_requested 与 succeeded 竞态 —— 按真实结果提交并标记 cancelRaced", async () => {
    const h = setup();
    const taskId = createOrThrow(h.scheduler, "可能已完成的任务");

    await h.scheduler.requestCancel(taskId, "停止");
    expect(requireTask(h.scheduler, taskId).state).toBe("cancel_requested");

    h.runtime.emitSucceeded(taskId, "实际上已完成");

    const final = requireTask(h.scheduler, taskId);
    expect(final.state).toBe("succeeded");
    expect(final.resultSummary).toBe("实际上已完成");
    const succeeded = eventsOfType(h.events, "task_succeeded");
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]?.detail?.["cancelRaced"]).toBe(true);

    await h.dispose();
  });

  it("场景 4b：先完成再取消 —— 终态拒绝取消请求，不复活任务", async () => {
    const h = setup();
    const taskId = createOrThrow(h.scheduler, "已完成的任务");
    h.runtime.emitSucceeded(taskId, "done");

    const outcome = await h.scheduler.requestCancel(taskId, "太晚了");

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.reason).toBe("already_terminal");
    expect(requireTask(h.scheduler, taskId).state).toBe("succeeded");
    expect(h.runtime.cancelRequests).toHaveLength(0);

    await h.dispose();
  });

  it("场景 5：旧 runGeneration 的迟到事件被拒绝，不污染当前状态", async () => {
    const h = setup();
    const taskId = createOrThrow(h.scheduler, "任务");
    expect(h.runtime.generationOf(taskId)).toBe(1);

    // 模拟被重启/错路由的 Worker 用旧代次汇报终态
    h.advance(10);
    h.runtime.emitSucceeded(taskId, "过期结果", 999);

    const afterStale = requireTask(h.scheduler, taskId);
    expect(afterStale.state).toBe("running");
    expect(afterStale.resultSummary).toBeUndefined();
    const rejected = eventsOfType(h.events, "worker_event_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.detail?.["reason"]).toBe("stale_generation");
    expect(rejected[0]?.detail?.["currentGeneration"]).toBe(1);

    // 正确代次的迟到进度事件仍被接受
    h.runtime.emitProgress(taskId, "仍在工作", 1);
    expect(requireTask(h.scheduler, taskId).state).toBe("running");

    await h.dispose();
  });

  it("场景 5b：终态之后的迟到事件一律拒绝，旧结果不覆盖新状态", async () => {
    const h = setup();
    const taskId = createOrThrow(h.scheduler, "任务");
    h.runtime.emitSucceeded(taskId, "第一次结果");

    h.advance(10);
    h.runtime.emitProgress(taskId, "迟到的进度");
    h.runtime.emitSucceeded(taskId, "重复的完成事件");
    h.runtime.emitFailed(taskId, "迟到的失败");

    const final = requireTask(h.scheduler, taskId);
    expect(final.state).toBe("succeeded");
    expect(final.resultSummary).toBe("第一次结果");
    expect(final.terminalAt).toBe(1000);

    const rejected = eventsOfType(h.events, "worker_event_rejected");
    expect(rejected).toHaveLength(3);
    for (const event of rejected) {
      expect(event.detail?.["reason"]).toBe("task_terminal");
    }
    // 完成事件只提交一次
    expect(eventsOfType(h.events, "task_succeeded")).toHaveLength(1);

    await h.dispose();
  });

  it("场景 6：两个独立任务真正并行，事件互不串扰，一个失败另一个成功", async () => {
    const h = setup({ maxConcurrent: 2 });
    const gitId = createOrThrow(h.scheduler, "分析 Git 提交");
    const weatherId = createOrThrow(h.scheduler, "查询天气");

    // 并行证据：两个任务同时处于 running，且各自有独立执行代次与启动记录
    expect(requireTask(h.scheduler, gitId).state).toBe("running");
    expect(requireTask(h.scheduler, weatherId).state).toBe("running");
    expect(h.runtime.startRequests).toHaveLength(2);
    expect(h.runtime.startRequests.map((request) => request.taskId)).toEqual([gitId, weatherId]);
    expect(h.scheduler.stats().running).toBe(2);

    // 交替汇报进度：证明两者互不阻塞
    h.advance(10);
    h.runtime.emitProgress(gitId, "读取提交历史");
    h.advance(10);
    h.runtime.emitProgress(weatherId, "调用天气接口");
    h.advance(10);
    h.runtime.emitToolCall(gitId, "bash");
    expect(requireTask(h.scheduler, gitId).state).toBe("running");
    expect(requireTask(h.scheduler, weatherId).state).toBe("running");

    h.runtime.emitFailed(gitId, "仓库不可读");
    h.runtime.emitSucceeded(weatherId, "晴 24℃");

    expect(requireTask(h.scheduler, gitId).state).toBe("failed");
    expect(requireTask(h.scheduler, gitId).failureReason).toBe("仓库不可读");
    expect(requireTask(h.scheduler, weatherId).state).toBe("succeeded");
    expect(h.scheduler.stats().byState.failed).toBe(1);
    expect(h.scheduler.stats().byState.succeeded).toBe(1);

    // 事件归属正确：两个任务的进度事件各自独立，工具事件只属于发起它的任务
    const progress = eventsOfType(h.events, "task_progress");
    expect(progress.filter((event) => event.taskId === gitId)).toHaveLength(1);
    expect(progress.filter((event) => event.taskId === weatherId)).toHaveLength(1);
    const toolCalls = eventsOfType(h.events, "task_tool_call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.taskId).toBe(gitId);
    expect(toolCalls[0]?.detail?.["toolName"]).toBe("bash");

    await h.dispose();
  });

  it("场景 7：并发超限时进入准入队列，按 FIFO 逐个放行", async () => {
    const h = setup({ maxConcurrent: 1 });
    const first = createOrThrow(h.scheduler, "任务一");
    const second = createOrThrow(h.scheduler, "任务二");
    const third = createOrThrow(h.scheduler, "任务三");

    expect(requireTask(h.scheduler, first).state).toBe("running");
    expect(requireTask(h.scheduler, second).state).toBe("queued");
    expect(requireTask(h.scheduler, third).state).toBe("queued");
    expect(h.scheduler.stats()).toMatchObject({ total: 3, running: 1, queued: 2 });
    expect(h.runtime.startRequests.map((request) => request.taskId)).toEqual([first]);

    h.runtime.emitSucceeded(first, "ok");
    expect(requireTask(h.scheduler, second).state).toBe("running");
    expect(requireTask(h.scheduler, third).state).toBe("queued");

    h.runtime.emitSucceeded(second, "ok");
    expect(requireTask(h.scheduler, third).state).toBe("running");
    expect(h.runtime.startRequests.map((request) => request.taskId)).toEqual([first, second, third]);

    // 每次准入都产生新的执行代次
    expect(requireTask(h.scheduler, third).runGeneration).toBe(1);

    await h.dispose();
  });
});

describe("TaskScheduler — 幂等与边界", () => {
  it("相同 idempotencyKey 不重复创建任务（重复决策防护的基础）", async () => {
    const h = setup();
    const first = h.scheduler.createTask({ goal: "查天气", idempotencyKey: "decision-1:action-2" });
    const second = h.scheduler.createTask({ goal: "查天气", idempotencyKey: "decision-1:action-2" });

    if (first.status === "rejected" || second.status === "rejected") {
      throw new Error("创建任务被拒绝");
    }
    expect(first.status).toBe("created");
    expect(second.status).toBe("reused");
    expect(second.task.taskId).toBe(first.task.taskId);
    expect(h.runtime.startRequests).toHaveLength(1);
    expect(h.scheduler.stats().total).toBe(1);

    await h.dispose();
  });

  it("空目标被拒绝", async () => {
    const h = setup();
    expect(h.scheduler.createTask({ goal: "   " }).status).toBe("rejected");
    expect(h.scheduler.stats().total).toBe(0);
    await h.dispose();
  });

  it("取消不存在的任务返回 task_not_found", async () => {
    const h = setup();
    const outcome = await h.scheduler.requestCancel("task-999", "无此任务");
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.reason).toBe("task_not_found");
    await h.dispose();
  });

  it("重复取消请求被幂等拒绝，不重复下发", async () => {
    const h = setup();
    const taskId = createOrThrow(h.scheduler, "任务");

    await h.scheduler.requestCancel(taskId, "第一次");
    const second = await h.scheduler.requestCancel(taskId, "第二次");

    expect(second.status).toBe("rejected");
    if (second.status === "rejected") expect(second.reason).toBe("already_cancel_requested");
    expect(h.runtime.cancelRequests).toHaveLength(1);

    await h.dispose();
  });

  it("执行层无法取消时明确报告失败，任务停在 cancel_requested 并等待真实终态", async () => {
    const h = setup();
    const taskId = createOrThrow(h.scheduler, "不可取消的工具调用");
    h.runtime.failNextCancel(taskId, "工具不支持取消");

    const outcome = await h.scheduler.requestCancel(taskId, "停止");

    expect(outcome.status).toBe("cancel_request_failed");
    if (outcome.status === "cancel_request_failed") expect(outcome.reason).toBe("工具不支持取消");
    expect(requireTask(h.scheduler, taskId).state).toBe("cancel_requested");
    expect(eventsOfType(h.events, "task_cancel_request_failed")).toHaveLength(1);

    // 执行层随后报出真实结果，仍应被正确提交
    h.runtime.emitSucceeded(taskId, "工具跑完了");
    const final = requireTask(h.scheduler, taskId);
    expect(final.state).toBe("succeeded");
    expect(final.resultSummary).toBe("工具跑完了");

    await h.dispose();
  });

  it("Worker 启动抛错时任务显式落到 failed，不静默消失", async () => {
    let now = 1_000;
    const throwingRuntime: WorkerRuntime = {
      subscribe: () => () => {},
      start: () => {
        throw new Error("session 创建失败");
      },
    };
    const scheduler = new TaskScheduler({ runtime: throwingRuntime, maxConcurrent: 1, now: () => now });
    const events: SchedulerEvent[] = [];
    scheduler.onEvent((event) => events.push(event));

    const outcome = scheduler.createTask({ goal: "会失败的任务" });

    if (outcome.status === "rejected") throw new Error(`创建任务被拒绝：${outcome.reason}`);
    expect(outcome.status).toBe("created");
    expect(outcome.task.state).toBe("failed");
    expect(outcome.task.failureReason).toContain("session 创建失败");
    expect(eventsOfType(events, "task_start_failed")).toHaveLength(1);

    await scheduler.dispose();
  });

  it("面向 Master 的活动任务视图有界，而不是把全部任务塞进上下文", async () => {
    const h = setup({ maxConcurrent: 2 });
    for (let index = 0; index < 7; index += 1) {
      createOrThrow(h.scheduler, `任务 ${index}`);
      h.advance(10);
    }

    const active = h.scheduler.listActiveTasks();
    expect(active).toHaveLength(5);
    // 按最近活动倒序
    expect(active.map((task) => task.taskId)).toEqual(["task-7", "task-6", "task-5", "task-4", "task-3"]);
    expect(h.scheduler.listActiveTasks(2)).toHaveLength(2);
    expect(h.scheduler.stats().total).toBe(7);

    await h.dispose();
  });

  it("dispose 会取消活动任务并回收执行资源", async () => {
    const h = setup({ maxConcurrent: 2 });
    const first = createOrThrow(h.scheduler, "任务一");
    const second = createOrThrow(h.scheduler, "任务二");

    await h.scheduler.dispose("服务关闭");

    expect(requireTask(h.scheduler, first).state).toBe("cancel_requested");
    expect(requireTask(h.scheduler, second).state).toBe("cancel_requested");
    expect(h.runtime.cancelRequests.map((request) => request.taskId)).toEqual([first, second]);
    expect(h.runtime.releases.map((release) => release.taskId).sort()).toEqual([first, second]);
    // 关闭后不再接受新任务
    expect(h.scheduler.createTask({ goal: "关闭后" }).status).toBe("rejected");
  });

  it("maxConcurrent 非法时构造即失败，不允许静默使用默认值", () => {
    const runtime = new FakeWorkerRuntime();
    expect(() => new TaskScheduler({ runtime, maxConcurrent: 0 })).toThrow(RangeError);
    expect(() => new TaskScheduler({ runtime, maxConcurrent: 1.5 })).toThrow(RangeError);
  });
});
