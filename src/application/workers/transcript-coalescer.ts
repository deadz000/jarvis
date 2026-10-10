/**
 * 文本增量合并器（高频通道的节流层）。
 *
 * ## 为什么需要节流
 * Worker 生成文字时可能每秒产出几十个 token。若每个 token 都触发一次界面推送，
 * 会形成无意义的写入风暴（旧项目的教训：高频数据把共享通道挤爆）。
 * 这里把增量按任务累积，**按时间窗口合并成一次刷新**，既保证"看起来是实时的"
 * （150ms 的粒度人眼已无法分辨），又不产生逐 token 的推送。
 *
 * ## 边界
 * - 每个任务的累积文本**有上限**（保留尾部），防止长回答让界面状态无界增长；
 * - 它不做任何语义判断，也不参与状态决策 —— 只是显示缓冲。
 */
export const DEFAULT_TRANSCRIPT_FLUSH_MS = 150;
export const DEFAULT_MAX_LIVE_TEXT_CHARS = 4_000;

export interface TranscriptCoalescerOptions {
  /** 合并窗口到期时回调（传出每个任务当前的完整实时文本）。 */
  readonly onFlush: (texts: ReadonlyMap<string, string>) => void;
  readonly flushMs?: number;
  readonly maxCharsPerTask?: number;
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

export class TranscriptCoalescer {
  private readonly onFlush: (texts: ReadonlyMap<string, string>) => void;
  private readonly flushMs: number;
  private readonly maxCharsPerTask: number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  private readonly buffers = new Map<string, string>();
  private cancelTimer: (() => void) | undefined;
  private disposed = false;

  public constructor(options: TranscriptCoalescerOptions) {
    this.onFlush = options.onFlush;
    this.flushMs = options.flushMs ?? DEFAULT_TRANSCRIPT_FLUSH_MS;
    this.maxCharsPerTask = options.maxCharsPerTask ?? DEFAULT_MAX_LIVE_TEXT_CHARS;
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => {
          clearTimeout(timer);
        };
      });
  }

  /** 追加一个增量；首个增量会启动合并窗口。 */
  public push(taskId: string, delta: string): void {
    if (this.disposed || delta.length === 0) return;

    const current = this.buffers.get(taskId) ?? "";
    const merged = current + delta;
    // 只保留尾部，保证界面状态有界
    this.buffers.set(taskId, merged.length > this.maxCharsPerTask ? merged.slice(-this.maxCharsPerTask) : merged);

    if (this.cancelTimer === undefined) {
      this.cancelTimer = this.schedule(() => {
        this.flush();
      }, this.flushMs);
    }
  }

  /** 立即合并刷新（例如任务结束时确保最后一段不丢）。 */
  public flushNow(): void {
    this.flush();
  }

  public textFor(taskId: string): string | undefined {
    return this.buffers.get(taskId);
  }

  public snapshot(): ReadonlyMap<string, string> {
    return new Map(this.buffers);
  }

  /** 任务结束时清掉它的实时缓冲（结果会以正式 summary 呈现）。 */
  public clear(taskId: string): void {
    this.buffers.delete(taskId);
  }

  public dispose(): void {
    this.disposed = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.buffers.clear();
  }

  private flush(): void {
    this.cancelTimer = undefined;
    if (this.buffers.size === 0) return;
    this.onFlush(new Map(this.buffers));
  }
}
