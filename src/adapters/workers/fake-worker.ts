/**
 * 确定性 FakeWorkerRuntime（实施计划 M3「用 FakeWorker 完成确定性测试，不调用真实 LLM」）。
 *
 * 设计取舍：**不自动汇报任何事件**。`start()` 只记录请求并返回句柄，
 * 由测试显式调用 `emit*` 驱动事件。这样：
 * - 没有隐式时序、没有微任务竞态，Scheduler 的行为完全可复现；
 * - 可以精确构造「旧代次迟到事件」等异常场景（`emitSucceeded(..., generation)`）。
 */
import type { RunGeneration, TaskId } from "../../domain/task/types.ts";
import type { WorkerEvent, WorkerHandle, WorkerRuntime, WorkerStartRequest } from "../../application/workers/ports.ts";

export interface FakeStartRequest {
  readonly taskId: TaskId;
  readonly runGeneration: RunGeneration;
  readonly goal: string;
  readonly at: number;
  readonly signal: AbortSignal;
}

export interface FakeCancelRequest {
  readonly taskId: TaskId;
  readonly runGeneration: RunGeneration;
  readonly reason: string;
  readonly at: number;
  /** Scheduler 是否已同时中止协作式取消信号。 */
  readonly signalAborted: boolean;
}

export interface FakeReleaseRecord {
  readonly taskId: TaskId;
  readonly runGeneration: RunGeneration;
}

function requestKey(taskId: TaskId, generation: RunGeneration): string {
  return `${taskId}#${generation}`;
}

export class FakeWorkerRuntime implements WorkerRuntime {
  private readonly listeners = new Set<(event: WorkerEvent) => void>();
  private readonly latest = new Map<TaskId, FakeStartRequest>();
  private readonly byKey = new Map<string, FakeStartRequest>();
  private readonly cancelFailures = new Map<TaskId, string>();
  private readonly releasedKeys = new Set<string>();
  private readonly now: () => number;

  /** 全部启动请求，按调用顺序。 */
  public readonly startRequests: FakeStartRequest[] = [];
  /** 全部取消请求，按调用顺序。 */
  public readonly cancelRequests: FakeCancelRequest[] = [];
  /** 全部回收记录，按调用顺序。 */
  public readonly releases: FakeReleaseRecord[] = [];

  public constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  public subscribe(listener: (event: WorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public start(request: WorkerStartRequest): WorkerHandle {
    const record: FakeStartRequest = {
      taskId: request.taskId,
      runGeneration: request.runGeneration,
      goal: request.goal,
      at: this.now(),
      signal: request.signal,
    };
    this.startRequests.push(record);
    this.latest.set(request.taskId, record);
    this.byKey.set(requestKey(record.taskId, record.runGeneration), record);

    return {
      taskId: record.taskId,
      runGeneration: record.runGeneration,
      cancel: async (reason: string): Promise<void> => {
        this.cancelRequests.push({
          taskId: record.taskId,
          runGeneration: record.runGeneration,
          reason,
          at: this.now(),
          signalAborted: record.signal.aborted,
        });
        const failure = this.cancelFailures.get(record.taskId);
        if (failure !== undefined) {
          this.cancelFailures.delete(record.taskId);
          throw new Error(failure);
        }
      },
      release: async (): Promise<void> => {
        this.releasedKeys.add(requestKey(record.taskId, record.runGeneration));
        this.releases.push({ taskId: record.taskId, runGeneration: record.runGeneration });
      },
    };
  }

  /** 让下一次对该任务的取消请求失败（模拟「不可取消的操作」）。 */
  public failNextCancel(taskId: TaskId, message: string): void {
    this.cancelFailures.set(taskId, message);
  }

  /** 该任务最近一次执行的代次；没有启动记录时返回 undefined。 */
  public generationOf(taskId: TaskId): RunGeneration | undefined {
    return this.latest.get(taskId)?.runGeneration;
  }

  public hasStarted(taskId: TaskId): boolean {
    return this.latest.has(taskId);
  }

  /** 已启动且尚未回收。 */
  public isActive(taskId: TaskId): boolean {
    const record = this.latest.get(taskId);
    if (record === undefined) return false;
    return !this.releasedKeys.has(requestKey(record.taskId, record.runGeneration));
  }

  public emitStarted(taskId: TaskId, generation?: RunGeneration): void {
    const base = this.baseOf(taskId, generation);
    this.dispatch({ type: "worker_started", ...base });
  }

  public emitProgress(taskId: TaskId, note: string, generation?: RunGeneration): void {
    const base = this.baseOf(taskId, generation);
    this.dispatch({ type: "worker_progress", ...base, note });
  }

  public emitToolCall(taskId: TaskId, toolName: string, generation?: RunGeneration): void {
    const base = this.baseOf(taskId, generation);
    this.dispatch({ type: "worker_tool_call", ...base, toolName });
  }

  public emitSucceeded(taskId: TaskId, summary: string, generation?: RunGeneration): void {
    const base = this.baseOf(taskId, generation);
    this.dispatch({ type: "worker_succeeded", ...base, summary });
  }

  public emitFailed(taskId: TaskId, reason: string, generation?: RunGeneration): void {
    const base = this.baseOf(taskId, generation);
    this.dispatch({ type: "worker_failed", ...base, reason });
  }

  public emitCancelled(taskId: TaskId, reason: string, generation?: RunGeneration): void {
    const base = this.baseOf(taskId, generation);
    this.dispatch({ type: "worker_cancelled", ...base, reason });
  }

  /** 直接投递任意事件，用于构造协议外的异常场景。 */
  public emitRaw(event: WorkerEvent): void {
    this.dispatch(event);
  }

  private baseOf(
    taskId: TaskId,
    generation?: RunGeneration,
  ): { taskId: TaskId; runGeneration: RunGeneration; at: number } {
    const runGeneration = generation ?? this.latest.get(taskId)?.runGeneration;
    if (runGeneration === undefined) {
      throw new Error(`FakeWorkerRuntime：taskId=${taskId} 没有启动记录，无法汇报事件`);
    }
    return { taskId, runGeneration, at: this.now() };
  }

  private dispatch(event: WorkerEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
