/**
 * 持久化端口（M7；SRS FR-11 / FR-12）。
 *
 * ## 一个关键设计决定：把「重启恢复」做成**独立维度**，而不是新状态
 * 重启后发现某任务上次处于 `running`，该怎么解释它？两个选项：
 * - A. 在任务状态机里加一个 `interrupted_unknown` 状态；
 * - B. 保持实时状态机不变，另加**恢复维度**（`recovery_status`）。
 *
 * 选 B，理由与 ADR-003 的 `eventSeq` / `controlRevision` 两维版本号同源：
 * **「任务此刻在什么状态」与「重启后我们如何解释它」是两个不同的问题**。
 * 掺进状态机会污染已被 ADR-002 冻结、且有 24 项穷举测试的生命周期语义，
 * 而且状态机描述的是**本进程内**的生命周期 —— 重启后那个进程已经不存在了。
 *
 * ## 安全底线（计划 M7 明确要求）
 * - 不得假设进程重启前的工具已停止；
 * - 不得盲目重跑可能有副作用的操作；
 * - 因此本端口**没有**「自动恢复」方法，只有「标记未知」与「显式重放」。
 */

export type RecoveryStatus = "unknown";

/** 持久化的任务记录（字段与实时 TaskRecord 对齐，另加恢复维度）。 */
export interface PersistedTask {
  readonly taskId: string;
  readonly goal: string;
  /** 上次已知状态（重启前）。 */
  readonly state: string;
  readonly runGeneration: number;
  readonly priority: string;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly terminalAt: number | null;
  readonly lastActivityAt: number;
  readonly resultSummary: string | null;
  readonly spokenSummary: string | null;
  readonly failureReason: string | null;
  readonly cancelReason: string | null;
  readonly decisionId: string | null;
  readonly idempotencyKey: string | null;
  /** 恢复维度：非空表示"重启时发现它未终结，真实结果未知"。 */
  readonly recoveryStatus: RecoveryStatus | null;
  readonly recoveredAt: number | null;
  readonly recoveryNote: string | null;
  /** 显式重放的时间与产生的新任务（用于追溯，不作为自动行为）。 */
  readonly replayedAt: number | null;
  readonly replayTaskId: string | null;
}

export interface PersistedTaskEvent {
  readonly taskId: string;
  readonly type: string;
  readonly state: string | null;
  readonly at: number;
  readonly runGeneration: number | null;
  readonly detail: string | null;
}

export interface PersistedDecision {
  readonly decisionId: string;
  readonly mode: string;
  readonly status: string;
  readonly at: number;
  readonly elapsedMs: number;
  readonly applied: readonly string[];
  readonly rejected: readonly string[];
  readonly dropped: readonly string[];
  readonly note: string | null;
  readonly eventSeq: number | null;
  readonly controlRevision: number | null;
}

/**
 * 语义记忆条目。
 *
 * `sourceRef` 是 SRS 要求的「可追溯来源」落点 —— 记忆必须能说明它是从哪来的，
 * 否则模型会把摘要当成无来源的断言使用。
 */
export type MemoryKind = "dialogue" | "screen" | "task" | "note";

export interface MemoryEntry {
  readonly id: number;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly at: number;
  /** 可追溯来源（例如 `task:task-3` / `screen:summary-12` / `dialogue:turn-5`）。 */
  readonly sourceRef: string | null;
  readonly expiresAt: number | null;
}

export interface MemoryQuery {
  readonly kind?: MemoryKind;
  readonly limit?: number;
  /** 只取 `at >= since` 的条目。 */
  readonly since?: number;
}

export interface TaskHistoryQuery {
  readonly limit?: number;
  /** 只取这些状态；省略表示全部。 */
  readonly states?: readonly string[];
  /** 只取恢复维度非空的（重启后结果未知的）。 */
  readonly onlyUnknownRecovery?: boolean;
}

export interface PersistencePort {
  saveTask(task: PersistedTask): void;
  /** 记录任务事件；供"从事件重建时间线"使用。 */
  appendTaskEvent(event: PersistedTaskEvent): void;
  saveDecision(decision: PersistedDecision): void;

  getTask(taskId: string): PersistedTask | undefined;
  listTasks(query?: TaskHistoryQuery): readonly PersistedTask[];
  /** 未终结的任务 —— 启动时的核对对象。 */
  findNonTerminalTasks(): readonly PersistedTask[];

  /** 任务事件（用于"从事件重建时间线"，计划 M8 要求指标可重算）。 */
  listTaskEvents(taskId: string, limit?: number): readonly PersistedTaskEvent[];
  /** 决策轨迹（含被拒/被丢弃的动作，用于复盘）。 */
  listDecisions(limit?: number): readonly PersistedDecision[];

  /**
   * 把上次未终结的任务标记为「结果未知」。返回被标记的条数。
   * **只做标记，不做任何重跑**。
   */
  markInterruptedAsUnknown(at: number, note: string): number;

  /** 显式重放：记录"这个未知任务被重新提交为 newTaskId"。 */
  markReplayed(taskId: string, newTaskId: string, at: number): void;

  appendMemory(entry: Omit<MemoryEntry, "id">): void;
  queryMemory(query?: MemoryQuery): readonly MemoryEntry[];
  pruneMemory(before: number): number;

  /** 数据保留：删除早于 `before` 的已终结任务及其事件。 */
  pruneTasks(before: number): number;

  close(): void;
}

/** 判断任务状态是否已经终结（用于恢复核对）。 */
export const TERMINAL_TASK_STATES: readonly string[] = ["succeeded", "failed", "cancelled"];
