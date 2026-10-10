/**
 * 交付策略（M5）：**决定「要不要为这批结果重新调用 Master」**。
 *
 * ## 为什么需要它
 * 「结果是否需要重新调用 Master」不应该是一条固定流水线步骤 —— 若每个任务完成事件
 * 都做一次完整推理，代价与延迟都白花。由**确定性策略**先分流：
 *
 * | 场景 | 路由 | 是否调 Master |
 * |---|---|---|
 * | 单个普通任务完成 | `direct`（直接用已有口语稿） | ❌ 零成本 |
 * | 多个任务同时完成（含需要综合分析） | `master_merge`（汇总成一次回答） | ✅ |
 * | 结果重要性需要语义判断 | `master_priority` | ✅ |
 * | 用户正在讲话 | `defer_for_speech`（面板先更新，语音等合适时机） | ❌ |
 *
 * 这也正是「Master 同时承担任务规划与结果汇总两个逻辑角色，但不必为每个完成事件完整推理」
 * 的落点：路由是确定性的，模型只在真正需要语义判断时才被调用。
 *
 * ## 边界
 * 本模块**不做**语义判断，只做分流；语义判断一律交给 Master（铁律 1）。
 */
import type { PendingResult } from "./delivery-batcher.ts";

export type DeliveryRoute =
  /** 零 LLM：直接用结果自带的口语稿交付。 */
  | "direct"
  /** 调 Master：把多条结果汇总/合并成一次回答。 */
  | "master_merge"
  /** 调 Master：语义判断重要性/紧急度（含需要重写成适合播报的稿）。 */
  | "master_priority"
  /** 用户正在讲话：只更新面板，语音交付等待合适时机。 */
  | "defer_for_speech";

export interface DeliveryPolicyInput {
  readonly batch: readonly PendingResult[];
  /** 用户正在讲话（真实实现由 ASR/VAD 提供；未接入前可由面板手动模拟）。 */
  readonly speechActive: boolean;
  /** 当前是否正在播报。 */
  readonly audioPlaying: boolean;
  /** 仍在运行的任务数（>0 说明可能马上又来结果，值得等一等）。 */
  readonly runningTaskCount: number;
}

export interface DeliveryPolicyDecision {
  readonly route: DeliveryRoute;
  /** 是否必须调用 Master。 */
  readonly requiresMaster: boolean;
  /** 命中该路由的理由，用于日志与排查。 */
  readonly reasons: readonly string[];
}

export interface DeliveryPolicyOptions {
  /** 超过此长度的完整结果，判为「需要 Master 重写/汇总成适合播报的稿」。 */
  readonly longResultLength?: number;
  /** 先验优先级达到此级别时，判为「需要语义判断紧急度」。 */
  readonly priorityNeedsJudgement?: readonly string[];
}

export const DEFAULT_LONG_RESULT_LENGTH = 600;

export class DeliveryPolicy {
  private readonly longResultLength: number;
  private readonly priorityNeedsJudgement: ReadonlySet<string>;

  public constructor(options: DeliveryPolicyOptions = {}) {
    this.longResultLength = options.longResultLength ?? DEFAULT_LONG_RESULT_LENGTH;
    this.priorityNeedsJudgement = new Set(options.priorityNeedsJudgement ?? ["high", "urgent"]);
  }

  public decide(input: DeliveryPolicyInput): DeliveryPolicyDecision {
    if (input.batch.length === 0) {
      return { route: "direct", requiresMaster: false, reasons: ["空批次"] };
    }

    // 1. 用户正在讲话：语音让路，面板照常更新（结果本身已经在快照里可见）
    if (input.speechActive) {
      return {
        route: "defer_for_speech",
        requiresMaster: false,
        reasons: ["用户正在讲话：先更新面板，语音交付等待合适时机"],
      };
    }

    // 2. 多条结果：合并通知，避免连续播报（也覆盖「需要综合分析」的场景）
    if (input.batch.length >= 2) {
      return {
        route: "master_merge",
        requiresMaster: true,
        reasons: [`本批 ${input.batch.length} 条结果同时就绪：合并成一次通知`],
      };
    }

    const only = input.batch[0];
    if (only === undefined) {
      return { route: "direct", requiresMaster: false, reasons: ["空批次"] };
    }

    // 3. 单条但命中「需要语义判断」的信号
    const reasons: string[] = [];

    if (only.hints !== undefined) {
      if (only.hints.needsUserDecision === true) reasons.push("结果需要用户决策");
      if (only.hints.hasBlocker === true) reasons.push("结果被阻塞或失败");
      if (only.hints.isBadNews === true) reasons.push("结果含坏消息");
    }
    if (this.priorityNeedsJudgement.has(only.priority)) {
      reasons.push(`先验优先级为 ${only.priority}，需要语义判断实际紧急度`);
    }
    if (only.fullSummary.length > this.longResultLength) {
      reasons.push(`完整结果较长（${only.fullSummary.length} 字符），需要重写成适合播报的稿`);
    }
    if (reasons.length > 0) {
      return { route: "master_priority", requiresMaster: true, reasons };
    }

    // 4. 单个普通结果：直接用已有口语稿，零 LLM 成本
    return {
      route: "direct",
      requiresMaster: false,
      reasons: ["单个普通结果：直接使用结果自带的口语稿"],
    };
  }
}
