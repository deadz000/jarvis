/**
 * 结果交付队列（实施计划 §8 Alpha 第 6–7 步；对应 SRS FR-09 验收项）。
 *
 * 默认策略（SRS §3.4）：
 * - 结果就绪 → **面板立即更新，不等播放**；
 * - **普通结果不抢占**正在进行的播报，而是进入队列；
 * - 播放结束后，按优先级取出下一条（同优先级 FIFO）；
 * - **紧急抢占暂不启用**（紧急条件属 SRS §11.5 待决策）。
 */
import { DEFAULT_PRIORITY, PRIORITIES, type Priority } from "../../domain/task/types.ts";
import type { SimulatedAudioManager } from "./audio-manager.ts";

/**
 * 优先级排名：`PRIORITIES` 按严重度升序声明（low → urgent），
 * 因此下标即排名，数值越大越优先。**不要用 length - index**，那会把顺序反过来。
 */
const PRIORITY_RANK: Readonly<Record<Priority, number>> = Object.fromEntries(
  PRIORITIES.map((priority, index) => [priority, index]),
) as Record<Priority, number>;

export interface DeliveryItem {
  readonly id: string;
  /** 批次内的**主任务**（展示与播放授权归属用）。 */
  readonly taskId: string;
  /** 批次内的全部任务。合并交付时长度 > 1。 */
  readonly taskIds: readonly string[];
  /** 实际播报文本（合并交付时是综合稿）。 */
  readonly summary: string;
  readonly priority: Priority;
  /** 是否允许本项触发抢占（交付决策给 `after_current` 时为 false）。 */
  readonly allowPreemption: boolean;
  readonly enqueuedAt: number;
  readonly status: "queued" | "playing" | "delivered";
  readonly deliveredAt?: number;
}

export type DeliveryEvent =
  | { type: "delivery_enqueued"; at: number; item: DeliveryItem; playingTaskId: string | null }
  | { type: "delivery_started"; at: number; item: DeliveryItem }
  | { type: "delivery_delivered"; at: number; item: DeliveryItem }
  | { type: "delivery_deferred"; at: number; item: DeliveryItem; reason: string }
  | { type: "delivery_preemption_requested"; at: number; item: DeliveryItem; reason: string };

export interface DeliveryQueueOptions {
  readonly audio: SimulatedAudioManager;
  readonly now?: () => number;
  /** 单次播放的模拟时长（由音频层分片控制），此处只决定文本长度上限。 */
  readonly maxSummaryLength?: number;
}

export class DeliveryQueue {
  private readonly audio: SimulatedAudioManager;
  private readonly now: () => number;
  private readonly maxSummaryLength: number;
  private readonly listeners = new Set<(event: DeliveryEvent) => void>();
  private readonly itemsById = new Map<string, DeliveryItem>();
  private readonly order: string[] = [];
  private readonly unsubscribeAudio: () => void;
  private nextOrdinal = 1;
  private counters = { enqueued: 0, delivered: 0, preemptions: 0 };

  public constructor(options: DeliveryQueueOptions) {
    this.audio = options.audio;
    this.now = options.now ?? (() => Date.now());
    this.maxSummaryLength = options.maxSummaryLength ?? 200;
    this.unsubscribeAudio = this.audio.onEvent((event) => {
      if (event.type === "playback_finished" || event.type === "playback_stopped") {
        this.markDelivered(event.taskId);
        this.startNext();
      }
    });
  }

  public dispose(): void {
    this.unsubscribeAudio();
    this.listeners.clear();
  }

  public onEvent(listener: (event: DeliveryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 结果就绪。**永不抢占**：正在播放时一律排队等待。
   */
  public enqueue(input: {
    taskId: string;
    summary: string;
    priority?: Priority;
    allowPreemption?: boolean;
  }): DeliveryItem {
    return this.enqueueBatch({
      taskIds: [input.taskId],
      text: input.summary,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.allowPreemption === undefined ? {} : { allowPreemption: input.allowPreemption }),
    });
  }

  /**
   * 批量入队（合并交付）。一条交付项可承载多个任务的结果，
   * 播报文本是交付决策给出的**综合稿** —— 这是「两个任务同时完成合成一次回答」的落点。
   */
  public enqueueBatch(input: {
    taskIds: readonly string[];
    text: string;
    priority?: Priority;
    allowPreemption?: boolean;
  }): DeliveryItem {
    const primary = input.taskIds[0];
    if (primary === undefined) throw new Error("enqueueBatch 需要至少一个 taskId");

    const at = this.now();
    const id = `delivery-${this.nextOrdinal}`;
    this.nextOrdinal += 1;

    const item: DeliveryItem = {
      id,
      taskId: primary,
      taskIds: [...input.taskIds],
      summary: input.text.slice(0, this.maxSummaryLength),
      priority: input.priority ?? DEFAULT_PRIORITY,
      allowPreemption: input.allowPreemption ?? true,
      enqueuedAt: at,
      status: "queued",
    };
    this.itemsById.set(id, item);
    this.order.push(id);
    this.counters = { ...this.counters, enqueued: this.counters.enqueued + 1 };

    if (this.audio.isPlaying) {
      this.emit({
        type: "delivery_deferred",
        at,
        item,
        reason: `当前正在播报 ${this.audio.currentTaskId ?? "未知任务"}，普通结果不抢占`,
      });
    }
    this.emit({ type: "delivery_enqueued", at, item, playingTaskId: this.audio.currentTaskId });

    this.startNext();
    this.requestPreemptionIfNeeded();
    return this.itemsById.get(id) ?? item;
  }

  public items(): readonly DeliveryItem[] {
    return this.order.map((id) => this.itemsById.get(id)).filter((item): item is DeliveryItem => item !== undefined);
  }

  public stats(): { enqueued: number; delivered: number; queued: number; playing: number; preemptions: number } {
    const items = this.items();
    return {
      enqueued: this.counters.enqueued,
      delivered: this.counters.delivered,
      preemptions: this.counters.preemptions,
      queued: items.filter((item) => item.status === "queued").length,
      playing: items.filter((item) => item.status === "playing").length,
    };
  }

  /**
   * 已确认的产品规则：**仅 `urgent` 可抢占，且只在分片边界停**（不截断句子中段）。
   *
   * 这里只发出「边界停止」请求；真正切换发生在音频层的分片边界，
   * 因此交付层不需要任何实时能力，规则保持确定性、可单测。
   */
  private requestPreemptionIfNeeded(): void {
    if (!this.audio.isPlaying) return;

    const playing = this.items().find((item) => item.status === "playing");
    if (playing === undefined) return;
    // 已经在播紧急内容，无需抢占
    if (playing.priority === "urgent") return;

    const urgentWaiting = this.items().find(
      (item) => item.status === "queued" && item.priority === "urgent" && item.allowPreemption,
    );
    if (urgentWaiting === undefined) return;

    const reason = `urgent 结果 ${urgentWaiting.taskId} 优先：在当前语句的分片边界停止 ${playing.taskId}`;
    if (!this.audio.requestStopAtBoundary(reason)) return;

    this.counters = { ...this.counters, preemptions: this.counters.preemptions + 1 };
    this.emit({ type: "delivery_preemption_requested", at: this.now(), item: playing, reason });
  }

  /** 播放空闲时取出最高优先级的一条（同优先级 FIFO）。 */
  private startNext(): void {
    if (this.audio.isPlaying) return;

    const next = this.items()
      .filter((item) => item.status === "queued")
      .sort((a, b) => {
        const byPriority = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
        if (byPriority !== 0) return byPriority;
        return a.enqueuedAt - b.enqueuedAt || a.id.localeCompare(b.id);
      })[0];
    if (next === undefined) return;

    const started: DeliveryItem = { ...next, status: "playing" };
    this.itemsById.set(next.id, started);
    this.emit({ type: "delivery_started", at: this.now(), item: started });
    this.audio.grant({ taskId: started.taskId, text: started.summary, priority: started.priority });
  }

  private markDelivered(taskId: string): void {
    const playing = this.items().find(
      (item) => item.status === "playing" && item.taskIds.includes(taskId),
    );
    if (playing === undefined) return;
    const delivered: DeliveryItem = { ...playing, status: "delivered", deliveredAt: this.now() };
    this.itemsById.set(playing.id, delivered);
    this.counters = { ...this.counters, delivered: this.counters.delivered + 1 };
    this.emit({ type: "delivery_delivered", at: this.now(), item: delivered });
  }

  private emit(event: DeliveryEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
