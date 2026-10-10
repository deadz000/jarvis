/**
 * 交互焦点（SRS §4.2 的独立状态维度之一）。
 *
 * 刻意保持最小：焦点回答「用户当前关注什么」，**不决定其他任务是否停止**，
 * 也不与 Task 生命周期、结果交付、音频播放混用同一字段
 * （踩坑指南「架构债」：旧项目把内容路由与声音放行共用 `foreground_id`）。
 */
export interface FocusRecord {
  readonly taskId: string | null;
  readonly at: number;
  readonly decisionId?: string;
  readonly reason?: string;
}

export interface SetFocusMeta {
  readonly decisionId?: string;
  readonly reason?: string;
}

export class InteractionFocusStore {
  private current: FocusRecord | undefined;
  private readonly now: () => number;

  public constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  public get(): FocusRecord | undefined {
    return this.current;
  }

  public focusedTaskId(): string | null {
    return this.current?.taskId ?? null;
  }

  public set(taskId: string | null, meta: SetFocusMeta = {}): FocusRecord {
    const record: FocusRecord = {
      taskId,
      at: this.now(),
      ...(meta.decisionId === undefined ? {} : { decisionId: meta.decisionId }),
      ...(meta.reason === undefined ? {} : { reason: meta.reason }),
    };
    this.current = record;
    return record;
  }
}
