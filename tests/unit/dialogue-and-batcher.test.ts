import { describe, expect, it } from "vitest";

import { DialogueHistory } from "../../src/application/interaction/dialogue-history.ts";
import {
  DEFAULT_DELIVERY_MAX_WINDOW_MS,
  DEFAULT_DELIVERY_WINDOW_MS,
  DeliveryBatcher,
  type PendingResult,
} from "../../src/application/delivery/delivery-batcher.ts";

/** 手动定时器：记录每次请求的延时，便于断言「硬上限」是否生效。 */
function manualScheduler() {
  let queue: Array<{ fn: () => void; ms: number }> = [];
  return {
    schedule: (fn: () => void, ms: number): (() => void) => {
      const entry = { fn, ms };
      queue.push(entry);
      return () => {
        queue = queue.filter((candidate) => candidate !== entry);
      };
    },
    runNext: (): void => {
      const entry = queue.shift();
      entry?.fn();
    },
    delays: (): number[] => queue.map((entry) => entry.ms),
    pendingCount: (): number => queue.length,
  };
}

function result(taskId: string, priority: PendingResult["priority"] = "normal"): PendingResult {
  return {
    taskId,
    fullSummary: `${taskId} 的完整结果`,
    spokenSummary: `${taskId} 的口语稿`,
    priority,
    at: 0,
  };
}

describe("DialogueHistory — 有界对话历史（M5 首版）", () => {
  it("按顺序记录用户与系统条目", () => {
    let now = 1_000;
    const history = new DialogueHistory({ now: () => now });
    history.appendUserTurn("查天气");
    now += 10;
    history.appendSystem("决策 d-1：创建任务 task-1");
    now += 10;
    history.appendUserTurn("取消吧");

    const entries = history.recent();
    expect(entries.map((entry) => entry.role)).toEqual(["user", "system", "user"]);
    expect(entries[0]?.text).toBe("查天气");
    expect(entries[2]?.text).toBe("取消吧");
    expect(entries[1]?.at).toBe(1_010);
  });

  it("超过上限时丢弃最旧的（保持有界，不让上下文无界增长）", () => {
    const history = new DialogueHistory({ maxEntries: 3 });
    for (let index = 1; index <= 5; index += 1) history.appendUserTurn(`第 ${index} 句`);

    expect(history.size).toBe(3);
    expect(history.recent().map((entry) => entry.text)).toEqual(["第 3 句", "第 4 句", "第 5 句"]);
  });

  it("recent(limit) 取最近若干条，保持时间正序", () => {
    const history = new DialogueHistory({ maxEntries: 10 });
    for (let index = 1; index <= 5; index += 1) history.appendUserTurn(`第 ${index} 句`);

    expect(history.recent(2).map((entry) => entry.text)).toEqual(["第 4 句", "第 5 句"]);
  });

  it("非法上限构造即失败", () => {
    expect(() => new DialogueHistory({ maxEntries: 0 })).toThrow(RangeError);
  });

  it("clear 会清空（用于会话重置）", () => {
    const history = new DialogueHistory();
    history.appendUserTurn("一");
    history.clear();

    expect(history.size).toBe(0);
    expect(history.recent()).toEqual([]);
  });
});

describe("DeliveryBatcher — 合并窗口（已确认：1.2s 窗口 / 3s 上限）", () => {
  function setup(options: { windowMs?: number; maxWindowMs?: number; maxBatchSize?: number } = {}) {
    const scheduler = manualScheduler();
    const flushes: PendingResult[][] = [];
    let now = 0;
    const batcher = new DeliveryBatcher({
      onFlush: (batch) => flushes.push([...batch]),
      schedule: scheduler.schedule,
      now: () => now,
      ...(options.windowMs === undefined ? {} : { windowMs: options.windowMs }),
      ...(options.maxWindowMs === undefined ? {} : { maxWindowMs: options.maxWindowMs }),
      ...(options.maxBatchSize === undefined ? {} : { maxBatchSize: options.maxBatchSize }),
    });
    return {
      batcher,
      scheduler,
      flushes,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("默认参数就是已确认的 1.2s 窗口 / 3s 上限", () => {
    const { scheduler, batcher } = setup();
    batcher.add(result("task-1"));

    expect(DEFAULT_DELIVERY_WINDOW_MS).toBe(1_200);
    expect(DEFAULT_DELIVERY_MAX_WINDOW_MS).toBe(3_000);
    expect(scheduler.delays()).toEqual([1_200]);
  });

  it("单个结果在窗口到期后冲批（批次含 1 条）", () => {
    const { batcher, scheduler, flushes } = setup();
    batcher.add(result("task-1"));

    expect(flushes).toEqual([]);
    scheduler.runNext();

    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.map((item) => item.taskId)).toEqual(["task-1"]);
  });

  it("窗口内到达的两个结果合并成**一次**冲批（这就是「合为一次回答」的基础）", () => {
    const { batcher, scheduler, flushes, advance } = setup();

    batcher.add(result("task-1"));
    advance(300);
    batcher.add(result("task-2")); // 窗口内 → 重置计时
    advance(300);
    batcher.add(result("task-3"));

    expect(flushes).toEqual([]);
    scheduler.runNext();

    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.map((item) => item.taskId)).toEqual(["task-1", "task-2", "task-3"]);
  });

  it("结果持续到来时受 3s 硬上限夹住，不会无限等待", () => {
    const { batcher, scheduler, advance } = setup();

    batcher.add(result("task-1"));
    expect(scheduler.delays()).toEqual([1_200]);

    advance(2_000);
    batcher.add(result("task-2"));
    // 距批次开始已过 2000ms，只剩 1000ms
    expect(scheduler.delays()).toEqual([1_000]);

    advance(900);
    batcher.add(result("task-3"));
    // 只剩 100ms，窗口再长也不能超过硬上限
    expect(scheduler.delays()).toEqual([100]);
  });

  it("批次达到上限时立即冲批，不等窗口", () => {
    const { batcher, flushes } = setup({ maxBatchSize: 3 });

    batcher.add(result("task-1"));
    batcher.add(result("task-2"));
    expect(flushes).toEqual([]);
    batcher.add(result("task-3"));

    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toHaveLength(3);
  });

  it("flushNow 立即冲批（命中「可能需要打断用户」时用）", () => {
    const { batcher, flushes, scheduler } = setup();
    batcher.add(result("task-1", "urgent"));

    batcher.flushNow("urgent_hint");

    expect(flushes).toHaveLength(1);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("空批次不会产生冲批，dispose 后不再冲批", () => {
    const { batcher, flushes, scheduler } = setup();

    scheduler.runNext();
    expect(flushes).toEqual([]);

    batcher.add(result("task-1"));
    batcher.dispose();
    scheduler.runNext();
    expect(flushes).toEqual([]);
    expect(batcher.pendingResults()).toEqual([]);
  });
});
