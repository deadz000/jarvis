/**
 * M1 剩余验收项实测：会话生命周期与资源清理。
 *
 * 覆盖开发实施计划 M1 任务清单中此前未验证的部分：
 *   A. 同一 Session 的**重复请求**（会话可复用，第二次仍正常完成）；
 *   B. **订阅清理**：退订后不再收到事件（无监听器泄漏）；
 *   C. **dispose 语义**：释放后的 Session 不能再产出成功结果；
 *   D. **in-memory 与持久化 Session 的基本差异**（是否落盘会话文件）。
 *
 * 用法：npm run example:lifecycle
 */
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { selectModel } from "../../src/adapters/pi/model-selection.ts";
import {
  classifySessionOutcome,
  readAssistantFinalMessage,
  type AssistantFinalMessage,
  type ClassifySessionOutcomeOptions,
  type SessionOutcome,
} from "../../src/adapters/pi/session-outcome.ts";
import { assertModelCredentials, ConfigError, loadConfig } from "../../src/config/env.ts";
import { createLogger } from "../../src/observability/logger.ts";

type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

function readEventType(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const type = (value as Record<string, unknown>)["type"];
    if (typeof type === "string") return type;
  }
  return "unknown";
}

function eventMessage(value: unknown): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)["message"]
    : undefined;
}

/** 运行一次 prompt，并用「权威终态消息」判定结果（不依赖 prompt() 是否抛错）。 */
async function promptOnce(
  session: PiSession,
  prompt: string,
  options: ClassifySessionOutcomeOptions = {},
): Promise<{ outcome: SessionOutcome; eventCount: number }> {
  let finalAssistant: AssistantFinalMessage | undefined;
  let eventCount = 0;

  const unsubscribe = session.subscribe((event) => {
    eventCount += 1;
    if (readEventType(event) === "message_end") {
      const candidate = readAssistantFinalMessage(eventMessage(event));
      if (candidate !== undefined) finalAssistant = candidate;
    }
  });

  try {
    await session.prompt(prompt);
    return { outcome: classifySessionOutcome(finalAssistant, session.getLastAssistantText(), options), eventCount };
  } finally {
    unsubscribe();
  }
}

async function run(): Promise<number> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, context: { component: "examples.sdk.lifecycle" } });
  assertModelCredentials(config);

  const selected = await selectModel(config);
  const checks: Record<string, boolean> = {};
  const observations: Record<string, unknown> = {};

  try {
    // ================= A + B：重复请求与订阅清理（in-memory） =================
    const { session } = await createAgentSession({
      cwd: config.workspace,
      modelRuntime: selected.modelRuntime,
      model: selected.model,
      sessionManager: SessionManager.inMemory(config.workspace),
    });

    try {
      const first = await promptOnce(session, "用一句话回答：你好。");
      const second = await promptOnce(session, "再回答一次，用一句话：今天星期几不重要，只说“收到”。");

      checks["同一 Session 可重复请求（两次都成功）"] =
        first.outcome.status === "succeeded" && second.outcome.status === "succeeded";
      observations["repeatRequests"] = {
        firstStatus: first.outcome.status,
        secondStatus: second.outcome.status,
        firstEvents: first.eventCount,
        secondEvents: second.eventCount,
        messageCountAfterTwoPrompts: session.messages.length,
      };

      // B：订阅一个计数器，退订后它不应再增长
      let subscribedEvents = 0;
      const unsubscribeProbe = session.subscribe(() => {
        subscribedEvents += 1;
      });
      await promptOnce(session, "回答：一二三四五。");
      const eventsWhileSubscribed = subscribedEvents;
      unsubscribeProbe();
      await promptOnce(session, "回答：六七八九十。");
      const eventsAfterUnsubscribe = subscribedEvents;

      checks["退订后不再收到事件（无监听器泄漏）"] =
        eventsWhileSubscribed > 0 && eventsAfterUnsubscribe === eventsWhileSubscribed;
      observations["listenerCleanup"] = { eventsWhileSubscribed, eventsAfterUnsubscribe };
    } finally {
      // ================= C：dispose 语义 =================
      session.dispose();

      let disposedOutcome: SessionOutcome | undefined;
      let disposedError: string | undefined;
      try {
        disposedOutcome = (await promptOnce(session, "释放之后还能回答吗？")).outcome;
      } catch (error) {
        disposedError = error instanceof Error ? error.message : String(error);
      }

      // 关键不变量：释放后的 Session 绝不能继续产出「成功」的结果
      checks["dispose 后不再产出成功结果"] = disposedOutcome === undefined || disposedOutcome.status !== "succeeded";
      observations["dispose"] = {
        settledAs: disposedOutcome?.status ?? "threw",
        error: disposedError ?? null,
        text: disposedOutcome?.text ?? null,
      };
    }

    // ================= D：in-memory 与持久化 Session 的差异 =================
    const sessionDir = join(config.workspace, ".tmp", "sessions");
    const memoryManager = SessionManager.inMemory(config.workspace);
    const fileManager = SessionManager.create(config.workspace, sessionDir);

    const memoryFile = memoryManager.getSessionFile();
    const fileManagerPath = fileManager.getSessionFile();

    const fileSession = await createAgentSession({
      cwd: config.workspace,
      modelRuntime: selected.modelRuntime,
      model: selected.model,
      sessionManager: fileManager,
    });
    try {
      await promptOnce(fileSession.session, "回答：持久化会话测试。");
      const activePath = fileManager.getSessionFile();
      const persisted = activePath !== undefined && existsSync(activePath) && statSync(activePath).size > 0;

      checks["in-memory Session 不落盘"] = memoryFile === undefined;
      checks["持久化 Session 写入会话文件"] = persisted;
      observations["sessionPersistence"] = {
        inMemorySessionFile: memoryFile ?? null,
        fileManagerSessionFile: fileManagerPath ?? null,
        fileAfterPrompt: activePath ?? null,
        fileSizeBytes: activePath !== undefined && existsSync(activePath) ? statSync(activePath).size : null,
        sessionDir,
      };
    } finally {
      fileSession.session.dispose();
    }

    const report = { model: `${selected.model.provider}/${selected.model.id}`, checks, observations };
    log.info("m1.lifecycle.verdict", report);

    const lines = [
      "",
      "===== M1 会话生命周期实测结论 =====",
      ...Object.entries(observations).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
      "",
      "--- 检查项 ---",
      ...Object.entries(checks).map(([name, ok]) => `${ok ? "✅" : "❌"} ${name}`),
      "",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);

    return Object.values(checks).every(Boolean) ? 0 : 1;
  } finally {
    // 清理持久化测试目录（会话文件属运行时产物）
    // 目录本身保留在 .tmp/ 下，已由 .gitignore 排除。
  }
}

try {
  process.exitCode = await run();
} catch (error) {
  const message =
    error instanceof ConfigError
      ? error.message
      : `M1 生命周期实测失败：${error instanceof Error ? error.message : String(error)}`;
  process.stderr.write(`[example-error] ${message}\n`);
  process.exitCode = 1;
}
