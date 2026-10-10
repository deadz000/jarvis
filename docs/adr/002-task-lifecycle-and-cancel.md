# ADR-002：Task / runGeneration / 状态转移与取消语义

- **状态**：已接受（2026-10-10）
- **关联**：需求规格说明书 §4.1、§4.3、§7.4；实施计划 M2 / M3 / §10
- **影响**：Scheduler、Worker Runtime Adapter、结果与交付层、后续恢复流程
- **实现位置**：`src/domain/task/`、`src/application/scheduler/`、`src/application/workers/ports.ts`

---

## 1. 背景

需求基线给出的是**候选**状态与转移（SRS §4.1），并要求「取消请求与任务自然完成/失败可能发生竞态，
最终规则需由执行适配层与 Scheduler 的契约确定」。M1 的实机结论（ADR-001 §3.2.1、§3.2.2）
进一步表明：**SDK 层面无法通过抛错或 `stopReason` 区分「被取消」与「真失败」**。
因此需要一份明确的契约，而不是把这些判断留在实现细节里。

---

## 2. 决定

### 2.1 状态集合与转移表（冻结）

| 状态 | 含义 |
|---|---|
| `queued` | 已接纳，等待并发槽位 |
| `running` | 某一代次执行中 |
| `cancel_requested` | 取消请求已送达执行层，**但尚未确认停止** |
| `succeeded` / `failed` / `cancelled` | 终态，不可再变更 |

合法转移（`src/domain/task/state-machine.ts`，以数据声明并被测试穷举验证）：

```
queued            → running | cancelled
running           → cancel_requested | succeeded | failed
cancel_requested  → cancelled | succeeded | failed
succeeded | failed | cancelled → （无）
```

- 除 `queued` 外，任何状态都不能再次进入 `running` —— 防止同一 Task 重复执行。
- 非法转移**抛错**（`IllegalTaskTransitionError`），不静默忽略。

### 2.2 TaskId 与 runGeneration 分离

- `TaskId` 标识「目标」；`runGeneration` 标识「该目标的一次具体执行」，从 1 递增，`0` 表示尚未执行。
- 每次准入（`queued → running`）分配新代次。
- **代次是事件准入的硬门槛**：`event.runGeneration !== task.runGeneration` 的事件一律拒绝，
  不修改任何状态，只记 `worker_event_rejected`（reason=`stale_generation`）。
- 终态任务收到任何事件（含同代次的迟到进度、重复完成事件）也一律拒绝（reason=`task_terminal`）。

### 2.3 取消的三层语义

| 层 | 信号 | 含义 |
|---|---|---|
| 1. 请求已送达 | `handle.cancel(reason)` resolve | 执行层**收到**取消请求 |
| 2. 协同中止 | `request.signal` 被 abort | Worker 内部工具能观察到取消 |
| 3. 已确认停止 | `worker_cancelled` 事件 | Scheduler **才**提交 `cancelled` |

关键是第 1 层不等于第 3 层：只有执行层确认停止，才允许提交 `cancelled`；
执行层若无法停止，必须改报 `worker_succeeded` / `worker_failed`，**不得伪装成成功取消**（SRS §7.4）。
`handle.cancel()` 抛错时，任务停在 `cancel_requested`，并记 `task_cancel_request_failed`，
**不假装已取消**。

### 2.4 取消与完成的竞态

`cancel_requested` 状态下收到 `succeeded`/`failed`：**按真实结果提交**，
并在事件里标记 `detail.cancelRaced = true`。终态之后到达的取消请求被幂等拒绝（`already_terminal`）。

配套的适配层规则（`src/adapters/pi/session-outcome.ts`）：
- 已发出取消请求时，SDK 的 `stopReason: "error"` 判定为 **`cancelled`** 而非 `failed`；
- 但若最终仍正常产出正文并正常收尾，则判定为 **`succeeded`**（取消输给了完成）。

### 2.5 单一写入口

所有 Task 状态变更只能经 `TaskScheduler`。Worker 事件只是事实；
`WorkerRuntime` 端口没有「设置状态」能力，从类型上排除 Worker 越权。

### 2.6 准入与并发

- 并发上限 `maxConcurrent` **必填且必须 ≥ 1**，非法值构造即抛错（不静默用默认值）。
- 数值来自配置 `JARVIS_MAX_CONCURRENT_TASKS`（默认 4），**不沿用旧项目的历史数值**。
- 队列 FIFO；任务终态时释放槽位并自动放行队首。
- 取消 `queued` 任务会将它移出队列（直接 `queued → cancelled`），不浪费一次执行。
- 队列中的任务若已被取消或已终态，准入时跳过而不是静默启动。

### 2.7 幂等与有界视图

- `idempotencyKey`：相同键重复创建返回既有任务（`status: "reused"`），不新建、不重复执行 ——
  这是 M4「重复决策不重复启动 Task」的基础。
- 完成事件重复到达不会二次提交（`task_terminal` 拒绝），结果字段不被覆盖。
- `listActiveTasks(limit)` 默认上限 5，按最近活动倒序 —— 落实「面向 LLM 的视图必须有界」。

---

## 3. 实机依据（为什么这样定）

| 观察 | 影响 |
|---|---|
| `abort()` 后 `prompt()` **resolve** 而非 reject（实测 abort 耗时 2ms） | 不能靠异常判断取消 |
| `abort()` 后 assistant 终态 `stopReason = "error"`，`errorMessage = "This operation was aborted"` | 与真实 provider 错误同形，**必须靠「谁发起了取消」区分** |
| 自定义工具 `execute(..., signal)` 在 abort 后 **1231ms** 观察到信号 | 取消确实能到达工具执行层（FR-07 核心要求成立） |
| 事件流含 `tool_execution_start` / `tool_execution_end` / `queue_update` | 工具事件可被 Worker 适配器关联到 `taskId` + `runGeneration` |

以上数据来自 `npm run example:abort`（`examples/sdk/02-abort-and-tools.ts`）。

---

## 4. 代价与已知限制（不对未实现的能力作任何声明）

| 项 | 现状 |
|---|---|
| 代次前进的生产路径 | 目前只有「准入」会递增代次。真正会让旧代次变旧的重试/恢复流程属 **M7**；届时代次门槛已就位，但**尚未经生产路径验证** |
| 取消超时看门狗 | **未实现**。执行层若既不确认停止也不报终态，任务会长期停在 `cancel_requested`（计划中的 watchdog 属 M7） |
| 不可逆副作用表达 | **未实现**。当前只有「停止确认」与「报真实终态」两种表达，没有副作用回滚语义 |
| 优先级与饥饿防护 | **未实现**。只有 FIFO + 并发上限，无优先级、无抢占、无饥饿保护（SRS 待决策项 3） |
| 结果持久化与交付 | **未实现**（M5）。`resultSummary` 只在内存 |
| Master 决策校验 | **未实现**（M4）。Scheduler 目前接受直接命令，逐动作校验与 revision 校验尚未建立 |
| 真实 Pi Worker | **未接入**。M2 端口已定义并有 FakeWorker 测试；真实适配器需在 M2 后半段实现 |

---

## 5. 验证方式

| 证据 | 结果 |
|---|---|
| 状态机穷举测试（7 项合法转移 vs 全部 36 种组合） | ✅ `tests/unit/task-state-machine.test.ts` |
| M3 要求的 7 个必备场景 + 幂等/边界场景，FakeWorker 驱动、**不调用 LLM** | ✅ `tests/unit/scheduler.test.ts`（18 项） |
| 取消分类（含 abort 的特殊性） | ✅ `tests/unit/session-outcome.test.ts`（11 项） |
| 全套测试与类型检查 | ✅ 50+ 项通过、`tsc --noEmit` 干净 |

---

## 6. 重新评估条件

1. M1 真实适配器发现 `abort()` 无法中止特定工具，需要引入「不可取消」的显式状态；
2. M4 的决策校验需要 revision 维度，从而改变代次/状态门槛的含义；
3. M7 的恢复流程需要跨进程重建代次，必须重新定义代次的持久化语义；
4. 实测证明 FIFO 准入会造成不可接受的饥饿，需要引入优先级。
