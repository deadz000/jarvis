/**
 * 决策业务校验器（M4）：把声明式动作**逐条**校验并编译为可执行命令。
 *
 * 核心原则（踩坑指南第 4 条、SRS §3.3）：
 * **不锁住世界等 LLM，也整体拒绝过期决策；而是用「当前状态」逐命令校验前置条件，
 * 拒失效意图、保留仍合法的意图。**
 *
 * 因此本模块必须在模型返回**之后**、用**最新**状态调用，而不是用构造提示词时的快照。
 */
import type { DecisionAction, MasterDecision, WorldRevision } from "../../domain/decision/types.ts";
import type { Priority, TaskRecord } from "../../domain/task/types.ts";

export interface StartTaskCommand {
  readonly type: "start_task";
  readonly goal: string;
  readonly priority: Priority;
  /** 幂等键：同一决策的同一动作重复执行不会重复建任务。 */
  readonly idempotencyKey: string;
  readonly decisionId: string;
}

export interface CancelTaskCommand {
  readonly type: "cancel_task";
  readonly taskId: string;
  readonly reason: string;
  readonly expectedGeneration?: number;
}

export interface SetFocusCommand {
  readonly type: "set_focus";
  readonly taskId: string | null;
  readonly decisionId: string;
}

export type CompiledCommand = StartTaskCommand | CancelTaskCommand | SetFocusCommand;

export type ActionRejectionReason =
  | "task_not_found"
  | "already_terminal"
  | "already_cancel_requested"
  | "generation_mismatch";

export interface RejectedAction {
  readonly action: DecisionAction;
  readonly reason: ActionRejectionReason;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface DecisionValidation {
  readonly decisionId: string;
  readonly accepted: readonly CompiledCommand[];
  readonly rejected: readonly RejectedAction[];
  readonly basedOn: WorldRevision;
  readonly currentRevision: WorldRevision;
  /** 决策基于的 `controlRevision` 落后于当前值：世界已变，动作需逐条复核（已复核）。 */
  readonly stale: boolean;
  /** 决策基于的 `eventSeq` 落后于当前值：模型可能没看到某些输入事件，建议重同步。 */
  readonly missedEvents: boolean;
}

export interface ValidationContext {
  readonly getTask: (taskId: string) => TaskRecord | undefined;
  /** **当前**世界版本（执行时刻读取，不是提示词时刻）。 */
  readonly currentRevision: WorldRevision;
}

export function validateDecision(decision: MasterDecision, context: ValidationContext): DecisionValidation {
  const accepted: CompiledCommand[] = [];
  const rejected: RejectedAction[] = [];

  decision.actions.forEach((action, index) => {
    switch (action.type) {
      case "start_task": {
        // 启动动作的前置条件只与参数本身有关：世界变新不会让它失效。
        // （「拒失效意图、保留仍合法意图」的典型情形。）
        accepted.push({
          type: "start_task",
          goal: action.goal,
          priority: action.priority,
          idempotencyKey: `${decision.decisionId}:start:${index}`,
          decisionId: decision.decisionId,
        });
        return;
      }

      case "cancel_task": {
        const task = context.getTask(action.taskId);
        if (task === undefined) {
          rejected.push({
            action,
            reason: "task_not_found",
            detail: { taskId: action.taskId },
          });
          return;
        }
        if (task.state === "succeeded" || task.state === "failed" || task.state === "cancelled") {
          rejected.push({
            action,
            reason: "already_terminal",
            detail: { taskId: action.taskId, state: task.state },
          });
          return;
        }
        if (task.state === "cancel_requested") {
          rejected.push({
            action,
            reason: "already_cancel_requested",
            detail: { taskId: action.taskId },
          });
          return;
        }
        // 代次校验：任务已被重启（代次前进）时，旧决策不得取消新一次执行。
        if (action.expectedGeneration !== undefined && action.expectedGeneration !== task.runGeneration) {
          rejected.push({
            action,
            reason: "generation_mismatch",
            detail: {
              taskId: action.taskId,
              expectedGeneration: action.expectedGeneration,
              actualGeneration: task.runGeneration,
            },
          });
          return;
        }
        accepted.push({
          type: "cancel_task",
          taskId: action.taskId,
          reason: action.reason ?? `决策 ${decision.decisionId} 请求取消`,
          ...(action.expectedGeneration === undefined ? {} : { expectedGeneration: action.expectedGeneration }),
        });
        return;
      }

      case "set_focus": {
        if (action.taskId === null) {
          accepted.push({ type: "set_focus", taskId: null, decisionId: decision.decisionId });
          return;
        }
        const task = context.getTask(action.taskId);
        if (task === undefined) {
          rejected.push({ action, reason: "task_not_found", detail: { taskId: action.taskId } });
          return;
        }
        accepted.push({ type: "set_focus", taskId: action.taskId, decisionId: decision.decisionId });
        return;
      }
    }
  });

  return {
    decisionId: decision.decisionId,
    accepted,
    rejected,
    basedOn: decision.basedOn,
    currentRevision: context.currentRevision,
    stale: decision.basedOn.controlRevision < context.currentRevision.controlRevision,
    missedEvents: decision.basedOn.eventSeq < context.currentRevision.eventSeq,
  };
}
