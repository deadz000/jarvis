/**
 * 对话历史（M5 首版：内存、有界）。
 *
 * ## 为什么需要它
 * 在此之前 Master 每次决策都是**新建一次性 Session 并 dispose**，
 * 它看不到自己上一轮做过什么决策 —— 用户问"为什么"时答不上来。
 * 但也不能让 Master 直接复用持久化 Session：那会无界增长，
 * 违反「面向 LLM 的视图必须有界」。
 *
 * 因此：把对话历史做成**有界的内存记录**，作为 Master 请求的一部分显式传入。
 *
 * ## 一个用户 turn 只记一次
 * 旧项目的经验（`TaskJournal`）要求「一个用户 turn 只记一次」，
 * 否则一次输入会因多次决策/多次交付而被重复记账。
 * 这里由调用方保证：`appendUserTurn()` 每个用户输入只调用一次，
 * 系统的决策与交付摘要另记为 `system` 条目。
 *
 * ## 边界（不要误解它的能力）
 * - 它**不是**长期记忆：不跨进程、不跨会话、不持久化（M7）；
 * - 它**不是**语义检索：只是最近若干条的有序记录。
 */

export interface DialogueEntry {
  readonly at: number;
  readonly role: "user" | "system";
  readonly text: string;
}

/** 默认保留 40 条（约 10 轮对话）。 */
export const DEFAULT_MAX_DIALOGUE_ENTRIES = 40;

export interface DialogueHistoryOptions {
  readonly maxEntries?: number;
  readonly now?: () => number;
}

export class DialogueHistory {
  private readonly entries: DialogueEntry[] = [];
  private readonly maxEntries: number;
  private readonly now: () => number;

  public constructor(options: DialogueHistoryOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_DIALOGUE_ENTRIES;
    this.now = options.now ?? (() => Date.now());
    if (this.maxEntries < 1) throw new RangeError(`maxEntries 必须 >= 1，收到：${this.maxEntries}`);
  }

  /** 记录一次用户输入。**每个用户 turn 只调用一次。** */
  public appendUserTurn(text: string): DialogueEntry {
    return this.append("user", text);
  }

  /** 记录系统侧发生了什么（决策摘要、交付摘要、取消等）。 */
  public appendSystem(text: string): DialogueEntry {
    return this.append("system", text);
  }

  public append(role: DialogueEntry["role"], text: string): DialogueEntry {
    const entry: DialogueEntry = { at: this.now(), role, text };
    this.entries.push(entry);
    while (this.entries.length > this.maxEntries) this.entries.shift();
    return entry;
  }

  /** 最近若干条（默认全部保留的条目），按时间正序。 */
  public recent(limit?: number): readonly DialogueEntry[] {
    if (limit === undefined) return [...this.entries];
    return this.entries.slice(Math.max(0, this.entries.length - limit));
  }

  public get size(): number {
    return this.entries.length;
  }

  public clear(): void {
    this.entries.length = 0;
  }
}
