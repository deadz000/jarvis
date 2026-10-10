/**
 * 屏幕帧攒批器：**3 帧或 5 分钟，先到先出**。
 *
 * ## 为什么要攒批
 * 逐帧调用 LLM 做摘要的成本与噪声都不可接受（首版不做清单明确排除
 * 「对每一帧屏幕变化都调用 Master LLM」）。
 * 攒批后：一次摘要覆盖一小段连续变化，调用次数与"变化时段"成正比。
 *
 * 注意「5 分钟」是**上限**而不是周期：如果 5 分钟内已经攒够 3 帧，
 * 会立刻出批，不必要地等到 5 分钟只会让屏幕上下文过时。
 */
import type { ScreenFrame } from "./screen-port.ts";

export const DEFAULT_SCREEN_BATCH_SIZE = 3;
export const DEFAULT_SCREEN_BATCH_MAX_WINDOW_MS = 300_000;

export interface ScreenSummaryBatcherOptions {
  readonly batchSize?: number;
  readonly maxWindowMs?: number;
}

export class ScreenSummaryBatcher {
  private readonly batchSize: number;
  private readonly maxWindowMs: number;

  private frames: ScreenFrame[] = [];
  private firstAt = 0;

  public constructor(options: ScreenSummaryBatcherOptions = {}) {
    this.batchSize = options.batchSize ?? DEFAULT_SCREEN_BATCH_SIZE;
    this.maxWindowMs = options.maxWindowMs ?? DEFAULT_SCREEN_BATCH_MAX_WINDOW_MS;
  }

  /** 加入一帧；达到阈值时返回该批帧，否则返回 null。 */
  public add(frame: ScreenFrame, now: number): readonly ScreenFrame[] | null {
    if (this.frames.length === 0) this.firstAt = now;
    this.frames.push(frame);

    if (this.frames.length >= this.batchSize) return this.take();
    if (now - this.firstAt >= this.maxWindowMs) return this.take();
    return null;
  }

  /** 取出当前批次（不足阈值时用于「关闭前的收尾」）。 */
  public take(): readonly ScreenFrame[] {
    const batch = this.frames;
    this.frames = [];
    this.firstAt = 0;
    return batch;
  }

  public pendingCount(): number {
    return this.frames.length;
  }

  /** 距首帧已等待多久（用于观察是否卡在窗口上）。 */
  public ageMs(now: number): number {
    return this.frames.length === 0 ? 0 : now - this.firstAt;
  }

  /** 清空（关闭屏幕观察时调用；未满批的帧直接丢弃，不做摘要）。 */
  public reset(): void {
    this.frames = [];
    this.firstAt = 0;
  }
}
