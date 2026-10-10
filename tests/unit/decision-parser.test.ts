import { describe, expect, it } from "vitest";

import {
  extractJsonObject,
  parseMasterDecision,
} from "../../src/application/master/decision-parser.ts";

const BASED_ON = { eventSeq: 3, controlRevision: 2 };

function raw(overrides: Record<string, unknown>): string {
  return JSON.stringify({ decisionId: "d-1", basedOn: BASED_ON, actions: [], ...overrides });
}

describe("extractJsonObject", () => {
  it("提取纯 JSON 对象", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("提取 ```json 围栏内的对象", () => {
    expect(extractJsonObject('说明文字\n```json\n{"a":1}\n```\n后续文字')).toBe('{"a":1}');
  });

  it("裁掉前后解释性文字", () => {
    expect(extractJsonObject('好的，这是决策：{"a":1} 以上。')).toBe('{"a":1}');
  });

  it("没有对象时返回 undefined", () => {
    expect(extractJsonObject("完全没有 JSON")).toBeUndefined();
    expect(extractJsonObject("")).toBeUndefined();
    expect(extractJsonObject("}{")).toBeUndefined();
  });
});

describe("parseMasterDecision — 结构与 Schema 校验", () => {
  it("接受合法决策并保留字段", () => {
    const result = parseMasterDecision(
      raw({
        rationale: "用户要求两件事",
        actions: [
          { type: "start_task", goal: "查天气", priority: "high" },
          { type: "cancel_task", taskId: "task-1", expectedGeneration: 1, reason: "不要了" },
          { type: "set_focus", taskId: "task-2" },
        ],
      }),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.decision.decisionId).toBe("d-1");
    expect(result.decision.basedOn).toEqual(BASED_ON);
    expect(result.decision.rationale).toBe("用户要求两件事");
    expect(result.decision.actions).toHaveLength(3);
    expect(result.droppedActions).toEqual([]);
  });

  it("priority 缺省时补 normal", () => {
    const result = parseMasterDecision(raw({ actions: [{ type: "start_task", goal: "x" }] }));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const action = result.decision.actions[0];
    expect(action?.type).toBe("start_task");
    if (action?.type !== "start_task") return;
    expect(action.priority).toBe("normal");
  });

  it("空 actions 数组是合法的「什么都不做」计划", () => {
    const result = parseMasterDecision(raw({ actions: [] }));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.decision.actions).toEqual([]);
  });

  it("JSON 无法解析 → invalid（调用方据此不执行任何动作）", () => {
    const result = parseMasterDecision("{ 这不是 JSON ");

    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.reason).toContain("JSON");
  });

  it("缺少 decisionId / basedOn / actions 均判 invalid", () => {
    for (const broken of [
      JSON.stringify({ basedOn: BASED_ON, actions: [] }),
      JSON.stringify({ decisionId: "d", actions: [] }),
      JSON.stringify({ decisionId: "d", basedOn: BASED_ON }),
      JSON.stringify({ decisionId: "d", basedOn: { eventSeq: 1 }, actions: [] }),
      JSON.stringify({ decisionId: "d", basedOn: BASED_ON, actions: "not-array" }),
    ]) {
      expect(parseMasterDecision(broken).status, broken).toBe("invalid");
    }
  });

  it("单个动作形状非法时只丢弃该动作，保留其余合法动作", () => {
    const result = parseMasterDecision(
      raw({
        actions: [
          { type: "start_task", goal: "有效目标" },
          { type: "cancel_task" },
          { type: "start_task", goal: "  " },
          { type: "start_task", goal: "另一个有效目标", priority: "highest" },
          { type: "unknown_action" },
        ],
      }),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.decision.actions).toHaveLength(1);
    expect(result.droppedActions).toHaveLength(4);
    expect(result.droppedActions.join(" | ")).toContain("cancel_task 缺少非空 taskId");
    expect(result.droppedActions.join(" | ")).toContain("priority 非法");
    expect(result.droppedActions.join(" | ")).toContain("未知动作类型");
  });

  it("取消动作的 expectedGeneration 必须是合法整数", () => {
    const bad = parseMasterDecision(
      raw({ actions: [{ type: "cancel_task", taskId: "task-1", expectedGeneration: -1 }] }),
    );
    const good = parseMasterDecision(
      raw({ actions: [{ type: "cancel_task", taskId: "task-1", expectedGeneration: 0 }] }),
    );

    expect(bad.status).toBe("ok");
    if (bad.status === "ok") expect(bad.decision.actions).toHaveLength(0);
    expect(good.status).toBe("ok");
    if (good.status === "ok") expect(good.decision.actions).toHaveLength(1);
  });

  it("set_focus 的 taskId 允许 null（清空焦点）", () => {
    const result = parseMasterDecision(raw({ actions: [{ type: "set_focus", taskId: null }] }));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const action = result.decision.actions[0];
    expect(action?.type).toBe("set_focus");
    if (action?.type !== "set_focus") return;
    expect(action.taskId).toBeNull();
  });
});
