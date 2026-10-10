/**
 * TTS 端口（SRS §7.8：外部依赖先定义 port，业务逻辑不绑厂商）。
 *
 * ## 为什么是「流式 + 可中止」而不是「一次返回整段音频」
 * 1. **预停要快**：用户开口后必须能立刻停播。若等整段音频返回再播，
 *    停播就只能靠前端丢弃已到达的数据，服务端算力照样白烧；
 *    流式可以在分片边界停，并且能让服务端取消合成（`directive: cancel`）。
 * 2. **首句延迟**：流式下第一段音频到达即可开口，不必等全文合成完。
 * 3. **播放代次**：分片天然对应「哪一次播放」的代次校验（见 audio-manager）。
 *
 * ## 契约
 * - 实现方**必须**在 `signal` 被中止时尽力停止服务端合成（本地方案的预停不依赖它）；
 * - 分片顺序保证，`index` 从 1 递增；
 * - 失败时以异常结束，且必须携带可诊断的信息（不要吞掉服务端错误码）。
 */

export type TtsAudioFormat = "pcm" | "mp3" | "wav" | "opus";

export interface TtsChunk {
  readonly audio: Buffer;
  /** 分片序号，从 1 递增。 */
  readonly index: number;
  readonly format: TtsAudioFormat;
  readonly sampleRate: number;
  /** 到达时间（毫秒），用于首句延迟埋点。 */
  readonly at: number;
}

export interface TtsRequest {
  readonly text: string;
  /** 中止合成（停播时由上层触发）。 */
  readonly signal?: AbortSignal;
  /** 覆盖默认音色。 */
  readonly voice?: string;
}

export interface TtsPort {
  /** 流式合成：边合成边产出音频分片。 */
  synthesize(request: TtsRequest): AsyncIterable<TtsChunk>;
}

export class TtsError extends Error {
  public readonly code: string | undefined;

  public constructor(message: string, code?: string) {
    super(message);
    this.name = "TtsError";
    this.code = code;
  }
}
