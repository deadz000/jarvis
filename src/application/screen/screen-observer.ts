/**
 * 屏幕观察器：把「采集 → 过滤 → 攒批 → 摘要 → 记忆」串成常驻循环。
 *
 * ## 循环节奏
 * 每 `pollIntervalMs`（默认 5s，与节流一致）采集一次。一次完整循环可能是
 * 333ms（采集）+ 2.7s（多模态摘要），因此**必须防重入**：
 * 上一轮还没结束时直接跳过本轮，而不是并发堆积。
 *
 * ## 开关语义
 * `stop()` 会**清空未满批的帧**（不做摘要）—— 关闭屏幕观察意味着不留残余。
 * 已进入滑动窗口的摘要保留（那是历史，不影响新的采集开关）。
 *
 * ## 失败处理
 * - 采集失败：记事件、跳过本轮，不清空缓冲（下一次可能就好了）；
 * - 图像物化失败：**不丢观察**，直接生成确定性摘要入窗口；
 * - 摘要失败：由 `FallbackScreenSummarizer` 处理，本层只负责记录。
 */
import type { Logger } from "../../observability/logger.ts";
import { deterministicScreenSummary } from "./deterministic-summary.ts";
import { ScreenSummaryBatcher } from "./screen-batcher.ts";
import { ScreenChangeFilter } from "./screen-filter.ts";
import { ScreenMemory } from "./screen-memory.ts";
import type {
  ScreenCapturePort,
  ScreenFrame,
  ScreenImagePort,
  ScreenSummarizerPort,
} from "./screen-port.ts";

export const DEFAULT_SCREEN_POLL_INTERVAL_MS = 5_000;

export type ScreenObserverEvent =
  | { readonly type: "screen_started"; readonly at: number }
  | { readonly type: "screen_stopped"; readonly at: number }
  | { readonly type: "screen_busy_skipped"; readonly at: number }
  | {
      readonly type: "screen_frame_skipped";
      readonly at: number;
      readonly reasons: readonly string[];
      readonly hammingDistance: number | null;
      readonly blockChangeRatio: number | null;
    }
  | {
      readonly type: "screen_frame_admitted";
      readonly at: number;
      readonly fingerprintHex: string;
      readonly hammingDistance: number | null;
      readonly blockChangeRatio: number | null;
    }
  | { readonly type: "screen_batch_ready"; readonly at: number; readonly frameCount: number }
  | {
      readonly type: "screen_summarized";
      readonly at: number;
      readonly text: string;
      readonly fromModel: boolean;
    }
  | { readonly type: "screen_error"; readonly at: number; readonly error: string };

export interface ScreenObserverOptions {
  readonly capture: ScreenCapturePort;
  readonly image: ScreenImagePort;
  readonly summarizer: ScreenSummarizerPort;
  readonly memory: ScreenMemory;
  readonly filter?: ScreenChangeFilter;
  readonly batcher?: ScreenSummaryBatcher;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly logger?: Logger;
  readonly onEvent?: (event: ScreenObserverEvent) => void;
}

export interface ScreenObserverStats {
  readonly polls: number;
  readonly captured: number;
  readonly admitted: number;
  readonly summarized: number;
  readonly errors: number;
}

export class ScreenObserver {
  private readonly options: ScreenObserverOptions;
  private readonly now: () => number;
  private readonly filter: ScreenChangeFilter;
  private readonly batcher: ScreenSummaryBatcher;

  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private counters = { polls: 0, captured: 0, admitted: 0, summarized: 0, errors: 0 };

  public constructor(options: ScreenObserverOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.filter = options.filter ?? new ScreenChangeFilter();
    this.batcher = options.batcher ?? new ScreenSummaryBatcher();
  }

  public get running(): boolean {
    return this.timer !== undefined;
  }

  public stats(): ScreenObserverStats {
    return { ...this.counters };
  }

  public pendingFrames(): number {
    return this.batcher.pendingCount();
  }

  public start(): void {
    if (this.timer !== undefined) return;
    this.emit({ type: "screen_started", at: this.now() });

    // 立即跑一轮，避免开关打开后要等一个完整间隔才有反应
    void this.pollOnce();

    const intervalMs = this.options.pollIntervalMs ?? DEFAULT_SCREEN_POLL_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, intervalMs);
    // 不要因为观察循环而阻止进程退出
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
    // 关闭意味着不留残余：未满批的帧直接丢弃，不做摘要
    this.batcher.reset();
    this.emit({ type: "screen_stopped", at: this.now() });
  }

  /** 单次轮询。**公开**是为了让测试可确定性驱动，也便于手动触发一次。 */
  public async pollOnce(): Promise<void> {
    if (this.busy) {
      this.emit({ type: "screen_busy_skipped", at: this.now() });
      return;
    }
    this.busy = true;
    this.counters = { ...this.counters, polls: this.counters.polls + 1 };

    try {
      let frame: ScreenFrame;
      try {
        frame = await this.options.capture.capture();
      } catch (error) {
        this.counters = { ...this.counters, errors: this.counters.errors + 1 };
        this.emit({ type: "screen_error", at: this.now(), error: describe(error) });
        return;
      }
      this.counters = { ...this.counters, captured: this.counters.captured + 1 };

      const now = this.now();
      const decision = this.filter.admit(frame, now);
      if (!decision.keep) {
        this.emit({
          type: "screen_frame_skipped",
          at: now,
          reasons: decision.reasons,
          hammingDistance: decision.hammingDistance,
          blockChangeRatio: decision.blockChangeRatio,
        });
        return;
      }

      this.counters = { ...this.counters, admitted: this.counters.admitted + 1 };
      this.emit({
        type: "screen_frame_admitted",
        at: now,
        fingerprintHex: frame.fingerprintHex,
        hammingDistance: decision.hammingDistance,
        blockChangeRatio: decision.blockChangeRatio,
      });

      const batch = this.batcher.add(frame, now);
      if (batch === null) return;
      await this.summarizeBatch(batch);
    } finally {
      this.busy = false;
    }
  }

  private async summarizeBatch(batch: readonly ScreenFrame[]): Promise<void> {
    const now = this.now();
    this.emit({ type: "screen_batch_ready", at: now, frameCount: batch.length });

    let image;
    try {
      image = await this.options.image.captureImage();
    } catch (error) {
      // 图像物化失败 → 不丢观察，直接落一条确定性摘要
      this.counters = { ...this.counters, errors: this.counters.errors + 1 };
      this.emit({ type: "screen_error", at: now, error: `图像物化失败：${describe(error)}` });
      const summary = deterministicScreenSummary(batch, now, "图像采集失败");
      this.options.memory.append(summary, now);
      this.emit({ type: "screen_summarized", at: now, text: summary.text, fromModel: summary.fromModel });
      return;
    }

    // summarizer 内部已有兜底链，这里不需要再 try/catch（除非实现方违约）
    const summary = await this.options.summarizer.summarize({ frames: batch, image });
    this.options.memory.append(summary, this.now());
    this.counters = { ...this.counters, summarized: this.counters.summarized + 1 };
    this.emit({
      type: "screen_summarized",
      at: summary.at,
      text: summary.text,
      fromModel: summary.fromModel,
    });
  }

  private emit(event: ScreenObserverEvent): void {
    this.options.onEvent?.(event);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
