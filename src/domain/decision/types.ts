/**
 * Master 决策契约的领域类型（实施计划 M4）。
 *
 * ## 为什么是「两维版本号」
 * 决策清单已确认采用两维（对应踩坑指南第 5 条：至少要有「使决策过期」与「不使决策过期」两类序号）：
 * - `eventSeq`：事件完整性。每收到一个输入事件递增；用于**检测漏事件并触发重同步**，
 *   本身**不**使决策过期。
 * - `controlRevision`：控制修订号。**只在「合法决策集合可能改变」时递增**
 *   （任务创建、准入、取消请求、终态），用于判定决策是否过期。
 *   遥测类事件（进度、工具调用）**不**递增它。
 *
 * ## Master 只能提出意图
 * `MasterDecision` 是**声明式建议**：它不携带任何可以直接改写权威状态的能力。
 * 是否落地由 `DecisionValidator` 逐动作复核后编译成命令，再交给 Scheduler 执行。
 */
import type { Priority } from "../task/types.ts";

export interface WorldRevision {
  readonly eventSeq: number;
  readonly controlRevision: number;
}

export const INITIAL_REVISION: WorldRevision = { eventSeq: 0, controlRevision: 0 };

export type StartTaskAction = {
  readonly type: "start_task";
  readonly goal: string;
  readonly priority: Priority;
  readonly reason?: string;
};

export type CancelTaskAction = {
  readonly type: "cancel_task";
  readonly taskId: string;
  /**
   * 决策所看到的执行代次。省略时不校验代次，仅校验任务仍处于可取消状态。
   * 提供时，代次不匹配（例如任务已被重启）会使该动作失效 —— 这是防止
   * 「过期决策误取消已完成/已换代任务」的关键前置条件。
   */
  readonly expectedGeneration?: number;
  readonly reason?: string;
};

export type SetFocusAction = {
  readonly type: "set_focus";
  readonly taskId: string | null;
  readonly reason?: string;
};

/**
 * 交付结果（交付决策模式的产出）。
 * 一条动作可覆盖**多个任务** —— 这就是「两个任务同时完成、合并成一次回答」的表达方式。
 */
export type DeliverResultsAction = {
  readonly type: "deliver_results";
  readonly taskIds: readonly string[];
  /** 实际播报文本（口语化；多条结果时是综合稿）。 */
  readonly text: string;
  readonly priority: Priority;
  /** `now` = 允许抢占（仍受确定性规则约束）；`after_current` = 等当前语句播完。 */
  readonly timing: "now" | "after_current";
  readonly reason?: string;
};

export type DecisionAction = StartTaskAction | CancelTaskAction | SetFocusAction | DeliverResultsAction;

export interface MasterDecision {
  readonly decisionId: string;
  /** 该决策基于的世界版本。执行前必须按**当前**状态逐动作复核，而不是信任它。 */
  readonly basedOn: WorldRevision;
  readonly actions: readonly DecisionAction[];
  readonly rationale?: string;
}
