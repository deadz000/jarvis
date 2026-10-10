# jarvis — 面向实时交互的主从多 Agent 任务调度系统

常驻、多模态、任务执行型助手：Master Agent 理解意图并提出结构化调度建议，
确定性 Scheduler 校验并管理多个独立 Worker Agent 的执行、取消、状态与结果交付。

**核心问题不是"让多个 Agent 并行"，而是：在持续输入和多任务并行条件下，
如何及时、安全地调度独立目标，并以合适的方式把结果交付给用户。**

---

## 当前进度

| 里程碑 | 状态 | 说明 |
|---|---|---|
| **M0 项目初始化与 SDK 核验** | 🟡 基本完成 | 工程骨架、锁定依赖、配置/日志、ADR-001、最小 Session 示例均已就绪；**真实模型调用待注入凭据后验证** |
| M1 单 Agent Runtime PoC | ⬜ 未开始 | 事件生命周期、`abort`、自定义工具取消语义 |
| M2 Worker Runtime Adapter | ⬜ 未开始 | 端口定义、独立 Session、`taskId`/`runGeneration` 关联 |
| M3 确定性 Scheduler | ⬜ 未开始 | 状态机、并发准入、取消竞态、迟到事件过滤 |
| M4–M8 | ⬜ 未开始 | Master 决策面、结果交付、混合输入、持久化恢复、评测 |

**明确未实现（不要当成已具备）**：常驻事件接入、Master 决策、Scheduler、Worker、
语音/屏幕输入、结果交付、音频仲裁、持久化与恢复。`npm start` 会在日志中显式报告该范围。

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
| `npm run check` | 配置自检：校验环境变量、报告检测到的 provider（不调用模型） |
| `npm test` | vitest 单元测试 |
| `npm run typecheck` | `tsc --noEmit` 全量类型检查 |
| `npm run example:sdk -- "<问题>"` | 最小 Session 示例：创建 → 订阅流式事件 → 单轮 prompt → 释放 |
| `npm start` | 服务入口（M0 仅输出启动日志与未实现范围） |

---

## 目录结构

```text
src/
  app.ts                     # 服务入口（配置校验 + 启动日志 + 退出钩子）
  config/env.ts              # 环境变量读取、校验与脱敏快照
  observability/logger.ts    # 结构化 JSON 日志 + 深度脱敏
examples/sdk/01-minimal.ts   # M0 交付物：最小 AgentSession 示例
tests/unit/                  # 配置与日志的单元测试
docs/
  项目文档索引_v0.1.md
  项目需求规格说明书_v0.1.md   # 需求主文档
  开发实施计划_v0.1.md         # 开发顺序与里程碑主文档
  踩坑指南-问题与解决方案.md    # 旧项目经验（新系统设计检查项）
  adr/001-pi-sdk.md          # SDK 来源/版本/许可证与已知限制
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
