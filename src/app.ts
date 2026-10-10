/**
 * 常驻服务入口。
 *
 * M0 范围：配置校验 + 结构化启动日志 + 优雅退出钩子。
 * 事件接入、Master、Scheduler、Worker 尚未实现；run 模式会显式报告未实现范围，
 * 不把「入口能启动」伪装成「常驻服务已具备」。
 *
 * 依据：开发实施计划 §3（M0 交付物）、§9（首版不做清单）。
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DashScopeAsrAdapter } from "./adapters/dashscope/asr-adapter.ts";
import { DashScopeTtsAdapter } from "./adapters/dashscope/tts-adapter.ts";
import { DemoServer } from "./adapters/http/demo-server.ts";
import { selectModel } from "./adapters/pi/model-selection.ts";
import {
  DeterministicScreenSummarizer,
  FallbackScreenSummarizer,
  OpenAiResponsesVisionSummarizer,
} from "./adapters/vision/openai-responses-vision-summarizer.ts";
import { WindowsScreenCapture } from "./adapters/windows/windows-screen-capture.ts";
import { WindowsScreenImage } from "./adapters/windows/windows-screen-image.ts";
import { SqliteStore } from "./adapters/sqlite/sqlite-store.ts";
import type { ScreenFilterOptions } from "./application/screen/screen-filter.ts";
import type { PersistencePort } from "./application/storage/store-port.ts";
import { JarvisRuntime, ASR_SAMPLE_RATE, type ScreenWiringOptions } from "./application/runtime.ts";
import type { TtsPort } from "./application/delivery/tts-port.ts";
import type { AsrPort } from "./application/input/asr-port.ts";
import {
  assertModelCredentials,
  ConfigError,
  DEFAULT_MODELS_RELATIVE_PATH,
  describeConfig,
  loadConfig,
  type AppConfig,
} from "./config/env.ts";
import { createLogger, type Logger } from "./observability/logger.ts";

const CHECK_FLAG = "--check";
const DEMO_FLAG = "--demo";
/** 演示端口；可用 JARVIS_DEMO_PORT 覆盖。 */
const DEFAULT_DEMO_PORT = 7717;
const SIGNALS = ["SIGINT", "SIGTERM"] as const;

function installShutdownHandlers(log: ReturnType<typeof createLogger>): void {
  for (const signal of SIGNALS) {
    process.once(signal, () => {
      // M0 无长驻资源；后续里程碑在此接入事件通道与 Worker 的优雅关闭。
      log.info("app.shutdown", { signal });
      process.exitCode = 0;
    });
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const checkOnly = argv.includes(CHECK_FLAG);
  const demoOnly = argv.includes(DEMO_FLAG);

  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : `配置加载失败：${String(error)}`;
    process.stderr.write(`[config-error] ${message}\n`);
    return 1;
  }

  const log = createLogger({ level: config.logLevel, context: { component: "app" } });
  log.info("app.startup", {
    mode: checkOnly ? "check" : "run",
    node: process.version,
    pid: process.pid,
    config: describeConfig(config),
  });

  if (!config.credentials.hasAny) {
    log.warn("credentials.missing", {
      hint: "复制 .env.example 为 .env 并填入至少一个 provider 的 API Key（.env 不会入库）",
      blocks: ["真实模型调用", "M1 单 Agent Runtime PoC"],
    });
  }

  if (checkOnly) {
    log.info("app.check.completed", { status: "ok", modelCallsPossible: config.credentials.hasAny });
    return 0;
  }

  if (demoOnly) return runDemo(config, log);

  installShutdownHandlers(log);

  // 诚实报告真实范围：引擎能力已就绪，但**尚未组装成常驻服务与可交互入口**。
  log.warn("app.runtime.not_implemented", {
    scope: "M0–M4 已完成；常驻服务与界面未实现",
    implemented: [
      "确定性 Scheduler（状态机 / 代次隔离 / 取消竞态 / FIFO 准入 / 幂等键）",
      "WorkerRuntime 端口 + 真实 Pi Worker 适配器（每 Task 独立 Session）",
      "Master 决策面（两维版本号 / 解析与校验分离 / 逐动作校验 / 超时降级）",
    ],
    missing: [
      "常驻事件接入（HTTP / WebSocket 服务）",
      "最小任务面板（结果交付与待交付队列可视化）",
      "ASR / TTS 与音频仲裁",
      "持久化、记忆与故障恢复",
    ],
    next: "实施计划 §8 的首个可演示增量 Milestone Alpha：聊天输入 + 任务面板 + 并行 Worker + 单任务取消 + 模拟音频仲裁",
    note: "当前各能力通过 npm run example:* 的实测脚本驱动，没有可交互入口",
  });
  return 0;
}

/** 真实 TTS 的输出采样率；与前端 AudioContext 构造一致，避免重采样。 */
const TTS_SAMPLE_RATE = 24_000;

/**
 * 组合根：根据配置决定用真实 TTS 还是模拟音频。
 * 运行时本身不接触密钥，只有这里读取进程环境。
 */
function buildTtsAdapter(config: AppConfig, log: Logger): TtsPort | undefined {
  const voice = config.voice;

  if (!voice.enabled) {
    log.info("app.voice.disabled", {
      hint: "设置 JARVIS_VOICE_ENABLED=1 启用真实 TTS；当前使用模拟音频分片（零成本）",
    });
    return undefined;
  }

  const apiKey = process.env["DASHSCOPE_API_KEY"];
  if (
    apiKey === undefined ||
    voice.workspaceId === undefined ||
    voice.ttsModel === undefined ||
    voice.ttsVoice === undefined
  ) {
    log.warn("app.voice.incomplete", {
      missing: voice.missing,
      hint: "语音已启用但配置不完整，回退为模拟音频",
    });
    return undefined;
  }

  log.info("app.voice.enabled", {
    model: voice.ttsModel,
    voice: voice.ttsVoice,
    region: voice.region,
    format: "pcm",
    sampleRate: TTS_SAMPLE_RATE,
  });

  return new DashScopeTtsAdapter({
    apiKey,
    workspaceId: voice.workspaceId,
    model: voice.ttsModel,
    voice: voice.ttsVoice,
    region: voice.region,
    format: "pcm",
    sampleRate: TTS_SAMPLE_RATE,
    logger: log,
  });
}

/**
 * 组合根：语音输入侧。与 TTS 同样的原则 —— 只有这里读密钥。
 */
function buildAsrAdapter(config: AppConfig, log: Logger): AsrPort | undefined {
  const voice = config.voice;

  if (!voice.enabled) return undefined;

  const apiKey = process.env["DASHSCOPE_API_KEY"];
  if (apiKey === undefined || voice.workspaceId === undefined || voice.asrModel === undefined) {
    log.warn("app.asr.incomplete", {
      missing: voice.missing,
      hint: "ASR 配置不完整，面板将不显示麦克风",
    });
    return undefined;
  }

  log.info("app.asr.enabled", {
    model: voice.asrModel,
    region: voice.region,
    sampleRate: ASR_SAMPLE_RATE,
  });

  return new DashScopeAsrAdapter({
    apiKey,
    workspaceId: voice.workspaceId,
    model: voice.asrModel,
    region: voice.region,
    sampleRate: ASR_SAMPLE_RATE,
    logger: log,
  });
}

/** 从 models.json 读取 provider 的 baseUrl（摘要走 OpenAI 兼容端点，需要它）。 */
function readProviderBaseUrl(config: AppConfig): string | undefined {
  interface ModelsFile {
    readonly providers?: Record<string, { readonly baseUrl?: string }>;
  }
  try {
    const raw = readFileSync(
      join(config.workspace, config.modelsPath ?? DEFAULT_MODELS_RELATIVE_PATH),
      "utf8",
    );
    const parsed = JSON.parse(raw) as ModelsFile;
    if (config.modelProvider === undefined) return undefined;
    return parsed.providers?.[config.modelProvider]?.baseUrl;
  } catch {
    return undefined;
  }
}

/**
 * 组合根：屏幕观察。
 *
 * **默认关闭** —— 这里只负责把端口装好并报告可用性，是否开启由用户显式决定
 * （面板开关 / `POST /api/screen`）。
 */
function buildScreenWiring(config: AppConfig, log: Logger): ScreenWiringOptions | undefined {
  if (process.platform !== "win32") {
    log.info("app.screen.unsupported", { platform: process.platform });
    return undefined;
  }

  const apiKey = process.env["JARVIS_MODEL_API_KEY"];
  const baseUrl = readProviderBaseUrl(config);
  const screenOverrides = readScreenOverrides();
  const pollMs = readScreenPollMs();
  if (apiKey === undefined || baseUrl === undefined || config.modelId === undefined) {
    log.warn("app.screen.unavailable", {
      hint: "无法确定多模态摘要所需的端点/密钥/模型，屏幕观察不可用",
      hasKey: apiKey !== undefined,
      hasBaseUrl: baseUrl !== undefined,
      hasModelId: config.modelId !== undefined,
    });
    return undefined;
  }

  log.info("app.screen.available", {
    baseUrl,
    model: config.modelId,
    thresholdsOverridden: screenOverrides ?? null,
    pollIntervalMs: pollMs ?? null,
    note: "默认关闭，需显式开启；摘要会把一张约 35KB 的 JPEG 发送给模型",
  });

  return {
    capture: new WindowsScreenCapture(config.workspace, { logger: log }),
    image: new WindowsScreenImage(config.workspace, { logger: log }),
    summarizer: new FallbackScreenSummarizer(
      new OpenAiResponsesVisionSummarizer({
        baseUrl,
        apiKey,
        model: config.modelId,
        logger: log,
      }),
      new DeterministicScreenSummarizer(),
      log,
    ),
    ...(screenOverrides === undefined ? {} : { filterOptions: screenOverrides }),
    ...(pollMs === undefined ? {} : { pollIntervalMs: pollMs }),
  };
}

/**
 * 屏幕过滤阈值的环境覆盖。
 *
 * 默认值是产品负责人确认的规格（汉明 ≥8 / 色块 ≥25% / 节流 5s）。
 * 允许覆盖有两个正当理由：
 * 1. 这些是**未经验证的启发式**，M8 需要用真实数据重新标定；
 * 2. 验证摘要链路时需要临时放宽阈值（静止画面永远不会触发双条件）。
 */
function readScreenOverrides(): ScreenFilterOptions | undefined {
  const overrides: {
    minHammingDistance?: number;
    minBlockChangeRatio?: number;
    throttleMs?: number;
  } = {};

  const hamming = Number(process.env["JARVIS_SCREEN_MIN_HAMMING"]);
  const hammingRaw = process.env["JARVIS_SCREEN_MIN_HAMMING"];
  if (hammingRaw !== undefined && Number.isFinite(hamming) && hamming >= 0) {
    overrides.minHammingDistance = hamming;
  }

  const ratioRaw = process.env["JARVIS_SCREEN_MIN_BLOCK_RATIO"];
  const ratio = Number(ratioRaw);
  if (ratioRaw !== undefined && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1) {
    overrides.minBlockChangeRatio = ratio;
  }

  const throttleRaw = process.env["JARVIS_SCREEN_THROTTLE_MS"];
  const throttle = Number(throttleRaw);
  if (throttleRaw !== undefined && Number.isFinite(throttle) && throttle >= 0) {
    overrides.throttleMs = throttle;
  }

  return Object.keys(overrides).length === 0 ? undefined : overrides;
}

/** 屏幕轮询间隔的环境覆盖（M8 调参用；默认与节流一致 5s）。 */
function readScreenPollMs(): number | undefined {
  const raw = process.env["JARVIS_SCREEN_POLL_MS"];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 100) return undefined;
  return value;
}

/**
 * 组合根：持久化（M7）。
 *
 * **持久化失败不能阻止应用启动** —— 退回纯内存模式，但要把这件事说出来，
 * 而不是静默降级（否则用户会以为历史被保存了）。
 */
function buildStore(config: AppConfig, log: Logger): PersistencePort | undefined {
  try {
    const dataDir = process.env["JARVIS_DATA_DIR"] ?? join(config.workspace, ".data");
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, "jarvis.db");
    const store = new SqliteStore({ path });
    log.info("app.store.ready", {
      path,
      note: "node:sqlite（实验性 API，会打印 ExperimentalWarning）",
    });
    return store;
  } catch (error) {
    log.warn("app.store.unavailable", {
      error: error instanceof Error ? error.message : String(error),
      note: "持久化不可用，将以纯内存模式运行：重启后历史与恢复核对都会丢失",
    });
    return undefined;
  }
}

/**
 * 演示模式（Milestone Alpha）：启动可视化面板，把聊天 → Master → Scheduler →
 * 真实 Worker → 结果 → 交付队列 → 音频仲裁（模拟或真实 TTS）整条链路跑起来。
 */
async function runDemo(config: AppConfig, log: Logger): Promise<number> {
  assertModelCredentials(config);
  const selected = await selectModel(config);
  log.info("app.demo.model_selected", {
    model: `${selected.model.provider}/${selected.model.id}`,
    availableCount: selected.availableCount,
  });

  const tts = buildTtsAdapter(config, log);
  const asr = buildAsrAdapter(config, log);
  const screen = buildScreenWiring(config, log);
  const store = buildStore(config, log);
  const runtime = new JarvisRuntime({
    config,
    selected,
    logger: log,
    ...(tts === undefined ? {} : { tts }),
    ...(asr === undefined ? {} : { asr }),
    ...(screen === undefined ? {} : { screen }),
    ...(store === undefined ? {} : { store }),
  });
  const rawPort = process.env["JARVIS_DEMO_PORT"];
  const port = rawPort === undefined ? DEFAULT_DEMO_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`JARVIS_DEMO_PORT 非法：${String(rawPort)}`);
  }

  const server = new DemoServer({
    runtime,
    publicDir: join(config.workspace, "public"),
    port,
    logger: log,
  });
  const started = await server.start();

  log.info("app.demo.ready", { url: started.url, publicDir: join(config.workspace, "public") });
  process.stdout.write(
    `\n  ✅ 演示面板已就绪：${started.url}\n` +
      `     在浏览器中打开它，然后在左侧输入一句话。\n` +
      `     模型：${selected.model.provider}/${selected.model.id}　并发上限：${config.maxConcurrentTasks}　Master 超时：${config.masterTimeoutMs}ms\n` +
      `     Ctrl+C 结束。\n\n`,
  );

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      resolve();
    };
    for (const signal of SIGNALS) process.once(signal, shutdown);
  });

  log.info("app.demo.stopping", {});
  await server.stop();
  await runtime.dispose();
  log.info("app.demo.stopped", {});
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
