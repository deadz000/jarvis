import { describe, expect, it } from "vitest";

import {
  classifySessionOutcome,
  readAssistantFinalMessage,
} from "../../src/adapters/pi/session-outcome.ts";

describe("readAssistantFinalMessage", () => {
  it("只接受 assistant 角色的消息", () => {
    expect(
      readAssistantFinalMessage({ role: "assistant", stopReason: "error", errorMessage: "401" }),
    ).toEqual({ stopReason: "error", errorMessage: "401" });
    expect(readAssistantFinalMessage({ role: "user", stopReason: "error" })).toBeUndefined();
    expect(readAssistantFinalMessage({ role: "system" })).toBeUndefined();
  });

  it("对形状不符的输入返回 undefined 而不是抛错", () => {
    expect(readAssistantFinalMessage(undefined)).toBeUndefined();
    expect(readAssistantFinalMessage(null)).toBeUndefined();
    expect(readAssistantFinalMessage("assistant")).toBeUndefined();
    expect(readAssistantFinalMessage(42)).toBeUndefined();
    expect(readAssistantFinalMessage({ role: "assistant", stopReason: 123, errorMessage: null })).toEqual({
      stopReason: undefined,
      errorMessage: undefined,
    });
  });
});

describe("classifySessionOutcome", () => {
  it("stopReason=error 判为失败 —— 这是 prompt() 不抛错时的真实失败信号", () => {
    const outcome = classifySessionOutcome(
      { stopReason: "error", errorMessage: "invalid api key" },
      undefined,
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.stopReason).toBe("error");
    expect(outcome.errorMessage).toBe("invalid api key");
    expect(outcome.reason).toContain("error");
  });

  it("stopReason=aborted 判为未成功，并保留 stopReason 供上层映射为「已取消」", () => {
    const outcome = classifySessionOutcome({ stopReason: "aborted", errorMessage: undefined }, "");

    expect(outcome.status).toBe("failed");
    expect(outcome.stopReason).toBe("aborted");
  });

  it("收到终态但正文为空判为失败", () => {
    const outcome = classifySessionOutcome({ stopReason: "stop", errorMessage: undefined }, undefined);

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("没有正文");
  });

  it("没有收到 assistant 终态消息判为 unverified，而不是成功", () => {
    const outcome = classifySessionOutcome(undefined, "看起来像答案的文本");

    expect(outcome.status).toBe("unverified");
    expect(outcome.reason).toContain("不得视为成功");
  });

  it("正常终态且有正文才判为成功", () => {
    const outcome = classifySessionOutcome({ stopReason: "stop", errorMessage: undefined }, "hello");

    expect(outcome.status).toBe("succeeded");
    expect(outcome.text).toBe("hello");
  });

  it("无法识别的 stopReason 不会被当作失败，避免误报", () => {
    const outcome = classifySessionOutcome({ stopReason: "length", errorMessage: undefined }, "partial");

    expect(outcome.status).toBe("succeeded");
    expect(outcome.stopReason).toBe("length");
  });

  it("已请求取消时 error 判定为 cancelled 而非 failed（实机：abort 后 stopReason 也是 error）", () => {
    const outcome = classifySessionOutcome(
      { stopReason: "error", errorMessage: "aborted by user" },
      undefined,
      { cancelRequested: true },
    );

    expect(outcome.status).toBe("cancelled");
    expect(outcome.stopReason).toBe("error");
    expect(outcome.reason).toContain("已取消");
  });

  it("未请求取消时的 error 仍判定为 failed", () => {
    const outcome = classifySessionOutcome({ stopReason: "error", errorMessage: "401" }, undefined);

    expect(outcome.status).toBe("failed");
  });

  it("请求过取消但最终成功产出正文，仍判定为 succeeded（取消与完成竞态）", () => {
    const outcome = classifySessionOutcome(
      { stopReason: "stop", errorMessage: undefined },
      "任务实际完成了",
      { cancelRequested: true },
    );

    expect(outcome.status).toBe("succeeded");
    expect(outcome.text).toBe("任务实际完成了");
  });
});
