/**
 * ASR **往返**冒烟实测：不需要麦克风就能验证整条语音链路。
 *
 * 链路：文字 → TTS 合成（24kHz PCM）→ 重采样到 16kHz → 分帧推入 ASR →
 * 收增量/终稿 → 与原文比对相似度。
 *
 * 这样一次跑通同时验证：
 * - TTS 适配器（已单独验过，这里复用）
 * - ASR 适配器的连接、鉴权、push 裸二进制帧、心跳包跳过、finish-task 收尾
 * - 「sentence_end 才是终稿」这条契约（中间结果的文本会变）
 *
 * 用法：npm run example:asr -- "要说的话"
 */
import { DashScopeAsrAdapter } from "../../src/adapters/dashscope/asr-adapter.ts";
import { DashScopeTtsAdapter } from "../../src/adapters/dashscope/tts-adapter.ts";
import { ASR_FRAME_BYTES, type AsrTranscript } from "../../src/application/input/asr-port.ts";
import { ConfigError, loadConfig } from "../../src/config/env.ts";
import { createLogger } from "../../src/observability/logger.ts";

const DEFAULT_TEXT = "今天北京天气晴朗，气温二十四度，适合出门散步。";
const TTS_SAMPLE_RATE = 24_000;
const ASR_SAMPLE_RATE = 16_000;

/** 线性插值重采样 PCM 16-bit LE 单声道。 */
function resamplePcm16(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return input;
  const inSamples = Math.floor(input.length / 2);
  const outSamples = Math.floor((inSamples * toRate) / fromRate);
  const output = Buffer.alloc(outSamples * 2);
  for (let index = 0; index < outSamples; index += 1) {
    const sourcePosition = (index * fromRate) / toRate;
    const low = Math.floor(sourcePosition);
    const high = Math.min(low + 1, inSamples - 1);
    const fraction = sourcePosition - low;
    const a = input.readInt16LE(low * 2);
    const b = input.readInt16LE(high * 2);
    const value = Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * fraction)));
    output.writeInt16LE(value, index * 2);
  }
  return output;
}

/** 去掉标点与空白，只比较内容字符。 */
function contentChars(text: string): string {
  return text.replace(/[\s，。、！？；：,.!?;:"'（）()《》「」【】\-—…]/g, "");
}

/** 最长公共子序列长度（文本很短，直接 O(n·m)）。 */
function lcsLength(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = new Array<number>(cols).fill(0);
  for (let i = 1; i < rows; i += 1) {
    const current = new Array<number>(cols).fill(0);
    for (let j = 1; j < cols; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? (previous[j - 1] ?? 0) + 1 : Math.max(previous[j] ?? 0, current[j - 1] ?? 0);
    }
    previous = current;
  }
  return previous[cols - 1] ?? 0;
}

async function run(): Promise<number> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, context: { component: "examples.asr.smoke" } });
  const voice = config.voice;
  const apiKey = process.env["DASHSCOPE_API_KEY"];

  if (apiKey === undefined || voice.workspaceId === undefined) {
    throw new ConfigError(`语音配置不完整，缺少：${voice.missing.join("、")}`);
  }
  if (voice.ttsModel === undefined || voice.ttsVoice === undefined || voice.asrModel === undefined) {
    throw new ConfigError(`语音模型配置不完整，缺少：${voice.missing.join("、")}`);
  }

  const text = process.argv.slice(2).join(" ").trim() || DEFAULT_TEXT;

  // ---- 第一步：TTS 合成语音 ----
  const tts = new DashScopeTtsAdapter({
    apiKey,
    workspaceId: voice.workspaceId,
    model: voice.ttsModel,
    voice: voice.ttsVoice,
    region: voice.region,
    format: "pcm",
    sampleRate: TTS_SAMPLE_RATE,
  });

  const ttsStartedAt = Date.now();
  const chunks: Buffer[] = [];
  let ttsError: string | undefined;
  try {
    for await (const chunk of tts.synthesize({ text })) chunks.push(chunk.audio);
  } catch (error) {
    ttsError = error instanceof Error ? error.message : String(error);
  }
  const pcm24k = Buffer.concat(chunks);
  const ttsMs = Date.now() - ttsStartedAt;

  if (ttsError !== undefined || pcm24k.length === 0) {
    throw new Error(`TTS 阶段失败：${ttsError ?? "未收到音频"}（无法继续 ASR 往返验证）`);
  }

  const pcm16k = resamplePcm16(pcm24k, TTS_SAMPLE_RATE, ASR_SAMPLE_RATE);
  const audioSeconds = pcm16k.length / (ASR_SAMPLE_RATE * 2);

  log.info("asr.smoke.tts_done", {
    textLength: text.length,
    pcmBytes24k: pcm24k.length,
    pcmBytes16k: pcm16k.length,
    audioSeconds: Number(audioSeconds.toFixed(2)),
  });

  // ---- 第二步：把音频推给 ASR ----
  const partials: string[] = [];
  const finals: AsrTranscript[] = [];
  const errors: string[] = [];

  const asr = new DashScopeAsrAdapter({
    apiKey,
    workspaceId: voice.workspaceId,
    model: voice.asrModel,
    region: voice.region,
    sampleRate: ASR_SAMPLE_RATE,
    maxSentenceSilenceMs: 800,
    logger: log,
  });

  const session = asr.start({
    sampleRate: ASR_SAMPLE_RATE,
    onPartial: (transcript) => {
      partials.push(transcript.text);
    },
    onFinal: (transcript) => {
      finals.push(transcript);
      log.info("asr.final", {
        sentenceId: transcript.sentenceId,
        text: transcript.text,
        beginTimeMs: transcript.beginTimeMs,
        endTimeMs: transcript.endTimeMs,
      });
    },
    onError: (error) => {
      errors.push(error.message);
    },
  });

  log.info("asr.smoke.start", { taskId: session.taskId, model: voice.asrModel, sampleRate: ASR_SAMPLE_RATE });

  const asrStartedAt = Date.now();
  await session.started;

  // 按 100ms 一帧推送，模拟真实推流节奏（略快于实时，便于测试）
  const frameIntervalMs = Number(process.env["JARVIS_ASR_FRAME_INTERVAL_MS"] ?? "8");
  for (let offset = 0; offset < pcm16k.length; offset += ASR_FRAME_BYTES) {
    session.push(pcm16k.subarray(offset, Math.min(offset + ASR_FRAME_BYTES, pcm16k.length)));
    if (frameIntervalMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, frameIntervalMs);
      });
    }
  }
  session.finish();
  await session.finished;
  const asrMs = Date.now() - asrStartedAt;

  // ---- 第三步：比对 ----
  const finalText = finals.map((item) => item.text).join("");
  const expected = contentChars(text);
  const actual = contentChars(finalText);
  const common = lcsLength(expected, actual);
  const similarity = expected.length === 0 ? 0 : common / expected.length;

  const checks: Record<string, boolean> = {
    "TTS 成功产出音频": ttsError === undefined && pcm24k.length > 0,
    "ASR 无错误": errors.length === 0,
    "收到中间结果（证明是流式而非一次性返回）": partials.length > 0,
    "收到终稿（sentence_end === true）": finals.length > 0,
    "转写与原文相似度 ≥ 0.6": similarity >= 0.6,
    "终稿句子带时间戳": finals.some((item) => (item.endTimeMs ?? 0) > (item.beginTimeMs ?? 0)),
  };

  const lines = [
    "",
    "===== ASR 往返实测结论 =====",
    `原文：${text}`,
    `转写：${finalText.length > 0 ? finalText : "（空）"}`,
    "",
    `TTS 模型 ${voice.ttsModel}　ASR 模型 ${voice.asrModel}`,
    `音频时长 ≈ ${audioSeconds.toFixed(2)}s（16kHz 单声道）　TTS 耗时 ${ttsMs}ms　ASR 耗时 ${asrMs}ms`,
    `中间结果 ${partials.length} 条　终稿 ${finals.length} 条`,
    partials.length > 0 ? `中间结果示例：${partials.slice(0, 3).join(" | ")}` : "",
    `内容相似度：${(similarity * 100).toFixed(1)}%（LCS ${common}/${expected.length} 字）`,
    errors.length > 0 ? `错误：${errors.join("；")}` : "",
    "",
    "--- 检查项 ---",
    ...Object.entries(checks).map(([name, ok]) => `${ok ? "✅" : "❌"} ${name}`),
    "",
  ];
  process.stdout.write(`${lines.filter((line) => line.length > 0).join("\n")}\n`);

  return Object.values(checks).every(Boolean) ? 0 : 1;
}

try {
  process.exitCode = await run();
} catch (error) {
  const message = error instanceof ConfigError ? error.message : `ASR 往返失败：${error instanceof Error ? error.message : String(error)}`;
  process.stderr.write(`[example-error] ${message}\n`);
  process.exitCode = 1;
}
