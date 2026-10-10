/**
 * 屏幕变化过滤器：**双条件 AND + 节流**（纯逻辑，可确定性单测）。
 *
 * ## 为什么是 AND 而不是 OR
 * 单看指纹会误报：光标闪烁、时钟跳秒、视频播放都会改变指纹，
 * 但这些**不代表上下文变了**。
 * 单看色块会误报：整体渐变、淡入淡出动画可能触发而内容没变。
 * 两个条件同时成立才认为"有意义的变化"——这是把误报压下去的关键。
 *
 * ## 基线是与「上次被采纳的帧」比较，而不是「上一帧」
 * 若与上一帧比较，缓慢滚动这类连续小变化永远达不到阈值（每帧只差一点）。
 * 与上次采纳的帧比较，变化会**累积**，最终触发一次判断 —— 这才是期望行为。
 *
 * ## 节流
 * 即使双条件成立，距上次采纳不足 `throttleMs` 也不采纳（默认 5s）。
 * 被节流拒绝的帧**不更新基线**，所以变化不会丢失，只是延后判断。
 */
import type { ScreenFrame } from "./screen-port.ts";
import { blockChangeRatio, DEFAULT_BLOCK_COLOR_THRESHOLD, hammingDistance } from "./fingerprint.ts";

export const DEFAULT_MIN_HAMMING_DISTANCE = 8;
export const DEFAULT_MIN_BLOCK_CHANGE_RATIO = 0.25;
export const DEFAULT_SCREEN_THROTTLE_MS = 5_000;

export interface ScreenFilterOptions {
  /** 指纹至少要变这么多位。 */
  readonly minHammingDistance?: number;
  /** 至少要这么大比例的色块发生变化。 */
  readonly minBlockChangeRatio?: number;
  readonly throttleMs?: number;
  readonly blockColorThreshold?: number;
}

export interface ScreenFilterDecision {
  /** 是否采纳该帧（进入攒批）。 */
  readonly keep: boolean;
  /** 与基线帧的汉明距离；首帧为 null。 */
  readonly hammingDistance: number | null;
  readonly blockChangeRatio: number | null;
  /** 是否因节流被拒绝。 */
  readonly throttled: boolean;
  /** 命中原因，用于日志与排查。 */
  readonly reasons: readonly string[];
}

export class ScreenChangeFilter {
  private readonly minHammingDistance: number;
  private readonly minBlockChangeRatio: number;
  private readonly throttleMs: number;
  private readonly blockColorThreshold: number;

  private baseline: ScreenFrame | undefined;
  private lastAdmittedAt = 0;

  public constructor(options: ScreenFilterOptions = {}) {
    this.minHammingDistance = options.minHammingDistance ?? DEFAULT_MIN_HAMMING_DISTANCE;
    this.minBlockChangeRatio = options.minBlockChangeRatio ?? DEFAULT_MIN_BLOCK_CHANGE_RATIO;
    this.throttleMs = options.throttleMs ?? DEFAULT_SCREEN_THROTTLE_MS;
    this.blockColorThreshold = options.blockColorThreshold ?? DEFAULT_BLOCK_COLOR_THRESHOLD;
  }

  public admit(frame: ScreenFrame, now: number): ScreenFilterDecision {
    // 首帧没有基线：采纳它，仅用于建立基线
    if (this.baseline === undefined) {
      this.baseline = frame;
      this.lastAdmittedAt = now;
      return {
        keep: true,
        hammingDistance: null,
        blockChangeRatio: null,
        throttled: false,
        reasons: ["首帧：建立变化基线"],
      };
    }

    const distance = hammingDistance(this.baseline.fingerprint, frame.fingerprint);
    const ratio = blockChangeRatio(this.baseline, frame, this.blockColorThreshold);

    if (now - this.lastAdmittedAt < this.throttleMs) {
      return {
        keep: false,
        hammingDistance: distance,
        blockChangeRatio: ratio,
        throttled: true,
        reasons: [`节流：距上次采纳仅 ${now - this.lastAdmittedAt}ms（上限 ${this.throttleMs}ms）`],
      };
    }

    const fingerprintChanged = distance >= this.minHammingDistance;
    const blocksChanged = ratio >= this.minBlockChangeRatio;

    if (!fingerprintChanged && !blocksChanged) {
      return {
        keep: false,
        hammingDistance: distance,
        blockChangeRatio: ratio,
        throttled: false,
        reasons: ["双条件都不满足：指纹与色块均无明显变化"],
      };
    }
    if (!fingerprintChanged) {
      return {
        keep: false,
        hammingDistance: distance,
        blockChangeRatio: ratio,
        throttled: false,
        reasons: [`指纹变化不足（${distance} < ${this.minHammingDistance}）：疑似仅局部变化`],
      };
    }
    if (!blocksChanged) {
      return {
        keep: false,
        hammingDistance: distance,
        blockChangeRatio: ratio,
        throttled: false,
        reasons: [`色块变化不足（${(ratio * 100).toFixed(1)}% < ${(this.minBlockChangeRatio * 100).toFixed(0)}%）：疑似小范围变化`],
      };
    }

    this.baseline = frame;
    this.lastAdmittedAt = now;
    return {
      keep: true,
      hammingDistance: distance,
      blockChangeRatio: ratio,
      throttled: false,
      reasons: [`双条件成立：指纹差异 ${distance} 位，色块变化 ${(ratio * 100).toFixed(1)}%`],
    };
  }

  /** 当前基线（调试用）。 */
  public baselineFingerprintHex(): string | null {
    return this.baseline?.fingerprintHex ?? null;
  }
}
