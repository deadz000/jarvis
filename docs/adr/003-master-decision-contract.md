# ADR-003：MasterDecision 契约、版本快照与逐动作校验

- **状态**：已接受（2026-10-10）
- **关联**：需求规格说明书 §3.3、§4.2、§11.4；实施计划 M4；ADR-002；《决策清单_v0.1》表 3 项 A–D
- **影响**：Master 适配器、决策平面、Scheduler、后续交付策略（M5）与恢复（M7）
- **实现位置**：`src/domain/decision/`、`src/application/master/`、`src/adapters/pi/pi-master.ts`

---

## 1. 背景

M4 要冻结的是「Master 如何提出建议、系统如何确认建议仍然有效」。
需求基线把 `Master` 定义为**只提出建议**（SRS §2.1），并把决策契约列为待决策项（§11.4）。
踩坑指南第 4、5 条给出了方向性结论，但最终维度与严格度由《决策清单 v0.1》表 3 明确选定。

---

## 2. 决定

### 2.1 两维版本号（决策清单项 A）

| 维度 | 递增时机 | 作用 |
|---|---|---|
| `eventSeq` | 每收到一个输入事件（chat / 语音 / 屏幕 / 外部） | **事件完整性**：落后说明模型没看到某些输入，建议重同步；**不使决策过期** |
| `controlRevision` | 仅在**合法决策集合可能改变**时（任务创建、准入、取消请求、终态、启动失败） | **判定决策是否过期** |

分界线由 `isControlChangingEvent()` 明确声明并被测试固定：**遥测类事件
（`task_progress`、`task_tool_call`、`task_cancel_request_failed`、`worker_event_rejected`）
不递增 `controlRevision`**。

这条分界正是踩坑指南第 5 条要解决的问题：旧项目把「信息变新」与「合法操作集合改变」
混为一个 revision，导致要么决策永远过期，要么新发言被旧决策覆盖。

### 2.2 决策 Schema

```ts
interface MasterDecision {
  decisionId: string;
  basedOn: { eventSeq: number; controlRevision: number };
  actions: DecisionAction[];        // 可以为空 = 什么都不做
  rationale?: string;
}
```

三类动作：

| 动作 | 关键字段 | 落地前的前置条件 |
|---|---|---|
| `start_task` | `goal`、`priority` | 无世界前置条件（世界变新不会使其失效） |
| `cancel_task` | `taskId`、`expectedGeneration?` | 任务存在、非终态、非已请求取消、代次匹配 |
| `set_focus` | `taskId` 或 `null` | 任务存在（`null` 表示清空焦点） |

`priority` 取 `low` / `normal` / `high` / `urgent`，**当前只记录、不参与抢占、不影响准入顺序**（决策清单项 C）。

### 2.3 解析与业务校验分离（决策清单项 B）

**输出通道**：提示词要求 JSON + 严格解析。**不依赖** provider 的 `response_format`
等特性，因此在任意 OpenAI 兼容端点上可复现、可单测。

**三条降级路径**（安全方向各不相同）：

| 情况 | 处理 | 理由 |
|---|---|---|
| JSON 无法解析 / 顶层结构非法 / 缺 `decisionId` 或 `basedOn` | **整体判 `invalid`，不执行任何动作** | 无法确认意图时，宁可不做 |
| 单个动作形状非法（缺字段 / 类型错 / 未知动作类型） | **只丢弃该动作**，保留其余合法动作并记录原因 | 一个畸形动作不应作废整个计划 |
| `actions` 为空数组 | 合法的「什么都不做」 | 空计划是正常结果 |

### 2.4 逐动作校验，而不是整体 revision 拒绝

执行时刻读取**当前**状态逐条校验，而不是信任提示词时刻的快照，也不是整体拒绝过期决策：

- 某个取消动作因目标已完成 / 已换代而失效时，**同一决策中仍合法的独立启动动作继续执行**；
- `expectedGeneration` 是防止「过期决策误取消已重启任务」的关键前置条件；
- 决策结果显式区分 `stale`（`controlRevision` 落后）与 `missedEvents`（`eventSeq` 落后），
  供后续重同步策略使用。

这落实了踩坑指南铁律：「**绝不能锁住世界等 LLM**；正确性靠逐命令引用校验」。

### 2.5 幂等

启动动作的幂等键为 `${decisionId}:start:${动作下标}`。
同一决策重复执行时，`createTask` 返回既有任务（`status: "reused"`），**不重复建任务、不重复执行**。

### 2.6 超时降级

Master 超时 → **空计划**，不改动任何状态，不猜测意图。
超时同时通过 `AbortSignal` 中止模型调用，避免遗留运行中的 Session。
超时值由 `JARVIS_MASTER_TIMEOUT_MS` 配置，**默认 30s 是暂定值，必须按实测延迟重新标定**。

### 2.7 Master 没有写状态的通道

`MasterPort` 的唯一返回类型是「文本」或「超时/错误」。它无法调用 Scheduler、
无法构造 `TaskRecord`、无法改任何状态。所有落地都发生在 `MasterDecisionPlane`
逐动作校验之后 —— 这在类型层面排除越权，而不是靠约定。

---

## 3. 实机依据

`npm run example:master`（真实 `cf-fan/deepseek-flash`，2.5s）：

```json
{
  "decisionId": "dec-1-4-cancel-weather-focus-git",
  "basedOn": { "eventSeq": 1, "controlRevision": 4 },
  "rationale": "用户要求取消天气查询任务，继续 Git 分析并将焦点切换到 Git 任务。",
  "actions": [
    { "type": "cancel_task", "taskId": "task-1", "expectedGeneration": 1, "reason": "用户明确要求取消天气查询" },
    { "type": "set_focus", "taskId": "task-2" }
  ]
}
```

- 模型**正确回填了** `basedOn` 与 `expectedGeneration`，说明「要求回填快照版本」在真实模型上可行；
- 输出带 ```json 围栏，解析器的围栏提取路径被真实触发；
- 落地结果：`task-1 → cancel_requested`、焦点 `task-2`、无关任务不受影响；
- 修订号 `controlRevision` 4 → 5（提交动作本身改变了合法决策集合）。

---

## 4. 代价与已知限制

| 项 | 现状 |
|---|---|
| 优先级与抢占 | `priority` 只记录。**未启用抢占**，准入仍为 FIFO（决策清单项 D：到 M8 用基线数据再定） |
| 紧急通知条件 | **未定义**（SRS §11.5，属 M5） |
| 重同步 | `missedEvents` 只是标记，**没有**实际的 resync 流程 |
| 决策轨迹持久化 | **未实现**（M7）。当前只有结构化日志 |
| Master 重试 | 无重试；失败即降级为空计划 |
| 多轮工具循环中的取消确认时点 | **未验证**（沿用 ADR-002 §4 的限制） |
| `eventSeq` 的生产来源 | 目前只有 `WorldModel.ingestInput()` 一个入口；真实 ASR/屏幕/外部事件接入在 M6 |

---

## 5. 验证方式

| 证据 | 结果 |
|---|---|
| 解析器：围栏提取、噪声裁剪、三类降级路径、逐动作丢弃 | ✅ 12 项 |
| 决策平面：超时 / 解析失败 / 调用失败 / 部分失效 / 代次不匹配 / 幂等 / stale 标记 / 空计划 / 视图有界 | ✅ 12 项 |
| 两维版本号分界线与有界视图 | ✅ 6 项 |
| 真实 Master 端到端 | ✅ 7 项检查全过（`npm run example:master`） |
| 全套 | ✅ **94 项单元测试通过**、`tsc --noEmit` 干净 |

---

## 6. 重新评估条件

1. 实测发现真实模型的 JSON 合规率过低，需要引入 `response_format` 或工具调用通道；
2. M5 定义紧急抢占条件后，`priority` 语义需要扩展（届时本 ADR 的 §2.2 需修订）；
3. M6 接入真实高频输入后，`eventSeq` 的粒度（每帧 vs 每语义事件）需要重新定义；
4. M7 恢复流程需要跨进程重建 revision，届时 `controlRevision` 的持久化语义必须重新冻结。
