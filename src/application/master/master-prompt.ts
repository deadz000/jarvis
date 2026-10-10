/**
 * Master 提示词（两种模式）。
 *
 * ## 模式 1：意图决策（用户输入触发的唤醒）
 * 输入是「世界快照 + 对话历史」，输出是调度建议（start_task / cancel_task / set_focus）。
 *
 * ## 模式 2：交付决策（结果产出后的唤醒）
 * 输入是「世界快照 + 对话历史 + 待交付结果批次」，输出是交付建议（deliver_results）。
 * 这一模式存在的意义：**交付该不该现在做、要不要把几条结果合并成一次回答**，
 * 是纯语义判断，确定性规则写不出来。
 *
 * ## 两种模式共同遵守的约束
 * - 提示词只影响「建议」，落地一律经逐动作校验与确定性仲裁器；
 * - 要求模型**原样回填** revision，用于判断决策是否过期；
 * - 取消/交付都必须回填前置条件（`expectedGeneration` / 任务必须已成功），
 *   过期决策不得误取消已完成任务、不得交付未就绪结果。
 */
import type { DialogueEntry } from "../interaction/dialogue-history.ts";
import type { PendingResult } from "../delivery/delivery-batcher.ts";
import type { MasterContextView } from "./context-view.ts";

export const MASTER_OUTPUT_SCHEMA_HINT = `{
  "decisionId": "唯一字符串",
  "basedOn": { "eventSeq": 快照.revision.eventSeq, "controlRevision": 快照.revision.controlRevision },
  "rationale": "一句话依据（可选）",
  "actions": [
    { "type": "start_task", "goal": "独立目标", "priority": "low|normal|high|urgent", "reason": "可选" },
    { "type": "cancel_task", "taskId": "task-N", "expectedGeneration": 快照中该任务的 runGeneration, "reason": "可选" },
    { "type": "set_focus", "taskId": "task-N" },
    { "type": "deliver_results", "taskIds": ["task-1", "task-2"], "text": "合并后的口语播报稿", "priority": "low|normal|high|urgent", "timing": "now|after_current" }
  ]
}`;

const SHARED_RULES = [
  "1. `basedOn` 必须**原样回填**世界快照中的 `revision.eventSeq` 与 `revision.controlRevision`。",
  "2. **一个目标内的多步骤不要拆成多个 Task**；只有真正相互独立的目标才分别 `start_task`。",
  "3. `cancel_task` 必须回填快照中该任务的 `runGeneration` 作为 `expectedGeneration`；",
  "   任务已完成、已取消或已换代的取消动作会被拒绝。",
  "4. 只取消确实应当停止的任务；无法判断时宁可不输出该动作。",
  "5. 不需要做任何事时，`actions` 输出空数组 `[]`。",
  "6. 不要输出 JSON 之外的任何内容。",
];

export interface MasterPromptRequest {
  readonly mode: "intent" | "delivery";
  readonly view: MasterContextView;
  readonly dialogue: readonly DialogueEntry[];
  readonly pendingResults: readonly PendingResult[];
  /**
   * 屏幕上下文（**仅摘要**）。
   * 只在意图门控命中时才有值 —— 纯文字指令不会带上任何屏幕内容。
   */
  readonly screen?: { readonly summaries: readonly string[]; readonly oldestAt: number | null };
}

function renderDialogue(dialogue: readonly DialogueEntry[]): string {
  if (dialogue.length === 0) return "（还没有对话历史）";
  return dialogue
    .map((entry) => `${entry.role === "user" ? "用户" : "系统"}：${entry.text}`)
    .join("\n");
}

/**
 * 渲染屏幕上下文。
 *
 * 两条约束写进提示词本身：
 * 1. **不含原始帧**（这里只有摘要文本）；
 * 2. 摘要是**滞后**的，不得当成实时事实 —— SRS 要求「历史信息可追溯来源、
 *    不会冒充实时事实」。用户问"现在屏幕上是什么"时，模型应当说明这是观察摘要，
 *    必要时建议重新观察，而不是假装自己正在看。
 */
function renderScreen(screen: MasterPromptRequest["screen"]): string {
  if (screen === undefined || screen.summaries.length === 0) {
    return "（未提供屏幕上下文）";
  }
  const lines = screen.summaries.map((summary, index) => `${index + 1}. ${summary}`);
  return [
    ...lines,
    "",
    "注意：以上是**间隔观察得到的摘要**（有滞后），不是实时画面。",
    "不要把它当成此刻正在发生的事实；需要当前画面时应先去获取，而不是假设。",
  ].join("\n");
}

export function buildMasterPrompt(request: MasterPromptRequest): string {
  const pending = request.pendingResults
    .map(
      (item) =>
        `- ${item.taskId}（priority=${item.priority}）\n  完整结果：${item.fullSummary}\n  口语稿：${item.spokenSummary}`,
    )
    .join("\n");

  if (request.mode === "delivery") {
    return [
      "你是**交付决策器**。刚刚有任务完成，你需要决定「怎么把结果告诉用户」。",
      "你的输出会被程序严格解析，因此**只输出一个 JSON 对象**。",
      "",
      "## 世界快照",
      "```json",
      JSON.stringify(request.view, null, 2),
      "```",
      "",
      "## 最近的对话历史",
      renderDialogue(request.dialogue),
      "",
      "## 本批待交付的结果",
      pending.length > 0 ? pending : "（空）",
      "",
      "## 你的任务",
      "对这批待交付结果给出**一个** `deliver_results` 动作：",
      "- `taskIds`：本批要交付的任务，**通常就是全部**；确实不该播的可以不列入；",
      "- `text`：**合并后的口语播报稿** —— 把几条结果综合成一次自然的回答，",
      "  1～3 句，直接说结论，不要 Markdown、代码、列表、链接、文件路径；",
      "- `priority`：这批结果对**当前用户**的实际紧急度（不是任务创建时的先验）；",
      "  只有确实需要立刻打断用户时才用 `urgent`；",
      "- `timing`：`now` 表示可以抢占当前播报（仍受确定性规则约束），",
      "  `after_current` 表示等当前语句播完再说。**无法判断时用 `after_current`**。",
      "",
      "## 判断依据（请真的用它）",
      "- 用户最近在问什么？这批结果是不是他在等的？",
      "- 几条结果是否相关？相关就合并叙述，不要机械地逐条罗列；",
      "- 结果里有没有**需要用户决策**、**阻塞或失败**、**坏消息**？",
      "  有的话应当更早说、说得更明确；",
      "- 用户是否明确表示过不要某个任务的结果？",
      "",
      "## 输出格式",
      "```json",
      MASTER_OUTPUT_SCHEMA_HINT,
      "```",
      "",
      "只输出 JSON 对象，不要任何解释。",
    ].join("\n");
  }

  return [
    "你是调度决策器。你的输出会被程序严格解析，因此**只输出一个 JSON 对象**，不要输出解释、前后缀或其他文字。",
    "",
    "## 当前世界快照",
    "```json",
    JSON.stringify(request.view, null, 2),
    "```",
    "",
    "## 最近的对话历史",
    renderDialogue(request.dialogue),
    "",
    "## 最近的屏幕观察",
    renderScreen(request.screen),
    "",
    "## 输出格式",
    "```json",
    MASTER_OUTPUT_SCHEMA_HINT,
    "```",
    "",
    "## 规则",
    ...SHARED_RULES,
    "7. 本模式只需给出调度建议；结果交付由交付决策器负责，不要输出 `deliver_results`。",
  ].join("\n");
}
