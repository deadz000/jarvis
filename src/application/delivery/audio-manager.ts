/**
 * 模拟 Audio Manager（实施计划 §8 Alpha 第 7 步；对应 SRS FR-10、§4.3 播放代次）。
 *
 * 这里不接真实 TTS，但把**音频播放的仲裁语义**做真：
 * - 播放是**受控单例资源**：同一时刻只有一次播放被授权；
 * - 「是谁」（taskId）与「哪一次」（playback token）**分离** —— 踩坑指南铁律 3 与坑 3；
 * - 每次授权生成新 token；`stop()` 递增 token，使**旧代次的残留分片被拒绝**，
 *   从而验证「停播后旧音频不会复活」这条 FR-10 验收项。
 *
 * 分片推进通过 `advance(token)` 驱动：生产上由定时器调用，测试里可手动调用，
 * 因此「旧代次被拒绝」可以被确定性地单测，而不依赖真实时间。
 */
import type { Priority } from "../../domain/task/types.ts";

export interface PlaybackGrant {
  readonly taskId: string;
  readonly token: number;
  readonly text: string;
  /** 本次播放的分片数（由文本长度与配置共同决定），供调用方与测试驱动。 */
  readonly chunkCount: number;
}

export type AudioEvent =
  | { type: "playback_granted"; at: number; taskId: string; token: number; chunkCount: number }
  | { type: "playback_chunk_delivered"; at: number; taskId: string; token: number; index: number }
  | { type: "playback_chunk_rejected"; at: number; taskId: string; token: number; index: number }
  | { type: "playback_stop_requested"; at: number; taskId: string; token: number; reason: string }
  | { type: "playback_finished"; at: number; taskId: string; token: number }
  | { type: "playback_stopped"; at: number; taskId: string; token: number; reason: string };

export interface SimulatedAudioOptions {
  readonly now?: () => number;
  /** 定时器注入点，便于测试替换为手动推进。 */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  readonly chunkIntervalMs?: number;
  readonly chunksPerPlayback?: number;
}

export interface AudioStats {
  readonly granted: number;
  readonly delivered: number;
  readonly rejected: number;
  readonly stopped: number;
  readonly finished: number;
  /** 因抢占而在分片边界被停止的次数。 */
  readonly preemptions: number;
}

interface ActivePlayback {
  readonly taskId: string;
  readonly token: number;
  readonly priority: Priority;
  index: number;
  readonly chunkCount: number;
  cancelTimer: (() => void) | undefined;
}

export class SimulatedAudioManager {
  private readonly listeners = new Set<(event: AudioEvent) => void>();
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly chunkIntervalMs: number;
  private readonly chunksPerPlayback: number;

  private token = 0;
  private active: ActivePlayback | undefined;
  /** 最近一次被作废的播放，用于在停播后仍能归属被拒绝的分片。 */
  private lastStopped: { readonly taskId: string; readonly token: number } | undefined;
  /** 已请求但尚未执行的边界停止（抢占用）。 */
  private pendingStopReason: string | undefined;
  private counters = { granted: 0, delivered: 0, rejected: 0, stopped: 0, finished: 0, preemptions: 0 };

  public constructor(options: SimulatedAudioOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => {
          clearTimeout(timer);
        };
      });
    this.chunkIntervalMs = options.chunkIntervalMs ?? 260;
    this.chunksPerPlayback = options.chunksPerPlayback ?? 6;
  }

  public onEvent(listener: (event: AudioEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public get isPlaying(): boolean {
    return this.active !== undefined;
  }

  public get currentToken(): number {
    return this.token;
  }

  public get currentTaskId(): string | null {
    return this.active?.taskId ?? null;
  }

  public currentPriority(): Priority | null {
    return this.active?.priority ?? null;
  }

  public stats(): AudioStats {
    return { ...this.counters };
  }

  /**
   * 授权一次新的播放代次。会先停止当前播放（调用方决定是否抢占 —— 交付策略负责该判断）。
   */
  public grant(input: { taskId: string; text: string; priority: Priority }): PlaybackGrant {
    if (this.active !== undefined) this.stop("被新的播放授权取代");
    this.pendingStopReason = undefined;

    this.token += 1;
    const token = this.token;
    const chunkCount = Math.max(1, Math.min(this.chunksPerPlayback, Math.ceil(input.text.length / 12) || 1));
    this.active = { taskId: input.taskId, token, priority: input.priority, index: 0, chunkCount, cancelTimer: undefined };
    this.counters = { ...this.counters, granted: this.counters.granted + 1 };

    this.emit({ type: "playback_granted", at: this.now(), taskId: input.taskId, token, chunkCount });
    this.scheduleNext(token);

    return { taskId: input.taskId, token, text: input.text, chunkCount };
  }

  /** 停止当前播放并作废旧代次。返回是否确实停止了某个播放。 */
  public stop(reason: string): boolean {
    const active = this.active;
    if (active === undefined) return false;

    this.pendingStopReason = undefined;
    active.cancelTimer?.();
    this.active = undefined;
    this.lastStopped = { taskId: active.taskId, token: active.token };
    this.token += 1; // 关键：代次前进，旧分片一律失效
    this.counters = { ...this.counters, stopped: this.counters.stopped + 1 };
    this.emit({ type: "playback_stopped", at: this.now(), taskId: active.taskId, token: active.token, reason });
    return true;
  }

  /**
   * 请求在**下一个分片边界**停止播放。
   *
   * 用于已确认的产品规则「仅 urgent 可抢占，且只在分片边界停」：
   * 立即切断会把句子截成两半，边界停止让当前语句自然收尾。
   * 返回是否接受了该请求（已有待执行的边界停止、或当前没有播放时返回 false）。
   */
  public requestStopAtBoundary(reason: string): boolean {
    const active = this.active;
    if (active === undefined) return false;
    if (this.pendingStopReason !== undefined) return false;

    this.pendingStopReason = reason;
    this.emit({
      type: "playback_stop_requested",
      at: this.now(),
      taskId: active.taskId,
      token: active.token,
      reason,
    });
    return true;
  }

  /**
   * 推进一个播放分片。
   *
   * 若当前没有活跃播放，或 `token` 与当前代次不匹配 → 该分片属于**已作废的代次**，
   * 必须被**拒绝并记账**，而不是静默丢弃。这正是「停播后旧音频不会复活」的可观测证据
   * （FR-10 验收项）。
   */
  public advance(token: number): void {
    const active = this.active;

    if (active === undefined || active.token !== token) {
      const owner = active?.taskId ?? this.lastStopped?.taskId ?? "unknown";
      this.counters = { ...this.counters, rejected: this.counters.rejected + 1 };
      this.emit({
        type: "playback_chunk_rejected",
        at: this.now(),
        taskId: owner,
        token,
        index: active?.index ?? 0,
      });
      return;
    }

    active.index += 1;
    this.counters = { ...this.counters, delivered: this.counters.delivered + 1 };
    this.emit({ type: "playback_chunk_delivered", at: this.now(), taskId: active.taskId, token, index: active.index });

    if (active.index >= active.chunkCount) {
      this.active = undefined;
      this.counters = { ...this.counters, finished: this.counters.finished + 1 };
      this.emit({ type: "playback_finished", at: this.now(), taskId: active.taskId, token });
      return;
    }

    // 抢占：在分片边界停（不截断句子中段）
    if (this.pendingStopReason !== undefined) {
      const reason = this.pendingStopReason;
      this.pendingStopReason = undefined;
      this.counters = { ...this.counters, preemptions: this.counters.preemptions + 1 };
      this.stop(reason);
      return;
    }

    this.scheduleNext(token);
  }

  /** 强制投递一个已失效代次的分片，用于演示/测试「旧代次不复活」。 */
  public replayStale(oldToken: number): void {
    this.advance(oldToken);
  }

  private scheduleNext(token: number): void {
    const cancel = this.schedule(() => {
      this.advance(token);
    }, this.chunkIntervalMs);
    if (this.active !== undefined && this.active.token === token) this.active.cancelTimer = cancel;
    else cancel();
  }

  private emit(event: AudioEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
