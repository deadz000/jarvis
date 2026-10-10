import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_LIVE_TEXT_CHARS,
  DEFAULT_TRANSCRIPT_FLUSH_MS,
  TranscriptCoalescer,
} from "../../src/application/workers/transcript-coalescer.ts";

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

function setup() {
  const scheduler = manualScheduler();
  const flushes: Array<ReadonlyMap<string, string>> = [];
  const coalescer = new TranscriptCoalescer({
    onFlush: (texts) => flushes.push(texts),
    schedule: scheduler.schedule,
  });
  return { scheduler, coalescer, flushes };
}

describe("TranscriptCoalescer — 高频文本增量的节流", () => {
  it("默认合并窗口 150ms（人眼已分辨不出，但避开逐 token 推送）", () => {
    const { scheduler, coalescer } = setup();
    coalescer.push("task-1", "你");

    expect(DEFAULT_TRANSCRIPT_FLUSH_MS).toBe(150);
    expect(scheduler.delays()).toEqual([150]);
  });

  it("窗口内的多个增量合并成一次刷新（这就是「实时但不风暴」）", () => {
    const { scheduler, coalescer, flushes } = setup();

    coalescer.push("task-1", "你");
    coalescer.push("task-1", "好");
    coalescer.push("task-1", "，世界");

    // 还没有到窗口，不刷新
    expect(flushes).toEqual([]);
    expect(scheduler.delays()).toEqual([150]); // 只挂了一个定时器，不重复挂

    scheduler.runNext();

    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.get("task-1")).toBe("你好，世界");
  });

  it("不同任务的增量互不干扰", () => {
    const { scheduler, coalescer, flushes } = setup();

    coalescer.push("task-1", "A");
    coalescer.push("task-2", "B");
    scheduler.runNext();

    expect(flushes[0]?.get("task-1")).toBe("A");
    expect(flushes[0]?.get("task-2")).toBe("B");
  });

  it("刷新之后可以再次累积（窗口会重新挂起）", () => {
    const { scheduler, coalescer, flushes } = setup();

    coalescer.push("task-1", "第一段");
    scheduler.runNext();
    coalescer.push("task-1", "第二段");
    scheduler.runNext();

    expect(flushes).toHaveLength(2);
    expect(flushes[0]?.get("task-1")).toBe("第一段");
    expect(flushes[1]?.get("task-1")).toBe("第一段第二段");
  });

  it("单个任务的缓冲有上限，只保留尾部（界面状态不无界增长）", () => {
    const { scheduler, coalescer } = setup();

    for (let index = 0; index < 200; index += 1) coalescer.push("task-1", "0123456789");
    scheduler.runNext();

    const text = coalescer.textFor("task-1") ?? "";
    expect(text.length).toBeLessThanOrEqual(DEFAULT_MAX_LIVE_TEXT_CHARS);
    // 保留的是尾部
    expect(text.endsWith("0123456789")).toBe(true);
  });

  it("空增量不触发刷新", () => {
    const { scheduler, coalescer, flushes } = setup();

    coalescer.push("task-1", "");
    scheduler.runNext();

    expect(flushes).toEqual([]);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("flushNow 立即刷新（任务结束时确保不丢最后一段）", () => {
    const { coalescer, flushes } = setup();
    coalescer.push("task-1", "最后一段");

    coalescer.flushNow();

    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.get("task-1")).toBe("最后一段");
  });

  it("clear 清掉某任务的实时缓冲（终态后由正式结果呈现）", () => {
    const { coalescer } = setup();
    coalescer.push("task-1", "进行中");

    coalescer.clear("task-1");

    expect(coalescer.textFor("task-1")).toBeUndefined();
  });

  it("dispose 后不再刷新", () => {
    const { scheduler, coalescer, flushes } = setup();
    coalescer.push("task-1", "内容");

    coalescer.dispose();
    scheduler.runNext();

    expect(flushes).toEqual([]);
  });
});
