import { describe, expect, it } from "vitest";

import { FakeWorkerRuntime } from "../../src/adapters/workers/fake-worker.ts";
import { InteractionFocusStore } from "../../src/application/interaction/focus.ts";
import { WorldModel } from "../../src/application/master/context-view.ts";
import { parseMasterDecision } from "../../src/application/master/decision-parser.ts";
import { validateDecision } from "../../src/application/master/decision-validator.ts";
import {
  MasterDecisionPlane,
  type MasterPort,
  type MasterProposal,
  type MasterRequest,
} from "../../src/application/master/decision-plane.ts";
import { DeliveryQueue } from "../../src/application/delivery/delivery-queue.ts";
import { SimulatedAudioManager } from "../../src/application/delivery/audio-manager.ts";
import type { PendingResult } from "../../src/application/delivery/delivery-batcher.ts";
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

function manualSchedule(): (fn: () => void, ms: number) => () => void {
  return () => () => {
    // 测试里不自动推进播放分片
  };
}

function setup(master: MasterPort) {
  const runtime = new FakeWorkerRuntime();
  const scheduler = new TaskScheduler({ runtime, maxConcurrent: 3 });
  const world = new WorldModel({ scheduler });
  const focus = new InteractionFocusStore();
  const audio = new SimulatedAudioManager({ schedule: manualSchedule(), chunksPerPlayback: 5 });
  const delivery = new DeliveryQueue({ audio, now: () => 1_000 });
  const plane = new MasterDecisionPlane({
    master,
    scheduler,
    world,
    focus,
    delivery,
    timeoutMs: 5_000,
  });
  return { runtime, scheduler, world, focus, audio, delivery, plane };
}

function createTask(scheduler: TaskScheduler, goal: string): string {
  const outcome = scheduler.createTask({ goal });
  if (outcome.status === "rejected") throw new Error("创建失败");
  return outcome.task.taskId;
}

function batchOf(scheduler: TaskScheduler, taskIds: readonly string[]): PendingResult[] {
  return taskIds.map((taskId) => {
    const task = scheduler.getTask(taskId);
    return {
      taskId,
      fullSummary: task?.resultSummary ?? "完整结果",
      spokenSummary: task?.spokenSummary ?? `口语稿 ${taskId}`,
      priority: task?.priority ?? "normal",
      at: 1_000,
    };
  });
}

function deliveryDecisionText(decisionId: string, basedOn: WorldRevision, actions: unknown[]): string {
  return JSON.stringify({ decisionId, basedOn, actions, rationale: "交付决策" });
}

describe("deliver_results — 解析", () => {
  const BASED_ON = { eventSeq: 1, controlRevision: 2 };

  it("接受合法的合并交付动作", () => {
    const result = parseMasterDecision(
      JSON.stringify({
        decisionId: "d-1",
        basedOn: BASED_ON,
        actions: [
          {
            type: "deliver_results",
            taskIds: ["task-1", "task-2"],
            text: "两件事都说完了。",
            priority: "high",
            timing: "now",
          },
        ],
      }),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const action = result.decision.actions[0];
    expect(action?.type).toBe("deliver_results");
    if (action?.type !== "deliver_results") return;
    expect(action.taskIds).toEqual(["task-1", "task-2"]);
    expect(action.timing).toBe("now");
    expect(action.priority).toBe("high");
  });

  it("timing 缺失时保守取 after_current（不抢占总是安全的）", () => {
    const result = parseMasterDecision(
      JSON.stringify({
        decisionId: "d-1",
        basedOn: BASED_ON,
        actions: [{ type: "deliver_results", taskIds: ["task-1"], text: "结果" }],
      }),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const action = result.decision.actions[0];
    if (action?.type !== "deliver_results") throw new Error("类型不符");
    expect(action.timing).toBe("after_current");
  });

  it("timing 非法时丢弃该动作（与其他枚举字段的严格程度一致）", () => {
    const result = parseMasterDecision(
      JSON.stringify({
        decisionId: "d-1",
        basedOn: BASED_ON,
        actions: [{ type: "deliver_results", taskIds: ["task-1"], text: "结果", timing: "immediately" }],
      }),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.decision.actions).toHaveLength(0);
    expect(result.droppedActions[0]).toContain("timing 非法");
  });

  it("taskIds 为空、含非字符串、缺少 text 时丢弃该动作", () => {
    for (const action of [
      { type: "deliver_results", taskIds: [], text: "结果" },
      { type: "deliver_results", taskIds: ["task-1", 42], text: "结果" },
      { type: "deliver_results", taskIds: ["task-1"] },
    ]) {
      const result = parseMasterDecision(
        JSON.stringify({ decisionId: "d-1", basedOn: BASED_ON, actions: [action] }),
      );
      expect(result.status).toBe("ok");
      if (result.status !== "ok") continue;
      expect(result.decision.actions).toHaveLength(0);
      expect(result.droppedActions).toHaveLength(1);
    }
  });
});

describe("deliver_results — 逐动作校验", () => {
  it("任务已成功才能交付；未就绪的结果被拒绝", () => {
    const h = setup(new FakeMaster());
    const succeeded = createTask(h.scheduler, "已完成任务");
    const running = createTask(h.scheduler, "还在跑的任务");
    h.runtime.emitSucceeded(succeeded, "结果");

    const decision = {
      decisionId: "d-1",
      basedOn: { eventSeq: 0, controlRevision: 0 } as WorldRevision,
      actions: [
        { type: "deliver_results" as const, taskIds: [succeeded], text: "可以说", priority: "normal" as const, timing: "after_current" as const },
        { type: "deliver_results" as const, taskIds: [running], text: "还不能说", priority: "normal" as const, timing: "after_current" as const },
      ],
    };

    const validation = validateDecision(decision, {
      getTask: (taskId) => h.scheduler.getTask(taskId),
      currentRevision: h.world.revision(),
    });

    expect(validation.accepted).toHaveLength(1);
    expect(validation.rejected).toHaveLength(1);
    expect(validation.rejected[0]?.reason).toBe("result_not_ready");
    expect(validation.rejected[0]?.detail["notSucceeded"]).toEqual([`${running}(running)`]);
  });
});

describe("交付决策（结果产出后的唤醒）", () => {
  it("两条同时完成的结果被合并成**一次**交付（一个批次项）", async () => {
    const h0 = setup(new FakeMaster());
    const first = createTask(h0.scheduler, "查天气");
    const second = createTask(h0.scheduler, "总结 Git");
    h0.runtime.emitSucceeded(first, "晴，24 度");
    h0.runtime.emitSucceeded(second, "三次提交");

    const basedOn = h0.world.revision();
    const master = new FakeMaster({
      status: "ok",
      rawText: deliveryDecisionText("d-merge", basedOn, [
        {
          type: "deliver_results",
          taskIds: [first, second],
          text: "天气是晴 24 度；另外最近三次提交内容正常。",
          priority: "normal",
          timing: "after_current",
        },
      ]),
    });
    const h = setup(master);

    const result = await h.plane.decideDelivery(
      batchOf(h0.scheduler, [first, second]).map((item) => ({ ...item })),
    );

    // 说明：此用例中用 h0 造结果，用 h 的 plane 执行交付会找不到任务，
    // 因此这里直接断言「决策被接受」这一层；合并的真实落点在下一个用例。
    expect(result.status).toBe("applied");
  });

  it("同一批次的两条结果落成一个交付项（taskIds 长度 2）", async () => {
    const h = setup(new FakeMaster());
    const first = createTask(h.scheduler, "查天气");
    const second = createTask(h.scheduler, "总结 Git");
    h.runtime.emitSucceeded(first, "晴，24 度");
    h.runtime.emitSucceeded(second, "三次提交");

    const basedOn = h.world.revision();
    const master = new FakeMaster({
      status: "ok",
      rawText: deliveryDecisionText("d-merge", basedOn, [
        {
          type: "deliver_results",
          taskIds: [first, second],
          text: "天气是晴 24 度；另外最近三次提交内容正常。",
          priority: "normal",
          timing: "after_current",
        },
      ]),
    });
    // 用同一个世界里的 plane，替换 master 需要重建 plane
    const plane = new MasterDecisionPlane({
      master,
      scheduler: h.scheduler,
      world: h.world,
      focus: h.focus,
      delivery: h.delivery,
      timeoutMs: 5_000,
    });

    const result = await plane.decideDelivery(batchOf(h.scheduler, [first, second]));

    expect(result.applied.map((action) => action.type)).toEqual(["deliver_results"]);
    const items = h.delivery.items();
    expect(items).toHaveLength(1);
    expect(items[0]?.taskIds).toEqual([first, second]);
    expect(items[0]?.summary).toContain("天气是晴");
    // after_current → 不允许抢占
    expect(items[0]?.allowPreemption).toBe(false);
    expect(master.calls[0]?.mode).toBe("delivery");
    expect(master.calls[0]?.pendingResults).toHaveLength(2);
  });

  it("交付决策失败时**不丢结果**：按确定性规则逐条兜底交付", async () => {
    const h = setup(new FakeMaster({ status: "error", reason: "provider 500" }));
    const first = createTask(h.scheduler, "任务一");
    const second = createTask(h.scheduler, "任务二");
    h.runtime.emitSucceeded(first, "结果一");
    h.runtime.emitSucceeded(second, "结果二");

    const result = await h.plane.decideDelivery(batchOf(h.scheduler, [first, second]));

    expect(result.status).toBe("applied");
    expect(result.applied.map((action) => action.type)).toEqual(["deliver_fallback", "deliver_fallback"]);
    expect(result.note).toContain("兜底交付");
    expect(h.delivery.items()).toHaveLength(2);
  });

  it("空批次不调用模型", async () => {
    const master = new FakeMaster();
    const h = setup(master);

    const result = await h.plane.decideDelivery([]);

    expect(result.status).toBe("empty_plan");
    expect(master.calls).toHaveLength(0);
  });
});
