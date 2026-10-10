import { describe, expect, it } from "vitest";

import { ScreenMemory } from "../../src/application/screen/screen-memory.ts";
import { ScreenObserver, type ScreenObserverEvent } from "../../src/application/screen/screen-observer.ts";
import { deterministicScreenSummary } from "../../src/application/screen/deterministic-summary.ts";
import type {
  PersistedFrameRef,
  ScreenCapturePort,
  ScreenFrame,
  ScreenFrameStorePort,
  ScreenImage,
  ScreenImagePort,
  ScreenSummarizeInput,
  ScreenSummarizerPort,
  ScreenSummary,
} from "../../src/application/screen/screen-port.ts";

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
    width: 1_920,
    height: 1_080,
    fingerprint,
    fingerprintHex: fingerprint.toString(16).padStart(16, "0"),
    grayMedian: 128,
    blockColors,
    blockSize: 16,
  };
}

class ScriptedCapture implements ScreenCapturePort {
  public readonly frames: ScreenFrame[] = [];
  public error: string | undefined;
  private index = 0;

  public constructor(frames: ScreenFrame[]) {
    this.frames = frames;
  }

  public capture(): Promise<ScreenFrame> {
    if (this.error !== undefined) return Promise.reject(new Error(this.error));
    const frame = this.frames[Math.min(this.index, this.frames.length - 1)];
    this.index += 1;
    if (frame === undefined) return Promise.reject(new Error("没有可用的帧"));
    return Promise.resolve(frame);
  }

  public isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class FakeImage implements ScreenImagePort {
  public fails = false;
  public calls = 0;

  public captureImage(): Promise<ScreenImage> {
    this.calls += 1;
    if (this.fails) return Promise.reject(new Error("图像探针失败"));
    return Promise.resolve({ jpegBase64: "AAAA", width: 1_024, height: 576, capturedAt: this.calls, byteLength: 4 });
  }
}

/** 内存版帧存储：记录落盘/删除调用，验证"帧只短暂存在"。 */
class FakeFrameStore implements ScreenFrameStorePort {
  public readonly saved: PersistedFrameRef[] = [];
  public readonly deleted: PersistedFrameRef[] = [];
  public cleanupCalls = 0;
  public readFails = false;
  public saveFails = false;
  private counter = 0;

  public save(image: ScreenImage): Promise<PersistedFrameRef> {
    if (this.saveFails) return Promise.reject(new Error("落盘失败"));
    this.counter += 1;
    const ref: PersistedFrameRef = {
      path: `/fake/frame-${String(this.counter)}.jpg`,
      width: image.width,
      height: image.height,
      byteLength: image.byteLength,
      capturedAt: image.capturedAt,
    };
    this.saved.push(ref);
    return Promise.resolve(ref);
  }

  public read(ref: PersistedFrameRef): Promise<ScreenImage> {
    if (this.readFails) return Promise.reject(new Error("读失败"));
    return Promise.resolve({
      jpegBase64: "BBBB",
      width: ref.width,
      height: ref.height,
      capturedAt: ref.capturedAt,
      byteLength: ref.byteLength,
    });
  }

  public remove(refs: readonly PersistedFrameRef[]): Promise<number> {
    this.deleted.push(...refs);
    return Promise.resolve(refs.length);
  }

  public cleanupOrphans(): Promise<number> {
    this.cleanupCalls += 1;
    return Promise.resolve(0);
  }

  public pendingCount(): Promise<number> {
    return Promise.resolve(this.saved.length - this.deleted.length);
  }
}

/** 让 fire-and-forget 的异步删除跑完。 */
async function settle(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

class RecordingSummarizer implements ScreenSummarizerPort {
  public readonly calls: ScreenSummarizeInput[] = [];
  public text = "用户在查看文档";

  public summarize(input: ScreenSummarizeInput): Promise<ScreenSummary> {
    this.calls.push(input);
    return Promise.resolve({
      text: this.text,
      at: 1_000,
      frameCount: input.frames.length,
      fromModel: true,
    });
  }
}

function setup(options: { frames: ScreenFrame[]; imageFails?: boolean; summarizerText?: string }) {
  const capture = new ScriptedCapture(options.frames);
  const image = new FakeImage();
  if (options.imageFails === true) image.fails = true;
  const frameStore = new FakeFrameStore();
  const summarizer = new RecordingSummarizer();
  if (options.summarizerText !== undefined) summarizer.text = options.summarizerText;
  const memory = new ScreenMemory();
  const events: ScreenObserverEvent[] = [];

  let currentTime = 0;
  const observer = new ScreenObserver({
    capture,
    image,
    frameStore,
    summarizer,
    memory,
    now: () => currentTime,
    onEvent: (event) => events.push(event),
  });

  return {
    observer,
    capture,
    image,
    frameStore,
    summarizer,
    memory,
    events,
    setTime: (value: number) => {
      currentTime = value;
    },
  };
}

/**
 * 一帧双条件都成立的变化（指纹差 8 位 + 色块变化 ≥25%）。
 *
 * 注意：**每次变化必须相对上一次采纳的帧**都成立 ——
 * 滤波器会把被采纳的帧变成新基线，所以连续几帧不能彼此相同
 * （否则第二帧之后与基线无差异，会被正确拒绝）。
 */
const CHANGE_STEPS = [
  { fingerprint: 0xffn, changedBlocks: 77 },
  { fingerprint: 0xffffn, changedBlocks: 150 },
  { fingerprint: 0xffffffn, changedBlocks: 220 },
] as const;

function changedFrame(step: number, capturedAt: number): ScreenFrame {
  const config = CHANGE_STEPS[step - 1] ?? CHANGE_STEPS[0];
  return makeFrame({
    fingerprint: config.fingerprint,
    baseColor: 0,
    changedBlocks: config.changedBlocks,
    capturedAt,
  });
}

describe("ScreenObserver —— 常驻观察循环", () => {
  it("首帧建立基线并进入攒批，未满 3 帧不出批（但已落盘）", async () => {
    const h = setup({ frames: [makeFrame({ capturedAt: 0 })] });
    await h.observer.pollOnce();

    expect(h.observer.pendingFrames()).toBe(1);
    expect(h.summarizer.calls).toHaveLength(0);
    // 新设计：判定有效即物化并落盘（不再等出批）
    expect(h.image.calls).toBe(1);
    expect(h.frameStore.saved).toHaveLength(1);
  });

  it("攒满 3 帧后把**整批多张图**交给摘要，然后删除这些帧", async () => {
    const h = setup({ frames: [makeFrame({ capturedAt: 0 })] });
    await h.observer.pollOnce(); // 首帧 → 基线

    h.capture.frames.push(changedFrame(1, 10_000), changedFrame(2, 20_000), changedFrame(3, 30_000));
    h.setTime(10_000);
    await h.observer.pollOnce();
    h.setTime(20_000);
    await h.observer.pollOnce(); // 第 3 帧 → 出批
    h.setTime(30_000);
    await h.observer.pollOnce();

    expect(h.summarizer.calls).toHaveLength(1);
    expect(h.summarizer.calls[0]?.frames).toHaveLength(3);
    expect(h.summarizer.calls[0]?.images).toHaveLength(3);
    expect(h.memory.size()).toBe(1);
    expect(h.observer.stats().summarized).toBe(1);
    // 该批 3 张全部删除；第 4 帧仍在待批
    expect(h.frameStore.deleted).toHaveLength(3);
    expect(h.frameStore.saved).toHaveLength(4);
  });

  it("被节流/双条件拒绝的帧不进入攒批", async () => {
    const h = setup({ frames: [makeFrame({ capturedAt: 0 })] });
    await h.observer.pollOnce();

    // 同一帧、时间只过 1s → 节流拒绝
    h.setTime(1_000);
    await h.observer.pollOnce();

    expect(h.observer.pendingFrames()).toBe(1);
    const skipped = h.events.filter((event) => event.type === "screen_frame_skipped");
    expect(skipped.length).toBe(1);
    if (skipped[0]?.type === "screen_frame_skipped") {
      expect(skipped[0].reasons.join("")).toContain("节流");
    }
  });

  it("采集失败只报事件，不清空已有缓冲", async () => {
    const h = setup({ frames: [makeFrame({ capturedAt: 0 })] });
    await h.observer.pollOnce();

    h.capture.error = "探针崩了";
    h.setTime(10_000);
    await h.observer.pollOnce();

    expect(h.observer.stats().errors).toBe(1);
    expect(h.observer.pendingFrames()).toBe(1); // 缓冲保留
    expect(h.events.some((event) => event.type === "screen_error")).toBe(true);
  });

  it("图像物化失败时**不丢观察**：该批仍产生摘要（只是没有图）", async () => {
    const h = setup({ frames: [makeFrame({ capturedAt: 0 })], imageFails: true });
    await h.observer.pollOnce();

    h.capture.frames.push(changedFrame(1, 10_000), changedFrame(2, 20_000), changedFrame(3, 30_000));
    h.setTime(10_000);
    await h.observer.pollOnce();
    h.setTime(20_000);
    await h.observer.pollOnce();
    h.setTime(30_000);
    await h.observer.pollOnce();

    expect(h.frameStore.saved).toHaveLength(0); // 一张都没落盘
    expect(h.summarizer.calls).toHaveLength(1); // 但摘要照样发生
    expect(h.summarizer.calls[0]?.frames).toHaveLength(3);
    expect(h.summarizer.calls[0]?.images).toHaveLength(0);
    expect(h.memory.size()).toBe(1);
  });

  it("防重入：上一轮未结束时跳过本轮", async () => {
    let resolveCapture: ((frame: ScreenFrame) => void) | undefined;
    const slowCapture: ScreenCapturePort = {
      capture: () =>
        new Promise<ScreenFrame>((resolve) => {
          resolveCapture = resolve;
        }),
      isAvailable: () => Promise.resolve(true),
    };
    const events: ScreenObserverEvent[] = [];
    const observer = new ScreenObserver({
      capture: slowCapture,
      image: new FakeImage(),
      frameStore: new FakeFrameStore(),
      summarizer: new RecordingSummarizer(),
      memory: new ScreenMemory(),
      onEvent: (event) => events.push(event),
    });

    const first = observer.pollOnce(); // 挂起在 capture
    await observer.pollOnce(); // 应当被跳过

    expect(events.some((event) => event.type === "screen_busy_skipped")).toBe(true);

    resolveCapture?.(makeFrame({ capturedAt: 0 }));
    await first;
  });

  it("stop() 丢弃未满批的帧（关闭即不留残余）", async () => {
    const h = setup({ frames: [makeFrame({ capturedAt: 0 })] });
    h.observer.start();
    await h.observer.pollOnce();

    h.observer.stop();

    expect(h.observer.running).toBe(false);
    expect(h.observer.pendingFrames()).toBe(0);
  });

  it("start() 是幂等的，stop() 后 running 为 false", () => {
    const h = setup({ frames: [makeFrame()] });
    h.observer.start();
    h.observer.start();

    expect(h.observer.running).toBe(true);
    h.observer.stop();
    expect(h.observer.running).toBe(false);
    h.observer.stop(); // 重复 stop 不抛错
  });
});

describe("屏幕帧的落盘生命周期（帧只短暂存在于磁盘）", () => {
  it("有效帧才落盘，摘要完成后立即全部删除", async () => {
    const h = setup({ frames: [makeFrame({ capturedAt: 0 })] });

    // 基线 + 2 次变化 = 3 帧，正好填满一批
    h.capture.frames.push(changedFrame(1, 10_000), changedFrame(2, 20_000));
    await h.observer.pollOnce();
    h.setTime(10_000);
    await h.observer.pollOnce();
    h.setTime(20_000);
    await h.observer.pollOnce();

    expect(h.frameStore.saved).toHaveLength(3);
    // 摘要落库后，3 张全部删除，磁盘上不再有待摘要帧
    expect(h.frameStore.deleted).toHaveLength(3);
    await expect(h.frameStore.pendingCount()).resolves.toBe(0);
    expect(h.observer.stats().deletedFrames).toBe(3);
  });

  it("被拒绝的帧不落盘（双条件不通过就不物化、不写盘、不调模型）", async () => {
    const h = setup({ frames: [makeFrame({ capturedAt: 0 })] });
    await h.observer.pollOnce();
    const savedAfterFirst = h.frameStore.saved.length;

    h.setTime(1_000); // 1s 后同一帧 → 节流拒绝
    await h.observer.pollOnce();

    expect(h.frameStore.saved).toHaveLength(savedAfterFirst);
    expect(h.image.calls).toBe(savedAfterFirst);
  });

  it("stop() 删除未满批的落盘帧（关闭即不留残余）", async () => {
    const h = setup({ frames: [makeFrame({ capturedAt: 0 })] });
    h.observer.start();
    await settle(); // 等 start() 触发的那一轮采集完成

    expect(h.frameStore.saved).toHaveLength(1);
    expect(h.observer.pendingFrames()).toBe(1);

    h.observer.stop();
    await settle();

    expect(h.frameStore.deleted).toHaveLength(1);
    expect(h.observer.pendingFrames()).toBe(0);
  });

  it("start() 会清理上次崩溃遗留的孤儿帧", async () => {
    const h = setup({ frames: [makeFrame({ capturedAt: 0 })] });
    h.observer.start();
    await settle();

    expect(h.frameStore.cleanupCalls).toBeGreaterThan(0);
  });

  it("单张图读取失败只少一张，不中断整批摘要", async () => {
    const h = setup({ frames: [makeFrame({ capturedAt: 0 })] });
    await h.observer.pollOnce();
    h.frameStore.readFails = true;

    h.capture.frames.push(changedFrame(1, 10_000), changedFrame(2, 20_000), changedFrame(3, 30_000));
    h.setTime(10_000);
    await h.observer.pollOnce();
    h.setTime(20_000);
    await h.observer.pollOnce();
    h.setTime(30_000);
    await h.observer.pollOnce();

    // 图读不出来 → 该批没有可用图 → 仍产生摘要（确定性兜底），且帧仍被删除
    expect(h.summarizer.calls[0]?.images).toHaveLength(0);
    expect(h.frameStore.deleted).toHaveLength(3);
  });

  it("落盘失败不丢观察：该帧仍进批次（只是这批少一张图）", async () => {
    const h = setup({ frames: [makeFrame({ capturedAt: 0 })] });
    h.frameStore.saveFails = true;
    await h.observer.pollOnce();

    expect(h.frameStore.saved).toHaveLength(0);
    expect(h.observer.pendingFrames()).toBe(1); // 帧仍在批次里
    expect(h.events.some((event) => event.type === "screen_error")).toBe(true);
  });
});

describe("确定性摘要（应用层纯逻辑）", () => {
  it("陈述可确定的事实并标注未生成", () => {
    const summary = deterministicScreenSummary([makeFrame({ capturedAt: 0 }), makeFrame({ capturedAt: 30_000 })], 1_000);

    expect(summary.fromModel).toBe(false);
    expect(summary.frameCount).toBe(2);
    expect(summary.text).toContain("1920x1080");
    expect(summary.text).toContain("30 秒");
  });

  it("空帧数组不抛错", () => {
    const summary = deterministicScreenSummary([], 0);

    expect(summary.text).toContain("未知");
  });
});
