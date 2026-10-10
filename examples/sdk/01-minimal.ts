/**
 * M0 交付物：最小 Pi AgentSession 示例。
 *
 * 覆盖的开发启动清单项（开发实施计划 §11.1–11.2）：
 *   1. 用锁定版本的 SDK 创建 Session；
 *   2. 订阅事件流，按 text_delta 增量输出；
 *   3. 单轮 prompt 完成并读取最终文本；
 *   4. 以 message_end 的 assistant 终态消息判定成败，而非以 prompt() 是否抛错为准；
 *   5. 释放订阅与 Session，避免监听器泄漏；
 *   6. 缺少凭据时给出可操作提示，而不是抛裸栈。
 *
 * 尚未覆盖（M1 范围）：steer / followUp / abort 语义、自定义工具与取消、
 * 超时与异常路径的清理、会话持久化、事件全生命周期采样。
 *
 * 用法：npm run example:sdk -- "你的问题"
 * 前置：.env 中至少配置一个 provider 的 API Key。
 */
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

import { selectModel } from "../../src/adapters/pi/model-selection.ts";
import {
  classifySessionOutcome,
  readAssistantFinalMessage,
  type AssistantFinalMessage,
} from "../../src/adapters/pi/session-outcome.ts";
import { assertModelCredentials, ConfigError, loadConfig } from "../../src/config/env.ts";
import { createLogger } from "../../src/observability/logger.ts";

async function run(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, context: { component: "examples.sdk.minimal" } });

  assertModelCredentials(config);

  const selected = await selectModel(config);
  log.info("example.model.selected", {
    model: `${selected.model.provider}/${selected.model.id}`,
    pinned: selected.pinned,
    availableCount: selected.availableCount,
    available: selected.availableLabel,
  });

  const prompt = process.argv.slice(2).join(" ").trim() || "用一句话确认你已就绪。";

  const { session } = await createAgentSession({
    cwd: config.workspace,
    modelRuntime: selected.modelRuntime,
    model: selected.model,
    sessionManager: SessionManager.inMemory(config.workspace),
    ...(config.thinkingLevel === undefined ? {} : { thinkingLevel: config.thinkingLevel }),
  });

  let deltaCount = 0;
  let finalAssistant: AssistantFinalMessage | undefined;

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      deltaCount += 1;
      process.stdout.write(event.assistantMessageEvent.delta);
      return;
    }
    if (event.type === "message_end") {
      // message_end 才是权威的已完成消息；只有 assistant 终态能判定本次运行成败。
      const candidate = readAssistantFinalMessage(event.message);
      if (candidate !== undefined) finalAssistant = candidate;
      return;
    }
    // 其余事件先用 debug 记录类型，M1 据此梳理完整事件生命周期。
    log.debug("session.event", { type: event.type });
  });

  const startedAt = Date.now();
  try {
    await session.prompt(prompt);
    const elapsedMs = Date.now() - startedAt;
    process.stdout.write("\n");

    const outcome = classifySessionOutcome(finalAssistant, session.getLastAssistantText());
    const fields = {
      elapsedMs,
      deltaCount,
      status: outcome.status,
      stopReason: outcome.stopReason ?? null,
      reason: outcome.reason,
      textLength: outcome.text.length,
      errorMessage: outcome.errorMessage ?? null,
    };

    if (outcome.status === "succeeded") {
      log.info("example.prompt.completed", { ...fields, text: outcome.text });
    } else {
      // 关键：prompt() 正常 resolve 也可能是失败，这里必须报错并以非零码退出。
      log.error("example.prompt.failed", fields);
      process.exitCode = 1;
    }
  } catch (error) {
    log.error("example.prompt.threw", { elapsedMs: Date.now() - startedAt, error });
    process.exitCode = 1;
  } finally {
    unsubscribe();
    session.dispose();
    log.info("example.session.disposed", { messageCount: session.messages.length });
  }
}

try {
  await run();
} catch (error) {
  const message =
    error instanceof ConfigError
      ? error.message
      : `示例运行失败：${error instanceof Error ? error.message : String(error)}`;
  process.stderr.write(`[example-error] ${message}\n`);
  process.exitCode = 1;
}
