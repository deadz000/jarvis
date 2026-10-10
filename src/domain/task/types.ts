/**
 * Task / Execution 领域类型。
 *
 * 依据：项目需求规格说明书 §4.1（Task 执行状态）、踩坑指南铁律 3
 * （「是谁」与「哪一次」必须分离 → TaskId 与 runGeneration 分离）。
 */

export type TaskId = string;

/**
 * 执行代次：标识「该目标的一次具体执行」。
 * `0` 表示尚未开始任何执行（任务仍在排队）。
 * 与 TaskId 严格分离，用于拒绝旧执行的迟到事件。
 */
export type RunGeneration = number;

/** 尚未开始执行时的代次。 */
export const NO_RUN_GENERATION: RunGeneration = 0;

/**
 * 任务优先级（决策清单 C：现在只引入枚举与字段，**不启用抢占**）。
 * 语义冻结与抢占条件属 M5 交付策略；当前仅作为记录与排序依据。
 */
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const DEFAULT_PRIORITY: Priority = "normal";

export function isPriority(value: unknown): value is Priority {
  return typeof value === "string" && (PRIORITIES as readonly string[]).includes(value);
}

export const TASK_STATES = [
  "queued",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES = ["succeeded", "failed", "cancelled"] as const;
export type TerminalTaskState = (typeof TERMINAL_TASK_STATES)[number];

/** 非终态 = 仍占用调度注意力的状态。 */
export const ACTIVE_TASK_STATES = ["queued", "running", "cancel_requested"] as const;
export type ActiveTaskState = (typeof ACTIVE_TASK_STATES)[number];

export function isTerminalTaskState(state: TaskState): state is TerminalTaskState {
  return (TERMINAL_TASK_STATES as readonly TaskState[]).includes(state);
}

export function isActiveTaskState(state: TaskState): state is ActiveTaskState {
  return (ACTIVE_TASK_STATES as readonly TaskState[]).includes(state);
}

/**
 * 任务快照。不可变：每次状态变更产生新记录，
 * 避免调用方持有可变引用绕过单一写入口。
 */
export interface TaskRecord {
  readonly taskId: TaskId;
  readonly goal: string;
  readonly state: TaskState;
  readonly runGeneration: RunGeneration;
  /** 记录用优先级。**当前不参与抢占或调度顺序**（FIFO 维持到 M8）。 */
  readonly priority: Priority;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 最近一次与任务相关的活动时间，用于有界视图排序。 */
  readonly lastActivityAt: number;
  readonly startedAt?: number;
  readonly terminalAt?: number;
  readonly cancelRequestedAt?: number;
  readonly cancelReason?: string;
  readonly resultSummary?: string;
  readonly failureReason?: string;
}

/** 任务是否已进入终态（终态不可再变更）。 */
export function isTaskTerminal(task: TaskRecord): boolean {
  return isTerminalTaskState(task.state);
}
