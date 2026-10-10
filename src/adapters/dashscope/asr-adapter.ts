/**
 * 阿里云百炼（DashScope）实时语音识别适配器。
 *
 * 协议依据：`docs/阿里云ASR-TTS实时协议_v0.1.md`（字段名原样引用）。
 *
 * ⚠️ **模型型号要点**：`qwen-audio-3.0-asr-flash` 是**非实时 HTTP 模型**，
 * 不支持 WebSocket、没有增量结果；流式必须用带 `-streaming` 后缀的型号。
 *
 * 关键事实：
 * - 端点与 TTS 相同：`wss://{WorkspaceId}.{region}.maas.aliyuncs.com/api-ws/v1/inference`；
 * - `task: "asr"` / `function: "recognition"`；
 * - 上行音频是**裸 binary 帧**（无 JSON 包装），且**必须单声道**；
 * - 结果在 `result-generated` 的 `payload.output.sentence`：
 *   `sentence_end === true` → 终稿；`heartbeat === true` → 心跳包**必须跳过**；
 * - `finish-task` 收尾，**ASR 侧没有 cancel directive**（文档中未找到取消语义）。
 *
 * ## 已知限制（未实现/未验证，不要当成已具备）
 * - 保活只做「空闲自动补静音帧」，未验证长连接（>数分钟）下的稳定性；
 * - 未做 `continue-task` 上下文注入（可用于提升专有名词识别率）；
 * - `task-failed` 后连接**不可复用**，这里直接关闭。
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import {
  ASR_FRAME_BYTES,
  AsrError,
  silentFrame,
  type AsrPort,
  type AsrSession,
  type AsrStartRequest,
  type AsrTranscript,
} from "../../application/input/asr-port.ts";
import type { Logger } from "../../observability/logger.ts";

export type DashScopeRegion = "cn-beijing" | "ap-southeast-1";

const REGION_HOSTS: Readonly<Record<DashScopeRegion, string>> = {
  "cn-beijing": "cn-beijing.maas.aliyuncs.com",
  "ap-southeast-1": "ap-southeast-1.maas.aliyuncs.com",
};

/** 空闲多久后补一帧静音保活（远小于服务端约 23 秒的空闲超时）。 */
export const DEFAULT_KEEPALIVE_IDLE_MS = 8_000;

export interface DashScopeAsrOptions {
  readonly apiKey: string;
  readonly workspaceId: string;
  readonly model: string;
  readonly region?: DashScopeRegion;
  /** 默认推流采样率。 */
  readonly sampleRate?: number;
  /** 语义断句：true 关 VAD 用语义断句；false（默认）用 VAD 断句。 */
  readonly semanticPunctuation?: boolean;
  /** VAD 静音阈值（ms），默认 800。 */
  readonly maxSentenceSilenceMs?: number;
  readonly connectTimeoutMs?: number;
  readonly keepaliveIdleMs?: number;
  readonly logger?: Logger;
  readonly now?: () => number;
}

interface DashScopeEventHeader {
  readonly event?: string;
  readonly task_id?: string;
  readonly error_code?: string;
  readonly error_message?: string;
}

interface DashScopeSentence {
  readonly text?: string;
  readonly sentence_id?: number;
  readonly sentence_end?: boolean;
  readonly sentence_begin?: boolean;
  readonly heartbeat?: boolean;
  readonly begin_time?: number;
  readonly end_time?: number | null;
}

interface DashScopeEvent {
  readonly header?: DashScopeEventHeader;
  readonly payload?: {
    readonly output?: { readonly sentence?: DashScopeSentence };
  };
}

export class DashScopeAsrAdapter implements AsrPort {
  private readonly options: DashScopeAsrOptions;
  private readonly now: () => number;

  public constructor(options: DashScopeAsrOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }

  public endpoint(): string {
    const region = this.options.region ?? "cn-beijing";
    return `wss://${this.options.workspaceId}.${REGION_HOSTS[region]}/api-ws/v1/inference`;
  }

  public start(request: AsrStartRequest = {}): AsrSession {
    const taskId = randomUUID();
    const sampleRate = request.sampleRate ?? this.options.sampleRate ?? 16_000;
    const logger = this.options.logger;

    const ws = new WebSocket(this.endpoint(), {
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "user-agent": "jarvis-adapter/1.0",
      },
    });

    /** 服务端就绪前推入的音频先缓冲，避免违反「task-started 后才能推流」。 */
    const pending: Buffer[] = [];
    let ready = false;
    let finishedSettled = false;
    let aborted = false;
    let keepalive: NodeJS.Timeout | undefined;

    let resolveStarted: () => void = () => {};
    let rejectStarted: (error: Error) => void = () => {};
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });

    let resolveFinished: () => void = () => {};
    let rejectFinished: (error: Error) => void = () => {};
    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });
    // 未被消费的 rejection 不应造成进程级 unhandledRejection
    finished.catch(() => {});

    const clearKeepalive = (): void => {
      if (keepalive !== undefined) {
        clearTimeout(keepalive);
        keepalive = undefined;
      }
    };

    const armKeepalive = (): void => {
      const idleMs = this.options.keepaliveIdleMs ?? DEFAULT_KEEPALIVE_IDLE_MS;
      if (idleMs <= 0) return;
      clearKeepalive();
      keepalive = setTimeout(() => {
        if (aborted || ws.readyState !== WebSocket.OPEN) return;
        // 官方：开启 heartbeat 后需**持续发送静音音频**才能保持连接
        ws.send(silentFrame());
        armKeepalive();
      }, idleMs);
    };

    const send = (payload: unknown): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      // ASR 上行是二进制，下行都是 JSON；若收到 binary 属异常，忽略即可
      if (isBinary) return;

      let message: DashScopeEvent;
      try {
        message = JSON.parse(data.toString("utf8")) as DashScopeEvent;
      } catch {
        logger?.warn("asr.unparsable_control_frame", { taskId });
        return;
      }

      switch (message.header?.event) {
        case "task-started": {
          ready = true;
          resolveStarted();
          for (const frame of pending) ws.send(frame);
          pending.length = 0;
          armKeepalive();
          logger?.debug("asr.ready", { taskId, sampleRate });
          return;
        }
        case "result-generated": {
          const sentence = message.payload?.output?.sentence;
          if (sentence === undefined) return;
          // 心跳包必须跳过，否则会被当成识别内容
          if (sentence.heartbeat === true) return;

          const transcript: AsrTranscript = {
            text: sentence.text ?? "",
            sentenceId: sentence.sentence_id ?? 0,
            beginTimeMs: sentence.begin_time ?? 0,
            endTimeMs: sentence.end_time ?? null,
            isFinal: sentence.sentence_end === true,
          };
          if (transcript.text.length === 0) return;

          if (transcript.isFinal) request.onFinal?.(transcript);
          else request.onPartial?.(transcript);
          return;
        }
        case "task-finished": {
          finishedSettled = true;
          clearKeepalive();
          resolveFinished();
          return;
        }
        case "task-failed": {
          const error = new AsrError(
            message.header?.error_message ?? "ASR 任务失败",
            message.header?.error_code,
          );
          finishedSettled = true;
          clearKeepalive();
          rejectStarted(error);
          rejectFinished(error);
          request.onError?.(error);
          return;
        }
        default:
          logger?.debug("asr.control_event", { taskId, event: message.header?.event ?? "unknown" });
      }
    });

    ws.on("error", (error: Error) => {
      clearKeepalive();
      if (!ready) rejectStarted(error);
      if (!finishedSettled) {
        finishedSettled = true;
        rejectFinished(error);
      }
      request.onError?.(error);
    });

    ws.on("close", () => {
      clearKeepalive();
      if (!finishedSettled) {
        finishedSettled = true;
        // 主动 abort 导致的关闭不算失败
        if (aborted) resolveFinished();
        else rejectFinished(new AsrError("ASR 连接在收到 task-finished 前关闭", "ClosedEarly"));
      }
    });

    const waitForOpen = new Promise<void>((resolve, reject) => {
      const timeoutMs = this.options.connectTimeoutMs ?? 10_000;
      const timer = setTimeout(() => {
        reject(new AsrError(`建立 ASR 连接超时（>${timeoutMs}ms）`, "ConnectTimeout"));
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("unexpected-response", (_request, response) => {
        clearTimeout(timer);
        reject(
          new AsrError(
            `ASR 握手失败：HTTP ${String(response.statusCode)}（检查 API Key 与 WorkspaceId）`,
            "HandshakeFailed",
          ),
        );
      });
    });

    void waitForOpen
      .then(() => {
        send({
          header: { action: "run-task", task_id: taskId, streaming: "duplex" },
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model: this.options.model,
            parameters: {
              format: "pcm",
              sample_rate: sampleRate,
              semantic_punctuation_enabled: this.options.semanticPunctuation ?? false,
              max_sentence_silence: this.options.maxSentenceSilenceMs ?? 800,
              heartbeat: true,
            },
            input: {},
          },
        });
      })
      .catch((error: unknown) => {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        rejectStarted(wrapped);
        if (!finishedSettled) {
          finishedSettled = true;
          rejectFinished(wrapped);
        }
        request.onError?.(wrapped);
      });

    return {
      taskId,
      started,
      finished,
      push(audio: Buffer): void {
        if (aborted || audio.length === 0) return;
        if (!ready) {
          pending.push(audio);
          return;
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(audio);
          armKeepalive();
        }
      },
      finish(): void {
        if (aborted) return;
        clearKeepalive();
        send({
          header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
          payload: { input: {} },
        });
      },
      abort(reason: string): void {
        if (aborted) return;
        aborted = true;
        clearKeepalive();
        logger?.info("asr.aborted", { taskId, reason });
        // 文档中未找到 ASR 的取消指令，只能关闭连接
        try {
          ws.close(1000, "aborted");
        } catch {
          // 忽略关闭异常
        }
      },
    };
  }
}

export { ASR_FRAME_BYTES };
