import { describe, expect, it } from "vitest";

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
import type { WorldRevision } from "../../src/domain/decision/types.ts";

class FakeMaster implements MasterPort {
  public readonly calls: MasterRequest[] = [];
  private readonly queue: MasterProposal[];

  public constructor(...proposals: MasterProposal[]) {
    this.queue = proposals;
  }

  public async proposeDecision(request: MasterRequest): Promise<MasterProposal> {
    this.calls.push(request);
    const next = this.queue.shift();
    if (next === undefined) throw new Error("FakeMaster 脚本已耗尽");
    return next;
  }
}

/** 永不 settle 的 Master，用于验证超时降级。 */
const hangingMaster: MasterPort = {
  proposeDecision: () =>
    new Promise<MasterProposal>(() => {
      // 故意不 resolve：只能靠超时路径结束
    }),
};

function decisionText(decisionId: string, basedOn: WorldRevision, actions: unknown[]): string {
  return JSON.stringify({ decisionId, basedOn, actions, rationale: "test" });
}

interface Harness {
  readonly runtime: FakeWorkerRuntime;
  readonly scheduler: TaskScheduler;
  readonly world: WorldModel;
  readonly focus: InteractionFocusStore;
}

function setup(options: { maxConcurrent?: number } = {}): Harness {
  const runtime = new FakeWorkerRuntime();
  const scheduler = new TaskScheduler({ runtime, maxConcurrent: options.maxConcurrent ?? 2 });
  const world = new WorldModel({ scheduler });
  return { runtime, scheduler, world, focus: new InteractionFocusStore() };
}

function planeFor(h: Harness, master: MasterPort, timeoutMs = 5_000): MasterDecisionPlane {
  return new MasterDecisionPlane({
    master,
    scheduler: h.scheduler,
    world: h.world,
    focus: h.focus,
    timeoutMs,
  });
}

function createTask(scheduler: TaskScheduler, goal: string): string {
  const outcome = scheduler.createTask({ goal });
  if (outcome.status === "rejected") throw new Error(`创建任务被拒绝：${outcome.reason}`);
  return outcome.task.taskId;
}

function taskByGoal(scheduler: TaskScheduler, goal: string) {
  return scheduler.listTasks().find((task) => task.goal === goal);
}

describe("MasterDecisionPlane — M4 出口条件", () => {
  it("正常路径：启动 / 取消 / 焦点建议逐条落地", async () => {
    const h = setup();
    const running = createTask(h.scheduler, "旧任务");
    const basedOn = h.world.revision();

    const master = new FakeMaster({
      status: "ok",
      rawText: decisionText("d-1", basedOn, [
        { type: "start_task", goal: "新任务", priority: "high" },
        { type: "cancel_task", taskId: running, expectedGeneration: 1 },
        { type: "set_focus", taskId: running },
      ]),
    });

    const result = await planeFor(h, master).decide({ userInput: "天气不用查了" });

    expect(result.status).toBe("applied");
    expect(result.applied.map((action) => action.type)).toEqual(["start_task", "cancel_task", "set_focus"]);
    expect(result.rejected).toEqual([]);
    expect(h.scheduler.getTask(running)?.state).toBe("cancel_requested");
    expect(h.focus.get()?.taskId).toBe(running);
    expect(taskByGoal(h.scheduler, "新任务")?.priority).toBe("high");
  });

  it("Master 超时 → 空计划，不改动任何状态（不猜测意图）", async () => {
    const h = setup();
    const running = createTask(h.scheduler, "正在跑的任务");
    const before = h.scheduler.getTask(running)?.state;

    const result = await planeFor(h, hangingMaster, 30).decide({ userInput: "把那个任务取消掉" });

    expect(result.status).toBe("timeout");
    expect(result.applied).toEqual([]);
    expect(result.note).toContain("不执行任何动作");
    expect(h.scheduler.getTask(running)?.state).toBe(before);
    expect(h.scheduler.stats().total).toBe(1);
    expect(h.focus.get()).toBeUndefined();
  });

  it("输出无法解析 → 安全降级为不执行", async () => {
    const h = setup();
    const running = createTask(h.scheduler, "任务");
    const master = new FakeMaster({ status: "ok", rawText: "我觉得可以取消任务，但我不打算给 JSON" });

    const result = await planeFor(h, master).decide();

    expect(result.status).toBe("parse_failed");
    expect(result.applied).toEqual([]);
    expect(h.scheduler.getTask(running)?.state).toBe("running");
  });

  it("Master 调用失败 → master_error，不改动任何状态", async () => {
    const h = setup();
    const running = createTask(h.scheduler, "任务");
    const master = new FakeMaster({ status: "error", reason: "provider 401" });

    const result = await planeFor(h, master).decide();

    expect(result.status).toBe("master_error");
    expect(result.note).toContain("provider 401");
    expect(h.scheduler.getTask(running)?.state).toBe("running");
  });

  it("某个取消目标失效时，计划内仍合法的独立启动动作继续执行", async () => {
    const h = setup();
    const done = createTask(h.scheduler, "已完成的任务");
    h.runtime.emitSucceeded(done, "早就完成了");
    const basedOn = h.world.revision();

    const master = new FakeMaster({
      status: "ok",
      rawText: decisionText("d-2", basedOn, [
        { type: "cancel_task", taskId: done, expectedGeneration: 1 },
        { type: "start_task", goal: "仍然独立的新目标" },
      ]),
    });

    const result = await planeFor(h, master).decide();

    expect(result.status).toBe("applied");
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("already_terminal");
    expect(result.applied.map((action) => action.type)).toEqual(["start_task"]);
    expect(h.scheduler.getTask(done)?.state).toBe("succeeded");
    expect(taskByGoal(h.scheduler, "仍然独立的新目标")).toBeDefined();
  });

  it("代次不匹配的取消被拒绝，且不会下发取消请求（防止取消已换代的执行）", async () => {
    const h = setup();
    const task = createTask(h.scheduler, "任务");
    const basedOn = h.world.revision();

    const master = new FakeMaster({
      status: "ok",
      rawText: decisionText("d-3", basedOn, [
        { type: "cancel_task", taskId: task, expectedGeneration: 7 },
      ]),
    });

    const result = await planeFor(h, master).decide();

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toBe("generation_mismatch");
    expect(result.rejected[0]?.detail["actualGeneration"]).toBe(1);
    expect(h.runtime.cancelRequests).toHaveLength(0);
    expect(h.scheduler.getTask(task)?.state).toBe("running");
    expect(result.status).toBe("empty_plan");
  });

  it("取消不存在的任务被拒绝，不影响同一决策中的其他动作", async () => {
    const h = setup();
    const basedOn = h.world.revision();
    const master = new FakeMaster({
      status: "ok",
      rawText: decisionText("d-4", basedOn, [
        { type: "cancel_task", taskId: "task-999" },
        { type: "set_focus", taskId: "task-999" },
        { type: "start_task", goal: "有效目标" },
      ]),
    });

    const result = await planeFor(h, master).decide();

    expect(result.rejected.map((action) => action.reason)).toEqual(["task_not_found", "task_not_found"]);
    expect(result.applied.map((action) => action.type)).toEqual(["start_task"]);
    expect(taskByGoal(h.scheduler, "有效目标")).toBeDefined();
  });

  it("同一决策重复执行不重复创建任务（幂等键）", async () => {
    const h = setup();
    const basedOn = h.world.revision();
    const text = decisionText("d-5", basedOn, [{ type: "start_task", goal: "只应存在一次" }]);
    const plane = planeFor(h, new FakeMaster({ status: "ok", rawText: text }, { status: "ok", rawText: text }));

    const first = await plane.decide();
    const second = await plane.decide();

    expect(first.applied[0]?.detail).toContain("创建任务");
    expect(second.applied[0]?.detail).toContain("复用既有任务");
    expect(h.scheduler.listTasks().filter((task) => task.goal === "只应存在一次")).toHaveLength(1);
  });

  it("决策基于旧修订号时标记 stale / missedEvents，但合法动作仍按当前状态复核后执行", async () => {
    const h = setup();
    const staleBasedOn = h.world.revision(); // controlRevision = 0
    createTask(h.scheduler, "后来才创建的任务"); // 世界前进

    const master = new FakeMaster({
      status: "ok",
      rawText: decisionText("d-6", staleBasedOn, [{ type: "start_task", goal: "基于旧快照的启动" }]),
    });

    const result = await planeFor(h, master).decide({ userInput: "新输入" });

    expect(result.stale).toBe(true);
    expect(result.missedEvents).toBe(true);
    expect(result.applied.map((action) => action.type)).toEqual(["start_task"]);
    expect(result.revisionAtCommit.controlRevision).toBeGreaterThan(staleBasedOn.controlRevision);
  });

  it("形状非法的动作被丢弃，同一决策中的合法动作照常执行", async () => {
    const h = setup();
    const basedOn = h.world.revision();
    const master = new FakeMaster({
      status: "ok",
      rawText: decisionText("d-7", basedOn, [
        { type: "cancel_task" },
        { type: "start_task", goal: "合法目标" },
      ]),
    });

    const result = await planeFor(h, master).decide();

    expect(result.droppedActions).toHaveLength(1);
    expect(result.applied.map((action) => action.type)).toEqual(["start_task"]);
  });

  it("空计划不会改动任何状态", async () => {
    const h = setup();
    createTask(h.scheduler, "任务");
    const basedOn = h.world.revision();
    const master = new FakeMaster({ status: "ok", rawText: decisionText("d-8", basedOn, []) });

    const result = await planeFor(h, master).decide();

    expect(result.status).toBe("empty_plan");
    expect(h.scheduler.stats().total).toBe(1);
    expect(h.focus.get()).toBeUndefined();
  });

  it("Master 只能看到有界视图，且视图里没有内部 Runtime 对象", async () => {
    const h = setup();
    createTask(h.scheduler, "任务");
    const master = new FakeMaster({ status: "ok", rawText: decisionText("d-9", h.world.revision(), []) });

    await planeFor(h, master).decide();

    const view = master.calls[0]?.view;
    expect(view).toBeDefined();
    expect(Object.keys(view ?? {}).sort()).toEqual(
      ["activeTasks", "latestUserInput", "recentCompletions", "recentInputs", "revision"].sort(),
    );
  });
});
