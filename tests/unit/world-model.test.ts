import { describe, expect, it } from "vitest";

import { FakeWorkerRuntime } from "../../src/adapters/workers/fake-worker.ts";
import { TaskScheduler } from "../../src/application/scheduler/scheduler.ts";
import {
  isControlChangingEvent,
  WorldModel,
  DEFAULT_ACTIVE_TASK_LIMIT,
  DEFAULT_RECENT_COMPLETION_LIMIT,
  DEFAULT_RECENT_INPUT_LIMIT,
} from "../../src/application/master/context-view.ts";
import type { SchedulerEventType } from "../../src/application/scheduler/scheduler.ts";

function setup() {
  const runtime = new FakeWorkerRuntime();
  const scheduler = new TaskScheduler({ runtime, maxConcurrent: 1 });
  const world = new WorldModel({ scheduler });
  return { runtime, scheduler, world };
}

describe("两维版本号的分界线", () => {
  it("状态类事件使 controlRevision 前进；遥测类事件不前进", () => {
    const controlChanging: SchedulerEventType[] = [
      "task_created",
      "task_admitted",
      "task_cancel_requested",
      "task_succeeded",
      "task_failed",
      "task_cancelled",
      "task_start_failed",
    ];
    const telemetry: SchedulerEventType[] = [
      "task_progress",
      "task_tool_call",
      "task_cancel_request_failed",
      "worker_event_rejected",
    ];

    for (const type of controlChanging) expect(isControlChangingEvent(type), type).toBe(true);
    for (const type of telemetry) expect(isControlChangingEvent(type), type).toBe(false);
  });

  it("任务进度与工具调用不使既有决策过期", () => {
    const { runtime, scheduler, world } = setup();
    const outcome = scheduler.createTask({ goal: "长任务" });
    if (outcome.status === "rejected") throw new Error("创建失败");
    const taskId = outcome.task.taskId;

    const revisionAfterAdmit = world.revision();

    runtime.emitProgress(taskId, "进度一");
    runtime.emitToolCall(taskId, "bash");
    runtime.emitProgress(taskId, "进度二");

    expect(world.revision()).toEqual(revisionAfterAdmit);
  });

  it("任务终态使 controlRevision 前进并进入最近完成列表", () => {
    const { runtime, scheduler, world } = setup();
    const outcome = scheduler.createTask({ goal: "任务" });
    if (outcome.status === "rejected") throw new Error("创建失败");
    const taskId = outcome.task.taskId;

    const before = world.revision().controlRevision;
    runtime.emitSucceeded(taskId, "结果");

    expect(world.revision().controlRevision).toBe(before + 1);
    const view = world.buildView();
    expect(view.recentCompletions).toHaveLength(1);
    expect(view.recentCompletions[0]?.taskId).toBe(taskId);
    expect(view.recentCompletions[0]?.resultSummary).toBe("结果");
  });

  it("输入事件只递增 eventSeq，不改变 controlRevision", () => {
    const { world } = setup();
    const before = world.revision();

    world.ingestInput({ source: "user", text: "查一下天气" });

    expect(world.revision().eventSeq).toBe(before.eventSeq + 1);
    expect(world.revision().controlRevision).toBe(before.controlRevision);
    expect(world.buildView().latestUserInput).toBe("查一下天气");
  });
});

describe("面向 Master 的视图有界", () => {
  it("活动任务、最近输入、最近完成都受数量上限约束", () => {
    const { runtime, scheduler, world } = setup();

    for (let index = 0; index < 10; index += 1) {
      const outcome = scheduler.createTask({ goal: `任务 ${index}` });
      if (outcome.status === "rejected") throw new Error("创建失败");
    }
    for (let index = 0; index < 10; index += 1) {
      world.ingestInput({ source: "user", text: `输入 ${index}` });
    }
    // 让部分任务进入终态
    const tasks = scheduler.listTasks();
    for (const task of tasks.slice(0, 7)) runtime.emitSucceeded(task.taskId, `结果 ${task.taskId}`);

    const view = world.buildView();

    expect(view.activeTasks.length).toBeLessThanOrEqual(DEFAULT_ACTIVE_TASK_LIMIT);
    expect(view.recentInputs.length).toBeLessThanOrEqual(DEFAULT_RECENT_INPUT_LIMIT);
    expect(view.recentCompletions.length).toBeLessThanOrEqual(DEFAULT_RECENT_COMPLETION_LIMIT);
    // 视图里不应出现内部 Runtime 对象
    for (const summary of view.activeTasks) {
      expect(Object.keys(summary).sort()).toEqual(
        ["goal", "lastActivityAt", "priority", "runGeneration", "state", "taskId"].sort(),
      );
    }
  });

  it("最新用户输入取最后一次 user 来源", () => {
    const { world } = setup();
    world.ingestInput({ source: "screen", text: "屏幕变化" });
    world.ingestInput({ source: "user", text: "第一次" });
    world.ingestInput({ source: "user", text: "第二次" });

    expect(world.buildView().latestUserInput).toBe("第二次");
  });
});
