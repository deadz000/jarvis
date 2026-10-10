import { describe, expect, it } from "vitest";

import {
  assertModelCredentials,
  ConfigError,
  describeConfig,
  loadConfig,
  PROVIDER_CREDENTIALS,
} from "../../src/config/env.ts";

const FAKE_KEY = "sk-ant-fake-000111222333";

describe("loadConfig", () => {
  it("提供默认值：info 日志、当前工作目录、无固定模型", () => {
    const config = loadConfig({});

    expect(config.logLevel).toBe("info");
    expect(config.workspace).toBe(process.cwd());
    expect(config.modelProvider).toBeUndefined();
    expect(config.modelId).toBeUndefined();
    expect(config.thinkingLevel).toBeUndefined();
    expect(config.credentials.hasAny).toBe(false);
  });

  it("拒绝非法 JARVIS_LOG_LEVEL，而不是静默回退", () => {
    expect(() => loadConfig({ JARVIS_LOG_LEVEL: "verbose" })).toThrow(ConfigError);
  });

  it("拒绝非法 JARVIS_THINKING_LEVEL", () => {
    expect(() => loadConfig({ JARVIS_THINKING_LEVEL: "turbo" })).toThrow(ConfigError);
  });

  it("JARVIS_MODEL_PROVIDER 与 JARVIS_MODEL_ID 必须成对设置", () => {
    expect(() => loadConfig({ JARVIS_MODEL_PROVIDER: "deepseek" })).toThrow(ConfigError);
    expect(() => loadConfig({ JARVIS_MODEL_ID: "deepseek-chat" })).toThrow(ConfigError);
    expect(loadConfig({ JARVIS_MODEL_PROVIDER: "deepseek", JARVIS_MODEL_ID: "deepseek-chat" }).modelId).toBe(
      "deepseek-chat",
    );
  });

  it("只登记检测到的 provider，空字符串视为未设置", () => {
    const config = loadConfig({ DEEPSEEK_API_KEY: FAKE_KEY, OPENAI_API_KEY: "   " });

    expect(config.credentials.hasAny).toBe(true);
    expect(config.credentials.detectedProviders).toEqual(["deepseek"]);
  });

  it("describeConfig 不包含任何凭据明文，但保留检测结果", () => {
    const config = loadConfig({ DEEPSEEK_API_KEY: FAKE_KEY, JARVIS_LOG_LEVEL: "warn" });
    const snapshot = describeConfig(config);
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain(FAKE_KEY);
    expect(serialized).not.toContain("DEEPSEEK_API_KEY_VALUE");
    expect(snapshot["detectedProviders"]).toEqual(["deepseek"]);
    expect(snapshot["detectedEnvVars"]).toEqual(["DEEPSEEK_API_KEY"]);
    expect(snapshot["logLevel"]).toBe("warn");
  });

  it("assertModelCredentials 在缺凭据时报错，且错误信息不含密钥值", () => {
    expect(() => assertModelCredentials(loadConfig({}))).toThrow(ConfigError);
    expect(() => assertModelCredentials(loadConfig({ DEEPSEEK_API_KEY: FAKE_KEY }))).not.toThrow();
  });

  it("登记的凭据变量名唯一，避免重复统计", () => {
    const envVars = PROVIDER_CREDENTIALS.map((entry) => entry.envVar);
    const providers = PROVIDER_CREDENTIALS.map((entry) => entry.provider);

    expect(new Set(envVars).size).toBe(envVars.length);
    expect(new Set(providers).size).toBe(providers.length);
  });
});
