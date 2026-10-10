/**
 * 屏幕意图门控：**让纯文字指令零成本**。
 *
 * ## 问题
 * 如果每次 Master 调用都带上屏幕摘要，那么"帮我写个函数"这类
 * 与屏幕无关的指令也会白白多花输入 token，还可能被无关上下文干扰。
 *
 * ## 做法
 * 用一个**确定性**的门控判断"这条输入是否与屏幕有关"：
 * - 命中屏幕指代词（"这个/那个/屏幕上/这里/刚才那个/画面"等）→ 注入屏幕上下文；
 * - 否则 → **完全不注入**，纯文字指令的提示词里屏幕 token 数为 0。
 *
 * ## 诚实标注
 * 这是**基于关键词的启发式**，不是语义判断。它会漏（用户用别的说法指屏幕）
 * 也会误（"这个方案"可能指屏幕上的东西）。选择用启发式而不是让模型判断，
 * 是因为后者必须先注入上下文才能判断——那就已经产生成本了，自相矛盾。
 * 关键词表可配置，后续应根据真实使用数据调整。
 */
export const DEFAULT_SCREEN_REFERENCE_WORDS: readonly string[] = [
  "屏幕",
  "画面",
  "截屏",
  "图表",
  "这个",
  "那个",
  "这张",
  "那张",
  "这里",
  "那里",
  "上面",
  "刚才那",
  "看到",
  "看图",
  "看一下这个",
  "报错",
  "弹窗",
];

export interface ScreenIntentGateOptions {
  readonly referenceWords?: readonly string[];
  /** 屏幕观察开启时是否**总是**注入（关闭门控，用于调试或明确需要时）。 */
  readonly alwaysInclude?: boolean;
}

export interface ScreenIntentDecision {
  readonly include: boolean;
  readonly reason: string;
  readonly matched: readonly string[];
}

export function evaluateScreenIntent(
  userInput: string,
  options: ScreenIntentGateOptions = {},
): ScreenIntentDecision {
  if (options.alwaysInclude === true) {
    return { include: true, reason: "已关闭门控：总是注入屏幕上下文", matched: [] };
  }

  const words = options.referenceWords ?? DEFAULT_SCREEN_REFERENCE_WORDS;
  const text = userInput.toLowerCase();
  const matched = words.filter((word) => text.includes(word.toLowerCase()));

  if (matched.length > 0) {
    return {
      include: true,
      reason: `命中屏幕指代词：${matched.join("、")}`,
      matched,
    };
  }

  return {
    include: false,
    reason: "纯文字指令：不注入屏幕上下文（零 token 成本）",
    matched: [],
  };
}
