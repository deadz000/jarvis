/**
 * SQLite 持久化适配器（Node 内置 `node:sqlite`，**零新增依赖**）。
 *
 * ## 为什么用内置模块
 * 实施计划要求「先不在 PoC 阶段引入额外数据库基础设施」。
 * Node 24 自带 `node:sqlite`，实测可用（`DatabaseSync` + 预编译语句），
 * 因此不需要 better-sqlite3 这类原生依赖。
 *
 * ## 已知代价（必须记住）
 * 1. `node:sqlite` 目前是**实验性 API**，会打印 `ExperimentalWarning`，未来可能变；
 * 2. 它是**同步 API** —— 写操作会阻塞事件循环。本项目的写入是任务级低频
 *    （状态变化、决策、摘要），可以接受；**不适合高频逐 token 写入**，
 *    因此这里刻意不持久化逐 token 文本与音频分片。
 *
 * ## 恢复语义
 * 启动时调用 `markInterruptedAsUnknown()`：把上次未终结的任务标为"结果未知"。
 * 它**不会**重跑任何东西 —— 计划明确要求不得假设重启前的工具已停止、
 * 不得盲目重跑可能有副作用的操作。
 */
import { DatabaseSync } from "node:sqlite";

import type {
  MemoryEntry,
  MemoryKind,
  MemoryQuery,
  PersistedDecision,
  PersistedTask,
  PersistedTaskEvent,
  PersistencePort,
  TaskHistoryQuery,
} from "../../application/storage/store-port.ts";
import { TERMINAL_TASK_STATES } from "../../application/storage/store-port.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id          TEXT PRIMARY KEY,
  goal             TEXT NOT NULL,
  state            TEXT NOT NULL,
  run_generation   INTEGER NOT NULL,
  priority         TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  terminal_at      INTEGER,
  last_activity_at INTEGER NOT NULL,
  result_summary   TEXT,
  spoken_summary   TEXT,
  failure_reason   TEXT,
  cancel_reason    TEXT,
  decision_id      TEXT,
  idempotency_key  TEXT UNIQUE,
  recovery_status  TEXT,
  recovered_at     INTEGER,
  recovery_note    TEXT,
  replayed_at      INTEGER,
  replay_task_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);

CREATE TABLE IF NOT EXISTS task_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT NOT NULL,
  type           TEXT NOT NULL,
  state          TEXT,
  at             INTEGER NOT NULL,
  run_generation INTEGER,
  detail         TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, seq);

CREATE TABLE IF NOT EXISTS decision_trace (
  decision_id      TEXT PRIMARY KEY,
  mode             TEXT NOT NULL,
  status           TEXT NOT NULL,
  at               INTEGER NOT NULL,
  elapsed_ms       INTEGER NOT NULL,
  applied          TEXT NOT NULL,
  rejected         TEXT NOT NULL,
  dropped          TEXT NOT NULL,
  note             TEXT,
  event_seq        INTEGER,
  control_revision INTEGER
);

CREATE INDEX IF NOT EXISTS idx_decisions_at ON decision_trace(at);

CREATE TABLE IF NOT EXISTS semantic_memory (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  text       TEXT NOT NULL,
  at         INTEGER NOT NULL,
  source_ref TEXT,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memory_kind_at ON semantic_memory(kind, at);
`;

export interface SqliteStoreOptions {
  /** 数据库文件路径；`:memory:` 表示内存库（测试用）。 */
  readonly path: string;
}

interface TaskRowShape {
  readonly task_id: string;
  readonly goal: string;
  readonly state: string;
  readonly run_generation: number;
  readonly priority: string;
  readonly created_at: number;
  readonly started_at: number | null;
  readonly terminal_at: number | null;
  readonly last_activity_at: number;
  readonly result_summary: string | null;
  readonly spoken_summary: string | null;
  readonly failure_reason: string | null;
  readonly cancel_reason: string | null;
  readonly decision_id: string | null;
  readonly idempotency_key: string | null;
  readonly recovery_status: string | null;
  readonly recovered_at: number | null;
  readonly recovery_note: string | null;
  readonly replayed_at: number | null;
  readonly replay_task_id: string | null;
}

export class SqliteStore implements PersistencePort {
  private readonly db: DatabaseSync;

  public constructor(options: SqliteStoreOptions) {
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.setMeta("schema_version", "1");
  }

  public saveTask(task: PersistedTask): void {
    this.db
      .prepare(
        `INSERT INTO tasks (
           task_id, goal, state, run_generation, priority, created_at, started_at, terminal_at,
           last_activity_at, result_summary, spoken_summary, failure_reason, cancel_reason,
           decision_id, idempotency_key, recovery_status, recovered_at, recovery_note,
           replayed_at, replay_task_id
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET
           goal=excluded.goal,
           state=excluded.state,
           run_generation=excluded.run_generation,
           priority=excluded.priority,
           started_at=excluded.started_at,
           terminal_at=excluded.terminal_at,
           last_activity_at=excluded.last_activity_at,
           result_summary=excluded.result_summary,
           spoken_summary=excluded.spoken_summary,
           failure_reason=excluded.failure_reason,
           cancel_reason=excluded.cancel_reason,
           decision_id=excluded.decision_id,
           recovery_status=excluded.recovery_status,
           recovered_at=excluded.recovered_at,
           recovery_note=excluded.recovery_note,
           replayed_at=excluded.replayed_at,
           replay_task_id=excluded.replay_task_id`,
      )
      .run(
        task.taskId,
        task.goal,
        task.state,
        task.runGeneration,
        task.priority,
        task.createdAt,
        task.startedAt,
        task.terminalAt,
        task.lastActivityAt,
        task.resultSummary,
        task.spokenSummary,
        task.failureReason,
        task.cancelReason,
        task.decisionId,
        task.idempotencyKey,
        task.recoveryStatus,
        task.recoveredAt,
        task.recoveryNote,
        task.replayedAt,
        task.replayTaskId,
      );
  }

  public appendTaskEvent(event: PersistedTaskEvent): void {
    this.db
      .prepare(
        `INSERT INTO task_events (task_id, type, state, at, run_generation, detail)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(event.taskId, event.type, event.state, event.at, event.runGeneration, event.detail);
  }

  public saveDecision(decision: PersistedDecision): void {
    this.db
      .prepare(
        `INSERT INTO decision_trace (
           decision_id, mode, status, at, elapsed_ms, applied, rejected, dropped, note,
           event_seq, control_revision
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(decision_id) DO UPDATE SET
           status=excluded.status,
           elapsed_ms=excluded.elapsed_ms,
           applied=excluded.applied,
           rejected=excluded.rejected,
           dropped=excluded.dropped,
           note=excluded.note`,
      )
      .run(
        decision.decisionId,
        decision.mode,
        decision.status,
        decision.at,
        decision.elapsedMs,
        JSON.stringify(decision.applied),
        JSON.stringify(decision.rejected),
        JSON.stringify(decision.dropped),
        decision.note,
        decision.eventSeq,
        decision.controlRevision,
      );
  }

  public getTask(taskId: string): PersistedTask | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as
      | TaskRowShape
      | undefined;
    return row === undefined ? undefined : toPersistedTask(row);
  }

  public listTasks(query: TaskHistoryQuery = {}): readonly PersistedTask[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (query.states !== undefined && query.states.length > 0) {
      conditions.push(`state IN (${query.states.map(() => "?").join(",")})`);
      params.push(...query.states);
    }
    if (query.onlyUnknownRecovery === true) {
      conditions.push("recovery_status IS NOT NULL");
    }

    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const limit = query.limit ?? 50;
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as unknown as TaskRowShape[];

    return rows.map(toPersistedTask);
  }

  public findNonTerminalTasks(): readonly PersistedTask[] {
    const placeholders = TERMINAL_TASK_STATES.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE state NOT IN (${placeholders}) ORDER BY created_at`)
      .all(...TERMINAL_TASK_STATES) as unknown as TaskRowShape[];
    return rows.map(toPersistedTask);
  }

  public listTaskEvents(taskId: string, limit = 200): readonly PersistedTaskEvent[] {
    const rows = this.db
      .prepare(
        `SELECT task_id, type, state, at, run_generation, detail
           FROM task_events WHERE task_id = ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(taskId, limit) as unknown as Array<{
      readonly task_id: string;
      readonly type: string;
      readonly state: string | null;
      readonly at: number;
      readonly run_generation: number | null;
      readonly detail: string | null;
    }>;

    return rows.map((row) => ({
      taskId: row.task_id,
      type: row.type,
      state: row.state,
      at: row.at,
      runGeneration: row.run_generation,
      detail: row.detail,
    }));
  }

  public listDecisions(limit = 50): readonly PersistedDecision[] {
    const rows = this.db
      .prepare(
        `SELECT decision_id, mode, status, at, elapsed_ms, applied, rejected, dropped, note,
                event_seq, control_revision
           FROM decision_trace ORDER BY at DESC LIMIT ?`,
      )
      .all(limit) as unknown as Array<{
      readonly decision_id: string;
      readonly mode: string;
      readonly status: string;
      readonly at: number;
      readonly elapsed_ms: number;
      readonly applied: string;
      readonly rejected: string;
      readonly dropped: string;
      readonly note: string | null;
      readonly event_seq: number | null;
      readonly control_revision: number | null;
    }>;

    return rows.map((row) => ({
      decisionId: row.decision_id,
      mode: row.mode,
      status: row.status,
      at: row.at,
      elapsedMs: row.elapsed_ms,
      applied: parseJsonArray(row.applied),
      rejected: parseJsonArray(row.rejected),
      dropped: parseJsonArray(row.dropped),
      note: row.note,
      eventSeq: row.event_seq,
      controlRevision: row.control_revision,
    }));
  }

  public markInterruptedAsUnknown(at: number, note: string): number {
    const placeholders = TERMINAL_TASK_STATES.map(() => "?").join(",");
    const result = this.db
      .prepare(
        `UPDATE tasks
            SET recovery_status = 'unknown', recovered_at = ?, recovery_note = ?
          WHERE state NOT IN (${placeholders}) AND recovery_status IS NULL`,
      )
      .run(at, note, ...TERMINAL_TASK_STATES);

    return Number(result.changes);
  }

  public markReplayed(taskId: string, newTaskId: string, at: number): void {
    this.db
      .prepare("UPDATE tasks SET replayed_at = ?, replay_task_id = ? WHERE task_id = ?")
      .run(at, newTaskId, taskId);
  }

  public appendMemory(entry: Omit<MemoryEntry, "id">): void {
    this.db
      .prepare("INSERT INTO semantic_memory (kind, text, at, source_ref, expires_at) VALUES (?,?,?,?,?)")
      .run(entry.kind, entry.text, entry.at, entry.sourceRef, entry.expiresAt);
  }

  public queryMemory(query: MemoryQuery = {}): readonly MemoryEntry[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (query.kind !== undefined) {
      conditions.push("kind = ?");
      params.push(query.kind);
    }
    if (query.since !== undefined) {
      conditions.push("at >= ?");
      params.push(query.since);
    }

    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.db
      .prepare(`SELECT id, kind, text, at, source_ref, expires_at FROM semantic_memory ${where} ORDER BY at DESC LIMIT ?`)
      .all(...params, query.limit ?? 20) as unknown as Array<{
      readonly id: number;
      readonly kind: string;
      readonly text: string;
      readonly at: number;
      readonly source_ref: string | null;
      readonly expires_at: number | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as MemoryKind,
      text: row.text,
      at: row.at,
      sourceRef: row.source_ref,
      expiresAt: row.expires_at,
    }));
  }

  public pruneMemory(before: number): number {
    const result = this.db.prepare("DELETE FROM semantic_memory WHERE at < ?").run(before);
    return Number(result.changes);
  }

  public pruneTasks(before: number): number {
    const placeholders = TERMINAL_TASK_STATES.map(() => "?").join(",");
    const doomed = this.db
      .prepare(
        `SELECT task_id FROM tasks WHERE terminal_at IS NOT NULL AND terminal_at < ? AND state IN (${placeholders})`,
      )
      .all(before, ...TERMINAL_TASK_STATES) as unknown as Array<{ readonly task_id: string }>;

    if (doomed.length === 0) return 0;

    const deleteEvents = this.db.prepare("DELETE FROM task_events WHERE task_id = ?");
    const deleteTask = this.db.prepare("DELETE FROM tasks WHERE task_id = ?");
    for (const row of doomed) {
      deleteEvents.run(row.task_id);
      deleteTask.run(row.task_id);
    }
    return doomed.length;
  }

  public close(): void {
    this.db.close();
  }

  public getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key) as
      | { readonly value: string }
      | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO schema_meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }
}

function parseJsonArray(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function toPersistedTask(row: TaskRowShape): PersistedTask {
  return {
    taskId: row.task_id,
    goal: row.goal,
    state: row.state,
    runGeneration: row.run_generation,
    priority: row.priority,
    createdAt: row.created_at,
    startedAt: row.started_at,
    terminalAt: row.terminal_at,
    lastActivityAt: row.last_activity_at,
    resultSummary: row.result_summary,
    spokenSummary: row.spoken_summary,
    failureReason: row.failure_reason,
    cancelReason: row.cancel_reason,
    decisionId: row.decision_id,
    idempotencyKey: row.idempotency_key,
    recoveryStatus: row.recovery_status === null ? null : "unknown",
    recoveredAt: row.recovered_at,
    recoveryNote: row.recovery_note,
    replayedAt: row.replayed_at,
    replayTaskId: row.replay_task_id,
  };
}
