import { describe, expect, it } from "vitest";

import {
  SimulatedAudioManager,
  type AudioEvent,
} from "../../src/application/delivery/audio-manager.ts";
import { DeliveryQueue, type DeliveryEvent } from "../../src/application/delivery/delivery-queue.ts";

/** 足够长的文本，使分片数由 `chunksPerPlayback` 决定（文本长度是分片数上限）。 */
const LONG_TEXT = "这是一段足够长的播报结果文本，用来让分片数量由配置决定。".repeat(4);

/** 手动定时器：让分片推进完全确定，不依赖真实时间。 */
function manualScheduler() {
  let pending: Array<() => void> = [];
  return {
    schedule: (fn: () => void): (() => void) => {
      pending.push(fn);
      return () => {
        pending = pending.filter((entry) => entry !== fn);
      };
    },
    runNext: (): void => {
      const fn = pending.shift();
      fn?.();
    },
    pendingCount: (): number => pending.length,
  };
}

function audioSetup(options: { chunks?: number } = {}) {
  const scheduler = manualScheduler();
  const audio = new SimulatedAudioManager({
    schedule: scheduler.schedule,
    chunksPerPlayback: options.chunks ?? 3,
    now: () => 1_000,
  });
  const events: AudioEvent[] = [];
  audio.onEvent((event) => events.push(event));
  return { scheduler, audio, events };
}

/**
 * 精确推进 `count` 个分片。
 * 注意不能用「播到结束」的循环：一条播完交付层会立刻授权下一条，
 * 那样会把整个队列播完，断言的就变成最终状态而非中间状态。
 */
function tick(scheduler: ReturnType<typeof manualScheduler>, count: number): void {
  for (let index = 0; index < count; index += 1) scheduler.runNext();
}

describe("SimulatedAudioManager — 播放代次仲裁（FR-10）", () => {
  it("授权后开始播放，分片推进到设定数量即完成", () => {
    const { scheduler, audio } = audioSetup({ chunks: 3 });

    const grant = audio.grant({ taskId: "task-1", text: LONG_TEXT, priority: "normal" });

    expect(grant.token).toBe(1);
    expect(grant.chunkCount).toBe(3);
    expect(audio.isPlaying).toBe(true);
    expect(audio.currentTaskId).toBe("task-1");
    expect(audio.currentToken).toBe(1);

    scheduler.runNext();
    scheduler.runNext();
    expect(audio.stats().delivered).toBe(2);
    expect(audio.isPlaying).toBe(true);
    scheduler.runNext();

    expect(audio.stats().delivered).toBe(3);
    expect(audio.stats().finished).toBe(1);
    expect(audio.isPlaying).toBe(false);
  });

  it("短文本只播少量分片（长度是分片数上限）", () => {
    const { audio } = audioSetup({ chunks: 6 });

    const grant = audio.grant({ taskId: "task-1", text: "很短", priority: "normal" });

    expect(grant.chunkCount).toBe(1);
  });

  it("stop() 作废旧代次：停播后到达的旧分片被拒绝并记账，而不是静默丢弃", () => {
    const { scheduler, audio, events } = audioSetup({ chunks: 5 });
    const grant = audio.grant({ taskId: "task-1", text: LONG_TEXT, priority: "normal" });
    scheduler.runNext();
    expect(audio.stats().delivered).toBe(1);

    const staleToken = grant.token;
    expect(audio.stop("用户开口触发停播")).toBe(true);
    expect(audio.isPlaying).toBe(false);
    expect(audio.currentToken).toBe(staleToken + 1);

    // 模拟「已经在途的旧分片到达」
    audio.advance(staleToken);
    audio.replayStale(staleToken);

    expect(audio.stats().rejected).toBe(2);
    expect(audio.stats().delivered).toBe(1);
    const rejected = events.filter((event) => event.type === "playback_chunk_rejected");
    expect(rejected).toHaveLength(2);
    // 仍能正确归属到原任务
    expect(rejected[0]?.taskId).toBe("task-1");
  });

  it("没有活跃播放时到达的分片同样被拒绝（不复活任何东西）", () => {
    const { audio } = audioSetup();

    audio.advance(1);

    expect(audio.stats().rejected).toBe(1);
    expect(audio.stats().delivered).toBe(0);
  });

  it("新的授权会先停掉当前播放，代次继续前进", () => {
    const { audio, events } = audioSetup();
    const first = audio.grant({ taskId: "task-1", text: "第一条", priority: "low" });
    const second = audio.grant({ taskId: "task-2", text: "第二条", priority: "high" });

    expect(second.token).toBeGreaterThan(first.token);
    expect(audio.currentTaskId).toBe("task-2");
    expect(audio.currentPriority()).toBe("high");
    expect(events.some((event) => event.type === "playback_stopped")).toBe(true);
  });

  it("空播放时 stop() 返回 false，不产生代次变化", () => {
    const { audio } = audioSetup();
    const tokenBefore = audio.currentToken;

    expect(audio.stop("无人在播")).toBe(false);
    expect(audio.currentToken).toBe(tokenBefore);
  });
});

describe("DeliveryQueue — 交付策略（FR-09）", () => {
  function queueSetup(chunks = 2) {
    const scheduler = manualScheduler();
    const audio = new SimulatedAudioManager({
      schedule: scheduler.schedule,
      chunksPerPlayback: chunks,
      now: () => 1_000,
    });
    const delivery = new DeliveryQueue({ audio, now: () => 1_000 });
    const events: DeliveryEvent[] = [];
    delivery.onEvent((event) => events.push(event));
    return { scheduler, audio, delivery, events };
  }

  it("播放空闲时结果立即开始交付", () => {
    const { audio, delivery } = queueSetup();

    const item = delivery.enqueue({ taskId: "task-1", summary: LONG_TEXT, priority: "normal" });

    expect(item.status).toBe("playing");
    expect(audio.currentTaskId).toBe("task-1");
  });

  it("普通结果不抢占正在进行的播报，而是排队等待", () => {
    const { audio, delivery, events } = queueSetup();

    delivery.enqueue({ taskId: "task-1", summary: LONG_TEXT, priority: "normal" });
    const second = delivery.enqueue({ taskId: "task-2", summary: LONG_TEXT, priority: "normal" });

    expect(second.status).toBe("queued");
    expect(audio.currentTaskId).toBe("task-1");
    expect(events.some((event) => event.type === "delivery_deferred")).toBe(true);
  });

  it("高优先级结果也不抢占当前播报，只保证在当前语句结束后优先交付", () => {
    const { scheduler, audio, delivery, events } = queueSetup(2);

    delivery.enqueue({ taskId: "task-1", summary: LONG_TEXT, priority: "normal" });
    delivery.enqueue({ taskId: "task-2", summary: LONG_TEXT, priority: "low" });
    delivery.enqueue({ taskId: "task-3", summary: LONG_TEXT, priority: "urgent" });

    // 仍在播第一条，没有任何抢占
    expect(audio.currentTaskId).toBe("task-1");
    expect(delivery.stats().queued).toBe(2);

    tick(scheduler, 2); // 第一条播完，交付层随即推进下一条

    // 结束后先交付 urgent，而不是先入队的 low
    expect(audio.currentTaskId).toBe("task-3");
    const started = events.filter((event) => event.type === "delivery_started");
    expect(started[0]?.item.taskId).toBe("task-1");
    expect(started[1]?.item.taskId).toBe("task-3");
  });

  it("同优先级按先来后到交付", () => {
    const { scheduler, audio, delivery } = queueSetup(2);

    delivery.enqueue({ taskId: "task-1", summary: LONG_TEXT, priority: "normal" });
    delivery.enqueue({ taskId: "task-2", summary: LONG_TEXT, priority: "normal" });
    delivery.enqueue({ taskId: "task-3", summary: LONG_TEXT, priority: "normal" });

    tick(scheduler, 2);
    expect(audio.currentTaskId).toBe("task-2");
    tick(scheduler, 2);
    expect(audio.currentTaskId).toBe("task-3");
  });

  it("任务执行状态与交付状态相互独立：交付完成不影响任务记录", () => {
    const { scheduler, audio, delivery } = queueSetup(1);

    delivery.enqueue({ taskId: "task-1", summary: LONG_TEXT, priority: "normal" });
    tick(scheduler, 1);

    expect(delivery.stats().delivered).toBe(1);
    expect(delivery.items()[0]?.status).toBe("delivered");
    expect(audio.isPlaying).toBe(false);
  });

  it("停播后队列继续推进下一条，且被停播的那条不会复活", () => {
    const { audio, delivery, events } = queueSetup(5);

    delivery.enqueue({ taskId: "task-1", summary: LONG_TEXT, priority: "normal" });
    delivery.enqueue({ taskId: "task-2", summary: LONG_TEXT, priority: "normal" });
    const staleToken = audio.currentToken;

    audio.stop("用户开口");

    // 停播 → 交付层把这一条标记为已交付并推进下一条
    expect(audio.currentTaskId).toBe("task-2");
    // 旧代次分片仍然被拒绝
    audio.advance(staleToken);
    expect(audio.stats().rejected).toBe(1);
    expect(events.some((event) => event.type === "delivery_delivered")).toBe(true);
  });
});

describe("urgent 抢占：只在分片边界停（已确认的产品规则）", () => {
  function setup(chunks = 3) {
    const scheduler = manualScheduler();
    const audio = new SimulatedAudioManager({
      schedule: scheduler.schedule,
      chunksPerPlayback: chunks,
      now: () => 1_000,
    });
    const delivery = new DeliveryQueue({ audio, now: () => 1_000 });
    const events: Array<AudioEvent | DeliveryEvent> = [];
    audio.onEvent((event) => events.push(event));
    delivery.onEvent((event) => events.push(event));
    return { scheduler, audio, delivery, events };
  }

  it("urgent 入队时不立即切断，而是在分片边界停止后优先交付 urgent", () => {
    const { scheduler, audio, delivery, events } = setup(3);

    delivery.enqueue({ taskId: "task-1", summary: LONG_TEXT, priority: "normal" });
    expect(audio.currentTaskId).toBe("task-1");

    delivery.enqueue({ taskId: "task-2", summary: LONG_TEXT, priority: "urgent" });

    // 关键：没有立即切断当前语句
    expect(audio.currentTaskId).toBe("task-1");
    expect(audio.stats().stopped).toBe(0);
    expect(delivery.stats().preemptions).toBe(1);
    expect(events.some((event) => event.type === "delivery_preemption_requested")).toBe(true);
    expect(events.some((event) => event.type === "playback_stop_requested")).toBe(true);

    // 推进到分片边界 → 停播 → 交付层切到 urgent
    scheduler.runNext();
    expect(audio.stats().preemptions).toBe(1);
    expect(audio.currentTaskId).toBe("task-2");
  });

  it("普通结果入队不会请求抢占", () => {
    const { audio, delivery, events } = setup();

    delivery.enqueue({ taskId: "task-1", summary: LONG_TEXT, priority: "normal" });
    delivery.enqueue({ taskId: "task-2", summary: LONG_TEXT, priority: "normal" });

    expect(delivery.stats().preemptions).toBe(0);
    expect(events.some((event) => event.type === "playback_stop_requested")).toBe(false);
    expect(audio.currentTaskId).toBe("task-1");
  });

  it("正在播 urgent 时不再触发抢占", () => {
    const { audio, delivery, events } = setup();

    delivery.enqueue({ taskId: "task-1", summary: LONG_TEXT, priority: "urgent" });
    delivery.enqueue({ taskId: "task-2", summary: LONG_TEXT, priority: "urgent" });

    expect(delivery.stats().preemptions).toBe(0);
    expect(events.some((event) => event.type === "playback_stop_requested")).toBe(false);
    expect(audio.currentTaskId).toBe("task-1");
  });

  it("播放空闲时 urgent 直接开始，不经过抢占路径", () => {
    const { audio, delivery } = setup();

    delivery.enqueue({ taskId: "task-1", summary: LONG_TEXT, priority: "urgent" });

    expect(audio.currentTaskId).toBe("task-1");
    expect(delivery.stats().preemptions).toBe(0);
  });
});
