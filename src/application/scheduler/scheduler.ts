/**
 * 确定性 Task Scheduler（实施计划 M3）。
 *
 * ## 唯一写入口
 * 所有 Task 状态变更都发生在本类内部。Worker 事件只是**事实**，
 * 是否改变状态由本类判定（SRS §2.1）。
 *
 * ## 已实现的关键不变量
 * 1. **代次隔离**：`event.runGeneration !== task.runGeneration` 的事件一律拒绝，
 *    不修改任何状态（踩坑指南铁律 3）。
 * 2. **终态不可变**：终态任务收到任何后续事件都被拒绝，旧结果不会覆盖新状态。
 * 3. **取消与完成的竞态**：`cancel_requested` 状态下收到 `succeeded`/`failed`
 *    仍按真实结果提交，并标记 `cancelRaced`（SRS §4.1）。
 * 4. **取消请求 ≠ 已取消**：只有 `worker_cancelled` 事件才提交 `cancelled`。
 * 5. **准入有界**：并发上限 + FIFO 准入队列，配置化传入，不硬编码历史数值。
 * 6. **幂等键**：相同 `idempotencyKey` 不会重复创建任务（支撑 M4 的重复决策防护）。
 *
 * ## 尚未实现（属后续里程碑，不在此伪装）
 * - 决策快照校验与逐动作校验（M4）；
 * - 结果持久化与交付（M5）；
 * - 取消超时看门狗、重启恢复（M7）。
 */
import { assertTransition } from "../../domain/task/state-machine.ts";
import {
  DEFAULT_PRIORITY,
  isActiveTaskState,
  isTerminalTaskState,
  NO_RUN_GENERATION,
  type Priority,
  type RunGeneration,
  type TaskId,
  type TaskRecord,
  type TaskState,
  type TerminalTaskState,
} from "../../domain/task/types.ts";
import type { Logger } from "../../observability/logger.ts";
import type { WorkerEvent, WorkerHandle, WorkerRuntime, WorkerStartRequest } from "../workers/ports.ts";

export type SchedulerEventType =
  | "task_created"
  | "task_admitted"
  | "task_progress"
  | "task_tool_call"
  | "task_cancel_requested"
  | "task_cancel_request_failed"
  | "task_succeeded"
  | "task_failed"
  | "task_cancelled"
  | "task_start_failed"
  | "worker_event_rejected";

export type WorkerEventRejectionReason =
  | "unknown_task"
  | "stale_generation"
  | "task_terminal";

export interface SchedulerEvent {
  readonly type: SchedulerEventType;
  readonly at: number;
  readonly taskId: TaskId;
  readonly runGeneration: RunGeneration;
  /** 任务未知时为 "unknown"（例如 Worker 汇报了不属于本 Scheduler 的 taskId）。 */
  readonly state: TaskState | "unknown";
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface SchedulerOptions {
  readonly runtime: WorkerRuntime;
  /** 并发执行上限。由调用方配置（环境变量），不使用历史项目的硬编码值。 */
  readonly maxConcurrent: number;
  readonly now?: () => number;
  readonly logger?: Logger;
  /** 面向 Master 的活动任务视图上限（有界视图）。 */
  readonly activeViewLimit?: number;
}

export const DEFAULT_ACTIVE_VIEW_LIMIT = 5;

export interface CreateTaskRequest {
  readonly goal: string;
  /** 幂等键：同一键重复创建返回既有任务而不是新建（M4 重复决策防护的基础）。 */
  readonly idempotencyKey?: string;
  /** 关联的 Master 决策 ID，仅用于可观测性。 */
  readonly decisionId?: string;
  /** 记录用优先级；省略时为 normal。当前不影响准入顺序。 */
  readonly priority?: Priority;
}

export type CreateTaskOutcome =
  | { readonly status: "created"; readonly task: TaskRecord }
  | { readonly status: "reused"; readonly task: TaskRecord }
  | { readonly status: "rejected"; readonly reason: string };

export type CancelRejectionReason =
  | "task_not_found"
  | "already_terminal"
  | "already_cancel_requested";

export type CancelOutcome =
  | { readonly status: "cancelled"; readonly task: TaskRecord }
  | { readonly status: "cancel_requested"; readonly task: TaskRecord }
  | { readonly status: "cancel_request_failed"; readonly task: TaskRecord; readonly reason: string }
  | { readonly status: "rejected"; readonly reason: CancelRejectionReason; readonly task?: TaskRecord };

export interface SchedulerStats {
  readonly total: number;
  readonly byState: Readonly<Record<TaskState, number>>;
  readonly running: number;
  readonly queued: number;
  readonly maxConcurrent: number;
}

export class TaskScheduler {
  private readonly runtime: WorkerRuntime;
  private readonly now: () => number;
  private readonly maxConcurrent: number;
  private readonly logger: Logger | undefined;
  private readonly activeViewLimit: number;

  private readonly tasks = new Map<TaskId, TaskRecord>();
  private readonly byIdempotencyKey = new Map<string, TaskId>();
  private readonly queue: TaskId[] = [];
  private readonly handles = new Map<TaskId, WorkerHandle>();
  private readonly controllers = new Map<TaskId, AbortController>();
  private readonly listeners = new Set<(event: SchedulerEvent) => void>();
  private readonly unsubscribeRuntime: () => void;

  private nextTaskOrdinal = 1;
  private admitting = false;
  private disposed = false;

  public constructor(options: SchedulerOptions) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new RangeError(`maxConcurrent 必须是 >= 1 的整数，收到：${options.maxConcurrent}`);
    }
    this.runtime = options.runtime;
    this.now = options.now ?? (() => Date.now());
    this.maxConcurrent = options.maxConcurrent;
    this.logger = options.logger;
    this.activeViewLimit = options.activeViewLimit ?? DEFAULT_ACTIVE_VIEW_LIMIT;
    this.unsubscribeRuntime = this.runtime.subscribe((event) => {
      this.handleWorkerEvent(event);
    });
  }

  // ---------------------------------------------------------------- 命令入口

  public createTask(request: CreateTaskRequest): CreateTaskOutcome {
    if (this.disposed) return { status: "rejected", reason: "scheduler_disposed" };

    const goal = request.goal.trim();
    if (goal.length === 0) return { status: "rejected", reason: "empty_goal" };

    if (request.idempotencyKey !== undefined) {
      const existingId = this.byIdempotencyKey.get(request.idempotencyKey);
      const existing = existingId === undefined ? undefined : this.tasks.get(existingId);
      if (existing !== undefined) {
        this.logger?.info("scheduler.task_reused", {
          taskId: existing.taskId,
          runGeneration: existing.runGeneration,
          state: existing.state,
          idempotencyKey: request.idempotencyKey,
        });
        return { status: "reused", task: existing };
      }
    }

    const at = this.now();
    const taskId = `task-${this.nextTaskOrdinal}`;
    this.nextTaskOrdinal += 1;

    const task: TaskRecord = {
      taskId,
      goal,
      state: "queued",
      runGeneration: NO_RUN_GENERATION,
      priority: request.priority ?? DEFAULT_PRIORITY,
      createdAt: at,
      updatedAt: at,
      lastActivityAt: at,
    };
    this.tasks.set(taskId, task);
    this.queue.push(taskId);
    if (request.idempotencyKey !== undefined) {
      this.byIdempotencyKey.set(request.idempotencyKey, taskId);
    }

    this.emit({
      type: "task_created",
      at,
      taskId,
      runGeneration: task.runGeneration,
      state: task.state,
      ...(request.decisionId === undefined ? {} : { detail: { decisionId: request.decisionId } }),
    });

    this.admitPending();
    return { status: "created", task: this.requireTask(taskId) };
  }

  /**
   * 请求取消。
   * - `queued`：直接提交 `cancelled`，并移出准入队列（不影响其他任务）。
   * - `running`：提交 `cancel_requested`，向执行层发出取消请求并中止协作式信号。
   *   **不**在此提交 `cancelled` —— 必须等执行层确认。
   * - 终态 / 已请求：幂等拒绝，不改变状态。
   */
  public async requestCancel(taskId: TaskId, reason: string): Promise<CancelOutcome> {
    const task = this.tasks.get(taskId);
    if (task === undefined) return { status: "rejected", reason: "task_not_found" };
    if (isTerminalTaskState(task.state)) {
      return { status: "rejected", reason: "already_terminal", task };
    }
    if (task.state === "cancel_requested") {
      return { status: "rejected", reason: "already_cancel_requested", task };
    }

    const at = this.now();

    if (task.state === "queued") {
      const index = this.queue.indexOf(taskId);
      if (index >= 0) this.queue.splice(index, 1);
      const cancelled = this.transitionTo(task, "cancelled", "task_cancelled", {
        cancelReason: reason,
        cancelRequestedAt: at,
        terminalAt: at,
        lastActivityAt: at,
      });
      return { status: "cancelled", task: cancelled };
    }

    const requested = this.transitionTo(task, "cancel_requested", "task_cancel_requested", {
      cancelReason: reason,
      cancelRequestedAt: at,
      lastActivityAt: at,
    });

    const controller = this.controllers.get(taskId);
    const handle = this.handles.get(taskId);
    // 协作式信号先中止，使 Worker 内部的工具执行能观察到取消。
    controller?.abort(reason);

    if (handle === undefined) {
      this.logger?.warn("scheduler.cancel_without_handle", { taskId, runGeneration: requested.runGeneration });
      return { status: "cancel_requested", task: requested };
    }

    try {
      await handle.cancel(reason);
    } catch (error) {
      // 请求送达失败：任务停在 cancel_requested，等待执行层自行汇报终态。
      // 不能假装已取消（SRS §7.4）。
      const latest = this.tasks.get(taskId) ?? requested;
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: "task_cancel_request_failed",
        at: this.now(),
        taskId,
        runGeneration: latest.runGeneration,
        state: latest.state,
        detail: { reason, error: message },
      });
      return { status: "cancel_request_failed", task: latest, reason: message };
    }

    const latest = this.tasks.get(taskId) ?? requested;
    // 请求送达期间执行层可能已经确认停止。
    if (latest.state === "cancelled") return { status: "cancelled", task: latest };
    return { status: "cancel_requested", task: latest };
  }

  // ---------------------------------------------------------------- 查询

  public getTask(taskId: TaskId): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  public listTasks(): readonly TaskRecord[] {
    return [...this.tasks.values()];
  }

  /** 有界视图：按最近活动倒序，最多 `limit` 条（避免无界上下文，SRS §9.6）。 */
  public listActiveTasks(limit: number = this.activeViewLimit): readonly TaskRecord[] {
    const active = [...this.tasks.values()].filter((task) => isActiveTaskState(task.state));
    active.sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.taskId.localeCompare(b.taskId));
    return active.slice(0, Math.max(0, limit));
  }

  public stats(): SchedulerStats {
    const byState: Record<TaskState, number> = {
      queued: 0,
      running: 0,
      cancel_requested: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const task of this.tasks.values()) byState[task.state] += 1;
    return {
      total: this.tasks.size,
      byState,
      running: byState.running,
      queued: byState.queued,
      maxConcurrent: this.maxConcurrent,
    };
  }

  public onEvent(listener: (event: SchedulerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async dispose(reason = "scheduler_disposed"): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeRuntime();

    const active = [...this.tasks.values()].filter((task) => isActiveTaskState(task.state));
    await Promise.all(
      active.map(async (task) => {
        try {
          await this.requestCancel(task.taskId, reason);
        } catch (error) {
          this.logger?.warn("scheduler.dispose_cancel_failed", { taskId: task.taskId, error });
        }
      }),
    );

    const handles = [...this.handles.values()];
    await Promise.all(
      handles.map(async (handle) => {
        try {
          await handle.release();
        } catch {
          // 回收失败不影响关闭流程；已在 releaseExecution 中记录过日志路径。
        }
      }),
    );
    this.handles.clear();
    this.controllers.clear();
  }

  // ---------------------------------------------------------------- Worker 事件

  private handleWorkerEvent(event: WorkerEvent): void {
    const task = this.tasks.get(event.taskId);
    if (task === undefined) {
      this.rejectWorkerEvent(event, "unknown_task", undefined);
      return;
    }
    if (event.runGeneration !== task.runGeneration) {
      this.rejectWorkerEvent(event, "stale_generation", task);
      return;
    }
    if (isTerminalTaskState(task.state)) {
      this.rejectWorkerEvent(event, "task_terminal", task);
      return;
    }

    switch (event.type) {
      case "worker_started":
        this.touch(task, "task_progress", event.at, { phase: "started" });
        return;
      case "worker_progress":
        this.touch(task, "task_progress", event.at, { phase: "progress", note: event.note });
        return;
      case "worker_tool_call":
        this.touch(task, "task_tool_call", event.at, { toolName: event.toolName });
        return;
      case "worker_succeeded":
        this.settle(task, "succeeded", "task_succeeded", event.at, { resultSummary: event.summary });
        return;
      case "worker_failed":
        this.settle(task, "failed", "task_failed", event.at, { failureReason: event.reason });
        return;
      case "worker_cancelled":
        this.settle(task, "cancelled", "task_cancelled", event.at, { cancelReason: event.reason });
        return;
    }
  }

  private rejectWorkerEvent(
    event: WorkerEvent,
    reason: WorkerEventRejectionReason,
    task: TaskRecord | undefined,
  ): void {
    this.emit({
      type: "worker_event_rejected",
      at: this.now(),
      taskId: event.taskId,
      runGeneration: event.runGeneration,
      state: task?.state ?? "unknown",
      detail: {
        reason,
        workerEventType: event.type,
        currentGeneration: task?.runGeneration ?? null,
        currentState: task?.state ?? null,
      },
    });
  }

  // ---------------------------------------------------------------- 准入

  private admitPending(): void {
    if (this.admitting || this.disposed) return;
    this.admitting = true;
    try {
      while (this.runningCount() < this.maxConcurrent) {
        const taskId = this.queue.shift();
        if (taskId === undefined) break;
        const task = this.tasks.get(taskId);
        // 队列里的任务可能已被取消或已终态；跳过而不是静默启动。
        if (task === undefined || task.state !== "queued") {
          this.logger?.debug("scheduler.queue_skip", { taskId, state: task?.state ?? null });
          continue;
        }
        this.admit(task);
      }
    } finally {
      this.admitting = false;
    }
  }

  private admit(task: TaskRecord): void {
    const at = this.now();
    const runGeneration = task.runGeneration + 1;
    const controller = new AbortController();
    const request: WorkerStartRequest = {
      taskId: task.taskId,
      runGeneration,
      goal: task.goal,
      signal: controller.signal,
    };

    assertTransition(task.state, "running");
    const running: TaskRecord = {
      ...task,
      state: "running",
      runGeneration,
      startedAt: at,
      updatedAt: at,
      lastActivityAt: at,
    };
    this.tasks.set(running.taskId, running);
    this.emit({
      type: "task_admitted",
      at,
      taskId: running.taskId,
      runGeneration,
      state: running.state,
    });

    try {
      this.handles.set(running.taskId, this.runtime.start(request));
      this.controllers.set(running.taskId, controller);
    } catch (error) {
      // 启动失败必须显式落到 failed，不能让任务无声消失。
      const message = error instanceof Error ? error.message : String(error);
      const failed: TaskRecord = {
        ...running,
        state: "failed",
        terminalAt: at,
        updatedAt: at,
        lastActivityAt: at,
        failureReason: `Worker 启动失败：${message}`,
      };
      this.tasks.set(failed.taskId, failed);
      this.emit({
        type: "task_start_failed",
        at,
        taskId: failed.taskId,
        runGeneration,
        state: failed.state,
        detail: { error: message },
      });
    }
  }

  private runningCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.state === "running") count += 1;
    }
    return count;
  }

  // ---------------------------------------------------------------- 状态提交

  /** 非状态转移的活动更新（进度、工具调用、心跳）。 */
  private touch(
    task: TaskRecord,
    eventType: SchedulerEventType,
    at: number,
    detail?: Readonly<Record<string, unknown>>,
  ): TaskRecord {
    const updated: TaskRecord = { ...task, updatedAt: at, lastActivityAt: at };
    this.tasks.set(updated.taskId, updated);
    this.emit({
      type: eventType,
      at,
      taskId: updated.taskId,
      runGeneration: updated.runGeneration,
      state: updated.state,
      ...(detail === undefined ? {} : { detail }),
    });
    return updated;
  }

  /** 显式的状态转移：非法转移抛错（编程错误必须暴露）。 */
  private transitionTo(
    task: TaskRecord,
    to: TaskState,
    eventType: SchedulerEventType,
    patch: Partial<TaskRecord>,
  ): TaskRecord {
    assertTransition(task.state, to);
    const at = patch.updatedAt ?? this.now();
    const updated: TaskRecord = { ...task, ...patch, state: to, updatedAt: at };
    this.tasks.set(updated.taskId, updated);
    this.emit({
      type: eventType,
      at,
      taskId: updated.taskId,
      runGeneration: updated.runGeneration,
      state: updated.state,
      ...(to === "cancelled" && task.state === "queued" ? { detail: { cancelledBeforeStart: true } } : {}),
    });
    return updated;
  }

  private settle(
    task: TaskRecord,
    to: TerminalTaskState,
    eventType: SchedulerEventType,
    at: number,
    patch: Partial<TaskRecord>,
  ): void {
    // 竞态：已请求取消但执行层报出真实结果 → 按真实结果提交并标记。
    const cancelRaced = task.state === "cancel_requested" && to !== "cancelled";
    assertTransition(task.state, to);
    const settled: TaskRecord = {
      ...task,
      ...patch,
      state: to,
      terminalAt: at,
      updatedAt: at,
      lastActivityAt: at,
    };
    this.tasks.set(settled.taskId, settled);
    this.releaseExecution(settled.taskId);
    this.emit({
      type: eventType,
      at,
      taskId: settled.taskId,
      runGeneration: settled.runGeneration,
      state: settled.state,
      ...(cancelRaced ? { detail: { cancelRaced: true } } : {}),
    });
    this.admitPending();
  }

  private releaseExecution(taskId: TaskId): void {
    const handle = this.handles.get(taskId);
    this.handles.delete(taskId);
    this.controllers.delete(taskId);
    if (handle === undefined) return;
    void handle.release().catch((error: unknown) => {
      this.logger?.warn("scheduler.worker_release_failed", {
        taskId,
        runGeneration: handle.runGeneration,
        error,
      });
    });
  }

  private requireTask(taskId: TaskId): TaskRecord {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error(`内部错误：任务 ${taskId} 不存在`);
    return task;
  }

  private emit(event: SchedulerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.logger?.warn("scheduler.listener_failed", { taskId: event.taskId, error });
      }
    }
    this.logger?.debug("scheduler.event", {
      taskId: event.taskId,
      runGeneration: event.runGeneration,
      state: event.state,
      schedulerEvent: event.type,
      ...(event.detail === undefined ? {} : { detail: event.detail }),
    });
  }
}
