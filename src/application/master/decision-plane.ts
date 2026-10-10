/**
 * Master 决策平面（M4）：把「模型建议」变成「经校验的调度命令」。
 *
 * ## 为什么存在这一层
 * Master **只能提出意图**（SRS §2.1）：`MasterPort` 的返回值只能是文本，
 * 它没有任何写状态的通道。所有落地都必须经过本层逐动作校验后调用 Scheduler。
 *
 * ## 三条硬约束
 * 1. **不锁住世界等 LLM**：提示词用的是某一时刻的快照，但落地前用**当前**状态逐动作复核；
 * 2. **超时降级**：Master 超时 → 空计划，**不取消任何任务**（踩坑指南：超时 → 空计划）；
 * 3. **部分失效不牵连**：某个取消动作失效，不应丢掉计划内仍合法的启动动作。
 */
import type { WorldRevision } from "../../domain/decision/types.ts";
import type { Logger } from "../../observability/logger.ts";
import type { InteractionFocusStore } from "../interaction/focus.ts";
import type { TaskScheduler } from "../scheduler/scheduler.ts";
import type { MasterContextView, WorldModel } from "./context-view.ts";
import { parseMasterDecision } from "./decision-parser.ts";
import { validateDecision, type CompiledCommand, type RejectedAction } from "./decision-validator.ts";

/** Master 端口：**只有产出建议的能力，没有写状态的通道**。 */
export interface MasterPort {
  proposeDecision(request: MasterRequest): Promise<MasterProposal>;
}

export interface MasterRequest {
  readonly view: MasterContextView;
  /** 超时或取消时用于中止模型调用，避免遗留运行中的 Session。 */
  readonly signal?: AbortSignal;
}

export type MasterProposal =
  | { readonly status: "ok"; readonly rawText: string }
  | { readonly status: "timeout" }
  | { readonly status: "error"; readonly reason: string };

export interface AppliedAction {
  readonly type: string;
  readonly detail: string;
}

export type DecisionCycleStatus =
  | "applied"
  | "empty_plan"
  | "apply_failed"
  | "parse_failed"
  | "timeout"
  | "master_error";

export interface DecisionCycleResult {
  readonly decisionId: string | null;
  readonly status: DecisionCycleStatus;
  readonly applied: readonly AppliedAction[];
  readonly rejected: readonly RejectedAction[];
  readonly droppedActions: readonly string[];
  readonly stale: boolean;
  readonly missedEvents: boolean;
  readonly revisionAtDecision: WorldRevision;
  readonly revisionAtCommit: WorldRevision;
  readonly elapsedMs: number;
  /** 降级/失败时的人类可读说明（用于日志与面板）。 */
  readonly note: string | null;
}

export interface DecisionPlaneOptions {
  readonly master: MasterPort;
  readonly scheduler: TaskScheduler;
  readonly world: WorldModel;
  readonly focus: InteractionFocusStore;
  readonly timeoutMs: number;
  readonly now?: () => number;
  readonly logger?: Logger;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          resolve(onTimeout());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class MasterDecisionPlane {
  private readonly master: MasterPort;
  private readonly scheduler: TaskScheduler;
  private readonly world: WorldModel;
  private readonly focus: InteractionFocusStore;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly logger: Logger | undefined;

  public constructor(options: DecisionPlaneOptions) {
    this.master = options.master;
    this.scheduler = options.scheduler;
    this.world = options.world;
    this.focus = options.focus;
    this.timeoutMs = options.timeoutMs;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger;
  }

  /**
   * 跑一次完整决策周期。
   * `userInput` 会先计入 `eventSeq`（事件完整性），再构造快照。
   */
  public async decide(
    input: { readonly userInput?: string; readonly source?: string } = {},
  ): Promise<DecisionCycleResult> {
    if (input.userInput !== undefined) {
      this.world.ingestInput({ source: input.source ?? "user", text: input.userInput });
    }

    const view = this.world.buildView();
    const revisionAtDecision = view.revision;
    const startedAt = this.now();

    const controller = new AbortController();
    let proposal: MasterProposal;
    try {
      proposal = await withTimeout(
        this.master.proposeDecision(
          controller.signal === undefined ? { view } : { view, signal: controller.signal },
        ),
        this.timeoutMs,
        () => {
          controller.abort("master_timeout");
          return { status: "timeout" } as const;
        },
      );
    } catch (error) {
      proposal = { status: "error", reason: error instanceof Error ? error.message : String(error) };
    }

    const elapsedMs = this.now() - startedAt;

    // ---------- 降级路径：一律不改动任何状态 ----------
    if (proposal.status === "timeout") {
      return this.noOp(
        "timeout",
        revisionAtDecision,
        elapsedMs,
        `Master 超时（>${this.timeoutMs}ms）：按降级策略不执行任何动作，不猜测意图`,
      );
    }
    if (proposal.status === "error") {
      return this.noOp("master_error", revisionAtDecision, elapsedMs, `Master 调用失败：${proposal.reason}`);
    }

    const parsed = parseMasterDecision(proposal.rawText);
    if (parsed.status === "invalid") {
      return this.noOp(
        "parse_failed",
        revisionAtDecision,
        elapsedMs,
        `决策输出无法解析，已安全降级为不执行：${parsed.reason}`,
        [],
      );
    }

    // ---------- 用「当前」状态逐动作复核（而不是提示词时刻的快照）----------
    const currentRevision = this.world.revision();
    const validation = validateDecision(parsed.decision, {
      getTask: (taskId) => this.scheduler.getTask(taskId),
      currentRevision,
    });

    const applied: AppliedAction[] = [];
    for (const command of validation.accepted) {
      try {
        applied.push(await this.commit(command));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.warn("master.commit_failed", {
          decisionId: validation.decisionId,
          command: command.type,
          error: message,
        });
      }
    }

    const status: DecisionCycleStatus =
      applied.length > 0
        ? "applied"
        : validation.accepted.length > 0
          ? "apply_failed"
          : "empty_plan";

    const result: DecisionCycleResult = {
      decisionId: validation.decisionId,
      status,
      applied,
      rejected: validation.rejected,
      droppedActions: parsed.droppedActions,
      stale: validation.stale,
      missedEvents: validation.missedEvents,
      revisionAtDecision,
      revisionAtCommit: this.world.revision(),
      elapsedMs,
      note: null,
    };

    this.logger?.info("master.decision_cycle", {
      decisionId: result.decisionId,
      status: result.status,
      applied: applied.map((action) => action.type),
      rejected: validation.rejected.map((action) => ({ action: action.action.type, reason: action.reason })),
      droppedActions: parsed.droppedActions,
      stale: result.stale,
      missedEvents: result.missedEvents,
      elapsedMs,
      revisionAtDecision,
      revisionAtCommit: result.revisionAtCommit,
    });

    return result;
  }

  private noOp(
    status: DecisionCycleStatus,
    revisionAtDecision: WorldRevision,
    elapsedMs: number,
    note: string,
    droppedActions: readonly string[] = [],
  ): DecisionCycleResult {
    this.logger?.warn("master.decision_cycle_degraded", { status, note, elapsedMs });
    return {
      decisionId: null,
      status,
      applied: [],
      rejected: [],
      droppedActions,
      stale: false,
      missedEvents: false,
      revisionAtDecision,
      revisionAtCommit: this.world.revision(),
      elapsedMs,
      note,
    };
  }

  private async commit(command: CompiledCommand): Promise<AppliedAction> {
    switch (command.type) {
      case "start_task": {
        const outcome = this.scheduler.createTask({
          goal: command.goal,
          idempotencyKey: command.idempotencyKey,
          decisionId: command.decisionId,
          priority: command.priority,
        });
        if (outcome.status === "rejected") throw new Error(`创建任务被拒绝：${outcome.reason}`);
        return {
          type: "start_task",
          detail: `${outcome.status === "reused" ? "复用既有任务" : "创建任务"} ${outcome.task.taskId}（priority=${command.priority}）`,
        };
      }
      case "cancel_task": {
        const outcome = await this.scheduler.requestCancel(command.taskId, command.reason);
        if (outcome.status === "rejected") throw new Error(`取消被拒绝：${outcome.reason}`);
        return { type: "cancel_task", detail: `${command.taskId} → ${outcome.status}` };
      }
      case "set_focus": {
        const record = this.focus.set(command.taskId, {
          decisionId: command.decisionId,
          reason: `决策 ${command.decisionId} 建议焦点`,
        });
        return { type: "set_focus", detail: record.taskId ?? "(清空焦点)" };
      }
    }
  }
}
