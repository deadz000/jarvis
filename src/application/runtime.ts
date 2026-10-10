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
import type { DeliveryEvent, DeliveryItem } from "./delivery/delivery-queue.ts";
import type { DecisionCycleResult } from "./master/decision-plane.ts";
import type { WorldRevision } from "../domain/decision/types.ts";
import type { Priority, TaskState } from "../domain/task/types.ts";
import type { Logger } from "../observability/logger.ts";
import type { SelectedModel } from "../adapters/pi/model-selection.ts";

import { PiMasterAdapter } from "../adapters/pi/pi-master.ts";
import { PiWorkerRuntime } from "../adapters/pi/pi-worker-runtime.ts";
import { InteractionFocusStore } from "./interaction/focus.ts";
import { DialogueHistory, type DialogueEntry } from "./interaction/dialogue-history.ts";
import { WorldModel } from "./master/context-view.ts";
import { MasterDecisionPlane } from "./master/decision-plane.ts";
import { TaskScheduler } from "./scheduler/scheduler.ts";
import { DeliveryQueue } from "./delivery/delivery-queue.ts";
import { DeliveryBatcher, type PendingResult } from "./delivery/delivery-batcher.ts";
import { DeliveryPolicy } from "./delivery/delivery-policy.ts";
import { TranscriptCoalescer } from "./workers/transcript-coalescer.ts";
import { SpeechActivityTracker } from "./interaction/speech-activity.ts";
import type { AsrPort, AsrSession } from "./input/asr-port.ts";
import { SimulatedAudioManager, type AudioEvent, type AudioStats, type DeliveredAudioChunk } from "./delivery/audio-manager.ts";
import type { TtsPort } from "./delivery/tts-port.ts";

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
  /** 口语化播报稿（TTS 实际念的那一段）。 */
  readonly spokenSummary: string | null;
  /** 正在生成的实时文本（逐 token 合并后的尾部），任务结束后清空。 */
  readonly liveText: string | null;
  readonly failureReason: string | null;
  readonly cancelReason: string | null;
}

export interface AudioView {
  readonly playing: boolean;
  readonly taskId: string | null;
  readonly token: number;
  readonly stoppedToken: number | null;
  /** simulated = 定时器模拟分片；real = 真实 TTS 合成。 */
  readonly mode: "simulated" | "real";
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
  /** 有界对话记忆（最近若干条），让面板能看出"系统记得什么"。 */
  readonly dialogue: readonly DialogueEntry[];
  /** 用户是否正在讲话（语音交付是否让路）。 */
  readonly speechActive: boolean;
  /** 语音输入状态（ASR）。 */
  readonly voice: {
    /** 是否配置了 ASR（未配置时面板应隐藏麦克风）。 */
    readonly available: boolean;
    readonly listening: boolean;
    /** 正在识别的中间文本（会变）。 */
    readonly partial: string;
    /**
     * 收到过多少次中间结果。
     *
     * 为什么要有计数：中间结果更新极快（远快于界面刷新），
     * 靠轮询 `partial` 判断"是否真的流式到达"会因竞态而漏判；
     * 计数是稳定可观测的证据。
     */
    readonly partialCount: number;
    /** 最近一次识别的终稿。 */
    readonly lastFinal: string | null;
  };
}

export interface JarvisRuntimeOptions {
  readonly config: AppConfig;
  readonly selected: SelectedModel;
  readonly logger?: Logger;
  readonly maxTimelineEntries?: number;
  /**
   * 真实 TTS 端口。提供则播放分片来自真实合成；省略则为模拟分片。
   * 由组合根（app.ts）根据配置构造，运行时不接触密钥。
   */
  readonly tts?: TtsPort;
  /**
   * 真实 ASR 端口。提供则语音输入可用；省略则面板不显示麦克风。
   */
  readonly asr?: AsrPort;
}

export const DEFAULT_MAX_TIMELINE_ENTRIES = 200;
/** 推给 ASR 的采样率（单声道 PCM 16-bit LE）。 */
export const ASR_SAMPLE_RATE = 16_000;
/** 快照里携带的时间线条数上限：避免高频刷新时反复序列化整条历史。 */
export const SNAPSHOT_TIMELINE_LIMIT = 80;

export class JarvisRuntime {
  private readonly config: AppConfig;
  private readonly selected: SelectedModel;
  private readonly logger: Logger | undefined;
  private readonly maxTimelineEntries: number;

  private readonly scheduler: TaskScheduler;
  private readonly world: WorldModel;
  private readonly focus = new InteractionFocusStore();
  private readonly dialogue = new DialogueHistory();
  private readonly plane: MasterDecisionPlane;
  private readonly audio: SimulatedAudioManager;
  private readonly delivery: DeliveryQueue;
  private readonly batcher: DeliveryBatcher;
  private readonly policy = new DeliveryPolicy();
  /** 文本增量的节流层：高频通道不进 Scheduler，只用于界面实时显示。 */
  private readonly transcript = new TranscriptCoalescer({
    onFlush: () => {
      this.emitUpdate();
    },
  });
  private readonly asr: AsrPort | undefined;
  /** 识别结果驱动的语音活动（驱动交付让路）。 */
  private readonly speechTracker = new SpeechActivityTracker({
    onActive: () => {
      this.vadSpeechActive = true;
      this.applySpeechState();
    },
    onIdle: () => {
      this.vadSpeechActive = false;
      this.applySpeechState();
    },
  });

  private readonly listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  private readonly audioChunkListeners = new Set<(chunk: DeliveredAudioChunk) => void>();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly timeline: TimelineEntry[] = [];

  private lastDecision: DecisionView | null = null;
  private stoppedToken: number | null = null;
  private speechActive = false;
  /** 面板手动开关。 */
  private manualSpeechActive = false;
  /** 由 ASR 识别结果驱动的语音活动。 */
  private vadSpeechActive = false;
  private voiceSession: AsrSession | undefined;
  private voicePartial = "";
  private voicePartialCount = 0;
  private voiceLastFinal: string | null = null;
  /** 因用户讲话而暂缓的语音交付批次（面板已经更新过，语音等合适时机）。 */
  private deferredResults: PendingResult[] = [];
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
      onTranscript: (chunk) => {
        this.transcript.push(chunk.taskId, chunk.delta);
      },
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });

    this.scheduler = new TaskScheduler({
      runtime: workerRuntime,
      maxConcurrent: options.config.maxConcurrentTasks,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    this.world = new WorldModel({ scheduler: this.scheduler });

    this.audio = new SimulatedAudioManager({
      ...(options.tts === undefined ? {} : { synthesizer: options.tts }),
      onChunk: (chunk) => {
        // 真实音频分片推给订阅者（演示服务 → 浏览器播放）。
        // 注意：这里同样带播放代次，浏览器可据 token 拒绝旧代次的分片。
        for (const listener of [...this.audioChunkListeners]) listener(chunk);
      },
    });

    this.asr = options.asr;
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
      dialogue: this.dialogue,
      delivery: this.delivery,
      timeoutMs: options.config.masterTimeoutMs,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });

    // 结果产出后不立刻播：先进合并窗口，由 Master 决定怎么交付（含多结果合并）。
    this.batcher = new DeliveryBatcher({
      onFlush: (batch) => {
        void this.runDeliveryDecision(batch);
      },
    });

    this.wireObservability();
  }

  // ------------------------------------------------------------------ 对外命令

  /** 聊天输入：走完整 Master 决策链路。 */
  public async handleUserInput(text: string): Promise<DecisionView> {
    // 一个用户 turn 只记一次（避免一次输入被重复记账）
    this.dialogue.appendUserTurn(text);
    this.pushTimeline("user_input", text);
    this.emitUpdate();

    const result = await this.plane.decide({ userInput: text });
    this.lastDecision = toDecisionView(result);
    this.dialogue.appendSystem(`调度决策：${describeDecision(this.lastDecision)}`);
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
      tasks: this.scheduler
        .listTasks()
        .map((task) => toTaskView(task, this.transcript.textFor(task.taskId) ?? null)),
      deliveries: this.delivery.items(),
      audio: {
        playing: this.audio.isPlaying,
        taskId: this.audio.currentTaskId,
        token: this.audio.currentToken,
        stoppedToken: this.stoppedToken,
        mode: this.audio.usesRealSynthesis ? "real" : "simulated",
        stats: this.audio.stats(),
      },
      lastDecision: this.lastDecision,
      timeline: this.timeline.slice(-SNAPSHOT_TIMELINE_LIMIT),
      dialogue: this.dialogue.recent(10),
      speechActive: this.speechActive,
      voice: {
        available: this.asr !== undefined,
        listening: this.voiceSession !== undefined,
        partial: this.voicePartial,
        partialCount: this.voicePartialCount,
        lastFinal: this.voiceLastFinal,
      },
    };
  }

  /**
   * 用户讲话状态（真实实现由 ASR/VAD 提供；未接入前可由面板手动模拟）。
   *
   * 讲话期间：**面板照常更新**（结果已在快照里可见），语音交付让路；
   * 讲话结束后把暂缓的结果放回合并窗口，与期间新产生的合批处理。
   */
  public setSpeechActive(active: boolean): void {
    this.manualSpeechActive = active;
    this.applySpeechState();
  }

  /**
   * 开始一次语音输入会话：浏览器推流 → ASR → 实时转写 → 终稿进入正常输入链路。
   *
   * 返回 `undefined` 表示**未配置 ASR**（能力不可用，不是失败）。
   */
  public startVoiceInput(): AsrSession | undefined {
    const asr = this.asr;
    if (asr === undefined || this.disposed) return undefined;
    if (this.voiceSession !== undefined) this.voiceSession.abort("被新的语音输入会话取代");

    const session = asr.start({
      sampleRate: ASR_SAMPLE_RATE,
      onPartial: (transcript) => {
        // 收到非空识别结果 → 认为用户在说话 → 语音交付让路
        this.speechTracker.noteSpeech();
        this.voicePartial = transcript.text;
        this.voicePartialCount += 1;
        this.emitUpdate();
      },
      onFinal: (transcript) => {
        this.speechTracker.noteSpeech();
        this.voicePartial = "";
        this.voiceLastFinal = transcript.text;
        this.pushTimeline("voice_transcript", `识别终稿：${transcript.text}`);
        this.emitUpdate();
        // 终稿走**与聊天输入完全相同**的链路 → 交给 Master 决策
        void this.handleUserInput(transcript.text).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger?.warn("runtime.voice_input_failed", { error: message });
          this.pushTimeline("voice_input_failed", `语音输入处理失败：${message}`);
          this.emitUpdate();
        });
      },
      onError: (error) => {
        this.logger?.warn("runtime.asr_failed", { error: error.message });
        this.pushTimeline("voice_error", `语音识别错误：${error.message}`);
        this.speechTracker.markIdle();
        this.emitUpdate();
      },
    });

    this.voiceSession = session;
    this.voicePartial = "";
    this.voicePartialCount = 0;
    this.pushTimeline("voice_started", `语音输入已开启（task ${session.taskId}）`);
    this.emitUpdate();

    void session.finished
      .catch(() => {
        // 错误已通过 onError 汇报，这里只负责收尾
      })
      .finally(() => {
        if (this.voiceSession === session) this.voiceSession = undefined;
        this.speechTracker.markIdle();
        this.voicePartial = "";
        this.pushTimeline("voice_stopped", "语音输入已结束");
        this.emitUpdate();
      });

    return session;
  }

  public get isListening(): boolean {
    return this.voiceSession !== undefined;
  }

  /** 是否配置了 ASR（面板据此决定是否显示麦克风）。 */
  public get voiceAvailable(): boolean {
    return this.asr !== undefined;
  }

  /**
   * 语音活动状态由**两个来源**合成：面板手动开关 + ASR 识别结果。
   * 任一为真即视为「用户正在讲话」，语音交付让路。
   */
  private applySpeechState(): void {
    const next = this.manualSpeechActive || this.vadSpeechActive;
    if (this.speechActive === next) return;
    this.speechActive = next;
    this.pushTimeline("speech_activity", next ? "用户开始讲话：语音交付让路" : "用户停止讲话：恢复语音交付");

    if (!next && this.deferredResults.length > 0) {
      const restored = this.deferredResults;
      this.deferredResults = [];
      this.pushTimeline("delivery_restored", `${restored.length} 条暂缓结果重新进入合并窗口`);
      for (const item of restored) this.batcher.add(item);
    }
    this.emitUpdate();
  }

  public onUpdate(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 订阅真实音频分片（演示服务用它推给浏览器播放）。 */
  public onAudioChunk(listener: (chunk: DeliveredAudioChunk) => void): () => void {
    this.audioChunkListeners.add(listener);
    return () => {
      this.audioChunkListeners.delete(listener);
    };
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.batcher.dispose();
    this.transcript.dispose();
    this.speechTracker.dispose();
    this.voiceSession?.abort("运行时结束");
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
            // 结果就绪 → 面板立刻可见（完整结果）；
            // 播报不立刻发生，先进入合并窗口，由 Master 交付决策决定怎么讲。
            this.batcher.add({
              taskId: task.taskId,
              fullSummary: task.resultSummary,
              spokenSummary: task.spokenSummary ?? task.resultSummary,
              priority: task.priority,
              at: Date.now(),
            });
          }
        }
        if (event.type === "task_succeeded" || event.type === "task_failed" || event.type === "task_cancelled") {
          // 任务终态：实时文本让位给正式结果，清掉高频缓冲
          this.transcript.clear(event.taskId);
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

  /**
   * 结果批次出窗口后的交付处理。
   *
   * **先由确定性策略分流**决定是否值得调用 Master（这是「不必为每个完成事件完整推理」的落点）：
   * - `direct`：单个普通结果，直接用自带口语稿，零 LLM 成本；
   * - `master_merge` / `master_priority`：多条需合并，或需语义判断重要性；
   * - `defer_for_speech`：用户正在讲话，面板先更新，语音等合适时机。
   */
  private async runDeliveryDecision(batch: readonly PendingResult[]): Promise<void> {
    const decision = this.policy.decide({
      batch,
      speechActive: this.speechActive,
      audioPlaying: this.audio.isPlaying,
      runningTaskCount: this.scheduler.stats().running,
    });

    this.pushTimeline(
      "delivery_route",
      `${batch.length} 条结果 → ${decision.route}（${decision.reasons.join("；")}）`,
    );

    if (decision.route === "defer_for_speech") {
      this.deferredResults.push(...batch);
      this.pushTimeline(
        "delivery_deferred",
        `语音交付暂缓，已保留 ${this.deferredResults.length} 条结果（面板已更新）`,
      );
      this.emitUpdate();
      return;
    }

    if (decision.route === "direct") {
      const applied = batch.map((item) => {
        const entry = this.delivery.enqueue({
          taskId: item.taskId,
          summary: item.spokenSummary,
          priority: item.priority,
        });
        return `${item.taskId} → ${entry.id}`;
      });
      this.dialogue.appendSystem(`直接交付 ${batch.length} 条结果（未调用 Master）`);
      this.pushTimeline("delivery_direct", applied.join("；"));
      this.emitUpdate();
      return;
    }

    try {
      const result = await this.plane.decideDelivery(batch);
      this.lastDecision = toDecisionView(result);
      this.dialogue.appendSystem(`交付决策（${decision.route}）：${describeDecision(this.lastDecision)}`);
      this.pushTimeline("delivery_decision", describeDecision(this.lastDecision));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn("runtime.delivery_decision_failed", { error: message });
      this.pushTimeline("delivery_decision_failed", `交付决策异常：${message}`);
    } finally {
      this.emitUpdate();
    }
  }

  private pushTimeline(kind: string, text: string): void {    this.timeline.push({ at: Date.now(), kind, text });
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

function toTaskView(
  task: {
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
    spokenSummary?: string;
    failureReason?: string;
    cancelReason?: string;
  },
  liveText: string | null,
): TaskView {
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
    spokenSummary: task.spokenSummary ?? null,
    liveText,
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
    case "playback_failed":
      return `${event.taskId} 合成失败：${event.reason}（token #${event.token}）`;
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
