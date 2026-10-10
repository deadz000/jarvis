/**
 * 「给面板看」与「给 TTS 念」是两种文本（提示词设计的基础设施）。
 *
 * ## 为什么必须有确定性兜底
 * Worker 会被要求额外产出一段口语化播报稿，但那是一个**概率性输出**：
 * 模型可能忘记给、可能给成 markdown、可能给超长。
 * 依据踩坑指南铁律 7（每个概率性判断都要有确定性兜底），
 * 这里提供一条**纯确定性**的 markdown → 口语稿转换：
 * 与模型是否配合无关，永远能产出可播报的文本。
 *
 * 转换规则（刻意保守，只做"去掉念不出来的东西"）：
 * - 移除围栏代码块（整体删除，避免把代码念出来）；
 * - 去掉 markdown 标记（标题、列表、强调、引用、行内代码反引号）；
 * - 移除 URL 与表格行；
 * - 折叠空白，超长时在**句子边界**截断（不截断句子中间）。
 */
export const DEFAULT_SPOKEN_MAX_LENGTH = 180;
export const DEFAULT_SPOKEN_MAX_SENTENCES = 3;

/** Worker 应把口语化播报稿放在这对标记之间（见 `buildWorkerPrompt`）。 */
export const SPOKEN_BLOCK_START = "[[SPOKEN]]";
export const SPOKEN_BLOCK_END = "[[/SPOKEN]]";

export interface SpokenTextOptions {
  /** 播报文本上限（字符数），默认 180 —— 约一口气可播完。 */
  readonly maxLength?: number;
  /** 最多保留几句，默认 3。 */
  readonly maxSentences?: number;
}

export interface SpokenText {
  readonly text: string;
  readonly truncated: boolean;
  /** 被整体移除的围栏代码块数量（便于排查"为什么播报很短"）。 */
  readonly removedCodeBlocks: number;
}

const CODE_FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`([^`]*)`/g;
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const BARE_URL = /https?:\/\/\S+/g;
const TABLE_ROW = /^\s*\|.*\|\s*$/gm;
const HEADING = /^\s{0,3}#{1,6}\s*/gm;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/gm;
const BLOCKQUOTE = /^\s*>\s?/gm;
const EMPHASIS = /(\*\*|__|\*|_|~~)/g;
const HORIZONTAL_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm;

/** 把一段（可能是 markdown 的）文本转成适合朗读的文本。 */
export function toSpokenText(markdown: string, options: SpokenTextOptions = {}): SpokenText {
  const maxLength = options.maxLength ?? DEFAULT_SPOKEN_MAX_LENGTH;
  const maxSentences = options.maxSentences ?? DEFAULT_SPOKEN_MAX_SENTENCES;

  let removedCodeBlocks = 0;
  let text = markdown.replace(CODE_FENCE, () => {
    removedCodeBlocks += 1;
    return " ";
  });

  text = text
    .replace(TABLE_ROW, " ")
    .replace(HORIZONTAL_RULE, " ")
    .replace(HEADING, "")
    .replace(LIST_MARKER, "")
    .replace(BLOCKQUOTE, "")
    .replace(MARKDOWN_LINK, "$1")
    .replace(BARE_URL, " ")
    .replace(INLINE_CODE, "$1")
    .replace(EMPHASIS, "");

  // 折叠空白：换行视作句子边界（补一个句号，避免两句连读）
  text = text
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (/[。！？.!?;；:：]$/.test(line) ? line : `${line}。`))
    .join("")
    .replace(/\s{2,}/g, " ")
    .replace(/。{2,}/g, "。")
    .trim();

  // 句子数上限
  const sentences = splitSentences(text);
  let selected = sentences.slice(0, maxSentences).join("");
  let truncated = sentences.length > maxSentences;

  // 长度上限：在句子边界内截断
  if (selected.length > maxLength) {
    truncated = true;
    let acc = "";
    for (const sentence of splitSentences(selected)) {
      if (acc.length + sentence.length > maxLength) break;
      acc += sentence;
    }
    selected = acc.length > 0 ? acc : `${selected.slice(0, maxLength)}…`;
  }

  return { text: selected.trim(), truncated, removedCodeBlocks };
}

/** 按中英文句末标点切句，保留标点。 */
export function splitSentences(text: string): string[] {
  const matched = text.match(/[^。！？.!?]+[。！？.!?]*/g);
  return (matched ?? [text]).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
}

export interface ExtractedSpoken {
  /** 去掉口语块之后的完整结果（给面板/存储用）。 */
  readonly full: string;
  /** 模型给的口语稿（可能没有）。 */
  readonly spoken: string | undefined;
}

/** 从 Worker 输出中分离出「完整结果」与「口语化播报稿」。 */
export function extractSpokenSummary(output: string): ExtractedSpoken {
  const start = output.indexOf(SPOKEN_BLOCK_START);
  const end = output.indexOf(SPOKEN_BLOCK_END);
  if (start < 0 || end < 0 || end <= start) {
    return { full: output.trim(), spoken: undefined };
  }

  const spoken = output.slice(start + SPOKEN_BLOCK_START.length, end).trim();
  const full = `${output.slice(0, start)}${output.slice(end + SPOKEN_BLOCK_END.length)}`.trim();
  return { full, spoken: spoken.length > 0 ? spoken : undefined };
}

/**
 * 产出最终用于播报的文本：
 * 优先用模型给的口语稿（仍会过一遍确定性清洗与限长），
 * 没有则**确定性**地从完整结果转换。
 */
export function resolveSpokenText(output: string, options: SpokenTextOptions = {}): {
  readonly full: string;
  readonly spoken: string;
  readonly fromModel: boolean;
  readonly truncated: boolean;
} {
  const { full, spoken } = extractSpokenSummary(output);

  if (spoken !== undefined) {
    const cleaned = toSpokenText(spoken, options);
    if (cleaned.text.length > 0) {
      return { full, spoken: cleaned.text, fromModel: true, truncated: cleaned.truncated };
    }
  }

  const fallback = toSpokenText(full, options);
  return { full, spoken: fallback.text, fromModel: false, truncated: fallback.truncated };
}
