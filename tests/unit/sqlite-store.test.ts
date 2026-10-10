import { describe, expect, it } from "vitest";

import { SqliteStore } from "../../src/adapters/sqlite/sqlite-store.ts";
import type {
  PersistedDecision,
  PersistedTask,
} from "../../src/application/storage/store-port.ts";

function task(overrides: Partial<PersistedTask> = {}): PersistedTask {
  return {
    taskId: "task-1",
    goal: "检查 src 目录",
    state: "succeeded",
    runGeneration: 1,
    priority: "normal",
    createdAt: 1_000,
    startedAt: 1_100,
    terminalAt: 5_000,
    lastActivityAt: 5_000,
    resultSummary: "共 42 个文件",
    spokenSummary: "src 目录下有四十二个文件。",
    failureReason: null,
    cancelReason: null,
    decisionId: "d-1",
    idempotencyKey: "d-1:start:0",
    recoveryStatus: null,
    recoveredAt: null,
    recoveryNote: null,
    replayedAt: null,
    replayTaskId: null,
    ...overrides,
  };
}

function decision(overrides: Partial<PersistedDecision> = {}): PersistedDecision {
  return {
    decisionId: "d-1",
    mode: "intent",
    status: "applied",
    at: 1_000,
    elapsedMs: 2_500,
    applied: ["start_task task-1"],
    rejected: [],
    dropped: [],
    note: null,
    eventSeq: 1,
    controlRevision: 2,
    ...overrides,
  };
}

function setup() {
  // 内存库：确定性、不落盘
  return new SqliteStore({ path: ":memory:" });
}

describe("SqliteStore —— 任务持久化与查询", () => {
  it("任务写入后可完整读回（含结果与口语稿）", () => {
    const store = setup();
    store.saveTask(task());

    const loaded = store.getTask("task-1");

    expect(loaded?.goal).toBe("检查 src 目录");
    expect(loaded?.state).toBe("succeeded");
    expect(loaded?.resultSummary).toBe("共 42 个文件");
    expect(loaded?.spokenSummary).toBe("src 目录下有四十二个文件。");
    expect(loaded?.idempotencyKey).toBe("d-1:start:0");
    store.close();
  });

  it("同一任务重复写入是 upsert（状态原地更新，不产生重复行）", () => {
    const store = setup();
    store.saveTask(task({ state: "running", terminalAt: null, resultSummary: null }));
    store.saveTask(task({ state: "succeeded" }));

    const all = store.listTasks();
    expect(all).toHaveLength(1);
    expect(all[0]?.state).toBe("succeeded");
    expect(all[0]?.resultSummary).toBe("共 42 个文件");
    store.close();
  });

  it("历史任务可按状态查询，并按创建时间倒序", () => {
    const store = setup();
    store.saveTask(task({ taskId: "task-1", createdAt: 1_000 }));
    store.saveTask(task({ taskId: "task-2", createdAt: 2_000, state: "failed", idempotencyKey: "k2" }));
    store.saveTask(task({ taskId: "task-3", createdAt: 3_000, state: "running", idempotencyKey: "k3" }));

    expect(store.listTasks().map((item) => item.taskId)).toEqual(["task-3", "task-2", "task-1"]);
    expect(store.listTasks({ states: ["failed"] }).map((item) => item.taskId)).toEqual(["task-2"]);
    expect(store.listTasks({ limit: 2 })).toHaveLength(2);
    store.close();
  });

  it("任务事件可按顺序读回（用于重建时间线）", () => {
    const store = setup();
    store.saveTask(task());
    store.appendTaskEvent({ taskId: "task-1", type: "task_created", state: "queued", at: 1_000, runGeneration: 1, detail: null });
    store.appendTaskEvent({ taskId: "task-1", type: "task_started", state: "running", at: 1_100, runGeneration: 1, detail: null });
    store.appendTaskEvent({ taskId: "task-1", type: "task_succeeded", state: "succeeded", at: 5_000, runGeneration: 1, detail: "共 42 个文件" });

    const events = store.listTaskEvents("task-1");

    expect(events.map((event) => event.type)).toEqual(["task_created", "task_started", "task_succeeded"]);
    store.close();
  });

  it("决策轨迹可读回，且保留被拒/被丢弃动作（便于复盘）", () => {
    const store = setup();
    store.saveDecision(
      decision({ rejected: ["cancel_task 任务已完成"], dropped: ["deliver_results 缺少 text"] }),
    );

    const loaded = store.listDecisions()[0];

    expect(loaded?.decisionId).toBe("d-1");
    expect(loaded?.applied).toEqual(["start_task task-1"]);
    expect(loaded?.rejected).toEqual(["cancel_task 任务已完成"]);
    expect(loaded?.dropped).toEqual(["deliver_results 缺少 text"]);
    expect(loaded?.elapsedMs).toBe(2_500);
    store.close();
  });
});

describe("SqliteStore —— 重启恢复（M7 退出条件）", () => {
  it("列出未终结任务：running / cancel_requested / queued 都算，终结的不算", () => {
    const store = setup();
    store.saveTask(task({ taskId: "task-1", state: "succeeded", idempotencyKey: "k1" }));
    store.saveTask(task({ taskId: "task-2", state: "running", terminalAt: null, idempotencyKey: "k2" }));
    store.saveTask(task({ taskId: "task-3", state: "cancel_requested", terminalAt: null, idempotencyKey: "k3" }));
    store.saveTask(task({ taskId: "task-4", state: "queued", terminalAt: null, idempotencyKey: "k4" }));

    const pending = store.findNonTerminalTasks();

    expect(pending.map((item) => item.taskId).sort()).toEqual(["task-2", "task-3", "task-4"]);
    store.close();
  });

  it("**只标记不重跑**：未终结任务被标为未知，且不会凭空产生新任务", () => {
    const store = setup();
    store.saveTask(task({ taskId: "task-2", state: "running", terminalAt: null, idempotencyKey: "k2" }));

    const marked = store.markInterruptedAsUnknown(10_000, "进程重启时该任务未终结，真实结果未知");

    expect(marked).toBe(1);
    const loaded = store.getTask("task-2");
    expect(loaded?.recoveryStatus).toBe("unknown");
    expect(loaded?.recoveredAt).toBe(10_000);
    expect(loaded?.recoveryNote).toContain("真实结果未知");
    // 关键安全断言：状态没被改成 succeeded/failed，也没有任何自动重跑产生的新任务
    expect(loaded?.state).toBe("running");
    expect(store.listTasks()).toHaveLength(1);
    store.close();
  });

  it("已终结的任务不受标记影响", () => {
    const store = setup();
    store.saveTask(task({ taskId: "task-1", state: "succeeded", idempotencyKey: "k1" }));

    expect(store.markInterruptedAsUnknown(10_000, "note")).toBe(0);
    expect(store.getTask("task-1")?.recoveryStatus).toBeNull();
    store.close();
  });

  it("重复标记是幂等的（第二次返回 0）", () => {
    const store = setup();
    store.saveTask(task({ taskId: "task-2", state: "running", terminalAt: null, idempotencyKey: "k2" }));

    expect(store.markInterruptedAsUnknown(10_000, "first")).toBe(1);
    expect(store.markInterruptedAsUnknown(20_000, "second")).toBe(0);
    // 首次的说明不会被覆盖
    expect(store.getTask("task-2")?.recoveryNote).toBe("first");
    store.close();
  });

  it("显式重放会记录来源任务与新任务的关联（供追溯）", () => {
    const store = setup();
    store.saveTask(task({ taskId: "task-2", state: "running", terminalAt: null, idempotencyKey: "k2" }));
    store.markInterruptedAsUnknown(10_000, "note");

    store.markReplayed("task-2", "task-9", 20_000);

    const loaded = store.getTask("task-2");
    expect(loaded?.replayedAt).toBe(20_000);
    expect(loaded?.replayTaskId).toBe("task-9");
    // 仍标记为未知 —— 重放不代表原任务有了结果
    expect(loaded?.recoveryStatus).toBe("unknown");
    store.close();
  });

  it("可按「恢复维度非空」筛选出待核对的任务", () => {
    const store = setup();
    store.saveTask(task({ taskId: "task-1", state: "succeeded", idempotencyKey: "k1" }));
    store.saveTask(task({ taskId: "task-2", state: "running", terminalAt: null, idempotencyKey: "k2" }));
    store.markInterruptedAsUnknown(10_000, "note");

    const unknown = store.listTasks({ onlyUnknownRecovery: true });

    expect(unknown.map((item) => item.taskId)).toEqual(["task-2"]);
    store.close();
  });
});

describe("SqliteStore —— 语义记忆与数据保留", () => {
  it("记忆条目带可追溯来源（SRS 要求不能无来源断言）", () => {
    const store = setup();
    store.appendMemory({ kind: "task", text: "用户让我查了 src 目录", at: 1_000, sourceRef: "task:task-1", expiresAt: null });
    store.appendMemory({ kind: "screen", text: "屏幕上是代码编辑器", at: 2_000, sourceRef: "screen:summary-1", expiresAt: null });

    const memory = store.queryMemory({ limit: 10 });

    expect(memory).toHaveLength(2);
    expect(memory[0]?.kind).toBe("screen"); // 按时间倒序
    expect(memory[0]?.sourceRef).toBe("screen:summary-1");
    store.close();
  });

  it("记忆可按类型与时间过滤", () => {
    const store = setup();
    store.appendMemory({ kind: "task", text: "A", at: 1_000, sourceRef: null, expiresAt: null });
    store.appendMemory({ kind: "screen", text: "B", at: 2_000, sourceRef: null, expiresAt: null });
    store.appendMemory({ kind: "screen", text: "C", at: 3_000, sourceRef: null, expiresAt: null });

    expect(store.queryMemory({ kind: "screen" })).toHaveLength(2);
    expect(store.queryMemory({ since: 2_500 }).map((entry) => entry.text)).toEqual(["C"]);
    store.close();
  });

  it("pruneMemory 按时间删除旧记忆", () => {
    const store = setup();
    store.appendMemory({ kind: "note", text: "旧", at: 1_000, sourceRef: null, expiresAt: null });
    store.appendMemory({ kind: "note", text: "新", at: 9_000, sourceRef: null, expiresAt: null });

    expect(store.pruneMemory(5_000)).toBe(1);
    expect(store.queryMemory().map((entry) => entry.text)).toEqual(["新"]);
    store.close();
  });

  it("pruneTasks 只删已终结的旧任务，未终结的保留（否则会丢掉待核对的线索）", () => {
    const store = setup();
    store.saveTask(task({ taskId: "task-1", state: "succeeded", terminalAt: 1_000, idempotencyKey: "k1" }));
    store.saveTask(task({ taskId: "task-2", state: "running", terminalAt: null, createdAt: 1_000, idempotencyKey: "k2" }));

    expect(store.pruneTasks(5_000)).toBe(1);
    expect(store.listTasks().map((item) => item.taskId)).toEqual(["task-2"]);
    store.close();
  });

  it("pruneTasks 会连带删除该任务的事件（不留孤儿）", () => {
    const store = setup();
    store.saveTask(task({ taskId: "task-1", state: "succeeded", terminalAt: 1_000, idempotencyKey: "k1" }));
    store.appendTaskEvent({ taskId: "task-1", type: "task_succeeded", state: "succeeded", at: 1_000, runGeneration: 1, detail: null });

    store.pruneTasks(5_000);

    expect(store.listTaskEvents("task-1")).toEqual([]);
    store.close();
  });
});
