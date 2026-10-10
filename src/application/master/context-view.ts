/**
 * 有界世界视图与两维版本号（M4）。
 *
 * 落实三条硬约束：
 * 1. **面向 LLM 的视图必须有界**（踩坑指南第 6 条）：活动任务、最近输入、最近完成
 *    各有数量上限，而不是把所有历史塞进上下文。
 * 2. **不暴露内部 Runtime 对象**：只给摘要字段，模型看不到 Session/句柄等内部结构。
 * 3. **两类序号分离**：遥测变化只让「信息变新」，不让决策过期。
 */
import type { TaskScheduler, SchedulerEvent, SchedulerEventType } from "../scheduler/scheduler.ts";
import { INITIAL_REVISION, type WorldRevision } from "../../domain/decision/types.ts";
import type { TaskState } from "../../domain/task/types.ts";

/** 送给 Master 的任务摘要：只有必要字段，没有 Runtime 内部对象。 */
export interface TaskSummary {
  readonly taskId: string;
  readonly goal: string;
  readonly state: TaskState;
  readonly runGeneration: number;
  readonly priority: string;
  readonly lastActivityAt: number;
}

export interface CompletionSummary {
  readonly taskId: string;
  readonly state: TaskState;
  readonly resultSummary: string | null;
  readonly terminalAt: number;
}

export interface InputSummary {
  readonly at: number;
  readonly source: string;
  readonly text: string;
}

export interface MasterContextView {
  readonly revision: WorldRevision;
  readonly latestUserInput: string | null;
  readonly recentInputs: readonly InputSummary[];
  readonly activeTasks: readonly TaskSummary[];
  readonly recentCompletions: readonly CompletionSummary[];
}

export const DEFAULT_ACTIVE_TASK_LIMIT = 5;
export const DEFAULT_RECENT_INPUT_LIMIT = 5;
export const DEFAULT_RECENT_COMPLETION_LIMIT = 5;

/**
 * 该 Scheduler 事件是否会使「合法决策集合」改变。
 *
 * 这条判定就是两维版本号的分界线：
 * - 状态类事件 → 递增 `controlRevision`（旧决策可能失效）；
 * - 遥测类事件（进度、工具调用）→ 只递增信息量，**不动** `controlRevision`。
 */
export function isControlChangingEvent(type: SchedulerEventType): boolean {
  switch (type) {
    case "task_created":
    case "task_admitted":
    case "task_cancel_requested":
    case "task_succeeded":
    case "task_failed":
    case "task_cancelled":
    case "task_start_failed":
      return true;
    case "task_progress":
    case "task_tool_call":
    case "task_cancel_request_failed":
    case "worker_event_rejected":
      return false;
  }
}

const CONTROL_TERMINAL_EVENTS: ReadonlySet<SchedulerEventType> = new Set([
  "task_succeeded",
  "task_failed",
  "task_cancelled",
]);

export interface WorldModelOptions {
  readonly scheduler: TaskScheduler;
  readonly now?: () => number;
  readonly activeTaskLimit?: number;
  readonly recentInputLimit?: number;
  readonly recentCompletionLimit?: number;
}

export class WorldModel {
  private readonly scheduler: TaskScheduler;
  private readonly now: () => number;
  private readonly activeTaskLimit: number;
  private readonly recentInputLimit: number;
  private readonly recentCompletionLimit: number;
  private readonly recentInputs: InputSummary[] = [];
  private readonly recentCompletions: CompletionSummary[] = [];
  private readonly unsubscribe: () => void;

  private eventSeq = INITIAL_REVISION.eventSeq;
  private controlRevision = INITIAL_REVISION.controlRevision;
  private latestUserInput: string | null = null;

  public constructor(options: WorldModelOptions) {
    this.scheduler = options.scheduler;
    this.now = options.now ?? (() => Date.now());
    this.activeTaskLimit = options.activeTaskLimit ?? DEFAULT_ACTIVE_TASK_LIMIT;
    this.recentInputLimit = options.recentInputLimit ?? DEFAULT_RECENT_INPUT_LIMIT;
    this.recentCompletionLimit = options.recentCompletionLimit ?? DEFAULT_RECENT_COMPLETION_LIMIT;

    this.unsubscribe = this.scheduler.onEvent((event) => {
      this.handleSchedulerEvent(event);
    });
  }

  public dispose(): void {
    this.unsubscribe();
  }

  public revision(): WorldRevision {
    return { eventSeq: this.eventSeq, controlRevision: this.controlRevision };
  }

  /**
   * 接收一个输入事件：递增 `eventSeq`（事件完整性），并保留有界的最近输入。
   * 注意：输入本身**不**改变 `controlRevision` —— 新话语让信息变新，但不让既有决策失效。
   */
  public ingestInput(input: { readonly source: string; readonly text: string }): InputSummary {
    const summary: InputSummary = { at: this.now(), source: input.source, text: input.text };
    this.eventSeq += 1;
    this.recentInputs.push(summary);
    while (this.recentInputs.length > this.recentInputLimit) this.recentInputs.shift();
    if (input.source === "user") this.latestUserInput = input.text;
    return summary;
  }

  public buildView(): MasterContextView {
    const activeTasks: TaskSummary[] = this.scheduler.listActiveTasks(this.activeTaskLimit).map((task) => ({
      taskId: task.taskId,
      goal: task.goal,
      state: task.state,
      runGeneration: task.runGeneration,
      priority: task.priority,
      lastActivityAt: task.lastActivityAt,
    }));

    return {
      revision: this.revision(),
      latestUserInput: this.latestUserInput,
      recentInputs: [...this.recentInputs],
      activeTasks,
      recentCompletions: [...this.recentCompletions],
    };
  }

  private handleSchedulerEvent(event: SchedulerEvent): void {
    if (isControlChangingEvent(event.type)) this.controlRevision += 1;

    if (CONTROL_TERMINAL_EVENTS.has(event.type)) {
      const task = this.scheduler.getTask(event.taskId);
      this.recentCompletions.unshift({
        taskId: event.taskId,
        state: task?.state ?? "cancelled",
        resultSummary: task?.resultSummary ?? null,
        terminalAt: task?.terminalAt ?? event.at,
      });
      while (this.recentCompletions.length > this.recentCompletionLimit) this.recentCompletions.pop();
    }
  }
}
