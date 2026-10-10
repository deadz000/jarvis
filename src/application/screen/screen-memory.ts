/**
 * 屏幕记忆：**10 分钟滑动窗口**。
 *
 * ## 为什么只保留摘要，不保留帧
 * 产品规则「原始帧一律不落盘」在记忆层同样成立：这里存的只有
 * **文本摘要**（由模型或确定性兜底产生）。所以屏幕记忆是**有损的、有界的**，
 * 这也是隐私与成本双重约束下的必然选择。
 *
 * ## 为什么必须有界
 * Master 的世界视图必须**有界**（踩坑指南铁律 5）。屏幕摘要若不设上限，
 * 一个常驻几小时的会话会把上下文撑爆。这里用「时间窗口 + 条数上限」双重夹逼。
 */
import type { ScreenSummary } from "./screen-port.ts";

export const DEFAULT_SCREEN_MEMORY_WINDOW_MS = 600_000;
export const DEFAULT_MAX_SCREEN_SUMMARIES = 20;

export interface ScreenMemoryOptions {
  readonly windowMs?: number;
  readonly maxEntries?: number;
}

export interface ScreenMemoryView {
  readonly count: number;
  readonly summaries: readonly string[];
  /** 窗口内最早一条的时间，用于让模型理解时间范围。 */
  readonly oldestAt: number | null;
}

export class ScreenMemory {
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private entries: ScreenSummary[] = [];

  public constructor(options: ScreenMemoryOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_SCREEN_MEMORY_WINDOW_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_SCREEN_SUMMARIES;
  }

  public append(summary: ScreenSummary, now: number): void {
    this.entries.push(summary);
    this.evict(now);
  }

  public recent(now: number): readonly ScreenSummary[] {
    this.evict(now);
    return [...this.entries];
  }

  /** 给 Master 的**有界**视图：只有文本，没有帧。 */
  public view(now: number): ScreenMemoryView {
    this.evict(now);
    return {
      count: this.entries.length,
      summaries: this.entries.map((entry) => entry.text),
      oldestAt: this.entries[0]?.at ?? null,
    };
  }

  public clear(): void {
    this.entries = [];
  }

  public size(): number {
    return this.entries.length;
  }

  /** 先按时间窗口淘汰，再按条数上限淘汰（保留最近的那些）。 */
  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    this.entries = this.entries.filter((entry) => entry.at >= cutoff);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }
}
