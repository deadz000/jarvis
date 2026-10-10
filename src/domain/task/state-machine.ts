/**
 * Task 状态机：唯一合法的转移集合。
 *
 * 依据：项目需求规格说明书 §4.1 候选转移：
 *   queued → running / cancelled
 *   running → cancel_requested / succeeded / failed
 *   cancel_requested → cancelled / succeeded / failed
 *
 * 设计要点：
 * - 合法转移以**数据**形式声明，便于测试穷举与后续演进；
 * - 非法转移必须**显式抛错**，不允许静默忽略（实施计划 M3 出口条件
 *   「所有非法转移可被检测，不静默破坏状态」）。
 */
import { TASK_STATES, type TaskState } from "./types.ts";

export const LEGAL_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  queued: ["running", "cancelled"],
  running: ["cancel_requested", "succeeded", "failed"],
  // 取消请求与自然完成/失败存在竞态，两种结果都必须可提交（SRS §4.1）。
  cancel_requested: ["cancelled", "succeeded", "failed"],
  // 终态不可再变更。
  succeeded: [],
  failed: [],
  cancelled: [],
};

export class IllegalTaskTransitionError extends Error {
  public readonly from: TaskState;
  public readonly to: TaskState;

  public constructor(from: TaskState, to: TaskState) {
    super(
      `非法状态转移：${from} → ${to}（合法目标：${legalTargets(from).join(" / ") || "无，终态不可变更"}）`,
    );
    this.name = "IllegalTaskTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function legalTargets(from: TaskState): readonly TaskState[] {
  return LEGAL_TRANSITIONS[from];
}

/** 非法转移直接抛错 —— 编程错误必须暴露，不能变成静默的状态破坏。 */
export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new IllegalTaskTransitionError(from, to);
}

/** 所有状态的合法目标表（供文档与测试使用）。 */
export function describeStateMachine(): ReadonlyArray<{ state: TaskState; targets: readonly TaskState[] }> {
  return TASK_STATES.map((state) => ({ state, targets: legalTargets(state) }));
}
