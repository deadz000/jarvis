import { describe, expect, it } from "vitest";

import { ScreenMemory } from "../../src/application/screen/screen-memory.ts";
import { ScreenObserver, type ScreenObserverEvent } from "../../src/application/screen/screen-observer.ts";
import { deterministicScreenSummary } from "../../src/application/screen/deterministic-summary.ts";
import type {
  ScreenCapturePort,
  ScreenFrame,
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
    return Promise.resolve({ jpegBase64: "AAAA", width: 1_024, height: 576, capturedAt: 0, byteLength: 4 });
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
  const summarizer = new RecordingSummarizer();
  if (options.summarizerText !== undefined) summarizer.text = options.summarizerText;
  const memory = new ScreenMemory();
  const events: ScreenObserverEvent[] = [];

  const observer = new ScreenObserver({
    capture,
    image,
    summarizer,
    memory,
    now: () => currentTime,
    onEvent: (event) => events.push(event),
  });

  let currentTime = 0;
  return { observer, capture, image, summarizer, memory, events, setTime: (value: number) => { currentTime = value; } };
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
  it("首帧建立基线并进入攒批，未满 3 帧不出批", async () => {
    const h = setup({ frames: [makeFrame({ capturedAt: 0 })] });
    await h.observer.pollOnce();

    expect(h.observer.pendingFrames()).toBe(1);
    expect(h.summarizer.calls).toHaveLength(0);
    expect(h.image.calls).toBe(0);
  });

  it("攒满 3 帧后物化图像并调一次摘要，写入滑动窗口", async () => {
    const h = setup({ frames: [makeFrame({ capturedAt: 0 })] });
    await h.observer.pollOnce(); // 首帧 → 基线

    h.capture.frames.push(changedFrame(1, 10_000), changedFrame(2, 20_000), changedFrame(3, 30_000));
    h.setTime(10_000);
    await h.observer.pollOnce();
    h.setTime(20_000);
    await h.observer.pollOnce();
    h.setTime(30_000);
    await h.observer.pollOnce();

    expect(h.image.calls).toBe(1);
    expect(h.summarizer.calls).toHaveLength(1);
    expect(h.summarizer.calls[0]?.frames).toHaveLength(3);
    expect(h.memory.size()).toBe(1);
    expect(h.observer.stats().summarized).toBe(1);
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

  it("图像物化失败时**不丢观察**：落一条确定性摘要", async () => {
    const h = setup({ frames: [makeFrame({ capturedAt: 0 })], imageFails: true });
    await h.observer.pollOnce();

    h.capture.frames.push(changedFrame(1, 10_000), changedFrame(2, 20_000), changedFrame(3, 30_000));
    h.setTime(10_000);
    await h.observer.pollOnce();
    h.setTime(20_000);
    await h.observer.pollOnce();
    h.setTime(30_000);
    await h.observer.pollOnce();

    expect(h.summarizer.calls).toHaveLength(0); // 没有图，不调模型
    expect(h.memory.size()).toBe(1);
    const entries = h.memory.recent(30_000);
    expect(entries[0]?.fromModel).toBe(false);
    expect(entries[0]?.text).toContain("图像采集失败");
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
