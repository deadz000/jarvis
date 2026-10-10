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
  readonly taskId: string;
  readonly summary: string;
  readonly priority: Priority;
  readonly enqueuedAt: number;
  readonly status: "queued" | "playing" | "delivered";
  readonly deliveredAt?: number;
}

export type DeliveryEvent =
  | { type: "delivery_enqueued"; at: number; item: DeliveryItem; playingTaskId: string | null }
  | { type: "delivery_started"; at: number; item: DeliveryItem }
  | { type: "delivery_delivered"; at: number; item: DeliveryItem }
  | { type: "delivery_deferred"; at: number; item: DeliveryItem; reason: string };

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
  private counters = { enqueued: 0, delivered: 0 };

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
  public enqueue(input: { taskId: string; summary: string; priority?: Priority }): DeliveryItem {
    const at = this.now();
    const id = `delivery-${this.nextOrdinal}`;
    this.nextOrdinal += 1;

    const item: DeliveryItem = {
      id,
      taskId: input.taskId,
      summary: input.summary.slice(0, this.maxSummaryLength),
      priority: input.priority ?? DEFAULT_PRIORITY,
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
    return this.itemsById.get(id) ?? item;
  }

  public items(): readonly DeliveryItem[] {
    return this.order.map((id) => this.itemsById.get(id)).filter((item): item is DeliveryItem => item !== undefined);
  }

  public stats(): { enqueued: number; delivered: number; queued: number; playing: number } {
    const items = this.items();
    return {
      enqueued: this.counters.enqueued,
      delivered: this.counters.delivered,
      queued: items.filter((item) => item.status === "queued").length,
      playing: items.filter((item) => item.status === "playing").length,
    };
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
    const playing = this.items().find((item) => item.status === "playing" && item.taskId === taskId);
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
