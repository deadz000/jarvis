/**
 * Master 提示词构造（M4）。
 *
 * 决策清单已确认：**用提示词要求 JSON + 严格解析与降级**，不依赖 provider 的
 * `response_format` 等特性。这样才能在任意 OpenAI 兼容端点上可复现、可单测。
 *
 * 要点：
 * - 要求模型**原样回填** 快照里的 revision，据此判断决策是否过期；
 * - 取消动作必须回填 `expectedGeneration`，这是防止「过期决策误取消已换代任务」的前置条件；
 * - 明确「一个目标内多步骤不要拆分」，对应 SRS §3.2 的任务拆分单位。
 */
import type { MasterContextView } from "./context-view.ts";

export const MASTER_OUTPUT_SCHEMA_HINT = `{
  "decisionId": "唯一字符串",
  "basedOn": { "eventSeq": 快照.revision.eventSeq, "controlRevision": 快照.revision.controlRevision },
  "rationale": "一句话依据（可选）",
  "actions": [
    { "type": "start_task", "goal": "独立目标", "priority": "low|normal|high|urgent", "reason": "可选" },
    { "type": "cancel_task", "taskId": "task-N", "expectedGeneration": 快照中该任务的 runGeneration, "reason": "可选" },
    { "type": "set_focus", "taskId": "task-N" }
  ]
}`;

export function buildMasterPrompt(view: MasterContextView): string {
  return [
    "你是调度决策器。你的输出会被程序严格解析，因此**只输出一个 JSON 对象**，不要输出解释、前后缀或 Markdown 代码块以外的任何文字。",
    "",
    "## 当前世界快照",
    "```json",
    JSON.stringify(view, null, 2),
    "```",
    "",
    "## 输出格式",
    "```json",
    MASTER_OUTPUT_SCHEMA_HINT,
    "```",
    "",
    "## 规则",
    "1. `basedOn` 必须**原样回填**快照中的 `revision.eventSeq` 与 `revision.controlRevision`。",
    "2. **一个目标内的多步骤不要拆成多个 Task**；只有真正相互独立的目标才分别 `start_task`。",
    "3. `cancel_task` 必须回填快照中该任务的 `runGeneration` 作为 `expectedGeneration`；",
    "   任务已完成、已取消或已换代的取消动作会被拒绝。",
    "4. 只取消确实应当停止的任务；无法判断时宁可不输出该动作。",
    "5. 不需要做任何事时，`actions` 输出空数组 `[]`。",
    "6. 不要输出 JSON 之外的任何内容。",
  ].join("\n");
}
