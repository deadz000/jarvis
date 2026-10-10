import { describe, expect, it } from "vitest";

import {
  DEFAULT_LONG_RESULT_LENGTH,
  DeliveryPolicy,
  type DeliveryPolicyInput,
} from "../../src/application/delivery/delivery-policy.ts";
import type { PendingResult } from "../../src/application/delivery/delivery-batcher.ts";

function pending(overrides: Partial<PendingResult> = {}): PendingResult {
  return {
    taskId: "task-1",
    fullSummary: "天气是晴，24 度。",
    spokenSummary: "天气是晴，24 度。",
    priority: "normal",
    at: 1_000,
    ...overrides,
  };
}

function input(overrides: Partial<DeliveryPolicyInput> = {}): DeliveryPolicyInput {
  return {
    batch: [pending()],
    speechActive: false,
    audioPlaying: false,
    runningTaskCount: 0,
    ...overrides,
  };
}

describe("DeliveryPolicy — 「要不要为这批结果重新调用 Master」的确定性分流", () => {
  const policy = new DeliveryPolicy();

  it("单个普通任务完成 → direct，**不调用 Master**（零成本）", () => {
    const decision = policy.decide(input());

    expect(decision.route).toBe("direct");
    expect(decision.requiresMaster).toBe(false);
    expect(decision.reasons.join("")).toContain("直接使用");
  });

  it("多个任务同时完成 → master_merge（合并通知，避免连续播报）", () => {
    const decision = policy.decide(
      input({ batch: [pending({ taskId: "task-1" }), pending({ taskId: "task-2" })] }),
    );

    expect(decision.route).toBe("master_merge");
    expect(decision.requiresMaster).toBe(true);
    expect(decision.reasons[0]).toContain("2 条结果");
  });

  it("结果重要性需要语义判断（先验 high/urgent）→ master_priority", () => {
    expect(policy.decide(input({ batch: [pending({ priority: "high" })] })).route).toBe("master_priority");
    expect(policy.decide(input({ batch: [pending({ priority: "urgent" })] })).route).toBe("master_priority");
    // normal / low 不需要语义判断
    expect(policy.decide(input({ batch: [pending({ priority: "low" })] })).route).toBe("direct");
  });

  it("结果自带的重要事实标记 → master_priority", () => {
    for (const hints of [
      { needsUserDecision: true },
      { hasBlocker: true },
      { isBadNews: true },
    ]) {
      const decision = policy.decide(input({ batch: [pending({ hints })] }));
      expect(decision.route, JSON.stringify(hints)).toBe("master_priority");
    }
  });

  it("完整结果过长（需要重写成适合播报的稿）→ master_priority", () => {
    const long = "很长的一段结果。".repeat(120);
    const decision = policy.decide(input({ batch: [pending({ fullSummary: long })] }));

    expect(long.length).toBeGreaterThan(DEFAULT_LONG_RESULT_LENGTH);
    expect(decision.route).toBe("master_priority");
    expect(decision.reasons.join("")).toContain("较长");
  });

  it("用户正在讲话 → defer_for_speech，语音让路但**不调用 Master**", () => {
    const decision = policy.decide(input({ speechActive: true }));

    expect(decision.route).toBe("defer_for_speech");
    expect(decision.requiresMaster).toBe(false);
    expect(decision.reasons.join("")).toContain("用户正在讲话");
  });

  it("用户讲话优先于其他一切判断（多结果也不例外）", () => {
    const decision = policy.decide(
      input({
        speechActive: true,
        batch: [pending({ taskId: "task-1", priority: "urgent" }), pending({ taskId: "task-2" })],
      }),
    );

    expect(decision.route).toBe("defer_for_speech");
  });

  it("空批次直接返回，不产生额外判断", () => {
    const decision = policy.decide(input({ batch: [] }));

    expect(decision.route).toBe("direct");
    expect(decision.requiresMaster).toBe(false);
  });

  it("路由是纯确定性的：同样输入永远同样结果", () => {
    const sample = input({ batch: [pending({ taskId: "task-1" }), pending({ taskId: "task-2" })] });

    const first = policy.decide(sample);
    const second = policy.decide(sample);

    expect(second).toEqual(first);
  });
});
