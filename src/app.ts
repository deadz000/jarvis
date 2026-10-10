/**
 * 常驻服务入口。
 *
 * M0 范围：配置校验 + 结构化启动日志 + 优雅退出钩子。
 * 事件接入、Master、Scheduler、Worker 尚未实现；run 模式会显式报告未实现范围，
 * 不把「入口能启动」伪装成「常驻服务已具备」。
 *
 * 依据：开发实施计划 §3（M0 交付物）、§9（首版不做清单）。
 */
import { join } from "node:path";

import { DashScopeAsrAdapter } from "./adapters/dashscope/asr-adapter.ts";
import { DashScopeTtsAdapter } from "./adapters/dashscope/tts-adapter.ts";
import { DemoServer } from "./adapters/http/demo-server.ts";
import { selectModel } from "./adapters/pi/model-selection.ts";
import { JarvisRuntime, ASR_SAMPLE_RATE } from "./application/runtime.ts";
import type { TtsPort } from "./application/delivery/tts-port.ts";
import type { AsrPort } from "./application/input/asr-port.ts";
import { assertModelCredentials, ConfigError, describeConfig, loadConfig, type AppConfig } from "./config/env.ts";
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
  const runtime = new JarvisRuntime({
    config,
    selected,
    logger: log,
    ...(tts === undefined ? {} : { tts }),
    ...(asr === undefined ? {} : { asr }),
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
