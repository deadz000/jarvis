/**
 * 阿里云百炼（DashScope）实时语音合成适配器。
 *
 * 协议依据：`docs/阿里云ASR-TTS实时协议_v0.1.md`（由官方文档整理，字段名原样引用）。
 * 关键事实：
 * - 端点 `wss://{WorkspaceId}.{region}.maas.aliyuncs.com/api-ws/v1/inference`；
 * - 鉴权走**握手 Header** `Authorization: Bearer <key>`（因此浏览器无法直连，必须后端中转）；
 * - 指令 `run-task` / `continue-task` / `finish-task`，事件 `task-started` /
 *   `result-generated` / `task-finished` / `task-failed`；
 * - **音频分片是两层**：JSON 事件预告 + 紧跟的**裸 binary 帧**，
 *   因此必须用 `isBinary` 分流，绝不能对二进制做 JSON.parse；
 * - **取消合成**：`finish-task` 带 `payload.input.directive = "cancel"`，
 *   服务端立即回 `task-finished` 且不再输出音频；
 * - `run-task`/`continue-task`/`finish-task` **必须使用同一个 task_id**；
 * - 文本限制：单次 ≤20000 字符，累计 ≤200000 字符，两次间隔 ≤23 秒。
 *
 * ## 已知限制（未验证/未实现，不要当成已具备）
 * - **每次合成都新建连接**：文档建议复用连接以降延迟，这里为可读性与可验证性先不做复用；
 * - **PCM 位深按 16-bit LE 单声道假设**（官方参数表未给位深字段，属推断），
 *   已做成可配置并在冒烟测试里按字节数反推时长来校准；
 * - 未做 23 秒空闲超时的主动保活（当前每次合成都是"发完即 finish"，不会空闲那么久）。
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import {
  TtsError,
  type TtsAudioFormat,
  type TtsChunk,
  type TtsPort,
  type TtsRequest,
} from "../../application/delivery/tts-port.ts";
import type { Logger } from "../../observability/logger.ts";

export type DashScopeRegion = "cn-beijing" | "ap-southeast-1";

const REGION_HOSTS: Readonly<Record<DashScopeRegion, string>> = {
  "cn-beijing": "cn-beijing.maas.aliyuncs.com",
  "ap-southeast-1": "ap-southeast-1.maas.aliyuncs.com",
};

/** 官方限制：单次 continue-task 最多 20000 字符。 */
export const MAX_TTS_TEXT_LENGTH = 20_000;

export interface DashScopeTtsOptions {
  readonly apiKey: string;
  readonly workspaceId: string;
  readonly model: string;
  readonly voice: string;
  readonly region?: DashScopeRegion;
  readonly format?: TtsAudioFormat;
  readonly sampleRate?: number;
  readonly connectTimeoutMs?: number;
  readonly logger?: Logger;
  readonly now?: () => number;
}

interface DashScopeEventHeader {
  readonly event?: string;
  readonly task_id?: string;
  readonly error_code?: string;
  readonly error_message?: string;
}

interface DashScopeEvent {
  readonly header?: DashScopeEventHeader;
}

export class DashScopeTtsAdapter implements TtsPort {
  private readonly options: DashScopeTtsOptions;
  private readonly now: () => number;

  public constructor(options: DashScopeTtsOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }

  public endpoint(): string {
    const region = this.options.region ?? "cn-beijing";
    return `wss://${this.options.workspaceId}.${REGION_HOSTS[region]}/api-ws/v1/inference`;
  }

  public async *synthesize(request: TtsRequest): AsyncIterable<TtsChunk> {
    const text = request.text.trim();
    if (text.length === 0) return;
    if (text.length > MAX_TTS_TEXT_LENGTH) {
      throw new TtsError(
        `单次合成长度 ${text.length} 超过上限 ${MAX_TTS_TEXT_LENGTH} 字符；上层应先切分文本`,
        "TextTooLong",
      );
    }

    const format = this.options.format ?? "pcm";
    const sampleRate = this.options.sampleRate ?? 24_000;
    const voice = request.voice ?? this.options.voice;
    const taskId = randomUUID();
    const startedAt = this.now();

    const ws = new WebSocket(this.endpoint(), {
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "user-agent": "jarvis-adapter/1.0",
      },
    });

    const audioQueue: Buffer[] = [];
    let wake: (() => void) | undefined;
    let settled = false;
    let started = false;
    let failure: Error | undefined;
    let firstAudioLatencyMs: number | undefined;

    const signalWake = (): void => {
      const pending = wake;
      wake = undefined;
      pending?.();
    };

    const send = (payload: unknown): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };

    const onAbort = (): void => {
      // 服务端取消：立即停止后续音频输出并回收算力。
      // 注意：本地预停（<100ms）不依赖这一步，见 ADR 中「预停必须本地完成」。
      if (ws.readyState === WebSocket.OPEN) {
        send({
          header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
          payload: { input: { directive: "cancel" } },
        });
        this.options.logger?.info("tts.cancel_sent", { taskId });
        return;
      }
      try {
        ws.terminate();
      } catch {
        // 连接尚未建立时 terminate 可能抛错，忽略即可
      }
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        if (firstAudioLatencyMs === undefined) {
          firstAudioLatencyMs = this.now() - startedAt;
          this.options.logger?.info("tts.first_audio", { taskId, latencyMs: firstAudioLatencyMs });
        }
        audioQueue.push(Buffer.from(data));
        signalWake();
        return;
      }

      let message: DashScopeEvent;
      try {
        message = JSON.parse(data.toString("utf8")) as DashScopeEvent;
      } catch {
        this.options.logger?.warn("tts.unparsable_control_frame", { taskId });
        return;
      }

      switch (message.header?.event) {
        case "task-started":
          // 必须等 task-started 之后才能发 continue-task
          started = true;
          send({
            header: { action: "continue-task", task_id: taskId, streaming: "duplex" },
            payload: { input: { text } },
          });
          // 文本一次发完，随即 finish-task 强制合成缓存中的内容
          send({
            header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
            payload: { input: {} },
          });
          return;
        case "task-finished":
          settled = true;
          signalWake();
          return;
        case "task-failed":
          failure = new TtsError(
            message.header?.error_message ?? "TTS 任务失败",
            message.header?.error_code,
          );
          settled = true;
          signalWake();
          return;
        default:
          this.options.logger?.debug("tts.control_event", { taskId, event: message.header?.event ?? "unknown" });
      }
    });

    ws.on("close", () => {
      settled = true;
      signalWake();
    });
    ws.on("error", (error: Error) => {
      failure ??= error;
      settled = true;
      signalWake();
    });

    try {
      await this.waitForOpen(ws, taskId);
      send({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model: this.options.model,
          parameters: {
            text_type: "PlainText",
            voice,
            format,
            sample_rate: sampleRate,
            volume: 50,
            rate: 1.0,
            pitch: 1.0,
            enable_ssml: false,
          },
          input: {},
        },
      });

      let index = 0;
      for (;;) {
        const audio = audioQueue.shift();
        if (audio !== undefined) {
          index += 1;
          yield { audio, index, format, sampleRate, at: this.now() };
          continue;
        }
        if (settled) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }

      if (failure !== undefined) throw failure;
      if (!started) throw new TtsError("未收到 task-started，合成未启动", "NotStarted");
      if (index === 0) throw new TtsError("合成结束但未收到任何音频分片", "NoAudio");
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close(1000, "done");
        } catch {
          // 关闭失败不影响结果
        }
      }
    }
  }

  private async waitForOpen(ws: WebSocket, taskId: string): Promise<void> {
    const timeoutMs = this.options.connectTimeoutMs ?? 10_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new TtsError(`建立 TTS 连接超时（>${timeoutMs}ms）`, "ConnectTimeout"));
      }, timeoutMs);

      ws.once("open", () => {
        clearTimeout(timer);
        this.options.logger?.debug("tts.connected", { taskId });
        resolve();
      });
      ws.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      ws.once("unexpected-response", (_request, response) => {
        clearTimeout(timer);
        reject(
          new TtsError(
            `TTS 握手失败：HTTP ${String(response.statusCode)}（检查 API Key 与 WorkspaceId）`,
            "HandshakeFailed",
          ),
        );
      });
    });
  }
}
