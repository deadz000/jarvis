# ADR-001：Pi TypeScript SDK 的仓库、包名、版本与集成边界

- **状态**：已接受（2026-10-10）
- **决策者**：项目负责人 + 开发
- **关联**：开发实施计划 §2.2 / M0 / §10；项目需求规格说明书 §1.2、§11.1
- **影响**：所有 Worker / Master Agent 的执行底座

---

## 1. 背景

需求基线把 Agent Runtime 方向定为 Pi TypeScript SDK，但明确要求：
「Pi SDK 的实际包名/版本、事件语义、取消行为、工具执行中止和会话持久化，
必须通过 PoC 验证后才能冻结详细接口」（SRS §1.2）。
M0 的出口条件之一是「SDK 来源和包名唯一且清楚」。

需要冻结的是：**用哪个仓库、哪个包、哪个版本、什么许可证、什么运行时，以及业务代码以什么边界依赖它。**

---

## 2. 核验方法（可复现）

1. 读取 npm registry 元数据：
   `npm view @earendil-works/pi-coding-agent version engines license repository.url dist-tags exports --json`
2. 下载并解包**已发布产物**：`npm pack @earendil-works/pi-coding-agent@1.1.0`，
   解包后阅读包内 `docs/`（37 个文档）与 `examples/sdk/`（14 个示例）。
3. 用冻结版本在真实工程中编写示例与配置层，跑 `tsc --noEmit` 与单元测试。

> **方法学说明**：本机 `raw.githubusercontent.com` 不可达，因此**没有**采用读取 GitHub 网页文档的方式，
> 而是直接读取与版本号严格对应的 npm 发布包内文档。后者与运行时产物同源，可信度更高，
> 也避免了「文档对应 main 分支、代码对应旧版本」的偏差。

---

## 3. 核验结论（实测事实）

| 项 | 实测值 |
|---|---|
| 包名 | `@earendil-works/pi-coding-agent` |
| 采用版本 | **1.1.0**（`latest` dist-tag），**精确锁定，不用 `^` 范围** |
| 其他 dist-tag | `legacy-node20: 0.74.2` —— **本项目不使用** |
| 许可证 | MIT |
| 源码仓库 | `git+https://github.com/earendil-works/pi.git`，子目录 `packages/coding-agent` |
| 官方文档 | <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md> |
| 模块格式 | ESM（`"type": "module"`），`main: ./dist/index.js`，`types: ./dist/index.d.ts` |
| 运行时要求 | `engines.node >= 22.19.0`（本机 v24.13.1 ✅） |
| 子路径导出 | `.`（types+import）、`./rpc-entry`（import）、`./client` 与 `./experimental/plugin` **仅有 `source` 条件** |

### 3.1 已确认可用的 API 面（来自 1.1.0 包内 `docs/sdk.md`）

- 创建：`createAgentSession(options?)` → `{ session }`；
  可选注入 `modelRuntime` / `model` / `thinkingLevel` / `scopedModels` /
  `settingsManager` / `sessionManager` / `resourceLoader` / `tools` / `noTools` / `excludeTools` / `customTools` / `cwd`。
- 会话：`session.prompt()`（运行结束才 resolve，流式中途调用必须显式选择 steer 或 follow-up，否则**拒绝而非猜测**）、
  `steer()`、`followUp()`（未消费时返回 `"queued"`）、`abort()`（停止当前操作并等待 idle）、
  `waitForIdle()`、`subscribe(cb)` → `unsubscribe`、`dispose()`、
  `getLastAssistantText()`、`session.messages`、`session.state.messages`、`getActiveToolNames()`。
- 会话存储：`SessionManager.inMemory(cwd)` 与持久化两种；`SessionManager` 是最终模型上下文的权威。
- 模型与凭据：`ModelRuntime.create({ authPath, modelsPath })`、
  `getModel(provider, id)`、`getAvailable()`（仅返回有有效凭据的模型）、`setRuntimeApiKey(provider, key)`。
- 工具集合通过名称选择（`tools: ["read","bash","grep"]`）；
  **自定义工具经 extensions 系统注册（`registerTool`），不是 `createAgentSession` 的独立选项**。

### 3.2 已确认的事件语义

| 事件 | 语义（关键区别） |
|---|---|
| `message_update` + `assistantMessageEvent.type === "text_delta"` | 流式增量文本 |
| `message_end` | **权威的**已完成消息 |
| `agent_end` | 一次底层 agent run 结束，**之后仍可能有自动恢复或排队工作** |
| `agent_settled` | Pi 不会自行继续 —— 宿主判断「真的停了」应以此为准 |

**这一区别直接决定 M2/M3 的正确性**：把 `prompt()` resolve 或 `agent_end` 当作唯一完成信号，
会把「排队工作尚未执行」误判为任务完成。

### 3.2.1 实机验证：失败**不会**表现为「抛错」（重要陷阱）

用**无效凭据**（伪造 `DEEPSEEK_API_KEY`）实测，事件序列与正常运行**完全一致**：

```text
agent_start → turn_start → message_start/message_end ×3 → turn_end → agent_end → agent_settled
```

而 `session.prompt()` 会**正常 resolve**（实测 324ms），`getLastAssistantText()` 返回 `undefined`，
`agent_end` / `agent_settled` 也都照常触发。**没有任何异常被抛出。**

唯一可靠的失败信号是 `message_end` 事件中 assistant 消息的：

- `stopReason: "error"` —— 判定失败的依据；
- `errorMessage` —— 实测为 provider 的 401 认证失败原文。

```json
{"role":"assistant","stopReason":"error","errorMessage":"401: ... api key: ****2333 is invalid ...",
 "model":"deepseek-flash","usage":{...},"durationMs":324}
```

**结论**：适配层必须显式判定终态，**绝不能把「`prompt()` 没抛错」当作任务成功**。
本项目已将该规则固化在 `src/adapters/pi/session-outcome.ts`，
并由 `tests/unit/session-outcome.test.ts`（8 项）覆盖，其中包含「终态缺失 → `unverified` 而非成功」。
这条规则同样约束 M2：Worker 的「完成」事件不得由 `prompt()` resolve 触发。

> 说明：`aborted` 也属于「未成功」，但在 Scheduler 层应映射为「已取消」而不是「失败」，
> 因此 `classifySessionOutcome` 保留原始 `stopReason` 供上层细分。

### 3.3 凭据与配置来源

- provider 凭据来自进程环境变量（Pi `docs/providers.md`）：
  `DEEPSEEK_API_KEY`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY` 等；
- 或来自配置目录 `~/.pi/agent/auth.json`；`PI_CODING_AGENT_DIR` 可覆盖该目录；
- SDK 嵌入时**不会**自动设置 `AI_AGENT`/`PI_CODING_AGENT` 进程标记。

---

## 4. 决定

1. **采用 `@earendil-works/pi-coding-agent@1.1.0`**，在 `package.json` 中写**精确版本**，
   并以 `package-lock.json` 固定整棵依赖树。
2. **全部 SDK 调用隔离在 `src/adapters/pi/` 之下**（M1/M2 建立）。
   业务层（domain/application）只依赖自定义 port（`WorkerRuntime`、`MasterRuntime`），
   不得直接 `import` SDK —— 落实 SRS §7.8 与踩坑指南「所有外部依赖先定义 port」。
3. 运行环境基线为 **Windows 原生 + Node >= 22.19.0**；不使用 `legacy-node20` 分支。
4. **不引入 `tsx`/`ts-node`**，直接用 Node 原生类型剥离运行 `.ts`；
   代价是代码受 `erasableSyntaxOnly` 约束（禁用 enum / namespace / 参数属性 / 装饰器），
   已写入 `tsconfig.json` 与 README，由 `tsc` 强制。
5. 凭据一律经环境变量注入，**只检测存在性、绝不回显**（见 `src/config/env.ts` 与日志脱敏测试）。

---

## 5. 代价与已知限制

| 项 | 说明 |
|---|---|
| 版本迭代快 | 0.74.x → 1.1.0 之间子路径导出已变更（`./hooks` 在 1.1.0 中**不存在**）。升级必须重跑 M1 PoC 并修订本 ADR |
| 子路径导出不完整 | `./client` 与 `./experimental/plugin` 只声明了 `source` 条件（指向 TS 源码），**不适合作为已发布包的外部入口**；本项目只用主入口 `.` |
| SDK 行为尚未真实调用验证 | 本机无模型凭据，`npm run example:sdk` **未取得真实模型响应**；`abort` 能否中止自定义长任务工具、取消确认的时点**均未验证**（SRS FR-07 验收项，M1 必做） |
| 自定义工具路径 | 自定义工具走 extensions 注册，M1 需确认其对 `abort` 的响应方式（能否收到取消信号） |
| 无浏览器条件导出 | exports 无 `browser` 条件，UI 层不能直接复用 SDK，需经服务端接口 |
| 内置扩展未自动加载 | SDK Session **不会**加载 CLI 的 `codemode` / `tool_search` / MCP，需要时须显式加入 `DefaultResourceLoader.extensionFactories` |
| 会话不等于任务状态 | `SessionManager` 管的是模型上下文，**不是**任务状态数据库；不得混用（计划 M1 已明确） |
| 失败信号不直观 | 见 §3.2.1：provider 失败时 `prompt()` 仍 resolve，必须解析 `message_end.stopReason`；`aborted` 需在 Scheduler 层映射为「已取消」而非「失败」 |

---

## 6. 验证方式与本次证据

| 证据 | 结果 |
|---|---|
| `npm install` 成功、`package-lock.json` 生成 | ✅ 122 包，19s |
| `tsc --noEmit`（含 `examples/sdk/01-minimal.ts` 对 SDK 的真实类型使用） | ✅ exit 0 |
| `vitest run`（配置校验 + 日志脱敏，含失败路径） | ✅ 15 项通过 |
| `npm run check`（配置与凭据检测链路） | ✅ 输出 `app.check.completed`，`modelCallsPossible: false` |
| 失败路径终态判定（无效凭据回归） | ✅ 正确报告 `status: failed` / `stopReason: error` / 401 `errorMessage`，exit 1（**修复前误报成功，exit 0**） |
| 凭据缺失路径 | ✅ 输出可读的 `[example-error]` 提示，exit 1，无裸栈 |
| 真实模型调用 | ⛔ **未验证** —— 网络链路已通（无效 Key 收到 provider 401，证明请求已到达 `api.deepseek.com`），但尚未取得有效模型响应；待注入有效凭据后执行 `npm run example:sdk` |
| `abort` / 自定义工具取消 | ⛔ **未验证** —— M1 范围 |

---

## 7. 重新评估条件

出现以下任一情况必须重开本 ADR：

1. SDK 发布 major 版本，或 `1.1.0` 出现影响本项目的安全/行为修复；
2. M1 证明 `abort()` **无法**中止自定义长任务工具，导致 FR-07 验收不可达；
3. 需要直接依赖 `@earendil-works/pi-agent-core` 等更低层包（届时需重新评估边界划分）；
4. 许可证变更，或需要浏览器端复用 SDK；
5. `engines` 要求超出目标运行环境。
