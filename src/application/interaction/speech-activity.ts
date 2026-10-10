/**
 * 语音活动跟踪器：把「用户正在说话」从手动开关升级为**识别结果驱动**。
 *
 * ## 为什么需要它
 * 产品规则要求「用户正在讲话时，语音交付让路」，但真实实现里没有独立的 VAD 信号。
 * 可行的确定性替代：**收到非空识别结果就认为在说话**，随后若一段时间没有新结果，
 * 就认为说完了。这样既不需要额外模型，又能驱动已有的交付让路逻辑。
 *
 * ## 边界
 * - 它**不做**语义判断，只做时间判定；
 * - 它是幂等的：连续 `noteSpeech()` 只在状态真正翻转时回调一次；
 * - 静音时长是可配置的启发式阈值，**不是已验证的产品结论**。
 */
export const DEFAULT_SPEECH_SILENCE_MS = 1_500;

export interface SpeechActivityOptions {
  readonly onActive: () => void;
  readonly onIdle: () => void;
  /** 多久没有新的识别结果就认为说完了。 */
  readonly silenceMs?: number;
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

export class SpeechActivityTracker {
  private readonly onActive: () => void;
  private readonly onIdle: () => void;
  private readonly silenceMs: number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  private isActive = false;
  private cancelTimer: (() => void) | undefined;
  private disposed = false;

  public constructor(options: SpeechActivityOptions) {
    this.onActive = options.onActive;
    this.onIdle = options.onIdle;
    this.silenceMs = options.silenceMs ?? DEFAULT_SPEECH_SILENCE_MS;
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => {
          clearTimeout(timer);
        };
      });
  }

  public get active(): boolean {
    return this.isActive;
  }

  /** 收到识别结果（中间或终稿）时调用；会重置静音计时。 */
  public noteSpeech(): void {
    if (this.disposed) return;

    if (!this.isActive) {
      this.isActive = true;
      this.onActive();
    }

    this.cancelTimer?.();
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = undefined;
      if (!this.isActive) return;
      this.isActive = false;
      this.onIdle();
    }, this.silenceMs);
  }

  /** 立刻判定为「说完了」（例如识别会话正常结束）。 */
  public markIdle(): void {
    if (this.disposed) return;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (!this.isActive) return;
    this.isActive = false;
    this.onIdle();
  }

  public dispose(): void {
    this.disposed = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.isActive = false;
  }
}
