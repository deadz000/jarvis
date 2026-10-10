/**
 * 演示运行时装配（实施计划 §8 Milestone Alpha）。
 *
 * 把已经独立验证过的部件串成一条可用链路：
 *   聊天输入 → WorldModel（两维版本号）→ Master 决策 → 逐动作校验 →
 *   Scheduler → 真实 Pi Worker（每 Task 独立 Session）→ 结果 →
 *   交付队列 → 模拟 Audio Manager（播放代次仲裁）。
 *
 * 本文件只做**装配与可观测**，不含任何新的领域规则：
 * 所有状态变更仍然只经 Scheduler / 交付层，Master 仍然只能提出建议。
 */
import type { AppConfig } from "../config/env.ts";
import type { SchedulerEvent } from "../application/scheduler/scheduler.ts";
import type { AudioEvent, AudioStats } from "./delivery/audio-manager.ts";
import type { DeliveryEvent, DeliveryItem } from "./delivery/delivery-queue.ts";
import type { DecisionCycleResult } from "./master/decision-plane.ts";
import type { WorldRevision } from "../domain/decision/types.ts";
import type { Priority, TaskState } from "../domain/task/types.ts";
import type { Logger } from "../observability/logger.ts";
import type { SelectedModel } from "../adapters/pi/model-selection.ts";

import { PiMasterAdapter } from "../adapters/pi/pi-master.ts";
import { PiWorkerRuntime } from "../adapters/pi/pi-worker-runtime.ts";
import { InteractionFocusStore } from "./interaction/focus.ts";
import { WorldModel } from "./master/context-view.ts";
import { MasterDecisionPlane } from "./master/decision-plane.ts";
import { TaskScheduler } from "./scheduler/scheduler.ts";
import { DeliveryQueue } from "./delivery/delivery-queue.ts";
import { SimulatedAudioManager } from "./delivery/audio-manager.ts";

export interface TaskView {
  readonly taskId: string;
  readonly goal: string;
  readonly state: TaskState;
  readonly runGeneration: number;
  readonly priority: Priority;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly terminalAt: number | null;
  readonly lastActivityAt: number;
  readonly resultSummary: string | null;
  readonly failureReason: string | null;
  readonly cancelReason: string | null;
}

export interface AudioView {
  readonly playing: boolean;
  readonly taskId: string | null;
  readonly token: number;
  readonly stoppedToken: number | null;
  readonly stats: AudioStats;
}

export interface TimelineEntry {
  readonly at: number;
  readonly kind: string;
  readonly text: string;
}

export interface DecisionView {
  readonly decisionId: string | null;
  readonly status: string;
  readonly applied: readonly { readonly type: string; readonly detail: string }[];
  readonly rejected: readonly { readonly type: string; readonly reason: string }[];
  readonly stale: boolean;
  readonly elapsedMs: number;
  readonly note: string | null;
}

export interface RuntimeSnapshot {
  readonly revision: WorldRevision;
  readonly model: { readonly provider: string; readonly id: string };
  readonly focusTaskId: string | null;
  readonly tasks: readonly TaskView[];
  readonly deliveries: readonly DeliveryItem[];
  readonly audio: AudioView;
  readonly lastDecision: DecisionView | null;
  readonly timeline: readonly TimelineEntry[];
}

export interface JarvisRuntimeOptions {
  readonly config: AppConfig;
  readonly selected: SelectedModel;
  readonly logger?: Logger;
  readonly maxTimelineEntries?: number;
}

export const DEFAULT_MAX_TIMELINE_ENTRIES = 200;

export class JarvisRuntime {
  private readonly config: AppConfig;
  private readonly selected: SelectedModel;
  private readonly logger: Logger | undefined;
  private readonly maxTimelineEntries: number;

  private readonly scheduler: TaskScheduler;
  private readonly world: WorldModel;
  private readonly focus = new InteractionFocusStore();
  private readonly plane: MasterDecisionPlane;
  private readonly audio: SimulatedAudioManager;
  private readonly delivery: DeliveryQueue;

  private readonly listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly timeline: TimelineEntry[] = [];

  private lastDecision: DecisionView | null = null;
  private stoppedToken: number | null = null;
  private disposed = false;

  public constructor(options: JarvisRuntimeOptions) {
    this.config = options.config;
    this.selected = options.selected;
    this.logger = options.logger;
    this.maxTimelineEntries = options.maxTimelineEntries ?? DEFAULT_MAX_TIMELINE_ENTRIES;

    const workerRuntime = new PiWorkerRuntime({
      modelRuntime: options.selected.modelRuntime,
      model: options.selected.model,
      workspace: options.config.workspace,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });

    this.scheduler = new TaskScheduler({
      runtime: workerRuntime,
      maxConcurrent: options.config.maxConcurrentTasks,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    this.world = new WorldModel({ scheduler: this.scheduler });

    this.audio = new SimulatedAudioManager();
    this.delivery = new DeliveryQueue({ audio: this.audio });

    this.plane = new MasterDecisionPlane({
      master: new PiMasterAdapter({
        modelRuntime: options.selected.modelRuntime,
        model: options.selected.model,
        workspace: options.config.workspace,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      }),
      scheduler: this.scheduler,
      world: this.world,
      focus: this.focus,
      timeoutMs: options.config.masterTimeoutMs,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });

    this.wireObservability();
  }

  // ------------------------------------------------------------------ 对外命令

  /** 聊天输入：走完整 Master 决策链路。 */
  public async handleUserInput(text: string): Promise<DecisionView> {
    this.pushTimeline("user_input", text);
    this.emitUpdate();

    const result = await this.plane.decide({ userInput: text });
    this.lastDecision = toDecisionView(result);
    this.pushTimeline("decision", describeDecision(this.lastDecision));
    this.emitUpdate();
    return this.lastDecision;
  }

  /** 面板上的取消按钮：这是用户的**直接**指令，因此不再经 Master 推断，直接交给 Scheduler。 */
  public async cancelTask(taskId: string): Promise<{ status: string }> {
    const outcome = await this.scheduler.requestCancel(taskId, "用户在面板上取消");
    this.pushTimeline("user_cancel", `${taskId} → ${outcome.status}`);
    this.emitUpdate();
    return { status: outcome.status };
  }

  /** 模拟「用户开口 → 本地停播」。注意：停播**不等于**取消任务。 */
  public stopPlayback(): void {
    this.stoppedToken = this.audio.currentToken;
    const stopped = this.audio.stop("用户开口触发停播");
    this.pushTimeline(
      "audio_stop",
      stopped ? `已停播，播放代次推进到 ${this.audio.currentToken}` : "当前没有播报",
    );
    this.emitUpdate();
  }

  /** 演示/验证用：投递一个**已失效代次**的分片，证明旧代次不会复活。 */
  public replayStaleChunk(): { replayedToken: number | null; rejected: number } {
    const token = this.stoppedToken;
    if (token === null) return { replayedToken: null, rejected: this.audio.stats().rejected };
    this.audio.replayStale(token);
    return { replayedToken: token, rejected: this.audio.stats().rejected };
  }

  // ------------------------------------------------------------------ 查询

  public snapshot(): RuntimeSnapshot {
    return {
      revision: this.world.revision(),
      model: { provider: this.selected.model.provider, id: this.selected.model.id },
      focusTaskId: this.focus.focusedTaskId(),
      tasks: this.scheduler.listTasks().map(toTaskView),
      deliveries: this.delivery.items(),
      audio: {
        playing: this.audio.isPlaying,
        taskId: this.audio.currentTaskId,
        token: this.audio.currentToken,
        stoppedToken: this.stoppedToken,
        stats: this.audio.stats(),
      },
      lastDecision: this.lastDecision,
      timeline: [...this.timeline],
    };
  }

  public onUpdate(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.delivery.dispose();
    this.audio.stop("演示结束");
    this.world.dispose();
    await this.scheduler.dispose("demo_finished");
    this.listeners.clear();
  }

  // ------------------------------------------------------------------ 内部

  private wireObservability(): void {
    this.unsubscribers.push(
      this.scheduler.onEvent((event) => {
        this.pushTimeline(`task_${event.type}`, describeSchedulerEvent(event));
        if (event.type === "task_succeeded") {
          const task = this.scheduler.getTask(event.taskId);
          if (task?.resultSummary !== undefined) {
            // 结果就绪 → 面板立刻可见，交付另行排队。
            this.delivery.enqueue({
              taskId: task.taskId,
              summary: task.resultSummary,
              priority: task.priority,
            });
          }
        }
        this.emitUpdate();
      }),
    );

    this.unsubscribers.push(
      this.audio.onEvent((event) => {
        this.pushTimeline(`audio_${event.type}`, describeAudioEvent(event));
        this.emitUpdate();
      }),
    );

    this.unsubscribers.push(
      this.delivery.onEvent((event) => {
        this.pushTimeline(`delivery_${event.type}`, describeDeliveryEvent(event));
        this.emitUpdate();
      }),
    );
  }

  private pushTimeline(kind: string, text: string): void {
    this.timeline.push({ at: Date.now(), kind, text });
    while (this.timeline.length > this.maxTimelineEntries) this.timeline.shift();
  }

  private emitUpdate(): void {
    if (this.disposed) return;
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger?.warn("runtime.listener_failed", { error });
      }
    }
  }
}

function toTaskView(task: {
  taskId: string;
  goal: string;
  state: TaskState;
  runGeneration: number;
  priority: Priority;
  createdAt: number;
  startedAt?: number;
  terminalAt?: number;
  lastActivityAt: number;
  resultSummary?: string;
  failureReason?: string;
  cancelReason?: string;
}): TaskView {
  return {
    taskId: task.taskId,
    goal: task.goal,
    state: task.state,
    runGeneration: task.runGeneration,
    priority: task.priority,
    createdAt: task.createdAt,
    startedAt: task.startedAt ?? null,
    terminalAt: task.terminalAt ?? null,
    lastActivityAt: task.lastActivityAt,
    resultSummary: task.resultSummary ?? null,
    failureReason: task.failureReason ?? null,
    cancelReason: task.cancelReason ?? null,
  };
}

function toDecisionView(result: DecisionCycleResult): DecisionView {
  return {
    decisionId: result.decisionId,
    status: result.status,
    applied: result.applied.map((action) => ({ type: action.type, detail: action.detail })),
    rejected: result.rejected.map((action) => ({ type: action.action.type, reason: action.reason })),
    stale: result.stale,
    elapsedMs: result.elapsedMs,
    note: result.note,
  };
}

function describeDecision(view: DecisionView): string {
  if (view.note !== null) return `降级：${view.note}`;
  const applied = view.applied.map((action) => `${action.type}(${action.detail})`).join("、") || "无动作";
  const rejected = view.rejected.length > 0 ? `；被拒 ${view.rejected.length} 项` : "";
  return `${view.decisionId ?? "(无 id)"} → ${applied}${rejected}（${view.elapsedMs}ms${view.stale ? "，基于旧修订号" : ""}）`;
}

function describeSchedulerEvent(event: SchedulerEvent): string {
  const detail = event.detail === undefined ? "" : ` ${JSON.stringify(event.detail)}`;
  return `${event.taskId} [gen ${event.runGeneration}] ${event.type} → ${event.state}${detail}`;
}

function describeAudioEvent(event: AudioEvent): string {
  switch (event.type) {
    case "playback_granted":
      return `授权 ${event.taskId} 播放代次 #${event.token}（${event.chunkCount} 分片）`;
    case "playback_chunk_delivered":
      return `${event.taskId} 分片 ${event.index} 已播出（token #${event.token}）`;
    case "playback_chunk_rejected":
      return `${event.taskId} 分片 ${event.index} **被拒绝**（token #${event.token} 已失效）`;
    case "playback_stop_requested":
      return `${event.taskId} 已请求在分片边界停止：${event.reason}（token #${event.token}）`;
    case "playback_finished":
      return `${event.taskId} 播报完成（token #${event.token}）`;
    case "playback_stopped":
      return `${event.taskId} 已停播：${event.reason}（token #${event.token} 作废）`;
  }
}

function describeDeliveryEvent(event: DeliveryEvent): string {
  switch (event.type) {
    case "delivery_enqueued":
      return `${event.item.taskId} 结果入队（priority=${event.item.priority}）`;
    case "delivery_started":
      return `${event.item.taskId} 开始交付`;
    case "delivery_delivered":
      return `${event.item.taskId} 已交付`;
    case "delivery_deferred":
      return `${event.item.taskId} 交付排队：${event.reason}`;
    case "delivery_preemption_requested":
      return `${event.item.taskId} 将被 urgent 结果抢占：${event.reason}`;
  }
}
