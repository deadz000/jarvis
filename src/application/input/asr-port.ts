/**
 * ASR 端口（SRS FR-02；实施计划 M6 语音输入侧）。
 *
 * ## 为什么是「长连接 + 推流 + 增量回调」
 * 1. **面板要实时**：用户说话时文字要边说边出（`onPartial`），而不是等说完才显示；
 * 2. **停播要联动**：识别到用户在说话 → 让语音交付让路（`speechActive`）；
 * 3. **与慢决策解耦**：识别回调属于高频通道，**不得**进入 Scheduler 事件流。
 *
 * ## 契约
 * - `push()` 的音频必须是**单声道** PCM 16-bit LE，采样率与 `start()` 声明一致；
 * - `onFinal` 只在服务端确认句子结束（`sentence_end === true`）时触发，
 *   而 `onPartial` 的文本是**会变的**，不能当成最终结果使用；
 * - 实现方必须丢弃心跳包，不得把心跳当成识别内容。
 */

/** ASR 的中间或最终识别结果。 */
export interface AsrTranscript {
  readonly text: string;
  readonly sentenceId: number;
  readonly beginTimeMs: number;
  readonly endTimeMs: number | null;
  /** true = 服务端确认的句子终稿；false = 中间结果（文本可能还会变）。 */
  readonly isFinal: boolean;
}

export interface AsrStartRequest {
  /** 推流采样率（Hz）。必须与 push 的音频一致。 */
  readonly sampleRate?: number;
  readonly onPartial?: (transcript: AsrTranscript) => void;
  readonly onFinal?: (transcript: AsrTranscript) => void;
  readonly onError?: (error: Error) => void;
}

export interface AsrSession {
  /** 服务端分配的 task_id，用于日志与排查。 */
  readonly taskId: string;
  /** 解析为「服务端已就绪、可以推音频」。 */
  readonly started: Promise<void>;
  /** 解析为「服务端已结束本次识别」。 */
  readonly finished: Promise<void>;
  /** 推入一段音频（单声道 PCM 16-bit LE）。就绪前推入的会被缓冲。 */
  push(audio: Buffer): void;
  /** 音频结束，请求收尾（服务端会补发尾部结果）。 */
  finish(): void;
  /** 立即中止（不等最终结果）。 */
  abort(reason: string): void;
}

export interface AsrPort {
  start(request: AsrStartRequest): AsrSession;
}

export class AsrError extends Error {
  public readonly code: string | undefined;

  public constructor(message: string, code?: string) {
    super(message);
    this.name = "AsrError";
    this.code = code;
  }
}

/** 官方示例的帧长：3200 字节 ≈ 100ms @ 16kHz 16bit 单声道。 */
export const ASR_FRAME_BYTES = 3_200;

/** 生成一帧静音 PCM（保活用）。 */
export function silentFrame(bytes = ASR_FRAME_BYTES): Buffer {
  return Buffer.alloc(bytes);
}
