import { describe, expect, it } from "vitest";

import { FakeWorkerRuntime } from "../../src/adapters/workers/fake-worker.ts";
import { TaskScheduler } from "../../src/application/scheduler/scheduler.ts";
import { maxTaskOrdinal } from "../../src/application/runtime.ts";

/**
 * 重启后 taskId 必须**继续递增**，不能从 1 重新开始。
 *
 * ## 为什么要专门为它写测试
 * 真实故障：M7 落库后跑重启流程时发现，调度器的序号是内存态，重启后回到 1，
 * 于是"显式重跑"产生的新任务复用了 `task-1`，而 `saveTask` 是按 task_id upsert 的 ——
 * **崩溃前那个已完成的 task-1 的结果被新任务覆盖掉了**（succeeded → running）。
 *
 * 这类缺陷不会抛错、不会阻塞流程，只会**静默销毁历史数据**，
 * 所以必须用测试锁住。
 */
describe("maxTaskOrdinal —— 从历史里续序号", () => {
  it("取最大数字后缀", () => {
    expect(maxTaskOrdinal([{ taskId: "task-1" }, { taskId: "task-7" }, { taskId: "task-3" }])).toBe(7);
  });

  it("按数值比较而不是字典序（task-10 > task-9）", () => {
    expect(maxTaskOrdinal([{ taskId: "task-9" }, { taskId: "task-10" }])).toBe(10);
  });

  it("空历史得到 0（新库从 task-1 开始）", () => {
    expect(maxTaskOrdinal([])).toBe(0);
  });

  it("不匹配的 id 被忽略（例如将来改用别的 id 形态）", () => {
    expect(maxTaskOrdinal([{ taskId: "ack-1" }, { taskId: "task-5" }, { taskId: "task-abc" }])).toBe(5);
  });
});

describe("TaskScheduler 的序号起始值", () => {
  it("默认从 1 开始", () => {
    const scheduler = new TaskScheduler({ runtime: new FakeWorkerRuntime(), maxConcurrent: 2 });
    const outcome = scheduler.createTask({ goal: "目标" });

    expect(outcome.status).not.toBe("rejected");
    if (outcome.status !== "rejected") expect(outcome.task.taskId).toBe("task-1");
    scheduler.dispose();
  });

  it("指定起始序号后从该值开始", () => {
    const scheduler = new TaskScheduler({
      runtime: new FakeWorkerRuntime(),
      maxConcurrent: 2,
      initialTaskOrdinal: 8,
    });
    const outcome = scheduler.createTask({ goal: "目标" });

    expect(outcome.status).not.toBe("rejected");
    if (outcome.status !== "rejected") expect(outcome.task.taskId).toBe("task-8");
    scheduler.dispose();
  });

  it("**回归**：重启后接着历史的序号，不会复用已存在的 taskId", () => {
    // 第一个"进程"：创建 3 个任务
    const first = new TaskScheduler({ runtime: new FakeWorkerRuntime(), maxConcurrent: 3 });
    for (const goal of ["甲", "乙", "丙"]) first.createTask({ goal });
    const persisted = ["task-1", "task-2", "task-3"].map((taskId) => ({ taskId }));
    first.dispose();

    // 第二个"进程"：模拟重启，序号从历史最大值续上
    const second = new TaskScheduler({
      runtime: new FakeWorkerRuntime(),
      maxConcurrent: 3,
      initialTaskOrdinal: maxTaskOrdinal(persisted) + 1,
    });
    const outcome = second.createTask({ goal: "重启后新建的目标" });

    expect(outcome.status).not.toBe("rejected");
    if (outcome.status !== "rejected") {
      expect(outcome.task.taskId).toBe("task-4");
      // 关键：不能和任何历史 id 撞上
      expect(persisted.some((item) => item.taskId === outcome.task.taskId)).toBe(false);
    }
    second.dispose();
  });
});
