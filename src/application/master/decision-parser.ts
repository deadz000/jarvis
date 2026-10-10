/**
 * 决策解析器（M4）：**只做结构与 Schema 校验，不做业务校验**。
 *
 * 计划明确要求「将模型输出解析和业务校验分开」。本模块的职责边界：
 * - 从模型文本中取出 JSON（兼容 ```json 围栏与前后噪声）；
 * - 校验顶层结构与每个动作的形状；
 * - **安全降级**：JSON 无法解析或顶层结构非法 → 整体判 `invalid`（调用方不执行任何动作）；
 *   单个动作形状非法 → 只丢弃该动作，保留其余合法动作，并记录丢弃原因。
 *
 * 它不知道任何任务状态，因此可以完全脱离 LLM 与 Scheduler 单测。
 */
import { DEFAULT_PRIORITY, isPriority } from "../../domain/task/types.ts";
import type { DecisionAction, MasterDecision, WorldRevision } from "../../domain/decision/types.ts";

export type DecisionParseResult =
  | {
      readonly status: "ok";
      readonly decision: MasterDecision;
      /** 因形状非法被丢弃的动作及原因（保留其余合法动作）。 */
      readonly droppedActions: readonly string[];
    }
  | { readonly status: "invalid"; readonly reason: string; readonly rawExcerpt: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** 从文本中抽出 JSON 对象：支持 ```json 围栏，并裁掉前后解释性文字。 */
export function extractJsonObject(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return candidate.slice(start, end + 1);
}

type ActionNormalization =
  | { readonly ok: true; readonly action: DecisionAction }
  | { readonly ok: false; readonly reason: string };

function normalizeAction(raw: unknown, index: number): ActionNormalization {
  const record = asRecord(raw);
  if (record === undefined) return { ok: false, reason: `actions[${index}] 不是对象` };

  const type = record["type"];
  if (typeof type !== "string") return { ok: false, reason: `actions[${index}] 缺少 type` };

  const reason = readNonEmptyString(record["reason"]);

  if (type === "start_task") {
    const goal = readNonEmptyString(record["goal"]);
    if (goal === undefined) return { ok: false, reason: `actions[${index}] start_task 缺少非空 goal` };

    const rawPriority = record["priority"];
    if (rawPriority !== undefined && !isPriority(rawPriority)) {
      return { ok: false, reason: `actions[${index}] start_task 的 priority 非法：${String(rawPriority)}` };
    }
    return {
      ok: true,
      action: {
        type,
        goal,
        priority: isPriority(rawPriority) ? rawPriority : DEFAULT_PRIORITY,
        ...(reason === undefined ? {} : { reason }),
      },
    };
  }

  if (type === "cancel_task") {
    const taskId = readNonEmptyString(record["taskId"]);
    if (taskId === undefined) return { ok: false, reason: `actions[${index}] cancel_task 缺少非空 taskId` };

    const rawGeneration = record["expectedGeneration"];
    let expectedGeneration: number | undefined;
    if (rawGeneration !== undefined) {
      const parsed = readNonNegativeInt(rawGeneration);
      if (parsed === undefined) {
        return { ok: false, reason: `actions[${index}] cancel_task 的 expectedGeneration 必须是非负整数` };
      }
      expectedGeneration = parsed;
    }
    return {
      ok: true,
      action: {
        type,
        taskId,
        ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
        ...(reason === undefined ? {} : { reason }),
      },
    };
  }

  if (type === "set_focus") {
    const rawFocus = record["taskId"];
    if (rawFocus !== null && typeof rawFocus !== "string") {
      return { ok: false, reason: `actions[${index}] set_focus 的 taskId 必须是字符串或 null` };
    }
    const taskId = typeof rawFocus === "string" ? (readNonEmptyString(rawFocus) ?? null) : null;
    return {
      ok: true,
      action: { type, taskId, ...(reason === undefined ? {} : { reason }) },
    };
  }

  if (type === "deliver_results") {
    const rawIds = record["taskIds"];
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return { ok: false, reason: `actions[${index}] deliver_results 需要非空 taskIds 数组` };
    }
    const taskIds: string[] = [];
    for (const candidate of rawIds) {
      const parsedId = readNonEmptyString(candidate);
      if (parsedId === undefined) {
        return { ok: false, reason: `actions[${index}] deliver_results 的 taskIds 含非字符串项` };
      }
      taskIds.push(parsedId);
    }

    const text = readNonEmptyString(record["text"]);
    if (text === undefined) return { ok: false, reason: `actions[${index}] deliver_results 缺少非空 text` };

    const rawPriority = record["priority"];
    if (rawPriority !== undefined && !isPriority(rawPriority)) {
      return { ok: false, reason: `actions[${index}] deliver_results 的 priority 非法：${String(rawPriority)}` };
    }

    const rawTiming = record["timing"];
    if (rawTiming !== undefined && rawTiming !== "now" && rawTiming !== "after_current") {
      return { ok: false, reason: `actions[${index}] deliver_results 的 timing 非法：${String(rawTiming)}` };
    }

    return {
      ok: true,
      action: {
        type,
        taskIds,
        text,
        priority: isPriority(rawPriority) ? rawPriority : DEFAULT_PRIORITY,
        // 无法确认时保守选 after_current：不抢占总是安全的
        timing: rawTiming === "now" ? "now" : "after_current",
        ...(reason === undefined ? {} : { reason }),
      },
    };
  }

  return { ok: false, reason: `actions[${index}] 未知动作类型：${type}` };
}

export function parseMasterDecision(text: string): DecisionParseResult {
  const excerpt = text.slice(0, 400);

  const json = extractJsonObject(text);
  if (json === undefined) {
    return { status: "invalid", reason: "未在模型输出中找到 JSON 对象", rawExcerpt: excerpt };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      status: "invalid",
      reason: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      rawExcerpt: excerpt,
    };
  }

  const root = asRecord(parsed);
  if (root === undefined) return { status: "invalid", reason: "顶层不是 JSON 对象", rawExcerpt: excerpt };

  const decisionId = readNonEmptyString(root["decisionId"]);
  if (decisionId === undefined) return { status: "invalid", reason: "缺少非空 decisionId", rawExcerpt: excerpt };

  const basedOnRaw = asRecord(root["basedOn"]);
  if (basedOnRaw === undefined) return { status: "invalid", reason: "缺少 basedOn 对象", rawExcerpt: excerpt };

  const eventSeq = readNonNegativeInt(basedOnRaw["eventSeq"]);
  const controlRevision = readNonNegativeInt(basedOnRaw["controlRevision"]);
  if (eventSeq === undefined || controlRevision === undefined) {
    return {
      status: "invalid",
      reason: "basedOn 必须包含非负整数 eventSeq 与 controlRevision",
      rawExcerpt: excerpt,
    };
  }

  const actionsRaw = root["actions"];
  if (!Array.isArray(actionsRaw)) {
    return { status: "invalid", reason: "actions 必须是数组（空计划应为 []）", rawExcerpt: excerpt };
  }

  const actions: DecisionAction[] = [];
  const droppedActions: string[] = [];
  actionsRaw.forEach((raw, index) => {
    const normalized = normalizeAction(raw, index);
    if (normalized.ok) actions.push(normalized.action);
    else droppedActions.push(normalized.reason);
  });

  const rationale = readNonEmptyString(root["rationale"]);
  const basedOn: WorldRevision = { eventSeq, controlRevision };
  const decision: MasterDecision = {
    decisionId,
    basedOn,
    actions,
    ...(rationale === undefined ? {} : { rationale }),
  };

  return { status: "ok", decision, droppedActions };
}
