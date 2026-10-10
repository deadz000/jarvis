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

/** 采集探针的原始输出（.NET 侧只做机械降采样，不做任何决策）。 */export interface ScreenProbeSample {
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

/**
 * 用于摘要的**一张**降采样图片。
 *
 * 与 `ScreenFrame` 的区别很重要：`ScreenFrame` 每轮轮询都会产生、**不含像素**；
 * `ScreenImage` 只在攒批出批、真正要调模型摘要时**才物化一次**。
 * 这样"图像"的存在时间与范围都被压到最小。
 *
 * ⚠️ 隐私含义：摘要步骤会把这张图**发送给模型 API**。
 * 帧仍然不落盘，但确实离开了本机 —— 这与"帧不出本机"是两个不同的保证，
 * 决策清单里已分别记录。
 */
export interface ScreenImage {
  readonly jpegBase64: string;
  readonly width: number;
  readonly height: number;
  readonly capturedAt: number;
  readonly byteLength: number;
}

export interface ScreenImagePort {
  captureImage(): Promise<ScreenImage>;
}

/**
 * 已落盘的一帧图像引用。
 *
 * ## 生命周期（**用完即删**）
 * 被判定为"有效变化"的帧 → 落盘 → 参与攒批 → 发给模型摘要 →
 * **摘要落库后立即删除对应文件**。
 *
 * 也就是说磁盘只是**待摘要帧的临时缓冲**，不是帧仓库：
 * 帧的持久存在时间上界 ≈ 攒批窗口（最长 5 分钟）。
 * 进程崩溃留下的孤儿帧会在下次启动时清理。
 */
export interface PersistedFrameRef {
  /** 绝对路径。 */
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly capturedAt: number;
}

export interface ScreenFrameStorePort {
  /** 把一帧图像落盘，返回引用。 */
  save(image: ScreenImage): Promise<PersistedFrameRef>;
  /** 读回（用于发给模型）。文件不存在时抛错，由调用方决定降级。 */
  read(ref: PersistedFrameRef): Promise<ScreenImage>;
  /** 删除这些帧（摘要落库后调用）。返回实际删除的数量。 */
  remove(refs: readonly PersistedFrameRef[]): Promise<number>;
  /** 清理孤儿帧（进程崩溃遗留），返回清理数量。 */
  cleanupOrphans(): Promise<number>;
  /** 当前待摘要帧数量（用于面板与排查）。 */
  pendingCount(): Promise<number>;
}

export interface ScreenSummarizeInput {
  readonly frames: readonly ScreenFrame[];
  /**
   * 该批的图片，**按时间顺序**，最多 3 张。
   *
   * 与旧设计的区别：以前只发"最近一张"，现在把整批都发给模型 ——
   * 这样才能看出"这 5 分钟里屏幕是怎么变化的"，而不只是"最后一刻长什么样"。
   */
  readonly images: readonly ScreenImage[];
}

export interface ScreenSummarizerPort {
  summarize(input: ScreenSummarizeInput): Promise<ScreenSummary>;
}
