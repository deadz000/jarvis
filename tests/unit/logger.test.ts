import { describe, expect, it } from "vitest";

import { createLogger, redact, REDACTED, type LogFields } from "../../src/observability/logger.ts";
import type { LogLevel } from "../../src/config/env.ts";

const FAKE_ANTHROPIC = "sk-ant-fake-abcdef123456";

interface Captured {
  readonly lines: string[];
  readonly records: () => Array<Record<string, unknown>>;
  readonly logger: ReturnType<typeof createLogger>;
}

function capture(level: LogLevel = "debug", context?: LogFields): Captured {
  const lines: string[] = [];
  const logger = createLogger({ level, sink: (line) => lines.push(line), ...(context ? { context } : {}) });
  return {
    lines,
    logger,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** noUncheckedIndexedAccess 下取元素需要显式处理，避免测试里到处是断言。 */
function at(records: Array<Record<string, unknown>>, index: number): Record<string, unknown> {
  const record = records[index];
  if (record === undefined) throw new Error(`没有捕获到第 ${index} 条日志记录`);
  return record;
}

describe("redact", () => {
  it("按键名脱敏：apiKey / token / password 等", () => {
    const input = {
      apiKey: FAKE_ANTHROPIC,
      accessToken: "tok_123",
      password: "hunter2",
      authorization: "Bearer abc.def.ghi",
      nested: { refresh_token: "r1" },
    };

    const output = redact(input) as Record<string, unknown>;

    expect(output["apiKey"]).toBe(REDACTED);
    expect(output["accessToken"]).toBe(REDACTED);
    expect(output["password"]).toBe(REDACTED);
    expect(output["authorization"]).toBe(REDACTED);
    expect((output["nested"] as Record<string, unknown>)["refresh_token"]).toBe(REDACTED);
  });

  it("按值形态兜底：键名正常但值像密钥时也脱敏", () => {
    const output = redact({ note: `key=${FAKE_ANTHROPIC}` }) as Record<string, unknown>;

    expect(output["note"]).toBe(REDACTED);
  });

  it("不误伤统计类字段名（实机踩过的坑：credential* 被整体抹掉）", () => {
    const output = redact({
      detectedProviders: ["deepseek"],
      detectedEnvVars: ["DEEPSEEK_API_KEY"],
      taskId: "task-1",
      runGeneration: 3,
    }) as Record<string, unknown>;

    expect(output["detectedProviders"]).toEqual(["deepseek"]);
    expect(output["detectedEnvVars"]).toEqual(["DEEPSEEK_API_KEY"]);
    expect(output["taskId"]).toBe("task-1");
    expect(output["runGeneration"]).toBe(3);
  });

  it("保留普通字段，处理 Error 与循环引用而不抛错", () => {
    const circular: Record<string, unknown> = { eventId: "e1" };
    circular["self"] = circular;

    const withError = redact({ error: new Error("boom") }) as Record<string, unknown>;
    const cyclic = redact(circular) as Record<string, unknown>;

    expect(withError["error"]).toMatchObject({ name: "Error", message: "boom" });
    expect(cyclic["eventId"]).toBe("e1");
    expect(cyclic["self"]).toBe("[circular]");
  });
});

describe("Logger", () => {
  it("按等级过滤：level=warn 时丢弃 debug/info", () => {
    const { logger, records } = capture("warn");

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(records().map((record) => record["event"])).toEqual(["w", "e"]);
  });

  it("child() 合并上下文且不污染父日志器", () => {
    const { logger, records } = capture("info", { component: "test" });
    const child = logger.child({ taskId: "task-1", runGeneration: 2 });

    child.info("child.event");
    logger.info("parent.event");

    const snapshot = records();
    expect(at(snapshot, 0)["taskId"]).toBe("task-1");
    expect(at(snapshot, 0)["component"]).toBe("test");
    expect(at(snapshot, 1)["taskId"]).toBeUndefined();
  });

  it("输出为单行 JSON，且凭据键不会以明文出现", () => {
    const { logger, lines, records } = capture("info");

    logger.info("probe", { apiKey: FAKE_ANTHROPIC, eventId: "e-1" });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.includes("\n")).toBe(false);
    expect(lines[0]).not.toContain(FAKE_ANTHROPIC);
    const snapshot = records();
    expect(at(snapshot, 0)["apiKey"]).toBe(REDACTED);
    expect(at(snapshot, 0)["eventId"]).toBe("e-1");
  });
});
