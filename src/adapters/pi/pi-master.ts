/**
 * 真实 Pi Master 适配器（M4）：用一次性的 Agent Session 产出结构化决策建议。
 *
 * 设计要点：
 * - **不给任何工具**（`noTools: "all"`）：Master 只提出意图，不需要也不应该动手；
 * - 每次决策一个独立的 in-memory Session，决策之间不共享历史（避免上下文串味）；
 * - 用既有的终态判定模块识别成败，**不把 prompt() resolve 当作成功**；
 * - 支持 `AbortSignal`：超时时由决策平面中止这次调用。
 */
import { createAgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { MasterContextView } from "../../application/master/context-view.ts";
import type { MasterPort, MasterProposal, MasterRequest } from "../../application/master/decision-plane.ts";
import { buildMasterPrompt } from "../../application/master/master-prompt.ts";
import type { Logger } from "../../observability/logger.ts";
import type { PiModel } from "./pi-worker-runtime.ts";
import {
  classifySessionOutcome,
  readAssistantFinalMessage,
  type AssistantFinalMessage,
} from "./session-outcome.ts";

function readEventType(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const type = (value as Record<string, unknown>)["type"];
    if (typeof type === "string") return type;
  }
  return "unknown";
}

export interface PiMasterAdapterOptions {
  readonly modelRuntime: ModelRuntime;
  readonly model: PiModel;
  readonly workspace: string;
  readonly logger?: Logger;
}

export class PiMasterAdapter implements MasterPort {
  private readonly options: PiMasterAdapterOptions;

  public constructor(options: PiMasterAdapterOptions) {
    this.options = options;
  }

  public async proposeDecision(request: MasterRequest): Promise<MasterProposal> {
    const { view, signal } = request;
    return this.runOnce(view, signal);
  }

  private async runOnce(view: MasterContextView, signal: AbortSignal | undefined): Promise<MasterProposal> {
    const logger = this.options.logger;

    let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
    try {
      const created = await createAgentSession({
        cwd: this.options.workspace,
        modelRuntime: this.options.modelRuntime,
        model: this.options.model,
        // Master 不需要任何工具：它只提出意图。
        noTools: "all",
      });
      session = created.session;
    } catch (error) {
      return { status: "error", reason: `无法创建 Master Session：${error instanceof Error ? error.message : String(error)}` };
    }

    let finalAssistant: AssistantFinalMessage | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (readEventType(event) === "message_end") {
        const candidate = readAssistantFinalMessage((event as Record<string, unknown>)["message"]);
        if (candidate !== undefined) finalAssistant = candidate;
      }
    });

    const onAbort = (): void => {
      void session.abort().catch(() => {
        // 超时路径下的中止失败不影响降级语义（仍然不执行任何动作）。
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await session.prompt(buildMasterPrompt(view));

      const outcome = classifySessionOutcome(finalAssistant, session.getLastAssistantText(), {
        cancelRequested: signal?.aborted === true,
      });

      if (outcome.status === "succeeded") return { status: "ok", rawText: outcome.text };
      if (outcome.status === "cancelled") return { status: "timeout" };
      return { status: "error", reason: `${outcome.reason}${outcome.errorMessage === undefined ? "" : ` / ${outcome.errorMessage}`}` };
    } catch (error) {
      if (signal?.aborted === true) return { status: "timeout" };
      logger?.warn("pi_master.prompt_failed", { error });
      return { status: "error", reason: error instanceof Error ? error.message : String(error) };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      session.dispose();
    }
  }
}
