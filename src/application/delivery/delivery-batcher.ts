/**
 * 交付批量器（M5）：把「几乎同时完成」的结果合成一批，只做**一次**交付决策。
 *
 * ## 为什么需要批量
 * 结果产出时若要唤醒 Master 做交付决策，每条结果单独唤醒会让
 * 调用次数与**结果数**成正比（每条 2.5–2.8s、一次模型调用）。
 * 加一个合并窗口后，调用次数与**批次数**成正比：
 * 两个任务同时完成 → 一次决策同时看到两条 → 天然可以合并成一次回答。
 *
 * ## 参数（已确认）
 * - `windowMs`（默认 1200）：静默窗口，窗口内又有结果则重置；
 * - `maxWindowMs`（默认 3000）：从**批次开始**算起的硬上限，防止结果连续到来时无限等待。
 *
 * ## 为什么它是确定性的
 * 定时器通过 `schedule` 注入，测试里可替换为手动推进；
 * 「何时冲批」完全由计数与时间决定，不依赖模型。
 */
import type { Priority } from "../../domain/task/types.ts";

export interface PendingResult {
  readonly taskId: string;
  /** 完整结果（面板用）。 */
  readonly fullSummary: string;
  /** 口语稿（交付用）。 */
  readonly spokenSummary: string;
  readonly priority: Priority;
  readonly at: number;
  /**
   * 结果自身的**事实标记**（由 Worker 自评提供）。
   *
   * 注意：这些是「结果自身属性」，**不是重要性** —— 重要性是相对的，
   * 需要参照物（用户此刻在问什么、在听什么），由交付策略决定是否交给 Master 判断。
   */
  readonly hints?: {
    readonly needsUserDecision?: boolean;
    readonly hasBlocker?: boolean;
    readonly isBadNews?: boolean;
    readonly isPartial?: boolean;
  };
}

export interface DeliveryBatcherOptions {
  readonly onFlush: (batch: readonly PendingResult[]) => void;
  readonly windowMs?: number;
  readonly maxWindowMs?: number;
  readonly maxBatchSize?: number;
  readonly now?: () => number;
  /** 定时器注入点，便于测试用人工推进。 */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

export const DEFAULT_DELIVERY_WINDOW_MS = 1_200;
export const DEFAULT_DELIVERY_MAX_WINDOW_MS = 3_000;
export const DEFAULT_MAX_BATCH_SIZE = 6;

export class DeliveryBatcher {
  private readonly onFlush: (batch: readonly PendingResult[]) => void;
  private readonly windowMs: number;
  private readonly maxWindowMs: number;
  private readonly maxBatchSize: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  private pending: PendingResult[] = [];
  private batchStartedAt: number | undefined;
  private cancelTimer: (() => void) | undefined;
  private disposed = false;

  public constructor(options: DeliveryBatcherOptions) {
    this.onFlush = options.onFlush;
    this.windowMs = options.windowMs ?? DEFAULT_DELIVERY_WINDOW_MS;
    this.maxWindowMs = options.maxWindowMs ?? DEFAULT_DELIVERY_MAX_WINDOW_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.now = options.now ?? (() => Date.now());
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => {
          clearTimeout(timer);
        };
      });
  }

  public add(result: PendingResult): void {
    if (this.disposed) return;

    if (this.pending.length === 0) this.batchStartedAt = this.now();
    this.pending.push(result);

    if (this.pending.length >= this.maxBatchSize) {
      this.flush("batch_full");
      return;
    }
    this.armTimer();
  }

  /** 立即冲掉当前批次（例如结果命中「可能需要打断用户」的事实，不宜再等）。 */
  public flushNow(reason = "manual"): void {
    this.flush(reason);
  }

  public pendingResults(): readonly PendingResult[] {
    return [...this.pending];
  }

  public isOpen(): boolean {
    return this.pending.length > 0;
  }

  public dispose(): void {
    this.disposed = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.pending = [];
    this.batchStartedAt = undefined;
  }

  private armTimer(): void {
    this.cancelTimer?.();

    const startedAt = this.batchStartedAt ?? this.now();
    const elapsed = this.now() - startedAt;
    // 距离批次硬上限还剩多少时间；不足静默窗口时按剩余时间安排
    const remaining = Math.max(1, this.maxWindowMs - elapsed);
    const delay = Math.max(1, Math.min(this.windowMs, remaining));

    this.cancelTimer = this.schedule(() => {
      this.flush("window_elapsed");
    }, delay);
  }

  private flush(reason: string): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (this.pending.length === 0) {
      this.batchStartedAt = undefined;
      return;
    }

    const batch = this.pending;
    this.pending = [];
    this.batchStartedAt = undefined;
    this.onFlush(batch);
    void reason;
  }
}
