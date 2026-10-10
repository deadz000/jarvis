/**
 * Pi Session 终态判定（适配层）。
 *
 * ## 为什么需要这个模块
 *
 * ADR-001 §3.2 记录的实机陷阱：当 provider 调用失败（例如 API Key 无效）时，
 * `session.prompt()` **仍然正常 resolve**，`getLastAssistantText()` 返回 `undefined`，
 * 事件序列也照常走完 `agent_start → … → agent_end → agent_settled`。
 *
 * 唯一可靠的失败信号是 `message_end` 事件中 assistant 消息的
 * `stopReason === "error"`（伴随 `errorMessage` 字段）。
 *
 * 因此：**绝不能把「prompt() 没抛错」当作任务成功**，必须显式判定终态。
 * 这直接支撑 SRS FR-07 验收「汇报真实的完成/失败事实」与 DoD
 * 「没有把已发出请求误报为成功」。
 */

export type SessionOutcomeStatus = "succeeded" | "failed" | "cancelled" | "unverified";

/** 从 SDK 消息中按需取出的最小字段集合，避免依赖未冻结的消息类型。 */
export interface AssistantFinalMessage {
  readonly stopReason: string | undefined;
  readonly errorMessage: string | undefined;
}

export interface ClassifySessionOutcomeOptions {
  /**
   * 适配器是否已向执行层发出取消请求。
   *
   * 实机结论（ADR-001 §3.2.2）：`abort()` 之后 assistant 终态的 stopReason 同样是
   * `"error"`，与真实的 provider 错误**无法仅凭 stopReason 区分**。
   * 因此必须由「是谁发起了取消」来判定 —— 这正是踩坑指南铁律 3
   * 「『是谁』与『哪一次』必须分离」的又一体现。
   */
  readonly cancelRequested?: boolean;
}

export interface SessionOutcome {
  readonly status: SessionOutcomeStatus;
  readonly stopReason: string | undefined;
  readonly errorMessage: string | undefined;
  readonly text: string;
  /** 判定依据，用于日志与故障排查。 */
  readonly reason: string;
}

/**
 * 被视为「未成功」的 stopReason。
 * 注意：`aborted` 在 Scheduler 层应映射为「已取消」而非「失败」，
 * 因此这里只标定为 failed + 保留 stopReason 供上层细分（M2 负责映射）。
 */
const FAILURE_STOP_REASONS: ReadonlySet<string> = new Set(["error", "aborted"]);

/**
 * 防御式读取：SDK 的消息类型尚未冻结，用运行时检查而不是类型断言。
 * 非 assistant 消息或形状不符时返回 undefined。
 */
export function readAssistantFinalMessage(message: unknown): AssistantFinalMessage | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as Record<string, unknown>;
  if (record["role"] !== "assistant") return undefined;

  const stopReason = typeof record["stopReason"] === "string" ? record["stopReason"] : undefined;
  const errorMessage = typeof record["errorMessage"] === "string" ? record["errorMessage"] : undefined;
  return { stopReason, errorMessage };
}

export function classifySessionOutcome(
  finalMessage: AssistantFinalMessage | undefined,
  lastAssistantText: string | undefined,
  options: ClassifySessionOutcomeOptions = {},
): SessionOutcome {
  const text = lastAssistantText ?? "";

  if (finalMessage === undefined) {
    return {
      status: "unverified",
      stopReason: undefined,
      errorMessage: undefined,
      text,
      reason: "未收到 message_end 的 assistant 终态消息：无法确认执行结果，不得视为成功",
    };
  }

  const { stopReason, errorMessage } = finalMessage;

  if (stopReason !== undefined && FAILURE_STOP_REASONS.has(stopReason)) {
    // 被取消与真实失败在 SDK 层都表现为 error，必须靠「谁发起了取消」区分。
    if (options.cancelRequested === true) {
      return {
        status: "cancelled",
        stopReason,
        errorMessage,
        text,
        reason: `已请求取消，assistant 终态 stopReason=${stopReason} → 判定为已取消而非失败`,
      };
    }
    return {
      status: "failed",
      stopReason,
      errorMessage,
      text,
      reason: `assistant 终态 stopReason=${stopReason}`,
    };
  }

  if (text.length === 0) {
    return {
      status: "failed",
      stopReason,
      errorMessage,
      text,
      reason: `assistant 终态没有正文（stopReason=${stopReason ?? "undefined"}）`,
    };
  }

  // 注意：即使请求过取消，只要最终真的产出了正文并正常收尾，就是成功
  // （对应 Scheduler 里「取消与完成竞态」的处理）。
  return {
    status: "succeeded",
    stopReason,
    errorMessage,
    text,
    reason: `assistant 终态正常（stopReason=${stopReason ?? "undefined"}）`,
  };
}
