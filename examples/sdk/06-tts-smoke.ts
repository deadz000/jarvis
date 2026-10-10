/**
 * TTS 冒烟实测：对**真实**阿里云百炼服务发起一次流式语音合成。
 *
 * 验证链：握手鉴权 → run-task → task-started → continue-task/finish-task →
 * 收到裸 binary 音频分片 → task-finished。
 *
 * 同时做一个**格式校准**：官方参数表未给 PCM 位深字段（属推断为 16-bit LE 单声道），
 * 因此按「字节数 ÷ (采样率 × 2)」反推音频时长，与文本长度对照 ——
 * 若比值明显不合理（例如差 2 倍或 4 倍），说明位深假设需要修正。
 *
 * 用法：npm run example:tts -- "要说的话"
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DashScopeTtsAdapter } from "../../src/adapters/dashscope/tts-adapter.ts";
import { ConfigError, loadConfig } from "../../src/config/env.ts";
import { createLogger } from "../../src/observability/logger.ts";

const DEFAULT_TEXT =
  "你好，我是 jarvis 的任务调度助手。这是一次真实的语音合成测试，用来验证流式音频分片与播放代次。";

async function run(): Promise<number> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, context: { component: "examples.tts.smoke" } });
  const voice = config.voice;

  if (
    !voice.keyDetected ||
    voice.workspaceId === undefined ||
    voice.ttsModel === undefined ||
    voice.ttsVoice === undefined
  ) {
    throw new ConfigError(`语音配置不完整，缺少：${voice.missing.join("、")}`);
  }
  const apiKey = process.env["DASHSCOPE_API_KEY"];
  if (apiKey === undefined) throw new ConfigError("DASHSCOPE_API_KEY 未设置");

  const text = process.argv.slice(2).join(" ").trim() || DEFAULT_TEXT;
  const sampleRate = 24_000;
  const adapter = new DashScopeTtsAdapter({
    apiKey,
    workspaceId: voice.workspaceId,
    model: voice.ttsModel,
    voice: voice.ttsVoice,
    region: voice.region,
    format: "pcm",
    sampleRate,
    logger: log,
  });

  log.info("tts.smoke.start", {
    host: `${voice.workspaceId}.${voice.region}`,
    model: voice.ttsModel,
    voice: voice.ttsVoice,
    textLength: text.length,
    sampleRate,
  });

  const startedAt = Date.now();
  const buffers: Buffer[] = [];
  let firstChunkAt: number | undefined;
  let chunkCount = 0;
  let failure: string | undefined;

  try {
    for await (const chunk of adapter.synthesize({ text })) {
      chunkCount += 1;
      firstChunkAt ??= Date.now();
      buffers.push(chunk.audio);
    }
  } catch (caught) {
    failure = caught instanceof Error ? caught.message : String(caught);
  }

  const totalBytes = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const bytesPerSecond = sampleRate * 2; // 假设 16-bit 单声道
  const audioSeconds = totalBytes / bytesPerSecond;
  const wallMs = Date.now() - startedAt;
  const firstAudioMs = firstChunkAt === undefined ? null : firstChunkAt - startedAt;
  const secondsPerChar = audioSeconds / Math.max(1, text.length);

  const outDir = join(config.workspace, ".tmp");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, "tts-smoke.pcm");
  if (totalBytes > 0) await writeFile(outPath, Buffer.concat(buffers));

  const checks: Record<string, boolean> = {
    未报错: failure === undefined,
    收到音频分片: chunkCount > 0,
    "首音频延迟 < 5s": firstAudioMs !== null && firstAudioMs < 5_000,
    "音频时长 > 0.5s": audioSeconds > 0.5,
    "时长与文本长度相称（0.05~0.6 秒/字）": secondsPerChar > 0.05 && secondsPerChar < 0.6,
  };

  const report = {
    model: voice.ttsModel,
    voice: voice.ttsVoice,
    region: voice.region,
    textLength: text.length,
    chunkCount,
    totalBytes,
    firstAudioMs,
    audioSeconds: Number(audioSeconds.toFixed(2)),
    secondsPerChar: Number(secondsPerChar.toFixed(3)),
    wallMs,
    error: failure ?? null,
  };
  log.info("tts.smoke.verdict", report);

  const lines = [
    "",
    "===== TTS 冒烟实测结论 =====",
    `模型 ${voice.ttsModel}　音色 ${voice.ttsVoice}　地域 ${voice.region}`,
    `文本长度 ${text.length} 字　分片数 ${chunkCount}　总字节 ${totalBytes}`,
    `首音频延迟 ${firstAudioMs ?? "n/a"}ms　总耗时 ${wallMs}ms`,
    `按 16-bit 单声道反推音频时长 ≈ ${audioSeconds.toFixed(2)}s（${secondsPerChar.toFixed(3)} 秒/字）`,
    totalBytes > 0 ? `PCM 已写入：${outPath}` : "未写出音频",
    totalBytes > 0 ? `试听：ffplay -f s16le -ar ${sampleRate} -ac 1 "${outPath}"` : "",
    failure === undefined ? "" : `错误：${failure}`,
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
  const message =
    error instanceof ConfigError
      ? error.message
      : `TTS 冒烟失败：${error instanceof Error ? error.message : String(error)}`;
  process.stderr.write(`[example-error] ${message}\n`);
  process.exitCode = 1;
}
