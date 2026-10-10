import { describe, expect, it } from "vitest";

import {
  SimulatedAudioManager,
  type AudioEvent,
  type DeliveredAudioChunk,
} from "../../src/application/delivery/audio-manager.ts";
import type { TtsChunk, TtsPort, TtsRequest } from "../../src/application/delivery/tts-port.ts";

/** 让挂起的微任务/宏任务跑完，避免测试依赖精确的 tick 次数。 */
async function settle(times = 20): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** 立即产出分片的假 TTS：确定性，不发起任何网络请求。 */
class ImmediateTts implements TtsPort {
  public readonly requests: TtsRequest[] = [];
  public chunkCount = 3;
  public failWith: string | undefined;

  public async *synthesize(request: TtsRequest): AsyncIterable<TtsChunk> {
    this.requests.push(request);
    if (this.failWith !== undefined) throw new Error(this.failWith);
    for (let index = 1; index <= this.chunkCount; index += 1) {
      if (request.signal?.aborted === true) return;
      yield { audio: Buffer.alloc(8, index), index, format: "pcm", sampleRate: 24_000, at: 0 };
      await settle(1);
    }
  }
}

function setup(tts: TtsPort) {
  const delivered: DeliveredAudioChunk[] = [];
  const events: AudioEvent[] = [];
  const audio = new SimulatedAudioManager({
    synthesizer: tts,
    onChunk: (chunk) => delivered.push(chunk),
  });
  audio.onEvent((event) => events.push(event));
  return { audio, delivered, events };
}

describe("真实合成模式：仲裁逻辑与模拟模式共用同一份代码", () => {
  it("分片来自 TTS，逐片携带播放代次与序号推给上层", async () => {
    const tts = new ImmediateTts();
    const { audio, delivered } = setup(tts);

    const grant = audio.grant({ taskId: "task-1", text: "要念的内容", priority: "normal" });
    expect(audio.usesRealSynthesis).toBe(true);

    await settle();

    expect(delivered).toHaveLength(3);
    expect(delivered.every((chunk) => chunk.token === grant.token)).toBe(true);
    expect(delivered.map((chunk) => chunk.index)).toEqual([1, 2, 3]);
    expect(delivered.every((chunk) => chunk.format === "pcm")).toBe(true);
    expect(delivered.every((chunk) => chunk.sampleRate === 24_000)).toBe(true);
    expect(audio.stats().delivered).toBe(3);
    expect(audio.stats().finished).toBe(1);
    expect(audio.isPlaying).toBe(false);
  });

  it("stop() 会中止合成 —— 这就是让服务端执行 directive:cancel 的通道", async () => {
    const tts = new ImmediateTts();
    const { audio } = setup(tts);

    audio.grant({ taskId: "task-1", text: "内容", priority: "normal" });
    await settle(2);

    const stopped = audio.stop("用户开口触发停播");
    await settle();

    expect(stopped).toBe(true);
    expect(tts.requests[0]?.signal?.aborted).toBe(true);
    expect(audio.isPlaying).toBe(false);
  });

  it("真实模式同样遵守「urgent 只在分片边界停」", async () => {
    const tts = new ImmediateTts();
    tts.chunkCount = 12;
    const { audio } = setup(tts);

    audio.grant({ taskId: "task-1", text: "很长的内容", priority: "normal" });
    await settle(3);

    // 请求边界停止：不应立刻切断
    expect(audio.requestStopAtBoundary("urgent 结果优先")).toBe(true);
    expect(audio.stats().stopped).toBe(0);

    await settle();

    expect(audio.stats().preemptions).toBe(1);
    expect(audio.stats().stopped).toBe(1);
    expect(audio.isPlaying).toBe(false);
    // 边界停止同样会中止服务端合成
    expect(tts.requests[0]?.signal?.aborted).toBe(true);
  });

  it("合成失败会报 playback_failed，不会静默当成播完", async () => {
    const tts = new ImmediateTts();
    tts.failWith = "HandshakeFailed：HTTP 401";
    const { audio, events } = setup(tts);

    audio.grant({ taskId: "task-1", text: "内容", priority: "normal" });
    await settle();

    expect(audio.stats().failed).toBe(1);
    const failed = events.filter((event) => event.type === "playback_failed");
    expect(failed).toHaveLength(1);
    if (failed[0]?.type === "playback_failed") {
      expect(failed[0].reason).toContain("HandshakeFailed");
    }
  });

  it("停播后到达的旧代次分片仍被拒绝（真实模式与模拟模式语义一致）", async () => {
    const tts = new ImmediateTts();
    const { audio } = setup(tts);

    const grant = audio.grant({ taskId: "task-1", text: "内容", priority: "normal" });
    audio.stop("用户开口");

    audio.advance(grant.token, {
      audio: Buffer.alloc(8),
      index: 99,
      format: "pcm",
      sampleRate: 24_000,
      at: 0,
    });

    expect(audio.stats().rejected).toBe(1);
  });

  it("模拟模式不受影响：未提供 synthesizer 时仍是定时器推进", () => {
    const audio = new SimulatedAudioManager({ chunksPerPlayback: 4 });

    const grant = audio.grant({ taskId: "task-1", text: "要念的内容", priority: "normal" });

    expect(audio.usesRealSynthesis).toBe(false);
    expect(grant.chunkCount).toBeGreaterThan(0);
  });
});
