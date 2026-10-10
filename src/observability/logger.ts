/**
 * 结构化日志：单行 JSON，便于后续按字段重算指标（实施计划 §6）。
 *
 * 硬性约束：
 * 1. 所有字段深度脱敏，密钥类键名一律替换为 "[redacted]"。
 * 2. 每条日志可携带关联 ID（eventId / decisionId / taskId / runGeneration / sessionId），
 *    以满足需求规格说明书 §7.6 的可观测性要求。
 *
 * 依据：项目需求规格说明书 §7.6、开发实施计划 §6.1 必备关联字段。
 */
import type { LogLevel } from "../config/env.ts";

export const REDACTED = "[redacted]";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * 键名命中即整体脱敏。注意大小写不敏感，且覆盖常见凭据命名。
 * 刻意不匹配 "author"、"authority" 之外的 "auth" 前缀误伤：使用词边界。
 */
const SECRET_KEY_PATTERN =
  /(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|credential|authorization|cookie|private[_-]?key)/i;

/** 值形态兜底：常见密钥前缀，即使键名正常也不外泄。 */
const SECRET_VALUE_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/;

const MAX_DEPTH = 6;

function redactValue(value: string): string {
  return SECRET_VALUE_PATTERN.test(value) ? REDACTED : value;
}

export function redact(input: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return redactValue(input);
  if (typeof input === "number" || typeof input === "boolean" || typeof input === "bigint") return input;
  if (typeof input === "function" || typeof input === "symbol") return `[${typeof input}]`;
  if (input instanceof Error) {
    return { name: input.name, message: redactValue(input.message), stack: input.stack };
  }
  if (depth >= MAX_DEPTH) return "[max-depth]";

  const asObject = input as object;
  if (seen.has(asObject)) return "[circular]";
  seen.add(asObject);

  if (Array.isArray(input)) {
    return input.slice(0, 100).map((item) => redact(item, depth + 1, seen));
  }

  if (input instanceof Map) {
    return Object.fromEntries(
      [...input.entries()].slice(0, 100).map(([key, value]) => [
        String(key),
        SECRET_KEY_PATTERN.test(String(key)) ? REDACTED : redact(value, depth + 1, seen),
      ]),
    );
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(value, depth + 1, seen);
  }
  return out;
}

export type LogFields = Readonly<Record<string, unknown>>;

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly context?: LogFields;
  /** 输出目标，默认写 stderr（保留 stdout 给业务数据）。 */
  readonly sink?: (line: string) => void;
}

export class Logger {
  public readonly level: LogLevel;
  private readonly context: LogFields;
  private readonly sink: (line: string) => void;

  public constructor(options: LoggerOptions) {
    this.level = options.level;
    this.context = options.context ?? {};
    this.sink = options.sink ?? ((line) => process.stderr.write(`${line}\n`));
  }

  /** 派生携带额外上下文的子日志器（如 taskId / runGeneration）。 */
  public child(fields: LogFields): Logger {
    return new Logger({
      level: this.level,
      context: { ...this.context, ...fields },
      sink: this.sink,
    });
  }

  public debug(event: string, fields?: LogFields): void {
    this.write("debug", event, fields);
  }

  public info(event: string, fields?: LogFields): void {
    this.write("info", event, fields);
  }

  public warn(event: string, fields?: LogFields): void {
    this.write("warn", event, fields);
  }

  public error(event: string, fields?: LogFields): void {
    this.write("error", event, fields);
  }

  public isEnabled(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.level];
  }

  private write(level: LogLevel, event: string, fields?: LogFields): void {
    if (!this.isEnabled(level)) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event,
      ...(redact(this.context) as Record<string, unknown>),
      ...(fields === undefined ? {} : (redact(fields) as Record<string, unknown>)),
    };
    this.sink(JSON.stringify(record));
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return new Logger(options);
}
