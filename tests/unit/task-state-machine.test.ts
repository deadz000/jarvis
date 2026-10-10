import { describe, expect, it } from "vitest";

import {
  assertTransition,
  canTransition,
  describeStateMachine,
  IllegalTaskTransitionError,
  legalTargets,
} from "../../src/domain/task/state-machine.ts";
import { TASK_STATES, type TaskState } from "../../src/domain/task/types.ts";

/** SRS §4.1 冻结的合法转移（与实现相互独立地写出来，避免直接抄实现）。 */
const SPEC_LEGAL: ReadonlyArray<readonly [TaskState, TaskState]> = [
  ["queued", "running"],
  ["queued", "cancelled"],
  ["running", "cancel_requested"],
  ["running", "succeeded"],
  ["running", "failed"],
  ["cancel_requested", "cancelled"],
  ["cancel_requested", "succeeded"],
  ["cancel_requested", "failed"],
];

describe("Task 状态机", () => {
  it("穷举验证：只有 SRS 声明的 7 项转移合法，其余一律非法", () => {
    const legalSet = new Set(SPEC_LEGAL.map(([from, to]) => `${from}->${to}`));

    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        const expected = legalSet.has(`${from}->${to}`);
        expect(canTransition(from, to), `期望 ${from} -> ${to} ${expected ? "合法" : "非法"}`).toBe(expected);
      }
    }
  });

  it("终态没有任何合法目标，不允许回退或复活", () => {
    for (const terminal of ["succeeded", "failed", "cancelled"] as const) {
      expect(legalTargets(terminal)).toEqual([]);
    }
  });

  it("除 running 外，没有任何状态可以再次进入 running（防止重复执行）", () => {
    const sources = TASK_STATES.filter((state) => canTransition(state, "running"));
    expect(sources).toEqual(["queued"]);
  });

  it("非法转移抛出的错误携带 from/to，便于定位", () => {
    const error = (() => {
      try {
        assertTransition("succeeded", "running");
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(IllegalTaskTransitionError);
    expect((error as IllegalTaskTransitionError).from).toBe("succeeded");
    expect((error as IllegalTaskTransitionError).to).toBe("running");
    expect((error as IllegalTaskTransitionError).message).toContain("终态不可变更");
  });

  it("assertTransition 对合法转移不抛错", () => {
    for (const [from, to] of SPEC_LEGAL) {
      expect(() => assertTransition(from, to)).not.toThrow();
    }
  });

  it("describeStateMachine 覆盖全部状态且与 legalTargets 一致", () => {
    const described = describeStateMachine();
    expect(described.map((entry) => entry.state)).toEqual([...TASK_STATES]);
    for (const entry of described) {
      expect(entry.targets).toEqual(legalTargets(entry.state));
    }
  });
});
