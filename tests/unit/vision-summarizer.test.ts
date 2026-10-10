import { describe, expect, it } from "vitest";

import {
  DeterministicScreenSummarizer,
  extractResponseText,
  FallbackScreenSummarizer,
  MAX_SCREEN_SUMMARY_LENGTH,
  OpenAiResponsesVisionSummarizer,
} from "../../src/adapters/vision/openai-responses-vision-summarizer.ts";
import type {
  ScreenFrame,
  ScreenImage,
  ScreenSummarizeInput,
} from "../../src/application/screen/screen-port.ts";

const IMAGE: ScreenImage = {
  jpegBase64: "AAAA",
  width: 1_024,
  height: 576,
  capturedAt: 1_000,
  byteLength: 4,
};

function frame(capturedAt: number): ScreenFrame {
  return {
    capturedAt,
    width: 1_920,
    height: 1_080,
    fingerprint: 1n,
    fingerprintHex: "0000000000000001",
    grayMedian: 30,
    blockColors: [],
    blockSize: 16,
  };
}

function input(frames = [frame(0), frame(5_000), frame(10_000)]): ScreenSummarizeInput {
  return { frames, image: IMAGE };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Responses API 文本提取", () => {
  it("优先用 output_text", () => {
    expect(extractResponseText({ output_text: " 摘要内容 " })).toBe("摘要内容");
  });

  it("output_text 缺失时遍历 output[].content[].text", () => {
    const text = extractResponseText({
      output: [{ content: [{ type: "output_text", text: "第一段" }, { text: "第二段" }] }],
    });

    expect(text).toBe("第一段第二段");
  });

  it("两者都缺失时返回空串", () => {
    expect(extractResponseText({})).toBe("");
  });
});

describe("OpenAiResponsesVisionSummarizer", () => {
  it("使用 Responses API 的 input_image 格式发送图片", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: unknown;

    const summarizer = new OpenAiResponsesVisionSummarizer({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "vision-model",
      fetchImpl: (url, init) => {
        capturedUrl = String(url);
        capturedBody = JSON.parse(String(init?.body));
        return Promise.resolve(jsonResponse({ output_text: "用户正在查看一份文档。" }));
      },
    });

    const summary = await summarizer.summarize(input());

    expect(capturedUrl).toBe("https://example.test/v1/responses");
    const body = capturedBody as { input: Array<{ content: Array<Record<string, unknown>> }> };
    const parts = body.input[0]?.content ?? [];
    expect(parts.some((part) => part["type"] === "input_text")).toBe(true);
    const imagePart = parts.find((part) => part["type"] === "input_image");
    expect(imagePart?.["image_url"]).toBe("data:image/jpeg;base64,AAAA");

    expect(summary.fromModel).toBe(true);
    expect(summary.text).toBe("用户正在查看一份文档。");
    expect(summary.frameCount).toBe(3);
  });

  it("HTTP 非 2xx 时报错（由兜底层处理，不静默成功）", async () => {
    const summarizer = new OpenAiResponsesVisionSummarizer({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "vision-model",
      fetchImpl: () => Promise.resolve(new Response("quota exceeded", { status: 429 })),
    });

    await expect(summarizer.summarize(input())).rejects.toThrow(/HTTP 429/);
  });

  it("响应没有文本时报错，而不是返回空摘要", async () => {
    const summarizer = new OpenAiResponsesVisionSummarizer({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "vision-model",
      fetchImpl: () => Promise.resolve(jsonResponse({ output: [] })),
    });

    await expect(summarizer.summarize(input())).rejects.toThrow(/不含文本/);
  });

  it("超长摘要会被截断，避免撑大滑动窗口", async () => {
    const summarizer = new OpenAiResponsesVisionSummarizer({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "vision-model",
      fetchImpl: () => Promise.resolve(jsonResponse({ output_text: "很长的内容。".repeat(100) })),
    });

    const summary = await summarizer.summarize(input());

    expect(summary.text.length).toBeLessThanOrEqual(MAX_SCREEN_SUMMARY_LENGTH);
  });
});

describe("确定性兜底摘要", () => {
  it("只说可确定的事实，并标注摘要未生成", async () => {
    const summary = await new DeterministicScreenSummarizer().summarize(input());

    expect(summary.fromModel).toBe(false);
    expect(summary.frameCount).toBe(3);
    expect(summary.text).toContain("1920x1080");
    expect(summary.text).toContain("未能生成");
  });

  it("空帧数组不会抛错", async () => {
    const summary = await new DeterministicScreenSummarizer().summarize({ frames: [], image: IMAGE });

    expect(summary.text).toContain("未知");
  });
});

describe("FallbackScreenSummarizer —— 绝不静默丢弃屏幕观察", () => {
  it("模型成功时用模型结果", async () => {
    const primary = new OpenAiResponsesVisionSummarizer({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "m",
      fetchImpl: () => Promise.resolve(jsonResponse({ output_text: "模型摘要" })),
    });
    const summarizer = new FallbackScreenSummarizer(primary);

    const summary = await summarizer.summarize(input());

    expect(summary.fromModel).toBe(true);
    expect(summary.text).toBe("模型摘要");
  });

  it("模型失败时退回确定性摘要，并保留帧数（不丢观察）", async () => {
    const primary = new OpenAiResponsesVisionSummarizer({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "m",
      fetchImpl: () => Promise.reject(new Error("网络不可达")),
    });
    const summarizer = new FallbackScreenSummarizer(primary);

    const summary = await summarizer.summarize(input());

    expect(summary.fromModel).toBe(false);
    expect(summary.frameCount).toBe(3);
    expect(summary.text).toContain("未能生成");
  });
});
