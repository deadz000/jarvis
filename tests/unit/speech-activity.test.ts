import { describe, expect, it } from "vitest";

import {
  DEFAULT_SPEECH_SILENCE_MS,
  SpeechActivityTracker,
} from "../../src/application/interaction/speech-activity.ts";

function manualScheduler() {
  let pending: Array<{ fn: () => void; ms: number }> = [];
  return {
    schedule: (fn: () => void, ms: number): (() => void) => {
      const entry = { fn, ms };
      pending.push(entry);
      return () => {
        pending = pending.filter((candidate) => candidate !== entry);
      };
    },
    runNext: (): void => {
      pending.shift()?.fn();
    },
    delays: (): number[] => pending.map((entry) => entry.ms),
    pendingCount: (): number => pending.length,
  };
}

function setup() {
  const scheduler = manualScheduler();
  const transitions: string[] = [];
  const tracker = new SpeechActivityTracker({
    onActive: () => transitions.push("active"),
    onIdle: () => transitions.push("idle"),
    schedule: scheduler.schedule,
  });
  return { scheduler, tracker, transitions };
}

describe("SpeechActivityTracker — 识别结果驱动的语音活动判定", () => {
  it("默认静音阈值 1.5s（启发式，不是已验证的产品结论）", () => {
    const { scheduler, tracker } = setup();
    tracker.noteSpeech();

    expect(DEFAULT_SPEECH_SILENCE_MS).toBe(1_500);
    expect(scheduler.delays()).toEqual([1_500]);
  });

  it("首个识别结果触发 active", () => {
    const { tracker, transitions } = setup();
    tracker.noteSpeech();

    expect(tracker.active).toBe(true);
    expect(transitions).toEqual(["active"]);
  });

  it("连续识别结果只触发一次 active（幂等），并重置静音计时", () => {
    const { scheduler, tracker, transitions } = setup();

    tracker.noteSpeech();
    tracker.noteSpeech();
    tracker.noteSpeech();

    expect(transitions).toEqual(["active"]);
    // 每次都重置：只留一个待执行定时器
    expect(scheduler.pendingCount()).toBe(1);
  });

  it("静音超时后触发 idle", () => {
    const { scheduler, tracker, transitions } = setup();
    tracker.noteSpeech();

    scheduler.runNext();

    expect(tracker.active).toBe(false);
    expect(transitions).toEqual(["active", "idle"]);
  });

  it("说话中途再次 noteSpeech 会推迟 idle（不会误判为说完）", () => {
    const { scheduler, tracker, transitions } = setup();
    tracker.noteSpeech();
    tracker.noteSpeech(); // 重置计时

    scheduler.runNext();

    // 只有最后一次被重置的计时器会执行，且只产生一次 idle
    expect(transitions).toEqual(["active", "idle"]);
  });

  it("idle 之后再次说话可重新触发 active", () => {
    const { scheduler, tracker, transitions } = setup();

    tracker.noteSpeech();
    scheduler.runNext();
    tracker.noteSpeech();

    expect(transitions).toEqual(["active", "idle", "active"]);
    expect(tracker.active).toBe(true);
  });

  it("markIdle 立即判定说完（用于识别会话正常结束）", () => {
    const { scheduler, tracker, transitions } = setup();
    tracker.noteSpeech();

    tracker.markIdle();

    expect(tracker.active).toBe(false);
    expect(transitions).toEqual(["active", "idle"]);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("markIdle 在本来就没说话时不会重复回调", () => {
    const { tracker, transitions } = setup();
    tracker.markIdle();

    expect(transitions).toEqual([]);
  });

  it("dispose 后不再回调", () => {
    const { scheduler, tracker, transitions } = setup();
    tracker.noteSpeech();

    tracker.dispose();
    scheduler.runNext();

    expect(transitions).toEqual(["active"]);
    expect(tracker.active).toBe(false);
  });
});
