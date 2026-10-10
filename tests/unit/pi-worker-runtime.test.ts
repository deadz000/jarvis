import { describe, expect, it } from "vitest";

import {
  buildTerminalEvent,
  MAX_RESULT_SUMMARY_LENGTH,
} from "../../src/adapters/pi/pi-worker-runtime.ts";
import type { SessionOutcome } from "../../src/adapters/pi/session-outcome.ts";

const BASE = { taskId: "task-1", runGeneration: 2, at: 1234 };

function outcome(partial: Partial<SessionOutcome> & Pick<SessionOutcome, "status">): SessionOutcome {
  return {
    stopReason: undefined,
    errorMessage: undefined,
    text: "",
    reason: "test",
    ...partial,
  };
}

describe("buildTerminalEvent — 终态到 Worker 事件的映射", () => {
  it("成功 → worker_succeeded，并携带结果摘要", () => {
    const event = buildTerminalEvent(outcome({ status: "succeeded", text: "结果是 42" }), BASE, {
      cancelRequested: false,
    });

    expect(event).toMatchObject({ type: "worker_succeeded", ...BASE, summary: "结果是 42" });
  });

  it("成功结果超长时截断，避免无界文本进入调度状态", () => {
    const long = "x".repeat(MAX_RESULT_SUMMARY_LENGTH + 500);
    const event = buildTerminalEvent(outcome({ status: "succeeded", text: long }), BASE, {
      cancelRequested: false,
    });

    expect(event.type).toBe("worker_succeeded");
    if (event.type !== "worker_succeeded") throw new Error("类型不符");
    expect(event.summary.length).toBeLessThan(long.length);
    expect(event.summary).toContain("已截断");
    expect(event.summary.startsWith("x".repeat(100))).toBe(true);
  });

  it("自定义截断长度生效", () => {
    const event = buildTerminalEvent(outcome({ status: "succeeded", text: "abcdefghij" }), BASE, {
      cancelRequested: false,
      maxSummaryLength: 4,
    });

    if (event.type !== "worker_succeeded") throw new Error("类型不符");
    expect(event.summary.startsWith("abcd")).toBe(true);
  });

  it("已取消 → worker_cancelled，而不是失败", () => {
    const event = buildTerminalEvent(
      outcome({ status: "cancelled", stopReason: "error", errorMessage: "This operation was aborted" }),
      BASE,
      { cancelRequested: true },
    );

    expect(event).toMatchObject({
      type: "worker_cancelled",
      reason: "This operation was aborted",
      ...BASE,
    });
  });

  it("失败 → worker_failed，优先使用 provider 的 errorMessage", () => {
    const event = buildTerminalEvent(
      outcome({ status: "failed", stopReason: "error", errorMessage: "401 unauthorized", reason: "内部理由" }),
      BASE,
      { cancelRequested: false },
    );

    expect(event).toMatchObject({ type: "worker_failed", reason: "401 unauthorized" });
  });

  it("未收到终态消息且未请求取消 → 报失败，不假装成功", () => {
    const event = buildTerminalEvent(
      outcome({ status: "unverified", reason: "未收到 message_end 的 assistant 终态消息" }),
      BASE,
      { cancelRequested: false },
    );

    expect(event.type).toBe("worker_failed");
    if (event.type !== "worker_failed") throw new Error("类型不符");
    expect(event.reason).toContain("未收到");
  });

  it("未收到终态消息但已请求取消 → 报已取消，避免把取消误报成失败", () => {
    const event = buildTerminalEvent(
      outcome({ status: "unverified", reason: "未收到 message_end 的 assistant 终态消息" }),
      BASE,
      { cancelRequested: true },
    );

    expect(event.type).toBe("worker_cancelled");
  });

  it("所有分支都保留 taskId / runGeneration / at", () => {
    const statuses = ["succeeded", "cancelled", "failed", "unverified"] as const;
    for (const status of statuses) {
      const event = buildTerminalEvent(outcome({ status, text: "t" }), BASE, { cancelRequested: false });
      expect(event.taskId).toBe(BASE.taskId);
      expect(event.runGeneration).toBe(BASE.runGeneration);
      expect(event.at).toBe(BASE.at);
    }
  });
});
