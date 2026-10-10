/**
 * 屏幕观察器：把「采集 → 过滤 → **落盘** → 攒批 → 多图摘要 → 记忆 → 删除帧」串成常驻循环。
 *
 * ## 帧的生命周期（本模块的核心）
 * ```
 * 轮询（每 5s）
 *   └─ 采集数值（不含像素）
 *        └─ 双条件过滤
 *             ├─ 不通过 → 丢弃（不落盘、不调模型）
 *             └─ 通过   → ① 物化图像 ② **落盘** ③ 进攒批
 *                            ↓
 *                     攒够 3 帧 或 满 5 分钟
 *                            ↓
 *                     读出最多 3 张图 → 一起发给多模态模型
 *                            ↓
 *                     摘要写入滑动窗口
 *                            ↓
 *                     **删除这一批的落盘帧**（finally，失败也删）
 * ```
 * 因此磁盘上的帧存在时间上界 ≈ 攒批窗口；崩溃遗留由启动时的
 * `cleanupOrphans()` 清理。
 *
 * ## 防重入
 * 一次循环可能是 340ms（采集）+ 340ms（物化）+ 2.7s（摘要）。
 * 上一轮未结束时直接跳过本轮，而不是并发堆积。
 *
 * ## 失败处理
 * - 采集失败：记事件、跳过本轮（不清缓冲）
 * - 物化/落盘失败：**不丢观察** —— 该帧进入"无图批次"，仍会产生摘要
 * - 摘要失败：由 `FallbackScreenSummarizer` 兜底，本层只记录
 */
import type { Logger } from "../../observability/logger.ts";
import { ScreenSummaryBatcher } from "./screen-batcher.ts";
import { ScreenChangeFilter } from "./screen-filter.ts";
import { ScreenMemory } from "./screen-memory.ts";
import type {
  PersistedFrameRef,
  ScreenCapturePort,
  ScreenFrame,
  ScreenFrameStorePort,
  ScreenImage,
  ScreenImagePort,
  ScreenSummarizerPort,
} from "./screen-port.ts";

export const DEFAULT_SCREEN_POLL_INTERVAL_MS = 5_000;
/** 一次摘要最多发几张图（与攒批上限一致）。 */
export const MAX_IMAGES_PER_SUMMARY = 3;

/** 攒批单元：数值帧 + 它的落盘引用（无引用表示物化失败）。 */
export interface ObservedFrame {
  readonly frame: ScreenFrame;
  readonly ref: PersistedFrameRef | null;
}

export type ScreenObserverEvent =
  | { readonly type: "screen_started"; readonly at: number }
  | { readonly type: "screen_stopped"; readonly at: number; readonly discardedFrames: number }
  | { readonly type: "screen_busy_skipped"; readonly at: number }
  | { readonly type: "screen_startup_cleanup"; readonly at: number; readonly removed: number }
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
      /** 落盘路径；物化失败时为 null。 */
      readonly framePath: string | null;
    }
  | {
      readonly type: "screen_batch_ready";
      readonly at: number;
      readonly frameCount: number;
      readonly imageCount: number;
    }
  | {
      readonly type: "screen_summarized";
      readonly at: number;
      readonly text: string;
      readonly fromModel: boolean;
      readonly deletedFrames: number;
    }
  | { readonly type: "screen_error"; readonly at: number; readonly error: string };

export interface ScreenObserverOptions {
  readonly capture: ScreenCapturePort;
  readonly image: ScreenImagePort;
  /** 帧落盘（用于把整批多张图一起发给模型）。 */
  readonly frameStore: ScreenFrameStorePort;
  readonly summarizer: ScreenSummarizerPort;
  readonly memory: ScreenMemory;
  readonly filter?: ScreenChangeFilter;
  readonly batcher?: ScreenSummaryBatcher<ObservedFrame>;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly logger?: Logger;
  readonly onEvent?: (event: ScreenObserverEvent) => void;
}

export interface ScreenObserverStats {
  readonly polls: number;
  readonly captured: number;
  readonly admitted: number;
  readonly persisted: number;
  readonly summarized: number;
  readonly deletedFrames: number;
  readonly errors: number;
}

export class ScreenObserver {
  private readonly options: ScreenObserverOptions;
  private readonly now: () => number;
  private readonly filter: ScreenChangeFilter;
  private readonly batcher: ScreenSummaryBatcher<ObservedFrame>;

  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private counters = {
    polls: 0,
    captured: 0,
    admitted: 0,
    persisted: 0,
    summarized: 0,
    deletedFrames: 0,
    errors: 0,
  };

  public constructor(options: ScreenObserverOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.filter = options.filter ?? new ScreenChangeFilter();
    this.batcher = options.batcher ?? new ScreenSummaryBatcher<ObservedFrame>();
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

    // 启动时清理上次崩溃遗留的待摘要帧（它们所属的批次已经不可能完成）
    void this.options.frameStore
      .cleanupOrphans()
      .then((removed) => {
        if (removed > 0) this.emit({ type: "screen_startup_cleanup", at: this.now(), removed });
      })
      .catch(() => {
        // cleanupOrphans 内部已记录
      });

    this.emit({ type: "screen_started", at: this.now() });

    // 立即跑一轮，避免开关打开后要等一个完整间隔才有反应
    void this.pollOnce();

    const intervalMs = this.options.pollIntervalMs ?? DEFAULT_SCREEN_POLL_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, intervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;

    // 关闭即不留残余：未满批的帧连同它们的落盘文件一起丢弃
    const discarded = this.batcher.take();
    const refs = collectRefs(discarded);
    this.batcher.reset();

    if (refs.length > 0) {
      void this.options.frameStore.remove(refs).catch(() => {
        // remove 内部已记录
      });
    }

    this.emit({ type: "screen_stopped", at: this.now(), discardedFrames: refs.length });
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

      // 判定有效之后才物化并落盘
      let ref: PersistedFrameRef | null = null;
      try {
        const image = await this.options.image.captureImage();
        ref = await this.options.frameStore.save(image);
        this.counters = { ...this.counters, persisted: this.counters.persisted + 1 };
      } catch (error) {
        // 物化或落盘失败不丢观察：该帧仍进批次，只是这一批少一张图
        this.counters = { ...this.counters, errors: this.counters.errors + 1 };
        this.emit({ type: "screen_error", at: now, error: `帧物化/落盘失败：${describe(error)}` });
      }

      this.emit({
        type: "screen_frame_admitted",
        at: now,
        fingerprintHex: frame.fingerprintHex,
        hammingDistance: decision.hammingDistance,
        blockChangeRatio: decision.blockChangeRatio,
        framePath: ref?.path ?? null,
      });

      const batch = this.batcher.add({ frame, ref }, now);
      if (batch === null) return;
      await this.summarizeBatch(batch);
    } finally {
      this.busy = false;
    }
  }

  private async summarizeBatch(batch: readonly ObservedFrame[]): Promise<void> {
    const now = this.now();
    const refs = collectRefs(batch).slice(0, MAX_IMAGES_PER_SUMMARY);

    // 按时间顺序读出最多 3 张图；单张读失败只少一张，不中断整批
    const images: ScreenImage[] = [];
    for (const ref of refs) {
      try {
        images.push(await this.options.frameStore.read(ref));
      } catch (error) {
        this.options.logger?.warn("screen.frame_read_failed", {
          path: ref.path,
          error: describe(error),
        });
      }
    }

    this.emit({
      type: "screen_batch_ready",
      at: now,
      frameCount: batch.length,
      imageCount: images.length,
    });

    let deleted = 0;
    try {
      // summarizer 内部有兜底链，正常不会抛
      const summary = await this.options.summarizer.summarize({
        frames: batch.map((item) => item.frame),
        images,
      });
      this.options.memory.append(summary, this.now());
      this.counters = { ...this.counters, summarized: this.counters.summarized + 1 };
      this.emit({
        type: "screen_summarized",
        at: summary.at,
        text: summary.text,
        fromModel: summary.fromModel,
        deletedFrames: 0,
      });
    } catch (error) {
      // 摘要链彻底失败：仍要删帧（否则文件会无限堆积），但必须记录
      this.counters = { ...this.counters, errors: this.counters.errors + 1 };
      this.emit({ type: "screen_error", at: now, error: `摘要失败：${describe(error)}` });
    } finally {
      // 摘要在或不在，这批帧都已经完成使命 —— 删除，不累积
      if (refs.length > 0) {
        deleted = await this.options.frameStore.remove(refs);
        this.counters = { ...this.counters, deletedFrames: this.counters.deletedFrames + deleted };
      }
    }

    this.options.logger?.debug("screen.batch_done", {
      frameCount: batch.length,
      imageCount: images.length,
      deletedFrames: deleted,
    });
  }

  private emit(event: ScreenObserverEvent): void {
    this.options.onEvent?.(event);
  }
}

function collectRefs(items: readonly ObservedFrame[]): PersistedFrameRef[] {
  const refs: PersistedFrameRef[] = [];
  for (const item of items) {
    if (item.ref !== null) refs.push(item.ref);
  }
  return refs;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
