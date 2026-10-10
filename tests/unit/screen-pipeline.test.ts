import { describe, expect, it } from "vitest";

import {
  blockChangeRatio,
  fingerprintToHex,
  hammingDistance,
  medianFingerprint,
} from "../../src/application/screen/fingerprint.ts";
import { ScreenChangeFilter } from "../../src/application/screen/screen-filter.ts";
import { ScreenSummaryBatcher } from "../../src/application/screen/screen-batcher.ts";
import { ScreenMemory } from "../../src/application/screen/screen-memory.ts";
import { evaluateScreenIntent } from "../../src/application/screen/screen-intent-gate.ts";
import type { ScreenFrame, ScreenSummary } from "../../src/application/screen/screen-port.ts";

const BLOCK_COUNT = 256;

function makeFrame(options: {
  fingerprint?: bigint;
  changedBlocks?: number;
  baseColor?: number;
  capturedAt?: number;
} = {}): ScreenFrame {
  const fingerprint = options.fingerprint ?? 0n;
  const base = options.baseColor ?? 0;
  const changed = options.changedBlocks ?? 0;
  const blockColors = Array.from({ length: BLOCK_COUNT }, (_unused, index) => {
    const value = index < changed ? 200 : base;
    return { r: value, g: value, b: value };
  });
  return {
    capturedAt: options.capturedAt ?? 0,
    width: 1920,
    height: 1080,
    fingerprint,
    fingerprintHex: fingerprintToHex(fingerprint),
    grayMedian: 128,
    blockColors,
    blockSize: 16,
  };
}

describe("64 位中值指纹", () => {
  it("以中值为阈值逐像素置位", () => {
    // 排序后 [10,20,30,40]，取 index 2 → 中值 30
    const { bits, median } = medianFingerprint([10, 20, 30, 40]);

    expect(median).toBe(30);
    // 只有 40 > 30 → 第 3 位置 1
    expect(bits).toBe(1n << 3n);
  });

  it("全等值输入得到 0（没有像素严格大于中值）", () => {
    const { bits } = medianFingerprint([5, 5, 5, 5]);

    expect(bits).toBe(0n);
  });

  it("整体变亮不改变指纹（中值法的稳健性）", () => {
    const base = [10, 20, 30, 40, 50, 60, 70, 80, 90];
    const brightened = base.map((value) => value + 40);

    expect(medianFingerprint(brightened).bits).toBe(medianFingerprint(base).bits);
  });

  it("空输入抛错而不是静默返回 0", () => {
    expect(() => medianFingerprint([])).toThrow(RangeError);
  });

  it("十六进制固定 16 位", () => {
    expect(fingerprintToHex(0n)).toHaveLength(16);
    expect(fingerprintToHex(0xffffffffffffffffn)).toHaveLength(16);
  });
});

describe("汉明距离与色块变化", () => {
  it("汉明距离是不同位的个数", () => {
    expect(hammingDistance(0n, 0n)).toBe(0);
    expect(hammingDistance(0b1111n, 0b0000n)).toBe(4);
    // 1010 XOR 0011 = 1001 → 2 位不同
    expect(hammingDistance(0b1010n, 0b0011n)).toBe(2);
    // 与自身比较恒为 0
    expect(hammingDistance(0xffffffffffffffffn, 0xffffffffffffffffn)).toBe(0);
  });

  it("色块变化比例是「变化超阈值」的色块占比", () => {
    const previous = makeFrame({ baseColor: 0 });
    const current = makeFrame({ baseColor: 0, changedBlocks: 64 });

    expect(blockChangeRatio(previous, current)).toBeCloseTo(64 / BLOCK_COUNT, 5);
  });

  it("色块差异刚好等于阈值不算变化（严格大于）", () => {
    const previous = makeFrame({ baseColor: 0 });
    const current = makeFrame({ baseColor: 30 });

    expect(blockChangeRatio(previous, current, 30)).toBe(0);
  });
});

describe("ScreenChangeFilter —— 双条件 AND + 5s 节流", () => {
  it("首帧总是采纳，作为变化基线", () => {
    const filter = new ScreenChangeFilter();
    const decision = filter.admit(makeFrame(), 1_000);

    expect(decision.keep).toBe(true);
    expect(decision.reasons.join("")).toContain("基线");
  });

  it("双条件都成立才采纳（指纹变 8 位 + 色块变 30%）", () => {
    const filter = new ScreenChangeFilter();
    filter.admit(makeFrame({ fingerprint: 0n, baseColor: 0 }), 0);

    const decision = filter.admit(
      makeFrame({ fingerprint: 0b11111111n, baseColor: 0, changedBlocks: 77 }),
      10_000,
    );

    expect(decision.keep).toBe(true);
    expect(decision.hammingDistance).toBe(8);
    expect(decision.blockChangeRatio).toBeCloseTo(77 / 256, 3);
  });

  it("只有指纹变（疑似光标闪烁/时钟跳秒）→ 拒绝", () => {
    const filter = new ScreenChangeFilter();
    filter.admit(makeFrame({ fingerprint: 0n, baseColor: 0 }), 0);

    const decision = filter.admit(makeFrame({ fingerprint: 0b11111111n, baseColor: 0 }), 10_000);

    expect(decision.keep).toBe(false);
    expect(decision.reasons.join("")).toContain("色块变化不足");
  });

  it("只有色块变（疑似整体渐变）→ 拒绝", () => {
    const filter = new ScreenChangeFilter();
    filter.admit(makeFrame({ fingerprint: 0n, baseColor: 0 }), 0);

    const decision = filter.admit(
      makeFrame({ fingerprint: 0n, baseColor: 0, changedBlocks: 200 }),
      10_000,
    );

    expect(decision.keep).toBe(false);
    expect(decision.reasons.join("")).toContain("指纹变化不足");
  });

  it("5s 内即使双条件成立也被节流拒绝", () => {
    const filter = new ScreenChangeFilter();
    filter.admit(makeFrame({ fingerprint: 0n, baseColor: 0 }), 0);

    const decision = filter.admit(
      makeFrame({ fingerprint: 0xffffffffffffffffn, baseColor: 0, changedBlocks: 256 }),
      3_000,
    );

    expect(decision.keep).toBe(false);
    expect(decision.throttled).toBe(true);
  });

  it("基线取「上次采纳的帧」，所以缓慢变化会累积后触发", () => {
    const filter = new ScreenChangeFilter();
    filter.admit(makeFrame({ fingerprint: 0n, baseColor: 0 }), 0);

    // 第一次：指纹只变 4 位 → 拒绝，基线不变
    filter.admit(makeFrame({ fingerprint: 0b1111n, baseColor: 0, changedBlocks: 0 }), 10_000);
    // 第二次：与**原始基线**比已变 8 位 → 采纳
    const decision = filter.admit(
      makeFrame({ fingerprint: 0b11111111n, baseColor: 0, changedBlocks: 77 }),
      20_000,
    );

    expect(decision.keep).toBe(true);
    expect(decision.hammingDistance).toBe(8);
  });
});

describe("ScreenSummaryBatcher —— 3 帧或 5 分钟", () => {
  it("攒满 3 帧立刻出批（不必等到 5 分钟）", () => {
    const batcher = new ScreenSummaryBatcher();

    expect(batcher.add(makeFrame(), 0)).toBeNull();
    expect(batcher.add(makeFrame(), 1_000)).toBeNull();
    const batch = batcher.add(makeFrame(), 2_000);

    expect(batch).toHaveLength(3);
    expect(batcher.pendingCount()).toBe(0);
  });

  it("不足 3 帧但到达 5 分钟窗口也出批（避免上下文过时）", () => {
    const batcher = new ScreenSummaryBatcher();
    batcher.add(makeFrame(), 0);
    batcher.add(makeFrame(), 1_000);

    expect(batcher.add(makeFrame(), 300_000)).toHaveLength(3);
  });

  it("窗口内不足批时返回 null", () => {
    const batcher = new ScreenSummaryBatcher();
    batcher.add(makeFrame(), 0);

    expect(batcher.add(makeFrame(), 4_000)).toBeNull();
    expect(batcher.pendingCount()).toBe(2);
  });

  it("reset 会丢弃未满批的帧（关闭观察时不做摘要）", () => {
    const batcher = new ScreenSummaryBatcher();
    batcher.add(makeFrame(), 0);
    batcher.add(makeFrame(), 1_000);

    batcher.reset();

    expect(batcher.pendingCount()).toBe(0);
    expect(batcher.ageMs(5_000)).toBe(0);
  });
});

describe("ScreenMemory —— 10 分钟滑动窗口", () => {
  function summary(text: string, at: number): ScreenSummary {
    return { text, at, frameCount: 3, fromModel: false };
  }

  it("窗口内的摘要保留，过期的淘汰", () => {
    const memory = new ScreenMemory();
    memory.append(summary("五分钟前看了需求文档", 0), 0);
    memory.append(summary("刚才在写代码", 400_000), 400_000);

    const recent = memory.recent(500_000);

    expect(recent).toHaveLength(2);
    // 600s 窗口：t=0 的那条在 now=700_000 时过期
    expect(memory.recent(700_000)).toHaveLength(1);
  });

  it("有界：条数超过上限时只保留最近的那些", () => {
    const memory = new ScreenMemory({ maxEntries: 3 });
    for (let index = 0; index < 6; index += 1) {
      memory.append(summary(`摘要${String(index)}`, index * 1_000), index * 1_000);
    }

    const texts = memory.recent(6_000).map((entry) => entry.text);
    expect(texts).toEqual(["摘要3", "摘要4", "摘要5"]);
  });

  it("给 Master 的视图只有文本、没有帧", () => {
    const memory = new ScreenMemory();
    memory.append(summary("看到了一个报错弹窗", 1_000), 1_000);

    const view = memory.view(2_000);

    expect(view.count).toBe(1);
    expect(view.summaries).toEqual(["看到了一个报错弹窗"]);
    expect(view.oldestAt).toBe(1_000);
  });

  it("clear 清空（关闭屏幕观察时应当调用）", () => {
    const memory = new ScreenMemory();
    memory.append(summary("内容", 0), 0);

    memory.clear();

    expect(memory.size()).toBe(0);
  });
});

describe("屏幕意图门控 —— 纯文字指令零成本", () => {
  it("屏幕指代词命中时注入", () => {
    const decision = evaluateScreenIntent("屏幕上这个报错是什么意思");

    expect(decision.include).toBe(true);
    expect(decision.matched.length).toBeGreaterThan(0);
  });

  it("纯文字指令不注入（零 token 成本）", () => {
    const decision = evaluateScreenIntent("帮我写一个快速排序函数");

    expect(decision.include).toBe(false);
    expect(decision.matched).toEqual([]);
    expect(decision.reason).toContain("零 token");
  });

  it("可用 alwaysInclude 关闭门控（调试或明确需要时）", () => {
    const decision = evaluateScreenIntent("写个函数", { alwaysInclude: true });

    expect(decision.include).toBe(true);
    expect(decision.reason).toContain("总是注入");
  });

  it("关键词表可配置（便于按真实数据调整）", () => {
    const decision = evaluateScreenIntent("看一下那个东西", { referenceWords: ["那个东西"] });

    expect(decision.include).toBe(true);
    expect(decision.matched).toEqual(["那个东西"]);
  });
});
