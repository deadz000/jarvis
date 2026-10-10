/**
 * WorkerRuntime 端口（实施计划 M2）。
 *
 * 契约要点：
 * 1. **Worker 只能汇报事实，不能修改权威状态。** 这里的事件全部是「发生了什么」，
 *    是否改变 Task 状态由 Scheduler 判定（SRS §2.1 关键职责原则）。
 * 2. 每个事件必须携带 `taskId` + `runGeneration` + `at`，使旧代次迟到事件可被识别。
 * 3. 取消语义分两层（SRS §4.1）：
 *    - `handle.cancel()` resolve 表示**取消请求已送达执行层**；
 *    - `worker_cancelled` 事件表示**执行层已确认停止**，Scheduler 才提交 `cancelled`。
 *    执行层若无法停止，应改报 `worker_succeeded` / `worker_failed`，
 *    **不得伪装成成功取消**（SRS §7.4）。
 */
import type { RunGeneration, TaskId } from "../../domain/task/types.ts";

interface WorkerEventBase {
  readonly taskId: TaskId;
  readonly runGeneration: RunGeneration;
  /** 事件时间戳（毫秒），由 Worker 侧或注入时钟提供。 */
  readonly at: number;
}

export interface WorkerStartedEvent extends WorkerEventBase {
  readonly type: "worker_started";
}

export interface WorkerProgressEvent extends WorkerEventBase {
  readonly type: "worker_progress";
  readonly note: string;
}

export interface WorkerToolCallEvent extends WorkerEventBase {
  readonly type: "worker_tool_call";
  readonly toolName: string;
}

export interface WorkerSucceededEvent extends WorkerEventBase {
  readonly type: "worker_succeeded";
  /** 完整结果（面板与历史记录用）。 */
  readonly summary: string;
  /**
   * 口语化播报稿（语音交付用）。可省略 —— 由适配层用**确定性**转换兜底生成，
   * 见 `application/delivery/spoken-text.ts`。
   */
  readonly spokenSummary?: string;
}

export interface WorkerFailedEvent extends WorkerEventBase {
  readonly type: "worker_failed";
  readonly reason: string;
}

export interface WorkerCancelledEvent extends WorkerEventBase {
  readonly type: "worker_cancelled";
  readonly reason: string;
}

/** Worker 汇报的全部事实。 */
export type WorkerEvent =
  | WorkerStartedEvent
  | WorkerProgressEvent
  | WorkerToolCallEvent
  | WorkerSucceededEvent
  | WorkerFailedEvent
  | WorkerCancelledEvent;

export type WorkerTerminalEvent = WorkerSucceededEvent | WorkerFailedEvent | WorkerCancelledEvent;

export function isWorkerTerminalEvent(event: WorkerEvent): event is WorkerTerminalEvent {
  return (
    event.type === "worker_succeeded" ||
    event.type === "worker_failed" ||
    event.type === "worker_cancelled"
  );
}

/** 一次执行的启动请求。 */
export interface WorkerStartRequest {
  readonly taskId: TaskId;
  readonly runGeneration: RunGeneration;
  readonly goal: string;
  /**
   * 协作式取消信号。适配器负责在 `handle.cancel()` 被调用时中止它，
   * 使 Worker 内部的工具执行能够观察到取消（M1 需验证 Pi SDK 的实际能力）。
   */
  readonly signal: AbortSignal;
}

export interface WorkerHandle {
  readonly taskId: TaskId;
  readonly runGeneration: RunGeneration;
  /** 请求取消：resolve = 请求已送达；停止确认由 `worker_cancelled` 事件给出。 */
  cancel(reason: string): Promise<void>;
  /** 回收该次执行占用的资源（Session、订阅、进程句柄等）。 */
  release(): Promise<void>;
}

export interface WorkerRuntime {
  /** 订阅全量 Worker 事件；返回退订函数。 */
  subscribe(listener: (event: WorkerEvent) => void): () => void;
  /** 启动一次执行代次。实现方必须自行按契约携带 taskId/runGeneration 汇报事件。 */
  start(request: WorkerStartRequest): WorkerHandle;
}

/**
 * 逐 token 的文本增量（**高频通道**）。
 *
 * 刻意**不**放进 `WorkerEvent`：那会让每个 token 都流经 Scheduler 的确定性事件流，
 * 污染状态机、放大事件量（踩坑指南铁律 4：高频实时通道必须独立于低频高优先级的共享循环）。
 * 它只用于「把正在生成的文字实时显示到界面」，不参与任何状态决策。
 */
export interface WorkerTranscriptChunk {
  readonly taskId: TaskId;
  readonly runGeneration: RunGeneration;
  readonly delta: string;
  readonly at: number;
}
