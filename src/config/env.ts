/**
 * 运行配置：只从进程环境读取，负责校验与归一化。
 *
 * 硬性约束（实施计划 M0 出口条件）：凭据值绝不进入返回值、日志和错误信息，
 * 配置层只保留「是否检测到某 provider 的凭据」这一布尔事实。
 *
 * 依据：项目需求规格说明书 §7.1/§7.6、开发实施计划 M0「配置加载」。
 */

/** 日志等级，与 observability/logger 共用。 */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** 推理等级，取值与 Pi SDK 的 thinkingLevel 一致。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * Pi SDK 从进程环境读取的 provider 凭据变量（来源：Pi docs/providers.md）。
 * 这里只登记本项目可能使用的子集，新增 provider 时按需扩充。
 */
export const PROVIDER_CREDENTIALS: ReadonlyArray<{ provider: string; envVar: string }> = [
  { provider: "deepseek", envVar: "DEEPSEEK_API_KEY" },
  { provider: "anthropic", envVar: "ANTHROPIC_API_KEY" },
  { provider: "openai", envVar: "OPENAI_API_KEY" },
  { provider: "gemini", envVar: "GEMINI_API_KEY" },
  { provider: "openrouter", envVar: "OPENROUTER_API_KEY" },
  { provider: "xai", envVar: "XAI_API_KEY" },
  { provider: "groq", envVar: "GROQ_API_KEY" },
  { provider: "mistral", envVar: "MISTRAL_API_KEY" },
  { provider: "moonshot", envVar: "MOONSHOT_API_KEY" },
];

export interface CredentialStatus {
  /** 检测到凭据的 provider 名（不含任何密钥内容）。 */
  readonly detectedProviders: readonly string[];
  /** 至少检测到一个 provider 凭据。 */
  readonly hasAny: boolean;
}

export interface AppConfig {
  readonly logLevel: LogLevel;
  /** Worker / Master Session 的工作目录。 */
  readonly workspace: string;
  readonly modelProvider: string | undefined;
  readonly modelId: string | undefined;
  readonly thinkingLevel: ThinkingLevel | undefined;
  readonly credentials: CredentialStatus;
}

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function readOptional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = readOptional(env, "JARVIS_LOG_LEVEL");
  if (raw === undefined) return "info";
  const found = LOG_LEVELS.find((level) => level === raw);
  if (found === undefined) {
    throw new ConfigError(`JARVIS_LOG_LEVEL 非法：${raw}（可选：${LOG_LEVELS.join(" / ")}）`);
  }
  return found;
}

function parseThinkingLevel(env: NodeJS.ProcessEnv): ThinkingLevel | undefined {
  const raw = readOptional(env, "JARVIS_THINKING_LEVEL");
  if (raw === undefined) return undefined;
  const found = THINKING_LEVELS.find((level) => level === raw);
  if (found === undefined) {
    throw new ConfigError(`JARVIS_THINKING_LEVEL 非法：${raw}（可选：${THINKING_LEVELS.join(" / ")}）`);
  }
  return found;
}

function detectCredentials(env: NodeJS.ProcessEnv): CredentialStatus {
  const detectedProviders = PROVIDER_CREDENTIALS.filter(
    (entry) => readOptional(env, entry.envVar) !== undefined,
  ).map((entry) => entry.provider);
  return { detectedProviders, hasAny: detectedProviders.length > 0 };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const workspace = readOptional(env, "JARVIS_WORKSPACE") ?? process.cwd();
  const modelProvider = readOptional(env, "JARVIS_MODEL_PROVIDER");
  const modelId = readOptional(env, "JARVIS_MODEL_ID");

  if ((modelProvider === undefined) !== (modelId === undefined)) {
    throw new ConfigError("JARVIS_MODEL_PROVIDER 与 JARVIS_MODEL_ID 必须同时设置或同时留空");
  }

  return {
    logLevel: parseLogLevel(env),
    workspace,
    modelProvider,
    modelId,
    thinkingLevel: parseThinkingLevel(env),
    credentials: detectCredentials(env),
  };
}

/**
 * 可安全写进日志的配置快照：不含任何凭据值。
 *
 * 注意：字段名刻意避开 token / secret / credential 等词，否则会被
 * logger 的键名脱敏规则整体替换（统计信息不需要脱敏，误伤会丢失诊断能力）。
 */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    logLevel: config.logLevel,
    workspace: config.workspace,
    modelProvider: config.modelProvider ?? null,
    modelId: config.modelId ?? null,
    thinkingLevel: config.thinkingLevel ?? null,
    detectedProviders: config.credentials.detectedProviders,
    detectedEnvVars: PROVIDER_CREDENTIALS.filter((entry) =>
      config.credentials.detectedProviders.includes(entry.provider),
    ).map((entry) => entry.envVar),
  };
}

/**
 * 真实模型调用前的准入检查。错误信息只说明缺失的变量名，不回显任何值。
 */
export function assertModelCredentials(config: AppConfig): void {
  if (config.credentials.hasAny) return;
  const expected = PROVIDER_CREDENTIALS.map((entry) => entry.envVar).join(" 或 ");
  throw new ConfigError(
    `未检测到任何模型凭据。请复制 .env.example 为 .env 并设置 ${expected}（.env 不会被提交）。`,
  );
}
