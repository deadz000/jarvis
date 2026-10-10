/**
 * 运行配置：只从进程环境读取，负责校验与归一化。
 *
 * 硬性约束（实施计划 M0 出口条件）：凭据值绝不进入返回值、日志和错误信息，
 * 配置层只保留「是否检测到某 provider 的凭据」这一事实。
 *
 * 依据：项目需求规格说明书 §7.1/§7.6、开发实施计划 M0「配置加载」。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

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

/**
 * 自定义 OpenAI 兼容端点的凭据变量。
 * 它不被 Pi 直接识别，而是通过 config/models.json 里的 `apiKey: "$JARVIS_MODEL_API_KEY"`
 * 插值后使用（见 Pi docs/models.md「Configure a compatible endpoint」）。
 */
export const CUSTOM_ENDPOINT_KEY_ENV_VAR = "JARVIS_MODEL_API_KEY";

/** 自定义端点声明文件的默认位置（相对 workspace）。 */
export const DEFAULT_MODELS_RELATIVE_PATH = join("config", "models.json");

/** 并发上限默认值：仅作为可配置项的初值，不是性能结论。 */
export const DEFAULT_MAX_CONCURRENT_TASKS = 4;

/**
 * Master 决策超时。超时按降级策略处理：**不执行任何动作**，不猜测意图。
 * 30s 是暂定值，必须按实测模型延迟重新标定（实施计划 M4：具体超时值基于模型实测配置）。
 */
export const DEFAULT_MASTER_TIMEOUT_MS = 30_000;

export interface CredentialStatus {
  /** 检测到凭据的 provider 名（不含任何密钥内容）。 */
  readonly detectedProviders: readonly string[];
  /** 检测到凭据的环境变量名（同样不含值）。 */
  readonly detectedEnvVars: readonly string[];
  /** 至少检测到一个可用于模型调用的凭据。 */
  readonly hasAny: boolean;
}

export interface AppConfig {
  readonly logLevel: LogLevel;
  /** Worker / Master Session 的工作目录。 */
  readonly workspace: string;
  readonly modelProvider: string | undefined;
  readonly modelId: string | undefined;
  readonly thinkingLevel: ThinkingLevel | undefined;
  /** 自定义端点声明文件（models.json）路径；不存在时为 undefined。 */
  readonly modelsPath: string | undefined;
  /** 并发执行上限。配置化，不沿用旧项目的硬编码值。 */
  readonly maxConcurrentTasks: number;
  /** Master 决策超时（毫秒）；超时 → 空计划，不改动任何状态。 */
  readonly masterTimeoutMs: number;
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

function parseEnum<T extends string>(
  raw: string,
  allowed: readonly T[],
  envName: string,
): T {
  const found = allowed.find((candidate) => candidate === raw);
  if (found === undefined) {
    throw new ConfigError(`${envName} 非法：${raw}（可选：${allowed.join(" / ")}）`);
  }
  return found;
}

function parseLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = readOptional(env, "JARVIS_LOG_LEVEL");
  return raw === undefined ? "info" : parseEnum(raw, LOG_LEVELS, "JARVIS_LOG_LEVEL");
}

function parseThinkingLevel(env: NodeJS.ProcessEnv): ThinkingLevel | undefined {
  const raw = readOptional(env, "JARVIS_THINKING_LEVEL");
  return raw === undefined ? undefined : parseEnum(raw, THINKING_LEVELS, "JARVIS_THINKING_LEVEL");
}

function parseMaxConcurrentTasks(env: NodeJS.ProcessEnv): number {
  const raw = readOptional(env, "JARVIS_MAX_CONCURRENT_TASKS");
  if (raw === undefined) return DEFAULT_MAX_CONCURRENT_TASKS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConfigError(`JARVIS_MAX_CONCURRENT_TASKS 必须是 >= 1 的整数，收到：${raw}`);
  }
  return parsed;
}

function parseModelsPath(env: NodeJS.ProcessEnv, workspace: string): string | undefined {
  const configured = readOptional(env, "JARVIS_MODELS_PATH");
  if (configured !== undefined) return configured;
  const fallback = join(workspace, DEFAULT_MODELS_RELATIVE_PATH);
  return existsSync(fallback) ? fallback : undefined;
}

function parseMasterTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = readOptional(env, "JARVIS_MASTER_TIMEOUT_MS");
  if (raw === undefined) return DEFAULT_MASTER_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConfigError(`JARVIS_MASTER_TIMEOUT_MS 必须是 >= 1 的整数，收到：${raw}`);
  }
  return parsed;
}

function detectCredentials(env: NodeJS.ProcessEnv, modelProvider: string | undefined): CredentialStatus {
  const detectedProviders: string[] = [];
  const detectedEnvVars: string[] = [];

  for (const entry of PROVIDER_CREDENTIALS) {
    if (readOptional(env, entry.envVar) === undefined) continue;
    detectedProviders.push(entry.provider);
    detectedEnvVars.push(entry.envVar);
  }

  if (readOptional(env, CUSTOM_ENDPOINT_KEY_ENV_VAR) !== undefined) {
    detectedProviders.push(modelProvider ?? "custom-endpoint");
    detectedEnvVars.push(CUSTOM_ENDPOINT_KEY_ENV_VAR);
  }

  return { detectedProviders, detectedEnvVars, hasAny: detectedProviders.length > 0 };
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
    modelsPath: parseModelsPath(env, workspace),
    maxConcurrentTasks: parseMaxConcurrentTasks(env),
    masterTimeoutMs: parseMasterTimeoutMs(env),
    credentials: detectCredentials(env, modelProvider),
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
    modelsPath: config.modelsPath ?? null,
    maxConcurrentTasks: config.maxConcurrentTasks,
    masterTimeoutMs: config.masterTimeoutMs,
    detectedProviders: config.credentials.detectedProviders,
    detectedEnvVars: config.credentials.detectedEnvVars,
  };
}

/**
 * 真实模型调用前的准入检查。错误信息只说明缺失的变量名，不回显任何值。
 */
export function assertModelCredentials(config: AppConfig): void {
  if (config.credentials.hasAny) return;
  const expected = [...PROVIDER_CREDENTIALS.map((entry) => entry.envVar), CUSTOM_ENDPOINT_KEY_ENV_VAR].join(
    " 或 ",
  );
  throw new ConfigError(
    `未检测到任何模型凭据。请复制 .env.example 为 .env 并设置 ${expected}（.env 不会被提交）。`,
  );
}
