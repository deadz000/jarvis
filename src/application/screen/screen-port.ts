/**
 * 屏幕观察端口（SRS FR-03；实施计划 M6 屏幕侧）。
 *
 * ## 隐私设计（这是本模块最重要的部分）
 * 产品规则：**原始帧一律不落盘**。这里进一步做到更强的保证：
 * `ScreenFrame` **不包含任何像素数据**，只有：
 * - 一帧的 64 位中值指纹（用于判断"画面是否变了"）；
 * - 16x16 色块均值（用于判断"是否发生了大面积色块变化"）。
 *
 * 也就是说：**原始帧既不落盘，也不进入业务进程的堆**。
 * 采集进程（.NET）内部完成截屏与降采样后立即丢弃位图。
 *
 * 唯一会把画面送出去的地方是「按需截图工具」（由 Worker 主动调用），
 * 那是显式动作，不属于持续观察。
 */

/** 采集探针的原始输出（.NET 侧只做机械降采样，不做任何决策）。 */
export interface ScreenProbeSample {
  readonly ok: boolean;
  readonly error?: string;
  readonly width: number;
  readonly height: number;
  readonly capturedAtMs: number;
  readonly hashSize: number;
  readonly blockSize: number;
  /** 8x8 灰度值（0-255），长度 64。 */
  readonly gray: readonly number[];
  /** 16x16 色块均值的 RGB 展平数组，长度 blockSize*blockSize*3。 */
  readonly rgb: readonly number[];
}

/** 一帧屏幕的**去像素化摘要**。 */
export interface ScreenFrame {
  readonly capturedAt: number;
  readonly width: number;
  readonly height: number;
  /** 64 位中值指纹。 */
  readonly fingerprint: bigint;
  readonly fingerprintHex: string;
  /** 灰度中值（指纹的阈值，便于排查）。 */
  readonly grayMedian: number;
  /** 色块均值，行优先。 */
  readonly blockColors: readonly { readonly r: number; readonly g: number; readonly b: number }[];
  readonly blockSize: number;
}

export interface ScreenCapturePort {
  /** 采集一帧（**不含像素**）。失败时抛错，不要返回空帧。 */
  capture(): Promise<ScreenFrame>;
  /** 当前环境是否支持采集（用于开关的可用性提示）。 */
  isAvailable(): Promise<boolean>;
}

/** 屏幕摘要（由 LLM 或确定性兜底产生，进入滑动窗口的那一层）。 */
export interface ScreenSummary {
  readonly text: string;
  readonly at: number;
  readonly frameCount: number;
  /** 是否由真实模型产生；false 表示确定性兜底。 */
  readonly fromModel: boolean;
}

export interface ScreenSummarizerPort {
  summarize(frames: readonly ScreenFrame[]): Promise<ScreenSummary>;
}
