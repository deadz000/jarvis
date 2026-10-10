/**
 * 屏幕摘要：多模态模型（OpenAI Responses API 格式）+ **确定性兜底**。
 *
 * ## 为什么用 Responses API 而不是 chat/completions
 * 本项目 provider 声明为 `openai-responses`。实测（2026-10-10）：
 * - `POST /v1/responses` 接受 `input_image` + data URL，返回可用中文摘要（HTTP 200）；
 * - `POST /v1/chat/completions` 同样返回 200 但内容为空。
 * 因此这里固定用 Responses API。
 *
 * ## 为什么必须有兜底
 * 摘要是一次**概率性调用**（网络、配额、模型行为都可能失败）。
 * 若失败就静默丢弃，屏幕上下文会出现无声的缺口 —— 调用方无法区分
 * 「屏幕没变化」和「摘要失败了」。所以失败时退回**确定性摘要**：
 * 只陈述可确定的事实（这一批有几帧、分辨率、观测时段），并明确标注未得到内容摘要。
 */
import type { Logger } from "../../observability/logger.ts";
import { deterministicScreenSummary } from "../../application/screen/deterministic-summary.ts";
import type {
  ScreenSummarizeInput,
  ScreenSummarizerPort,
  ScreenSummary,
} from "../../application/screen/screen-port.ts";

/** 摘要文本上限（防止模型啰嗦把滑动窗口撑大）。 */
export const MAX_SCREEN_SUMMARY_LENGTH = 200;
export const DEFAULT_VISION_TIMEOUT_MS = 20_000;
/**
 * 输出 token 上限。
 *
 * 实测教训：给 200 时模型把预算花在推理上，返回
 * `incomplete_details: {reason: "length"}` 且**没有可见文本**。
 * 这里留足余量；同时错误信息会带上 incomplete_details，便于下次快速定位。
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 800;

export const SCREEN_SUMMARY_INSTRUCTION = [
  "你在为一位语音助手提供「屏幕上下文摘要」。下面这张图是用户当前的屏幕。",
  "请用 1-2 句中文说明：用户此刻在做什么、当前焦点是什么。",
  "要求：",
  "- 只写能从画面确认的内容；",
  "- 不要猜测用户意图，不要评价，不要给建议；",
  "- 抓重点，不要罗列界面元素细节；",
  "- 如果画面没有可描述的内容（例如空白桌面），直接说明「屏幕为空白桌面」。",
].join("\n");

export interface VisionSummarizerOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
  readonly now?: () => number;
  /** 注入点：测试用假 fetch，避免真实网络调用。 */
  readonly fetchImpl?: typeof fetch;
}

interface ResponsesApiContentPart {
  readonly type?: string;
  readonly text?: string;
}

interface ResponsesApiOutputItem {
  readonly content?: readonly ResponsesApiContentPart[];
}

interface ResponsesApiResponse {
  readonly output_text?: string;
  readonly output?: readonly ResponsesApiOutputItem[];
  readonly error?: { readonly message?: string };
  readonly incomplete_details?: { readonly reason?: string };
}

/** 从 Responses API 响应里稳健地取出文本。 */
export function extractResponseText(payload: ResponsesApiResponse): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim().length > 0) {
    return payload.output_text.trim();
  }

  const parts: string[] = [];
  for (const item of payload.output ?? []) {
    for (const part of item.content ?? []) {
      if (typeof part.text === "string" && part.text.length > 0) parts.push(part.text);
    }
  }
  return parts.join("").trim();
}

export class OpenAiResponsesVisionSummarizer implements ScreenSummarizerPort {
  private readonly options: VisionSummarizerOptions;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: VisionSummarizerOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  public async summarize(input: ScreenSummarizeInput): Promise<ScreenSummary> {
    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS;
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: SCREEN_SUMMARY_INSTRUCTION },
                {
                  type: "input_image",
                  image_url: `data:image/jpeg;base64,${input.image.jpegBase64}`,
                },
              ],
            },
          ],
          max_output_tokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        }),
        signal: controller.signal,
      });

      const body = await response.text();
      if (!response.ok) {
        throw new Error(`屏幕摘要请求失败：HTTP ${response.status}，响应前 200 字符：${body.slice(0, 200)}`);
      }

      let parsed: ResponsesApiResponse;
      try {
        parsed = JSON.parse(body) as ResponsesApiResponse;
      } catch {
        throw new Error(`屏幕摘要响应无法解析为 JSON：${body.slice(0, 200)}`);
      }

      const text = extractResponseText(parsed);
      if (text.length === 0) {
        // 明确区分「被 token 上限截断」与「响应结构异常」：
        // 前者是配置问题（调大 max_output_tokens），后者是接口问题。
        const reason = parsed.incomplete_details?.reason;
        const hint =
          reason === "length"
            ? `：输出被 token 上限截断（max_output_tokens=${String(this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS)}），请调大该值`
            : "";
        throw new Error(`屏幕摘要响应不含文本${hint}；响应前 200 字符：${body.slice(0, 200)}`);
      }

      return {
        text: truncate(text, MAX_SCREEN_SUMMARY_LENGTH),
        at: this.now(),
        frameCount: input.frames.length,
        fromModel: true,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`屏幕摘要超时（>${timeoutMs}ms）`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 确定性兜底摘要：只说能确定的事实，并**明确标注这是兜底**。
 *
 * 实际逻辑在应用层（`application/screen/deterministic-summary.ts`）——
 * 那是纯逻辑，不该放在厂商适配器里。这里保留一个薄包装，
 * 方便 `FallbackScreenSummarizer` 以端口形式使用。
 */
export class DeterministicScreenSummarizer implements ScreenSummarizerPort {
  private readonly now: () => number;

  public constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  public summarize(input: ScreenSummarizeInput): Promise<ScreenSummary> {
    return Promise.resolve(deterministicScreenSummary(input.frames, this.now()));
  }
}

/** 先试模型，失败则兜底；**绝不静默丢弃**屏幕观察。 */
export class FallbackScreenSummarizer implements ScreenSummarizerPort {
  private readonly primary: ScreenSummarizerPort;
  private readonly fallback: ScreenSummarizerPort;
  private readonly logger: Logger | undefined;

  public constructor(
    primary: ScreenSummarizerPort,
    fallback: ScreenSummarizerPort = new DeterministicScreenSummarizer(),
    logger?: Logger,
  ) {
    this.primary = primary;
    this.fallback = fallback;
    this.logger = logger;
  }

  public async summarize(input: ScreenSummarizeInput): Promise<ScreenSummary> {
    try {
      return await this.primary.summarize(input);
    } catch (error) {
      this.logger?.warn("screen.summary_failed_using_fallback", {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.fallback.summarize(input);
    }
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
