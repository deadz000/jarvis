import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertModelCredentials,
  ConfigError,
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_MODELS_RELATIVE_PATH,
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

describe("loadConfig — 调度与自定义端点", () => {
  it("并发上限默认 4，并可通过环境变量覆盖", () => {
    expect(loadConfig({}).maxConcurrentTasks).toBe(DEFAULT_MAX_CONCURRENT_TASKS);
    expect(loadConfig({ JARVIS_MAX_CONCURRENT_TASKS: "7" }).maxConcurrentTasks).toBe(7);
  });

  it("并发上限非法时抛 ConfigError，不静默回退", () => {
    for (const bad of ["0", "-1", "2.5", "abc"]) {
      expect(() => loadConfig({ JARVIS_MAX_CONCURRENT_TASKS: bad })).toThrow(ConfigError);
    }
  });

  it("自定义端点凭据计入检测结果，标签使用配置的 provider 名", () => {
    const config = loadConfig({
      JARVIS_MODEL_API_KEY: FAKE_KEY,
      JARVIS_MODEL_PROVIDER: "cf-fan",
      JARVIS_MODEL_ID: "deepseek-flash",
      JARVIS_MODELS_PATH: "config/models.json",
    });

    expect(config.credentials.hasAny).toBe(true);
    expect(config.credentials.detectedProviders).toEqual(["cf-fan"]);
    expect(config.credentials.detectedEnvVars).toEqual(["JARVIS_MODEL_API_KEY"]);
    expect(config.modelsPath).toBe("config/models.json");
    expect(() => assertModelCredentials(config)).not.toThrow();
  });

  it("自定义端点凭据的原始值不会出现在脱敏快照中", () => {
    const config = loadConfig({ JARVIS_MODEL_API_KEY: FAKE_KEY });
    const serialized = JSON.stringify(describeConfig(config));

    expect(serialized).not.toContain(FAKE_KEY);
    expect(config.credentials.detectedEnvVars).toEqual(["JARVIS_MODEL_API_KEY"]);
  });

  it("未显式配置 models.json 时，采用 workspace 下的默认位置（存在才采用）", () => {
    const config = loadConfig({});
    expect(config.modelsPath).toBe(join(process.cwd(), DEFAULT_MODELS_RELATIVE_PATH));

    const missing = loadConfig({ JARVIS_WORKSPACE: join(process.cwd(), "__no_such_workspace__") });
    expect(missing.modelsPath).toBeUndefined();
  });

  it("describeConfig 暴露调度与端点配置但不含值", () => {
    const snapshot = describeConfig(loadConfig({ JARVIS_MAX_CONCURRENT_TASKS: "3" }));

    expect(snapshot["maxConcurrentTasks"]).toBe(3);
    expect(snapshot["modelsPath"]).toBe(join(process.cwd(), DEFAULT_MODELS_RELATIVE_PATH));
    expect(snapshot["modelId"]).toBeNull();
  });
});
