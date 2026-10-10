/**
 * 常驻服务入口。
 *
 * M0 范围：配置校验 + 结构化启动日志 + 优雅退出钩子。
 * 事件接入、Master、Scheduler、Worker 尚未实现；run 模式会显式报告未实现范围，
 * 不把「入口能启动」伪装成「常驻服务已具备」。
 *
 * 依据：开发实施计划 §3（M0 交付物）、§9（首版不做清单）。
 */
import { ConfigError, describeConfig, loadConfig, type AppConfig } from "./config/env.ts";
import { createLogger } from "./observability/logger.ts";

const CHECK_FLAG = "--check";
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

  installShutdownHandlers(log);
  log.warn("app.runtime.not_implemented", {
    scope: "M0",
    detail: "常驻事件接入 / Master 决策 / Scheduler / Worker 尚未实现，本轮仅完成工程初始化与 Pi SDK 核验",
    pending: ["M1 单 Agent Runtime PoC", "M2 Worker Runtime Adapter", "M3 确定性 Scheduler"],
  });
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
