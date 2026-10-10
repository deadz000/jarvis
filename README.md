# jarvis — 面向实时交互的主从多 Agent 任务调度系统

常驻、多模态、任务执行型助手：Master Agent 理解意图并提出结构化调度建议，
确定性 Scheduler 校验并管理多个独立 Worker Agent 的执行、取消、状态与结果交付。

**核心问题不是"让多个 Agent 并行"，而是：在持续输入和多任务并行条件下，
如何及时、安全地调度独立目标，并以合适的方式把结果交付给用户。**

---

## 当前进度

| 里程碑 | 状态 | 说明 |
|---|---|---|
| **Milestone Alpha（首个可演示增量）** | ✅ 完成 | 可视化面板：聊天 → Master 决策 → 并行 Worker → 任务面板 → 取消隔离 → 交付队列 → 音频仲裁 |
| **M0 项目初始化与 SDK 核验** | ✅ 完成 | 工程骨架、锁定依赖、配置/日志、ADR-001、最小 Session 示例；真实模型调用已实测通过 |
| **M1 单 Agent Runtime PoC** | ✅ 完成 | 事件生命周期、自定义工具闭环、`abort` 传递到工具层、`steer` 契约、重复请求/退订/dispose/会话持久化差异。ADR-001 §3.2 记录了三个实测陷阱 |
| **M2 Worker Runtime Adapter** | ✅ 完成 | 真实 Pi Worker 适配器 + 确定性 FakeWorker。**真实 Session 并行重叠 1818ms、上下文隔离、取消隔离均已实测** |
| **M3 确定性 Scheduler** | ✅ 完成 | 状态机 + 单写入口 + 代次隔离 + 取消竞态 + 并发准入 + 幂等键；24 项状态测试**不调用 LLM**。**未实现**：取消超时看门狗、优先级/饥饿防护 |
| **M4 Master 决策面** | ✅ 完成 | 两维版本号（eventSeq / controlRevision）、决策 Schema、解析与业务校验分离、逐动作前置条件校验、幂等键、超时降级为空计划。**真实 Master 端到端实测通过**（ADR-003） |
| **M5 结果与交付** | ✅ 完成（超出原计划） | 交付策略**确定性路由**（单个普通结果零 LLM 成本 / 多条合并 / 语义判断 / 讲话时让路）、1.2s 合并窗口（硬上限 3s）、音频仲裁（代次隔离 + 分片边界抢占）、有界对话记忆、面板 |
| **M6a 语音输出（TTS）** | ✅ 完成 | 阿里云百炼真实 TTS → SSE → 浏览器 `AudioContext` 播放。**首音频 565ms**；分片来源可插拔（模拟/真实共用同一套代次逻辑） |
| **M6b 语音输入（ASR）** | ✅ 完成 | 麦克风 → `AudioWorklet` 重采样 16k → 独立 WebSocket → 流式识别 → 实时转写 → 终稿进调度链路。**往返实测通过**（TTS 合成→ASR 转写，相似度 85%） |
| **M6c 外部事件** | ⬜ 未开始 | 剪贴板 / 文件变化等外部信号 |
| **M6d 屏幕上下文** | ✅ 完成 | 帧不落盘（且不进业务进程堆）、`pHash(64bit 中值指纹) AND 大面积色块变化` 双条件过滤、5s 节流、攒批 3 帧/5min、多模态摘要（带确定性兜底）、10 分钟滑动窗口、意图门控（纯文字指令零 token）、显式开关。**真实屏幕与真实模型均实测通过** |
| **M7 持久化 / 跨会话记忆 / 恢复** | ✅ 完成 | `node:sqlite`（零新增依赖）：任务/事件/决策轨迹/语义记忆落库；重启把未终结任务标为「结果未知」（**与状态机正交的恢复维度**）且**不自动重跑**；显式重跑入口。**真实崩溃重启流程实测通过** |
| **M8 评测与性能基线** | ⬜ 未开始 | 可重复场景脚本、指标（P50/P95）、故障注入、定阈值 |

**首版明确未实现（不要当成已具备）**：
- **优先级不参与准入**（FIFO，无抢占/无饥饿防护）—— 已确认延到 M8 用基线决定
- **跨重启幂等去重**：`TaskRecord` 不携带 `decisionId`/`idempotencyKey`，这两列落库为 NULL
- **取消超时看门狗**、`副作用不可逆`的表达能力（决策清单 #2）
- **首声延迟**：结果播报要等任务做完才产生。优化方案已提出但**未获授权实施**
- **M6c 外部事件**、**Worker 按需截图工具**
- **工具安全边界**（决策 #8）：Worker 目前**可无确认地往仓库写文件**，已显式延后

**实机验收**：见 [实机检验清单](docs/实机检验清单_v0.1.md)（逐场景操作步骤 + 预期结果 + 报错时该提供什么）。

### M0 实测发现（详见 ADR-001）

1. **`prompt()` 正常返回 ≠ 任务成功。** 用无效 API Key 实测：`prompt()` 324ms 正常 resolve、
   `getLastAssistantText()` 返回 `undefined`、事件照常走完 `agent_start → … → agent_settled`，
   **全程不抛异常**。唯一可靠信号是 `message_end` 中 assistant 消息的
   `stopReason === "error"`（伴 `errorMessage`）。该规则已固化为
   `src/adapters/pi/session-outcome.ts` 并附 8 项单元测试 —— 修复前示例会误报成功并 exit 0。
2. **日志脱敏会误伤"看起来敏感"的统计字段。** `credentialProviders` 命中 `/credential/`
   被整块替换为 `[redacted]`，反而丢失诊断信息；已改名为 `detectedProviders` /
   `detectedEnvVars` 并加回归测试。
3. `~/.pi/agent` 在本机不存在**不影响** SDK 初始化；`ModelRuntime.create()` 会按环境变量列出可用模型。
4. `raw.githubusercontent.com` 在本机不可达，因此 SDK 核验改为直接读取 npm 发布包内的
   官方 `docs/` 与 `examples/`，与所锁定的版本号严格对应。

---

## 环境要求

| 项 | 要求 | 本机实测 |
|---|---|---|
| Node.js | `>=22.19.0`（受 Pi SDK `engines` 约束） | v24.13.1 ✅ |
| npm | 随 Node 安装 | 11.8.0 ✅ |
| 平台 | Windows 原生（当前基线）；未验证 WSL/Linux | Windows 10/11 ✅ |
| TypeScript | 由 devDependency 提供，无需全局安装 | 5.9.3 |

运行 `.ts` 文件直接使用 **Node 原生类型剥离**，不依赖 `tsx`/`ts-node`。
因此源代码受 `erasableSyntaxOnly` 约束：**不得使用 enum、namespace、参数属性、装饰器**。

---

## 快速开始

```powershell
# 1. 安装依赖（使用精确版本 + lockfile）
npm install

# 2. 配置凭据：复制模板后填入至少一个 provider 的 API Key
Copy-Item .env.example .env

# 3. 校验配置与凭据注入链路（不调用模型，不需要 Key 也能跑通）
npm run check

# 4. 运行单元测试与类型检查
npm test
npm run typecheck

# 5. 跑最小 AgentSession 示例（需要 .env 中的有效 Key）
npm run example:sdk -- "用一句话介绍这个仓库"
```

### 常用命令

| 命令 | 作用 |
|---|---|
| `npm run demo` | **启动可视化演示面板**（默认 http://127.0.0.1:7717），见 [演示脚本](docs/演示脚本_v0.1.md) |
| `npm run check` | 配置自检：校验环境变量、报告检测到的 provider（不调用模型） |
| `npm test` | vitest 单元测试 |
| `npm run typecheck` | `tsc --noEmit` 全量类型检查 |
| `npm run example:sdk -- "<问题>"` | 最小 Session 示例：创建 → 订阅流式事件 → 单轮 prompt → 释放 |
| `npm run example:abort` | M1 实测：自定义工具闭环 + `abort` 是否传递到工具执行层 + `steer` 契约 |
| `npm run example:workers` | M2 实测：真实双 Worker 并行重叠、上下文隔离、取消隔离 |
| `npm run example:lifecycle` | M1 实测：重复请求、退订、`dispose` 语义、内存 vs 持久化会话 |
| `npm run example:master` | M4 实测：真实 Master 产出结构化决策 → 逐动作校验 → 经 Scheduler 落地 |
| `npm start` | 服务入口（M0 仅输出启动日志与未实现范围） |

---

## 目录结构

```text
src/
  app.ts                          # 服务入口（配置校验 + 启动日志 + 退出钩子）
  config/env.ts                   # 环境变量读取、校验与脱敏快照
  observability/logger.ts         # 结构化 JSON 日志 + 深度脱敏
  domain/task/
    types.ts                      # TaskId / runGeneration / Task 状态与快照
    state-machine.ts              # 合法转移表（数据声明，可穷举测试）
  domain/decision/types.ts        # MasterDecision 契约与两维版本号
  application/
    runtime.ts                    # 演示运行时装配（把各部件串成一条链路）
    scheduler/scheduler.ts        # 确定性 Scheduler：唯一写入口、准入、取消、代次
    workers/ports.ts              # WorkerRuntime 端口（含取消与事件契约）
    interaction/focus.ts          # 交互焦点（独立状态维度）
    delivery/
      audio-manager.ts            # 模拟 Audio Manager：播放代次仲裁（旧代次被拒绝）
      delivery-queue.ts           # 交付队列：不抢占、播完后按优先级交付
    master/
      context-view.ts             # 有界世界视图 + 两维版本号
      decision-parser.ts          # 输出解析与 Schema 校验（不含业务规则）
      decision-validator.ts       # 逐动作前置条件校验 → 编译为命令
      decision-plane.ts           # 决策周期编排 + 超时降级
      master-prompt.ts            # 提示词模板
  adapters/
    http/demo-server.ts           # 演示服务：静态面板 + SSE + 命令接口
    pi/session-outcome.ts         # Pi 终态判定（含 abort/取消的特殊性）
    pi/pi-worker-runtime.ts       # 真实 Pi Worker 适配器
    pi/pi-master.ts               # 真实 Pi Master 适配器（无工具，只出建议）
    pi/model-selection.ts         # 模型选择
    workers/fake-worker.ts        # 确定性 FakeWorkerRuntime
examples/sdk/
  01-minimal.ts                   # 最小 Session 示例
  02-abort-and-tools.ts           # M1 实测：自定义工具 + 取消传递
config/models.json                # 自定义端点声明（不含密钥）
public/index.html                 # 可视化面板（单文件，无前端依赖）
tests/unit/                       # 状态机、Scheduler、配置、日志、终态判定
docs/
  项目文档索引_v0.1.md
  项目需求规格说明书_v0.1.md       # 需求主文档
  开发实施计划_v0.1.md             # 开发顺序与里程碑主文档
  踩坑指南-问题与解决方案.md        # 旧项目经验（新系统设计检查项）
  adr/001-pi-sdk.md               # SDK 来源/版本/许可证与已知限制
  adr/002-task-lifecycle-and-cancel.md  # Task / runGeneration / 取消语义
```

后续里程碑按《开发实施计划》§5 的建议逐步引入 `domain/`、`application/`、`adapters/`。

---

## 凭据与安全规则

1. **`.env` 永不入库**（已在 `.gitignore` 中）；只提交 `.env.example`。
2. 凭据由 Pi SDK 直接读进程环境变量（`DEEPSEEK_API_KEY`、`ANTHROPIC_API_KEY` …），
   本项目配置层**只检测「是否存在」，从不回显、不落盘、不写日志**。
3. 日志器对字段做**深度脱敏**：键名命中 `apiKey`/`token`/`secret`/`password` 等，
   或值形态匹配 `sk-…`/`Bearer …`，一律替换为 `[redacted]`。
   回归测试见 `tests/unit/logger.test.ts`。
4. 若使用 `~/.pi/agent/auth.json` 或 `models.json`，同样不要提交。

---

## Windows 已知注意事项

- **`npm.ps1` 可能被执行策略拦截**（`无法加载文件 ...npm.ps1，因为在此系统上禁止运行脚本`）。
  此时改用 `npm.cmd`，或执行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。
  在 npm scripts 内调用不受影响。
- `.env` 通过 Node 原生 `--env-file-if-exists=.env` 注入，无需 `dotenv`；
  文件不存在时会打印一行提示，属正常现象。
- Git 换行符由 `.gitattributes` 统一为 LF。

---

## 文档使用规则

- 以 [项目需求规格说明书](docs/项目需求规格说明书_v0.1.md) 为需求主文档；
- 以 [开发实施计划](docs/开发实施计划_v0.1.md) 为开发顺序与里程碑主文档；
- 文档中的「已确认 / 建议 / 待决策」必须区分对待，不得把待决策项当冻结要求；
- **PoC 证明某假设不成立时，必须修订需求或新增 ADR，不能只改代码而不更新文档。**
