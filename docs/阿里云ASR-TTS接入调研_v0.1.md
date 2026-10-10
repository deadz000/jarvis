# 阿里云 ASR / TTS 接入调研（DashScope 百炼 vs 智能语音交互 NLS）

> **用途**：为「Node.js (TypeScript) 后端 + 浏览器 Web Audio 前端」的实时语音助手项目选定一条可落地的接入路线，
> 并提供**足以直接写适配器**的协议细节。
>
> **方法论声明**：本文结论**全部来自阿里云官方文档**（`help.aliyun.com`，含其 `.md` 原始 Markdown 导出）。
> 所有 JSON 样例均为官方文档**原样引用**，未改写字段名。
> 无法从官方文档确认的内容已明确标注 **【不确定】**。**没有编造任何字段名或端点。**
>
> 调研日期：以文档站当前（含 2026 年时间戳内容）版本为准。

---

## 0. 结论摘要（先看这个）

| 结论 | 内容 |
|---|---|
| **推荐路线** | **路线 1（DashScope / 百炼）**，且**不要用 paraformer + sambert** |
| **推荐模型组合** | ASR: `qwen-audio-3.1-asr-flash-streaming`（或 `fun-asr-realtime`）；TTS: `cosyvoice-v3.5-plus` / `qwen-audio-3.0-tts-plus` |
| **关键理由** | paraformer 与 sambert 均已被官方文档标记为「早期一代，建议迁移」；NLS 是独立的老产品线，鉴权/配额/模型配置全走控制台项目（Appkey），无模型选择能力 |
| **必须后端中转** | ✅ 是。官方**明文禁止**浏览器直连 NLS RESTful；且浏览器 `WebSocket` API **无法设置自定义 Header**，而 DashScope 鉴权靠握手 Header |
| **TTS 中途取消** | ✅ DashScope CosyVoice **支持**（`finish-task` + `directive: cancel`）；NLS【不确定】 |
| **最大工程风险** | DashScope 的 URL 是「业务空间专属域名」，需要 `WorkspaceId`；且 `dashscope.aliyuncs.com` 自 **2026-09-30** 起不再支持新特性 |

---

## 1. 两条路线的定位差异

| 维度 | 路线 1：DashScope / 百炼 | 路线 2：智能语音交互 NLS |
|---|---|---|
| 产品页 | `help.aliyun.com/zh/model-studio/` | `help.aliyun.com/zh/isi/` |
| 端点 | `wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference` | `wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1` |
| 鉴权凭据 | **百炼 API Key**（`DASHSCOPE_API_KEY`，`sk-` 开头） | **AccessKey 换取的临时 Token** + **项目 Appkey** |
| 鉴权位置 | **HTTP Header** `Authorization: Bearer <key>` | **URL query** `?token=<token>` |
| 模型选择 | 请求报文里写 `model` 字段，随时换 | **控制台项目里配置**，请求参数无法切换 |
| 协议风格 | 统一 `run-task` / `continue-task` / `finish-task` | ASR 与 TTS **各自一套**指令/事件名 |
| 官方 SDK | 仅 Java / Python（其他语言走 WebSocket） | 有官方 **Node.js SDK `alibabacloud-nls`** |
| 维护状态 | 当前主推 | 维护中，但不在 AI 主推叙事里 |

> **重要**：两者**不能共用适配器**。指令名、事件名、鉴权、错误码体系全部不同。

---

## 2. 接入协议与鉴权

### 2.1 路线 1（DashScope）鉴权

**协议：WebSocket（WSS）。** 鉴权在**握手阶段**用 HTTP Header 完成，无独立"鉴权帧"。

官方原文（[WebSocket 接入指南 · Paraformer](https://help.aliyun.com/zh/model-studio/websocket-for-paraformer-real-time-service)）：

> URL 必须使用 `wss://` 协议，且固定不变。Authorization 在请求头中设置
>
> Authorization 鉴权在 WebSocket 握手阶段验证。如果 API Key 无效或缺失，握手将失败并返回 HTTP 401/403 错误。

请求头字段表（原文）：

| 参数 | 类型 | 是否必选 | 说明 |
|---|---|---|---|
| `Authorization` | string | 是 | 鉴权令牌，格式为 `Bearer <your_api_key>` |
| `user-agent` | string | 否 | 客户端标识，便于服务端追踪来源。 |
| `X-DashScope-WorkSpace` | string | 否 | 阿里云百炼业务空间ID。 |
| `X-DashScope-DataInspection` | string | 否 | 是否启用数据合规检测功能。默认不传或设为 `enable`。如非必要，请勿启用该参数。 |

**Token 有效期**：API Key 是长期凭据，**没有 token 换取与过期问题**（与 NLS 相反）。

**接口地址**（原文，Paraformer 与 CosyVoice 一致）：

```
wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference
```

CosyVoice 文档额外给出新加坡地域：`wss://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference`
（[CosyVoice WebSocket 接入指南](https://help.aliyun.com/zh/model-studio/cosyvoice-websocket-api)）

> **注意**：文档同时提示「Paraformer仅支持在华北2（北京）地域使用」。CosyVoice 支持北京 + 新加坡。

**域名迁移（务必知悉）**（[选择地域、服务部署范围和接入域名](https://help.aliyun.com/zh/model-studio/regions)）：

> 百炼为模型推理 API 提供业务空间专属、DashScope 和试用三种接入域名……推荐使用业务空间专属域名
>
> DashScope 域名（`dashscope.aliyuncs.com`）自 **2026年9月30日** 起不再支持新特性。

请求超时差异（同页）：业务空间专属域名 **3600 秒**，DashScope 域名 **600 秒**。

**环境变量建议**：

```dotenv
# 路线 1
DASHSCOPE_API_KEY=sk-xxxxxxxx          # 百炼 API Key（北京/新加坡 Key 不通用）
DASHSCOPE_WORKSPACE_ID=llm-xxxxxxxx    # 业务空间 ID，用于拼 {WorkspaceId}.cn-beijing.maas.aliyuncs.com
DASHSCOPE_REGION=cn-beijing            # cn-beijing | ap-southeast-1
```

---

### 2.2 路线 2（NLS）鉴权

**协议：WebSocket（WSS）用于流式；HTTP 用于一句话识别 RESTful / 短句合成 RESTful。**

NLS 用**临时 Token**，由 AccessKey 换取（[获取 Token](https://help.aliyun.com/zh/isi/getting-started/obtain-an-access-token)）。

官方原文：

> 获取 Token 使用的是 AccessKey，不是百炼 API Key。将 AccessKey 配置到运行示例的进程环境中：`ALIYUN_AK_ID` 对应 AccessKey ID，`ALIYUN_AK_SECRET` 对应 AccessKey Secret。
>
> AccessKey 仅保存在可信的服务端环境，不写入源代码或移动端应用。

**CreateToken 调用参数**（原文表格）：

| 参数 | 配置值 |
|---|---|
| `domain` | `nls-meta.cn-shanghai.aliyuncs.com` |
| `region_id` | `cn-shanghai` |
| `action` | `CreateToken` |
| `version` | `2019-02-28` |

**返回值**（原文）：`Token.Id`（Token 字符串）、`Token.ExpireTime`（Unix 时间戳，单位秒）。

**官方 Node.js 换取示例（原文，可直接用）**：

```javascript
const { RPCClient } = require('@alicloud/pop-core');

const client = new RPCClient({
  accessKeyId: process.env.ALIYUN_AK_ID,
  accessKeySecret: process.env.ALIYUN_AK_SECRET,
  endpoint: 'https://nls-meta.cn-shanghai.aliyuncs.com',
  apiVersion: '2019-02-28',
});

async function main() {
  const result = await client.request('CreateToken', {}, { method: 'POST' });
  const token = result.Token.Id;
  const expireTime = result.Token.ExpireTime;
  console.log('Token acquired:', Boolean(token));
  console.log('ExpireTime (Unix seconds):', expireTime);
}
```

**Token 有效期多久？** → **【不确定】**
官方文档**只给出 `ExpireTime` 字段，未给出固定时长**（未出现"24 小时"之类的明确表述）。官方原文明说：

> 缓存 Token 并在有效期内复用，不必在每次语音服务请求前重新获取。**根据返回的 `ExpireTime` 判断有效期**，在过期前重新获取并更新缓存，**不使用固定时长代替返回值**。

→ **适配器必须按 `ExpireTime` 动态刷新，不要硬编码时长。**

**WebSocket 鉴权位置**（[实时语音识别 WebSocket 协议](https://help.aliyun.com/zh/isi/user-guide/websocket)）：

```
wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1?token=<your_token>
```

原文还给出：
- 就近接入域名：`nls-gateway.aliyuncs.com`（自动解析到最近地域）
- 上海 ECS 内网：`ws://nls-gateway-cn-shanghai-internal.aliyuncs.com:80/ws/v1?token=<your_token>`
- 一句话识别可选地域：`nls-gateway-cn-beijing.aliyuncs.com`、`nls-gateway-cn-shenzhen.aliyuncs.com`

**同时需要 Appkey**：NLS 的每条指令 `header` 都要带 `appkey`（**项目**的 Appkey，控制台创建）。
所以 NLS 是**双凭据**：`token`（连接级）+ `appkey`（指令级）。

**环境变量建议**：

```dotenv
# 路线 2
ALIYUN_AK_ID=                    # AccessKey ID（仅服务端）
ALIYUN_AK_SECRET=                # AccessKey Secret（仅服务端）
NLS_APP_KEY=                     # 控制台项目的 Appkey
NLS_TOKEN=                       # 运行时换取并缓存，不必写 .env
NLS_ENDPOINT=wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1
```

---

## 3. WebSocket 完整连接流程与报文格式

### 3.1 路线 1 · ASR（Paraformer）交互流程

官方原文（[WebSocket 接入指南](https://help.aliyun.com/zh/model-studio/websocket-for-paraformer-real-time-service)）：

> 1. 建立连接：客户端与服务端建立 WebSocket 连接。
> 2. 开启任务：客户端发送 **run-task** 指令以开启任务，并接收服务端返回的 **task-started** 事件，标志着任务已成功开启，可以进行后续步骤。
> 3. 发送音频流：客户端开始发送二进制音频（**须为单声道音频**），并同时接收服务端持续返回的 **result-generated** 事件，该事件包含语音识别结果。
> 4. 通知服务端结束任务：客户端发送 **finish-task** 指令通知服务端结束任务，并继续接收服务端返回的 result-generated 事件。
> 5. 任务结束：客户端收到服务端返回的 **task-finished** 事件，标志着任务结束。
> 6. 关闭连接：客户端关闭 WebSocket 连接。

**关键点**：**没有独立鉴权帧**；`run-task` 是首个 JSON 文本帧；音频走**二进制帧**（不进 JSON）。

#### 3.1.1 `run-task` 首帧（官方样例原样引用）

```json
{
    "header": {
        "action": "run-task",
        "task_id": "2bf83b9a-baeb-4fda-8d9a-xxxxxxxxxxxx",
        "streaming": "duplex"
    },
    "payload": {
        "task_group": "audio",
        "task": "asr",
        "function": "recognition",
        "model": "paraformer-realtime-v2",
        "parameters": {
            "format": "pcm",
            "sample_rate": 16000,
            "disfluency_removal_enabled": false,
            "language_hints": [
                "en"
            ]
        },
        "input": {}
    }
}
```

字段语义（原文摘要）：
- `header.action` = `run-task`（固定）
- `header.task_id` = 客户端生成的 UUID
- `header.streaming` = `duplex`（固定）
- `payload.task_group` = `audio`（固定）
- `payload.task` = `asr`（固定）
- `payload.function` = `recognition`（固定）
- `payload.model` = 模型名
- `payload.input` = `{}`（固定）
- `payload.parameters.format` ∈ `pcm` / `wav` / `mp3` / `opus` / `speex` / `aac` / `amr`
- `payload.parameters.sample_rate` 整数

可调关键参数（原文）：
- `semantic_punctuation_enabled`（bool，默认 false）：`true` 开启**语义断句**并关闭 VAD 断句；`false` 开启 **VAD 断句**
- `max_sentence_silence`（int，默认 `1300`，范围 `[200, 6000]`）：VAD 断句静音阈值（ms），仅 `semantic_punctuation_enabled=false` 时生效
- `punctuation_prediction_enabled`（bool，默认 `true`）
- `heartbeat`（bool，默认 `false`）：**`true` 时，在持续发送静音音频的情况下，可保持与服务端的连接不中断**
- `inverse_text_normalization_enabled`（bool，默认 `true`）
- `multi_threshold_mode_enabled`、`disfluency_removal_enabled`、`vocabulary_id`、`language_hints`

> **对你项目的直接影响**：这条 `heartbeat` 参数正好解决你「长连接必须有业务级心跳」的约束——**不用自己造静音帧协议**，开 `heartbeat: true` 并持续发静音 PCM 即可。

#### 3.1.2 `finish-task`（EOS，官方样例原样引用）

```json
{
    "header": {
        "action": "finish-task",
        "task_id": "2bf83b9a-baeb-4fda-8d9a-xxxxxxxxxxxx",
        "streaming": "duplex"
    },
    "payload": {
        "input": {}
    }
}
```

#### 3.1.3 服务端事件

**`task-started`**（官方样例）：

```json
{
    "header": {
        "task_id": "2bf83b9a-baeb-4fda-8d9a-xxxxxxxxxxxx",
        "event": "task-started",
        "attributes": {}
    },
    "payload": {}
}
```

**`result-generated`**（官方样例，含完整字时间戳）：

```json
{
  "header": {
    "task_id": "2bf83b9a-baeb-4fda-8d9a-xxxxxxxxxxxx",
    "event": "result-generated",
    "attributes": {}
  },
  "payload": {
    "output": {
      "sentence": {
        "begin_time": 170,
        "end_time": null,
        "text": "好，我知道了",
        "heartbeat": false,
        "sentence_end": true,
        "words": [
          {
            "begin_time": 170,
            "end_time": 295,
            "text": "好",
            "punctuation": "，"
          },
          {
            "begin_time": 295,
            "end_time": 503,
            "text": "我",
            "punctuation": ""
          },
          {
            "begin_time": 503,
            "end_time": 711,
            "text": "知道",
            "punctuation": ""
          },
          {
            "begin_time": 711,
            "end_time": 920,
            "text": "了",
            "punctuation": ""
          }
        ]
      }
    },
    "usage": {
      "duration": 3
    }
  }
}
```

**`task-finished`**（官方样例）：

```json
{
    "header": {
        "task_id": "2bf83b9a-baeb-4fda-8d9a-xxxxxxxxxxxx",
        "event": "task-finished",
        "attributes": {}
    },
    "payload": {
        "output": {},
        "usage": null
    }
}
```

**`task-failed`**（官方样例）：

```json
{
    "header": {
        "task_id": "2bf83b9a-baeb-4fda-8d9a-xxxxxxxxxxxx",
        "event": "task-failed",
        "error_code": "CLIENT_ERROR",
        "error_message": "request timeout after 23 seconds.",
        "attributes": {}
    },
    "payload": {}
}
```

> 官方说明：`task-failed` → **连接会被关闭，无法复用**。

---

### 3.2 路线 1 · TTS（CosyVoice）交互流程

官方原文（[CosyVoice WebSocket 接入指南](https://help.aliyun.com/zh/model-studio/cosyvoice-websocket-api)）：

> 1. 建立连接
> 2. 开启任务：客户端发送 **run-task** 事件以开启任务。
> 3. 等待确认：客户端收到服务端返回的 **task-started** 事件
> 4. 发送待合成文本：客户端按顺序向服务端发送一个或多个包含待合成文本的 **continue-task** 事件，服务端接收到完整语句后返回 **result-generated** 事件和音频流
> 5. 接收音频：通过 `binary` 通道接收音频流
> 6. **待文本发送完毕后，客户端发送 finish-task 事件**……**此步骤不可省略，否则可能导致语音数据不完整**
> 7. 任务结束：客户端收到服务端返回的 **task-finished** 事件
> 8. 关闭连接

> 为提高资源利用率，建议复用 WebSocket 连接处理多个任务，而非为每个任务建立新连接。

> 同一次合成任务中，run-task、所有 continue-task、finish-task 必须使用相同的 `task_id`。每次发起新任务时生成新的 task_id（如使用 UUID）。**使用不同 task_id 会导致音频错乱或任务失败。**

**文本分句语义（原文）**：

> 支持多次发送 continue-task 事件，按顺序提交文本片段。服务端接收文本片段后自动进行分句：
> - 完整语句立即合成，此时客户端能够接收到服务端返回的音频
> - **不完整语句缓存至完整后合成，语句不完整时服务端不返回音频**
> - 当发送 finish-task 事件时，服务端会强制合成所有缓存内容。

#### 3.2.1 `run-task`（官方样例原样引用）

```json
{
    "header": {
        "action": "run-task",
        "task_id": "2bf83b9a-baeb-4fda-8d9a-xxxxxxxxxxxx",
        "streaming": "duplex"
    },
    "payload": {
        "task_group": "audio",
        "task": "tts",
        "function": "SpeechSynthesizer",
        "model": "cosyvoice-v3-plus",
        "parameters": {
            "text_type": "PlainText",
            "voice": "longanyang",
            "format": "mp3",
            "sample_rate": 22050,
            "volume": 50,
            "rate": 1.0,
            "pitch": 1.0,
            "enable_ssml": false
        },
        "input": {}
    }
}
```

关键参数（原文）：
- `parameters.text_type` = `PlainText`（固定）
- `parameters.voice` = 音色（必选）
- `parameters.format` ∈ `pcm` / `wav` / `mp3`（**默认**）/ `opus`（cosyvoice-v1 不支持 opus）
- `parameters.sample_rate` ∈ 8000, 16000, **22050（默认）**, 24000, 44100, 48000
- `parameters.volume` 默认 50，范围 [0,100]
- `parameters.rate`（语速）默认 1.0，范围 [0.5,2.0]
- `parameters.pitch` 默认 1.0，范围 [0.5,2.0]
- `parameters.bit_rate` 默认 32，范围 [6,510]（mp3/opus 时可用）
- `parameters.enable_ssml` 默认 false；为 true 后**仅允许发送一次 continue-task**
- `instruction`（可选）：自然语言控制方言/情感/角色
- `word_timestamp_enabled`（可选，默认 false）：字级时间戳
- `language_hints`（array[string]，可选）

**TTS 默认输出格式：`mp3`，采样率 `22050` Hz。**（这是文档明确写的默认值）

#### 3.2.2 `continue-task`（官方样例）

```json
{
    "header": {
        "action": "continue-task",
        "task_id": "2bf83b9a-baeb-4fda-8d9a-xxxxxxxxxxxx",
        "streaming": "duplex"
    },
    "payload": {
        "input": {
            "text": "床前明月光，疑是地上霜"
        }
    }
}
```

**文本长度限制（原文）**：
- 单次调用最多 **20000 字符**
- 累计最多 **200000 字符**
- **发送间隔不得超过 23 秒，否则连接超时**

#### 3.2.3 `finish-task` 正常结束 + **取消**（官方样例原样引用）

正常结束：

```json
{
    "header": {
        "action": "finish-task",
        "task_id": "2bf83b9a-baeb-4fda-8d9a-xxxxxxxxxxxx",
        "streaming": "duplex"
    },
    "payload": {
        "input": {}
    }
}
```

**取消正在进行的合成**：

```json
{
    "header": {
        "action": "finish-task",
        "task_id": "2bf83b9a-baeb-4fda-8d9a-xxxxxxxxxxxx",
        "streaming": "duplex"
    },
    "payload": {
        "input": {
            "directive": "cancel"
        }
    }
}
```

官方原文：

> 如需取消当前轮次的语音合成任务，可在 `input` 中设置 `directive` 为 `cancel`。
>
> 控制任务结束行为。当前仅支持取值为 `cancel`，表示取消当前轮次的语音合成任务，服务端会立即返回 `task-finished` 事件，且**不会输出后续音频**。
>
> 取消后，**可在当前 WebSocket 连接上重新发起语音合成任务**（发送新的 `run-task` 事件），无需重新建立连接。
>
> **模型限制**：
> - 华北2（北京）地域：CosyVoice 系列模型仅 **v2 及以上**版本支持该功能。
> - **新加坡地域：CosyVoice 系列模型不支持该功能。**

#### 3.2.4 TTS 服务端事件

官方说明（[CosyVoice 服务端事件](https://help.aliyun.com/zh/model-studio/cosyvoice-server-events)）：

`result-generated` 的 `payload.output.type` 取值：
- `sentence-begin`：句子开始，返回待合成的文本内容
- `sentence-synthesis`：**标识音频数据块，每个事件后立即通过 WebSocket binary 通道传输一个音频数据帧**
- `sentence-end`：句子结束，返回文本内容和累计字符数

`task-started`（官方样例）：

```json
{
  "header": {
    "task_id": "2bf83b9a-baeb-4fda-8d9a-xxxxxxxxxxxx",
    "event": "task-started",
    "attributes": {}
  },
  "payload": {}
}
```

`sentence-begin`（官方样例）：

```json
{
  "header": {
    "task_id": "3f2d5c86-0550-45c0-801f-xxxxxxxxxx",
    "event": "result-generated",
    "attributes": {}
  },
  "payload": {
    "output": {
      "sentence": {
        "index": 0,
        "words": []
      },
      "type": "sentence-begin",
      "original_text": "床前明月光，"
    }
  }
}
```

`sentence-synthesis`（官方样例）——**收到此事件 ⇒ 紧接着有一个二进制音频帧**：

```json
{
    "header": {
        "task_id": "3f2d5c86-0550-45c0-801f-xxxxxxxxxx",
        "event": "result-generated",
        "attributes": {}
    },
    "payload": {
        "output": {
            "sentence": {
                "index": 0,
                "words": []
            },
            "type": "sentence-synthesis"
        }
    }
}
```

`sentence-end`（官方样例）：

```json
{
  "header": {
    "task_id": "3f2d5c86-0550-45c0-801f-xxxxxxxxxx",
    "event": "result-generated",
    "attributes": {}
  },
  "payload": {
    "output": {
      "sentence": {
        "index": 0,
        "words": [
          {
            "text": "床",
            "begin_index": 0,
            "end_index": 1,
            "begin_time": 0,
            "end_time": 263
          }
        ]
      },
      "type": "sentence-end",
      "original_text": "床前明月光，"
    },
    "usage": {
      "characters": 6
    }
  }
}
```

`task-finished`（官方样例，注意 `attributes.request_uuid`）：

```json
{
  "header": {
    "task_id": "2bf83b9a-baeb-4fda-8d9a-xxxxxxxxxxxx",
    "event": "task-finished",
    "attributes": {
      "request_uuid": "0a9dba9e-d3a6-45a4-be6d-xxxxxxxxxxxx"
    }
  },
  "payload": {
    "usage": {
      "characters": 13
    }
  }
}
```

`task-failed`（官方样例）：

```json
{
  "header": {
    "task_id": "2bf83b9a-baeb-4fda-8d9a-xxxxxxxxxxxx",
    "event": "task-failed",
    "error_code": "InvalidParameter",
    "error_message": "[tts:]Engine return error code: 418",
    "attributes": {}
  },
  "payload": {}
}
```

---

### 3.3 路线 2 · NLS 实时语音识别（`StartTranscription`）

官方原文（[实时语音识别 WebSocket 协议](https://help.aliyun.com/zh/isi/user-guide/websocket)）：

> 1. 携带 Token 建立 WebSocket 连接。
> 2. 发送 `StartTranscription` 指令，等待 `TranscriptionStarted` 事件。
> 3. 以二进制帧分片发送音频，同时处理 `SentenceBegin`、`TranscriptionResultChanged` 和 `SentenceEnd` 事件。**中间结果仅在开启相应参数后返回。**
> 4. 音频发送完毕后，发送 `StopTranscription` 指令。
> 5. 收到 `TranscriptionCompleted` 后关闭连接。发生错误时，读取 `TaskFailed` 事件中的状态码和错误信息。

**Header 格式（原文表格）**：

| 参数 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `appkey` | String | 是 | 项目的 Appkey。 |
| `message_id` | String | 是 | 当前消息的唯一 ID，由客户端生成，**包含 32 个十六进制字符**。每条指令使用新的 ID。 |
| `task_id` | String | 是 | 当前识别任务的唯一 ID，**包含 32 个十六进制字符**。同一任务的所有指令保持一致。 |
| `namespace` | String | 是 | 固定为 `SpeechTranscriber`。 |
| `name` | String | 是 | 指令名称：`StartTranscription` 或 `StopTranscription`。 |

`StartTranscription`（官方样例原样引用）：

```json
{
  "header": {
    "message_id": "05450bf69c53413f8d88aed1ee600001",
    "task_id": "640bc797bb684bd69601856513070001",
    "namespace": "SpeechTranscriber",
    "name": "StartTranscription",
    "appkey": "<your_appkey>"
  },
  "payload": {
    "format": "pcm",
    "sample_rate": 16000,
    "enable_intermediate_result": true,
    "enable_punctuation_prediction": true,
    "enable_inverse_text_normalization": true
  }
}
```

`StopTranscription`（官方样例原样引用）：

```json
{
  "header": {
    "message_id": "05450bf69c53413f8d88aed1ee600002",
    "task_id": "640bc797bb684bd69601856513070001",
    "namespace": "SpeechTranscriber",
    "name": "StopTranscription",
    "appkey": "<your_appkey>"
  }
}
```

事件样例（全部官方原样引用）：

`TranscriptionStarted`：
```json
{
  "header": {
    "namespace": "SpeechTranscriber",
    "name": "TranscriptionStarted",
    "task_id": "640bc797bb684bd69601856513070001",
    "status": 20000000,
    "status_text": "Gateway:SUCCESS:Success."
  }
}
```

`SentenceBegin`：
```json
{
  "header": {"name": "SentenceBegin", "status": 20000000},
  "payload": {"index": 1, "time": 0}
}
```

`TranscriptionResultChanged`（**中间结果**）：
```json
{
  "header": {"name": "TranscriptionResultChanged", "status": 20000000},
  "payload": {
    "index": 1,
    "time": 1000,
    "result": "今天天气",
    "words": [
      {"text": "今天", "startTime": 0, "endTime": 500},
      {"text": "天气", "startTime": 500, "endTime": 1000}
    ]
  }
}
```

`SentenceEnd`（**最终结果**）：
```json
{
  "header": {"name": "SentenceEnd", "status": 20000000},
  "payload": {
    "index": 1,
    "time": 1500,
    "begin_time": 0,
    "result": "今天天气很好。"
  }
}
```

`TranscriptionCompleted`：
```json
{
  "header": {
    "namespace": "SpeechTranscriber",
    "name": "TranscriptionCompleted",
    "task_id": "640bc797bb684bd69601856513070001",
    "status": 20000000,
    "status_text": "Gateway:SUCCESS:Success."
  }
}
```

**⚠️ 字段命名陷阱（务必注意）**：NLS 实时识别里 **时间戳字段是驼峰 `startTime`/`endTime`**，而 DashScope 里是**下划线 `begin_time`/`end_time`**。两套适配器绝不能混用字段名。

**音频发送建议（官方 FAQ 原文）**：

> 按音频时长分片发送，例如 16000 Hz、16 bit、单声道 PCM 每 100 ms 对应 **3200 字节**，8000 Hz 时对应 1600 字节。分片大小不限定为这两个值；**发送节奏需与音频时长匹配**。

> **如何生成 message_id 和 task_id？** 由客户端生成 32 个十六进制字符组成的唯一 ID。同一识别任务始终使用同一个 `task_id`；每次发送指令时生成新的 `message_id`。

---

### 3.4 路线 2 · NLS 一句话识别（`StartRecognition`）— 名字完全不同！

⚠️ **一句话识别与实时识别是两套不同的指令/事件名，别抄错。**

官方原文（[一句话识别 API 参考](https://help.aliyun.com/zh/isi/developer-reference/api-reference-1)）：

- 指令：`StartRecognition` → 事件 `RecognitionStarted`
- 中间结果事件：`RecognitionResultChanged`（`payload.result`）
- 最终结果事件：`RecognitionCompleted`（`payload.result`）
- 音频上限：**不超过 60 秒**，**不超过 2 MB**
- 命名空间：`SpeechRecognizer`（**注意不是 `SpeechTranscriber`**）

官方事件样例：

```json
{
  "header": {
    "namespace": "SpeechRecognizer",
    "name": "RecognitionResultChanged",
    "status": 20000000,
    "message_id": "f2bc60c1fd834da1bef7b9929fd1****",
    "task_id": "7ce7bac115844c109c680da4bf28****",
    "status_text": "Gateway:SUCCESS:Success."
  },
  "payload": {
    "result": "开始测试今天北京的天气很好我想购买三十二个苹果请拨打电话一二三四五结束测试"
  }
}
```

```json
{
  "header": {
    "namespace": "SpeechRecognizer",
    "name": "RecognitionCompleted",
    "status": 20000000,
    "message_id": "22ac941179bf45a8989d660bd9e8****",
    "task_id": "7ce7bac115844c109c680da4bf28****",
    "status_text": "Gateway:SUCCESS:Success."
  },
  "payload": {
    "result": "开始测试今天北京的天气很好我想购买三十二个苹果请拨打电话一二三四五结束测试"
  }
}
```

**一句话识别 RESTful（更简单，但延迟高）**（[RESTful API](https://help.aliyun.com/zh/isi/developer-reference/restful-api-2)）：

```
POST https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/asr?appkey=<appkey>&format=pcm&sample_rate=16000
X-NLS-Token: <token>
Content-Type: application/octet-stream
```

成功响应（官方样例）：

```json
{
  "task_id": "cf7b0c5339244ee29cd4e43fb97f****",
  "result": "北京的天气。",
  "status": 20000000,
  "message": "SUCCESS"
}
```

---

### 3.5 路线 2 · NLS 语音合成

NLS 有**三条**合成路径，需要区分：

#### (a) 短句合成 RESTful（非流式，最简单）

官方原文（[语音合成 RESTful API](https://help.aliyun.com/zh/isi/user-guide/restful-api-3)）：

> 单次请求的文本**不超过 300 个字符**，超过的字符会被截断。更长的文本需要分段合成，再拼接音频。

```
https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/tts
```

参数（原文）：`appkey`(必)、`text`(必)、`token`（或 `X-NLS-Token` 头）、`format` ∈ `pcm`/`wav`/`mp3`（**默认 `pcm`**）、`sample_rate` 支持 `8000`/`16000`（默认 `16000`；默认发音人 `xiaoyun` 还支持 `24000`）、`voice`（默认 `xiaoyun`）、`volume`(0~100，默认50)、`speech_rate`(-500~500，默认0)、`pitch_rate`(-500~500，默认0)、`chunk`(bool，启用 HTTP Chunked 流式接收)

> ✅ `Content-Type` 为 `audio/mpeg` 时响应体是音频二进制。**该响应头不表示请求的音频格式一定是 MP3；实际音频格式由 `format` 决定**（官方明确警告）。

失败响应（官方样例）：
```json
{
    "task_id":"8f95d0b9b6e948bc98e8d0ce64b0****",
    "result":"",
    "status":40000000,
    "message":"Gateway:CLIENT_ERROR:in post data, json format illegal"
}
```

#### (b) 短句合成 WebSocket（流式）

官方端点与 ASR 相同：`wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1`（[语音合成概述](https://help.aliyun.com/zh/isi/user-guide/overview-of-speech-synthesis)）。

流程（原文）：
> 1. **鉴权**：客户端与服务端建立 WebSocket 连接时，使用 Token 进行鉴权。
> 2. **开始合成**：客户端发起语音合成请求，在请求消息中进行参数设置
> 3. **接收合成数据**：服务端返回合成的语音二进制数据
> 4. **结束合成**：语音合成完毕，服务端发送合成完毕事件通知

参数：`appkey`(必)、`text`(必，**不超过 300 个字符**)、`voice`(默认 `xiaoyun`)、`format`(`pcm`/`wav`/`mp3`，默认 `pcm`)、`sample_rate`(默认 16000)、`volume`、`speech_rate`、`pitch_rate`、`enable_subtitle`

结束事件（官方样例原样引用）：

```json
{
    "header": {
        "message_id": "05450bf69c53413f8d88aed1ee60****",
        "task_id": "640bc797bb684bd6960185651307****",
        "namespace": "SpeechSynthesizer",
        "name": "SynthesisCompleted",
        "status": 20000000,
        "status_message": "GATEWAY|SUCCESS|Success."
    }
}
```

失败事件（官方样例原样引用）：

```json
{
   "header":{
      "namespace":"Default",
      "name":"TaskFailed",
      "status":41020001,
      "message_id":"62c126f7d9b340deb82b5b7eaca0****",
      "task_id":"4552df26d1f547aab9a2c4a94678****",
      "status_text":"TTS:TtsClientError:[tts]Engine return error code: 418"
   }
}
```

> **【不确定】** 短句合成 WebSocket 的**「开始合成」指令的确切 `name` 值**（例如是否为 `StartSynthesis`）在可访问的官方页面中**未找到完整指令表**。错误码表里出现过来自服务端的提示 `the last directive is 'StartSynthesis'`，暗示该指令名可能为 `StartSynthesis`，但**这来自错误消息字符串，不是指令规格表**，我不建议据此硬编码。
>
> **建议**：若选 NLS 流式合成，**直接使用官方 Node.js SDK `alibabacloud-nls`**（见 §3.6），由 SDK 负责指令名，避免猜错。

#### (c) CosyVoice 大模型流式合成（NLS 网关上的新版）

NLS 文档里有一个独立服务项「**流式文本语音合成（CosyVoice大模型）**」，商用版 **10 路并发**（[并发与 QPS 说明](https://help.aliyun.com/zh/isi/getting-started/faq-about-concurrency-and-monitoring)）。

错误码文档提到：
> 若使用 CosyVoice-V2 音色报此错误，请确认使用北京区域的 WebSocket 网关地址（`wss://nls-gateway-cn-beijing.aliyuncs.com/ws/v1`），**CosyVoice大模型音色仅在北京区域可用**。

> **注意**：这是 NLS 侧的 CosyVoice 通道，与 DashScope 侧的 CosyVoice 是两套东西。不要混淆。

---

### 3.6 路线 2 的官方 Node.js SDK（绕开猜指令名的风险）

官方文档（[一句话识别 Node.js SDK](https://help.aliyun.com/zh/isi/developer-reference/sdk-for-node-js-2)）：

```bash
npm install alibabacloud-nls
```

```javascript
const Nls = require('alibabacloud-nls')
//Nls内部含SpeechRecognition, SpeechTranscription, SpeechSynthesizer
```

**一句话识别 `defaultStartParams()` 返回（官方原文）**：

```javascript
{
    "format": "pcm",
    "sample_rate": 16000,
    "enable_intermediate_result": true,
    "enable_punctuation_predition": true,
    "enable_inverse_text_normalization": true
}
```

> ⚠️ 注意官方文档此处的键名 **`enable_punctuation_predition`** 拼写为 `predition`（少一个 `c`），
> 而接口说明里的参数名是 `enable_punctuation_prediction`。**这是官方文档自身的拼写不一致**。
> 这是 SDK 层面还是文档笔误，我**无法确认**。若走 SDK 请以实际 SDK 行为为准，不要照抄。

SDK 事件回调名（原文）：`started` / `changed` / `completed` / `closed` / `failed`

SDK 方法（原文）：`start(param, enablePing, pingInterval)`、`close(param)`、`shutdown()`、`sendAudio(data)`
- `enablePing` 默认 false；`pingInterval` 默认 6000 ms

官方 Node.js 示例中的常量（原文）：

```javascript
const URL = "wss://nls-gateway.cn-shanghai.aliyuncs.com/ws/v1"
const APPKEY = "Your Appkey"
const TOKEN = "Your Token"
```

> 注意官方这一句示例的域名是 `nls-gateway.cn-shanghai.aliyuncs.com`（网关与地域之间是**点**），
> 而 RESTful/协议页多用 `nls-gateway-cn-shanghai.aliyuncs.com`（**连字符**）。两处写法在官方文档中并存，**我不敢断定哪个是笔误**。建议以服务端实际可达为准测试。

---

## 4. 音频格式

### 4.1 DashScope（路线 1）

| 项 | ASR（上行） | TTS（下行） |
|---|---|---|
| 编码 | `pcm` / `wav` / `mp3` / `opus` / `speex` / `aac` / `amr`（Paraformer 参数 `format`） | `pcm` / `wav` / `mp3` / `opus` |
| 约束 | opus/speex **必须 Ogg 封装**；wav **必须 PCM 编码**；amr 仅 AMR-NB | cosyvoice-v1 不支持 opus |
| 采样率 | `paraformer-realtime-v2` **任意**；`paraformer-realtime-8k-v2` 仅 8000 Hz | 8000 / 16000 / **22050（默认）** / 24000 / 44100 / 48000 |
| 位深 | **【不确定】** 文档未在 Paraformer 页明确写位深 | **【不确定】** 文档未写位深 |
| 声道 | **单声道**（原文："客户端开始发送二进制音频（须为单声道音频）"） | 单声道（推测，文档未明写 → **【不确定】**） |
| 裸 PCM | ✅ 接受（`format: "pcm"`，二进制帧） | ✅ 支持 `pcm` 输出 |
| 默认输出 | — | **`mp3`，22050 Hz**（文档明确） |

官方实时 ASR 音频规格表（[语音识别概述](https://help.aliyun.com/zh/model-studio/asr-model)）关键行：

| 模型 | 音频格式 | 采样率 |
|---|---|---|
| Qwen-Audio-3.x-ASR-Flash-Streaming | `pcm`,`wav`,`mp3`,`opus`,`speex`,`aac`,`amr` | 任意 |
| Fun-ASR-Realtime | 同上 | 任意 |
| Qwen-ASR-Realtime (`qwen3-asr-flash-realtime`) | **仅 `pcm`,`opus`** | 8k、16k |
| Paraformer-Realtime | 同 Fun-ASR | v2 任意；8k-v2 8kHz |

> 原文：**所有实时模型均为单声道输入。**

### 4.2 NLS（路线 2）

| 项 | ASR（上行） | TTS（下行） |
|---|---|---|
| 编码 | `pcm` / `wav` / `ogg 封装 opus` / `ogg 封装 speex` / `amr` / `mp3` / `aac` | `pcm` / `wav` / `mp3` |
| 采样率 | **仅 8000 或 16000 Hz** | 8000 / 16000（默认 16000）；`xiaoyun` 还支持 24000 |
| 位深 | **16 bit**（原文明确："PCM 采样位数为 16 bit"，"单声道、16 bit 采样位数"） | **【不确定】** |
| 声道 | **单声道**（原文明确） | **【不确定】** |
| 裸 PCM | ✅ 接受 | ✅ 默认就是 `pcm` |
| 默认输出 | — | **`pcm`，16000 Hz** |

官方原文（实时识别）：

> 支持的输入格式：PCM、PCM 编码的 WAV、OGG 封装的 OPUS、OGG 封装的 SPEEX、AMR、MP3、AAC。**音频需为单声道，PCM 采样位数为 16 bit。**
> 支持的音频采样率：**8000 Hz、16000 Hz**。音频、请求参数和项目所选模型的采样率需匹配。

> **关键差异**：NLS 采样率**只有 8k/16k 两档**，且必须与控制台项目模型匹配；DashScope 支持任意采样率（部分模型）。

---

## 5. ASR 语义

### 5.1 DashScope（Paraformer / 实时模型）

| 问题 | 答案 | 依据 |
|---|---|---|
| 有增量（partial）结果？ | ✅ 有 | `result-generated` 事件 |
| 有最终（final）结果？ | ✅ 有 | 同一事件 |
| **如何区分 partial / final？** | **`payload.output.sentence.sentence_end`**：`false` = 中间结果，`true` = 最终结果 | 官方："是否句子结束（true=最终结果，false=中间结果）" |
| 文本字段 | **`payload.output.sentence.text`** | 官方样例 |
| 自带 VAD/断句？ | ✅ 自带。`semantic_punctuation_enabled=false`（默认）时用 **VAD 断句**；`=true` 时用**语义断句**并关闭 VAD | 官方参数表 |
| 断句阈值参数 | `max_sentence_silence`（默认 1300 ms，范围 200–6000） | 官方参数表 |
| 心跳 | `heartbeat: true` + 持续发静音 PCM 即可保活 | 官方参数表 |
| 心跳结果如何跳过 | `payload.output.sentence.heartbeat === true` → 跳过该结果 | 官方："若为 true，可跳过该结果（心跳包）" |
| 结束一次听写 | 发 `finish-task`，等 `task-finished` | 官方流程 |
| 计费时长 | `payload.usage.duration`（秒），仅在 `sentence_end=true` 时有值 | 官方："当 `sentence_end` 为 `false` 时，`usage` 为 `null`" |
| 单连接时长上限 | **【不确定】**。Paraformer 页未写上限；但 [语音识别概述](https://help.aliyun.com/zh/model-studio/asr-model) 的"音频最大时长"列中，所有实时模型（含 Paraformer-Realtime）均为「**无限制**」/「不限」 | 见 §4.1 表 |
| 并发上限 | **【不确定】**。`help.aliyun.com/zh/model-studio/rate-limit` 页面（已访问）**未包含音频类模型的 RPM/TPM 行**，其目录只覆盖文本生成/Omni/OCR 等 | 已实际访问该页确认 |
| 断线重连续传 | **【不确定】**。文档未提及续传机制 | — |
| 错误码 | `header.error_code` + `header.error_message`（`task-failed` 事件） | 官方样例 `CLIENT_ERROR` |

> ⚠️ **注意 `finish-task` 之后仍会继续收到 `result-generated`**（官方流程第 4 步明说"并继续接收服务端返回的 result-generated 事件"）。
> 适配器**不能在发完 EOS 就立刻丢弃消息**。

### 5.2 NLS

| 问题 | 答案 | 依据 |
|---|---|---|
| 有增量结果？ | ✅ 但**默认关闭**，需 `enable_intermediate_result: true` | 官方参数表默认 `false` |
| 有最终结果？ | ✅ | `SentenceEnd` / `RecognitionCompleted` |
| **如何区分 partial / final？** | **靠事件名**：`TranscriptionResultChanged` = 中间；`SentenceEnd` = 句末；`TranscriptionCompleted` = 任务完成 | 官方事件表 |
| 文本字段 | 均为 **`payload.result`** | 官方样例 |
| 自带 VAD/断句？ | ✅ `max_sentence_silence`（默认 **800** ms，范围 200–2000 用于一句话 / 200–6000 用于实时） | 官方参数表 |
| 语义断句 | `enable_semantic_sentence_detection`（默认 false）；**必须同时开 `enable_intermediate_result=true`** | 官方参数表 |
| 结束 | 发 `StopTranscription`，等 `TranscriptionCompleted` 后关闭 | 官方流程 |
| 单连接时长上限 | **【不确定】** 未找到明确上限 | — |
| **并发上限** | ✅ **明确**：一句话识别、实时语音识别 免费试用 **2 路**，商用 **200 路** | [并发与 QPS 说明](https://help.aliyun.com/zh/isi/getting-started/faq-about-concurrency-and-monitoring) |
| 空闲超时 | ⚠️ **10 秒**！`40000004 Gateway:IDLE_TIMEOUT` | 官方错误码表 |
| 一句话识别时长 | **≤ 60 秒**，**≤ 2 MB** | 官方 |
| 重要行为 | 官方："**最后一次中间结果可能与最终结果不同，以 `RecognitionCompleted` 中的结果为准。**" | 官方原文 |

> **对你的"心跳/保活"约束**：NLS 的空闲超时是 **10 秒**（建立连接后长时间不发数据即断），且实时识别要求
> `41040201 Realtime:GET_CLIENT_DATA_TIMEOUT:Client data does not send continuously!`
> → **NLS 必须按实时速率持续送音频**，不能只在有声音时送。DashScope 有 `heartbeat` 参数可兜底。

---

## 6. TTS 语义

| 问题 | DashScope（CosyVoice） | NLS（短句合成） |
|---|---|---|
| 文本可流式追加？ | ✅ `continue-task` 可多次发送，**最多 20000 字符/次、200000 字符累计**；发送间隔**不得超过 23 秒** | ❌ 一次 ≤ **300 字符**，超出截断 |
| 音频流式分片？ | ✅ 分片。**`result-generated` 且 `output.type == "sentence-synthesis"` ⇒ 紧接一个 binary 音频帧** | ✅ 流式（`chunk=true` / WebSocket binary）；但仍受 300 字符限制 |
| **结束标记是什么？** | **三个层级**，务必区分：<br>• `output.type == "sentence-end"` = **一句**结束<br>• `header.event == "task-finished"` = **整个任务**结束<br>• 音频分片本身**没有 `is_last` 字段**，靠 `task-finished` 判定全部结束 | • `header.name == "SynthesisCompleted"` = 合成完毕<br>• RESTful 无事件，靠 HTTP 响应体结束 |
| **能否中途取消？** | ✅ **能**。`finish-task` + `payload.input.directive = "cancel"`，服务端**立即返回 `task-finished` 且不再输出后续音频**，且可在**同一条连接上重新 `run-task`**<br>⚠️ 限制：北京仅 CosyVoice **v2+**；**新加坡不支持** | **【不确定】** 未在官方文档中找到等价的"取消合成"指令 |
| 并发上限 | **【不确定】**（百炼限流页未覆盖音频模型） | ✅ 语音合成 免费 2 路 / 商用 **200 路**；**流式文本语音合成（CosyVoice大模型）商用 10 路，不支持试用** |
| 单次文本长度上限 | **20000 字符/次**，**200000 字符**累计 | **300 字符**（超出截断） |
| 音色/语速参数 | `voice` / `rate`(0.5–2.0) / `pitch`(0.5–2.0) / `volume`(0–100) / `bit_rate` / `instruction` | `voice`(默认 `xiaoyun`) / `speech_rate`(-500~500) / `pitch_rate`(-500~500) / `volume`(0–100) |
| 结束任务是否必须 | ✅ **必须**发 `finish-task`，官方明说"此步骤不可省略，否则可能导致语音数据不完整" | **【不确定】** |

> **对你"停播 <100ms"约束的影响**：
> DashScope 的 `directive: cancel` 是**服务端**取消，往返延迟仍是网络 RTT。
> **前端仍必须先做本地预停**（停掉 `<audio>` / `AudioBufferSourceNode` 播放），
> 再异步发 `cancel` 释放服务端算力。这与你的 ADR 一致——不要为了 `cancel` 牺牲预停速度。

> **对"预停 + 代次隔离"的额外提醒**：CosyVoice 一个 `run-task` 内会有**多个句子**，
> 每个句子有独立的 `sentence.index`。若上一轮任务尚未 `task-finished` 就发起新任务，且**复用了同一个 `task_id`**，
> 官方明确警告会「**音频错乱或任务失败**」。所以**每轮合成必须用新 `task_id`（UUID）**，与你现有播放代次机制天然契合。

---

## 7. 浏览器直连可行性

### 7.1 结论：**两条路线都必须经后端中转。**

### 7.2 NLS：官方明文禁止前端直连

官方原文（[一句话识别 RESTful API](https://help.aliyun.com/zh/isi/developer-reference/restful-api-2)）：

> **不要在浏览器前端代码中直接调用该接口。** 浏览器可能因跨域资源共享（CORS）限制而拒绝请求，而且**前端代码会暴露 AppKey 和 Token**。

官方另一处（长文本语音合成 RESTful）：

> 建议在服务端调用接口，**避免在浏览器端暴露鉴权 Token**。

> 另外，NLS 的 WebSocket 把 token 放在 **URL query** 里，这比 Header 更糟——URL 会进浏览器历史、
> 服务器访问日志、Referer。**绝不可在前端持有 NLS Token。**

### 7.3 DashScope：浏览器技术上无法携带鉴权 Header

这是最硬的约束，与文档无关、是 Web 平台规范：

- DashScope 的鉴权是 **握手阶段的 HTTP Header** `Authorization: Bearer <API_KEY>`（官方明确）。
- **浏览器 `WebSocket` API 规范不允许设置自定义请求头**（构造函数只接受 `(url, protocols)`）。
- 因此**浏览器无法直连 DashScope 的 `/api-ws/v1/inference`**，除非：
  - 把 API Key 放进 URL（DashScope 不支持这种鉴权），或
  - 用官方前端 SDK（DashScope 的浏览器/移动 SDK 会封装鉴权）。

官方关于协议的表述（[Realtime API 概述](https://help.aliyun.com/zh/model-studio/realtime-api-overview)）：

| 维度 | AOQ | WebRTC | WebSocket |
|---|---|---|---|
| 适用场景 | AI 多模态实时交互、弱网场景 | **浏览器端互动**、传统音视频通话 | **服务端集成**、快速原型验证 |
| 浏览器兼容性 | **不支持** | 原生支持 | 原生支持 |
| 回声消除/降噪 | 内置 | 内置 | **无，需客户端自行处理** |

> ⚠️ 注意"浏览器兼容性：原生支持"指的是**协议能被浏览器发起**，**不等于官方支持你用浏览器带 API Key 直连**。
> 官方 TS/JS 样例（如 TTS Realtime 的 Python/Java 客户端）全部以 `Authorization: Bearer` 头连接，属于**服务端**用法。
> 如果目标是**浏览器直连**，官方给的答案是走 **WebRTC** 或 **AOQ**（AOQ 不支持浏览器）。

> **【不确定】** DashScope 是否存在"浏览器端签发临时 Token 用于 WebSocket 鉴权"的官方机制。
> Realtime API 概述的协议对比表里有一行 `Token Plan`（AOQ/WebRTC/WebSocket 三者都写"支持"），
> 但**该页未展开说明 Token Plan 是什么、如何在浏览器中用于 WebSocket 鉴权**。我不会据此推断出具体字段名。

### 7.4 推荐架构（对你现有项目）

```
浏览器 (Web Audio)                    Node.js/TS 后端                阿里云
─────────────────                    ──────────────                ──────
getUserMedia({echoCancellation})                                   
  → AudioWorklet 采集 PCM 16k/16bit                                
  → 内部 WS (你自己的协议) ────────►  AsrPort 适配器 ──WSS+Header──► DashScope ASR
                                     (持有 DASHSCOPE_API_KEY)       wss://{ws}.maas...
                                     
  播放队列 + <100ms 本地预停 ◄────── TtsPort 适配器 ◄──binary 音频── DashScope TTS
  (播放代次 token 仲裁)               (发 directive: cancel 释放服务端)
```

**要点**：
1. 浏览器只连**你自己的后端**，凭据永不离开服务端。
2. 后端到阿里云用**独立 WebSocket 连接**，不复用 Master/LLM 的 HTTP 通道（你 ADR 里的约束 1）。
3. ASR 上行与 TTS 下行建议**分两条连接**，避免一条连接上的双向背压互相影响。
4. 前端保留 `<100ms` 预停，`cancel` 只作为服务端算力回收。

---

## 8. 取舍建议

### 8.1 选哪条路线：**选路线 1（DashScope / 百炼）**

理由（按权重排序）：

**① 官方明确把 paraformer / sambert 标记为过时**（这直接否掉了你原本的选型）

[语音识别概述](https://help.aliyun.com/zh/model-studio/asr-model) 原文：
> Paraformer 是较早一代的 ASR 模型……**若您的业务允许，建议迁移到前文推荐的 Fun-ASR 或 Qwen-ASR。**

[实时语音合成](https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide) 原文：
> **Sambert 为早期语音合成模型，新项目建议优先使用 CosyVoice 或 Qwen-Audio-TTS**，可获得更好的合成效果和更丰富的功能支持。

→ 所以「**paraformer-realtime 系列 + sambert 系列**」这个组合**按官方当前口径属于不推荐路线**。
实时 ASR 官方首选：`qwen-audio-3.1-asr-flash-streaming`；实时 TTS 官方首选：`cosyvoice-v3.5-plus` / `qwen-audio-3.0-tts-plus`。

**② DashScope 支持服务端取消合成，NLS 未找到**

`directive: cancel` 直接支撑你「停播」约束的服务端侧。NLS 侧【不确定】。

**③ 鉴权更适合服务端架构**

DashScope 一个长期 API Key 放 `.env` 即可；NLS 需要 AccessKey（权限远大于 API Key，泄露后果严重得多）+ Appkey，
还要自己实现 Token 缓存与定时刷新（官方明说不使用固定时长，必须按 `ExpireTime` 刷新）。

**④ 模型可热切换，无需控制台操作**

DashScope 换模型只改请求报文的 `model` 字段；NLS 必须去控制台改项目配置，且**语种/采样率由项目模型决定，请求参数无法切换**。这对多语种/AB 测试很致命。

**⑤ 无 300 字符硬限制**

DashScope TTS 单次 20000 字符；NLS 300 字符截断，长回复必须自己切分拼接。

### 8.2 NLS 是否已停止推荐 / 被 DashScope 取代？

**没有官方公告说 NLS 已下线或停止推荐**（我在可访问的官方页面上**没有**找到这类公告 → 不要传播"已废弃"的说法）。

但客观事实是：
- AI 主推叙事（模型广场、选型指南、协议对比）**全部在 `model-studio` 侧**；
- NLS 侧仍是「控制台建项目 + Appkey」的老模型，**没有模型选择/升级能力**；
- NLS 的并发是买路数的（商用 200 路 / CosyVoice 流式 10 路），DashScope 走 RPM/TPM 限流；
- NLS 文档里的 CosyVoice 通道也说明阿里在把新模型往 NLS 网关上搬，但**主推渠道仍是百炼**。

→ 稳妥表述：**NLS 处于维护状态、不在 AI 主推路径上；新项目按官方指引应选百炼。**

### 8.3 成本

**【不确定】** 两边的音频类计费单价我**均未从本次访问的官方页面取得可靠数字**
（百炼限流页未覆盖音频模型，计费页未访问）。**不要依据本文做成本决策**，请查：
- 百炼：`help.aliyun.com/zh/model-studio/model-pricing`
- NLS：`help.aliyun.com/document_detail/84881.html`

可确认的计费**计量单位**（官方）：
- DashScope ASR：`payload.usage.duration`（**秒**），仅在 `sentence_end=true` 时返回
- DashScope TTS：`payload.usage.characters`（**累计字符数**）
- NLS：按并发路数 + 时长/字符

### 8.4 稳定性与文档质量

| 维度 | DashScope | NLS |
|---|---|---|
| 文档完整度 | 高，字段级表格齐全，样例报文完整 | 中，实时 ASR 完整；**短句合成 WebSocket 指令表缺失** |
| 文档一致性 | 较好 | **较差**：域名连字符/点号并存、`predition` 拼写错误、指令名靠错误消息推断 |
| 官方 Node SDK | **无**（仅 Java/Python） | **有** `alibabacloud-nls` |
| 超时保障 | 专属域名 3600s / DashScope 域名 600s | 空闲 10s 断连 |
| SLA | 99.9%（专属域名与 DashScope 域名） | **【不确定】** |

**这条是对路线 1 的唯一减分项**：Node.js 没有官方 DashScope SDK，**必须自己实现 WebSocket 协议**
（也就是本文 §3.1–3.2 的那些报文）。但报文已完整给出，工作量可控。

### 8.5 给你的最终建议

1. **主路线**：DashScope，模型用 `qwen-audio-3.1-asr-flash-streaming` + `cosyvoice-v3.5-plus`（或 `fun-asr-realtime` + `qwen-audio-3.0-tts-plus`）。
2. **务必先确认 `WorkspaceId`**，并直接用**业务空间专属域名**（别从 `dashscope.aliyuncs.com` 起步，2026-09-30 后不再支持新特性）。
3. **先做 TTS**（你的 M6a 计划是对的）：TTS 是单向流，先验证 `<100ms` 预停 + 代次不复活 + `directive: cancel`。
4. **再做 ASR**：注意 `finish-task` 后仍会来 `result-generated`；开 `heartbeat: true` 解决保活。
5. **NLS 作为备份**：因为 NLS 有官方 Node SDK，若自研 WebSocket 协议遇阻，NLS 一句话识别 + 短句合成 RSFful 是可用的降级方案（但失去流式体验）。

---

## 9. 给实施者的最小接入清单

> 目标：让另一个人（或另一个模型）**只凭这一节就能写出正确的适配器**，不需要再猜。
> 若清单里任何一项标了 **【不确定】**，实施者**必须先去官方文档确认，不得凭直觉填写**。

### 9.1 必需项（缺一项就写不出适配器）

| # | 信息 | 路线 1 已确认值 | 路线 2 已确认值 |
|---|---|---|---|
| 1 | **协议** | WebSocket (WSS) | WebSocket (WSS) + HTTP (RESTful) |
| 2 | **ASR 端点** | `wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference` | `wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1?token={token}` |
| 3 | **TTS 端点** | 与 ASR **同一 URL**（靠 `payload.task=tts` 区分） | WS 同上；RESTful: `https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/tts` |
| 4 | **鉴权方式** | 握手 Header `Authorization: Bearer {API_KEY}` | URL query `token` + 每指令 `header.appkey` |
| 5 | **凭据变量名** | `DASHSCOPE_API_KEY`、`DASHSCOPE_WORKSPACE_ID` | `ALIYUN_AK_ID`、`ALIYUN_AK_SECRET`、`NLS_APP_KEY` |
| 6 | **Token 刷新** | 不需要（长期 Key） | 必须。按 `Token.ExpireTime`（Unix 秒）刷新，**不可硬编码时长** |
| 7 | **ASR 首帧** | `{header:{action:"run-task",task_id,streaming:"duplex"}, payload:{task_group:"audio",task:"asr",function:"recognition",model,input:{},parameters:{...}}}` | `{header:{message_id,task_id,namespace:"SpeechTranscriber",name:"StartTranscription",appkey}, payload:{format,sample_rate,...}}` |
| 8 | **ASR 音频帧** | WebSocket **binary 帧**，裸音频按 `format` 指定 | 同上，**binary 帧** |
| 9 | **ASR 结束帧 (EOS)** | `{header:{action:"finish-task",task_id,streaming:"duplex"}, payload:{input:{}}}` | `{header:{message_id,task_id,namespace:"SpeechTranscriber",name:"StopTranscription",appkey}}` |
| 10 | **ASR 结果帧** | `header.event=="result-generated"` → 文本在 `payload.output.sentence.text` | `header.name=="TranscriptionResultChanged"` → 文本在 `payload.result` |
| 11 | **partial / final 判据** | **`payload.output.sentence.sentence_end`**（false/true） | **靠事件名**：`TranscriptionResultChanged` vs `SentenceEnd` |
| 12 | **TTS 首帧** | `{header:{action:"run-task",...}, payload:{task_group:"audio",task:"tts",function:"SpeechSynthesizer",model,input:{},parameters:{text_type:"PlainText",voice,format,sample_rate,...}}}` | 【不确定】：短句合成 WS 起始指令 `name` 未在文档中找到 → **改用官方 SDK `alibabacloud-nls`** |
| 13 | **TTS 文本帧** | `{header:{action:"continue-task",task_id,streaming:"duplex"}, payload:{input:{text}}}`（单次 ≤20000，累计 ≤200000，间隔 ≤23s） | 同上【不确定】；RESTful 则是 `text` 参数（≤300 字符） |
| 14 | **TTS 结束帧** | `{header:{action:"finish-task",...}, payload:{input:{}}}` **必须发** | 同上【不确定】 |
| 15 | **TTS 取消** | `{header:{action:"finish-task",...}, payload:{input:{directive:"cancel"}}}` | 【不确定】：未找到 |
| 16 | **TTS 音频分片** | `header.event=="result-generated"` 且 `payload.output.type=="sentence-synthesis"` ⇒ **紧随一个 binary 帧** | WS：binary 帧；RESTful：响应体 `Content-Type: audio/mpeg` |
| 17 | **TTS 结束判据** | `header.event=="task-finished"`（**音频分片无 `is_last` 字段**） | `header.name=="SynthesisCompleted"` |
| 18 | **音频上行格式** | 单声道；`format:"pcm"`,`sample_rate:16000`；paraformer-realtime-v2 支持任意采样率 | **单声道、16 bit**；采样率**仅 8000/16000**，**必须与控制台项目模型匹配** |
| 19 | **TTS 下行格式** | **默认 `mp3` @ 22050 Hz**；可设 `pcm`/`wav`/`opus` | **默认 `pcm` @ 16000 Hz**；可设 `pcm`/`wav`/`mp3` |
| 20 | **错误帧** | `header.event=="task-failed"` → `header.error_code` / `header.error_message`；**连接被关闭不可复用** | `header.name=="TaskFailed"` → `header.status` / `header.status_text` |
| 21 | **错误码基准** | HTTP 401/403 = 握手鉴权失败 | `status: 20000000` = 成功；`40000001` = Token 无效/过期；`40000005` = 并发超限 |
| 22 | **浏览器直连** | ❌ 必须后端中转（浏览器无法设握手 Header） | ❌ **官方明文禁止** |
| 23 | **心跳/保活** | `parameters.heartbeat: true` + 持续发静音 PCM | 必须持续按实时速率送音频；**空闲 10s 会被断（`40000004`）** |
| 24 | **并发上限** | 【不确定】（百炼限流页未覆盖音频模型） | 一句话识别/实时识别/语音合成：试用 2 路、商用 200 路；CosyVoice 流式合成商用 10 路 |
| 25 | **单连接时长上限** | 实时 ASR 标「无限制」（[asr-model](https://help.aliyun.com/zh/model-studio/asr-model)）；TTS 未标 | 【不确定】 |
| 26 | **单次文本长度上限** | 20000 字符/次，200000 累计 | **300 字符**（超出截断） |
| 27 | **必须唯一化的 ID** | `task_id`：每轮合成/每次识别**必须新 UUID**（复用会「音频错乱或任务失败」） | `task_id` + `message_id`：**各 32 位十六进制字符**；同任务 `task_id` 固定、每条指令 `message_id` 更新 |

### 9.2 音频参数速查（直接填进 port 定义）

```
// 路线 1（推荐）
ASR 上行:  pcm, 16000 Hz, mono, 16 bit（位深官方未写，按 PCM16 实现并实测确认）
TTS 下行:  pcm, 24000 Hz, mono        ← 显式设 format:"pcm" 以避开 mp3 解码
           或 mp3, 22050 Hz（默认）

// 路线 2
ASR 上行:  pcm, 16000 Hz, mono, 16 bit
TTS 下行:  pcm, 16000 Hz, mono
```

> 浏览器侧建议：`getUserMedia` 拿到的通常是 48kHz float32。
> **必须在 AudioWorklet 里重采样到 16000 Hz 并转 PCM16**，再送后端。
> TTS 下行若选 `pcm` 则前端可用 `AudioContext({sampleRate: 24000})` 直接构造 `AudioBuffer` 播放，
> **免去 mp3 解码**——这对你的 `<100ms` 预停约束更友好。

### 9.3 建议的 Port 签名（承接你现有 `AsrPort` / `TtsPort` 设计）

```typescript
interface AsrPort {
  open(opts: { sampleRate: 16000; format: 'pcm' }): Promise<void>;
  pushAudio(frame: Buffer): void;          // 裸 PCM16 二进制帧
  onPartial(cb: (text: string) => void): void;   // sentence_end === false
  onFinal(cb: (text: string) => void): void;     // sentence_end === true
  close(): Promise<void>;                  // 发 finish-task，等 task-finished
  // 注意：close() 之后仍可能收到 result-generated，须继续消费到 task-finished
}

interface TtsPort {
  synthesize(text: string): AsyncIterable<{ audio: Buffer; isLast: boolean }>;
  // isLast 由 task-finished 决定（源自 sentence-end vs task-finished 的区别）
  abort(requestId: string): Promise<void>;
  // = finish-task + payload.input.directive = 'cancel'（同连接可复用，无需重连）
}
```

### 9.4 最后三条硬提醒

1. **绝不猜字段名。** 本文所有字段名都来自官方样例。若你需要用本文未覆盖的字段，**先查官方文档**。
2. **NLS 的 partial/final 靠事件名区分，DashScope 靠 `sentence_end` 布尔值区分。** 两者适配器不能互相 copy-paste。
3. **两套时间戳字段名不同**：DashScope `begin_time`/`end_time`；NLS `startTime`/`endTime`（实时）但 `begin_time`/`end_time`（一句话 RESTful 响应里是 `begin_time`/`end_time`）。**同一个 NLS 产品内部都不一致。**

---

## 附：本文引用的官方文档 URL

### 路线 1（DashScope / 百炼）

- [Paraformer 模型接入方式](https://help.aliyun.com/zh/model-studio/paraformer-realtime-model-access)
- [WebSocket 接入指南（Paraformer ASR）](https://help.aliyun.com/zh/model-studio/websocket-for-paraformer-real-time-service)
- [实时语音识别（Paraformer）客户端事件](https://help.aliyun.com/zh/model-studio/paraformer-client-events)
- [实时语音识别（Paraformer）服务端事件](https://help.aliyun.com/zh/model-studio/paraformer-server-events)
- [CosyVoice 模型接入方式](https://help.aliyun.com/zh/model-studio/cosyvoice-model-access)
- [WebSocket 接入指南（CosyVoice TTS）](https://help.aliyun.com/zh/model-studio/cosyvoice-websocket-api)
- [CosyVoice 客户端事件](https://help.aliyun.com/zh/model-studio/cosyvoice-client-events)
- [CosyVoice 服务端事件](https://help.aliyun.com/zh/model-studio/cosyvoice-server-events)
- [实时语音合成（用户指南）](https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide)
- [Realtime API 概述（协议选型）](https://help.aliyun.com/zh/model-studio/realtime-api-overview)
- [语音识别概述（模型选型与音频规格）](https://help.aliyun.com/zh/model-studio/asr-model)
- [语音合成概述（模型选型）](https://help.aliyun.com/zh/model-studio/tts-model)
- [选择地域、服务部署范围和接入域名](https://help.aliyun.com/zh/model-studio/regions)
- [限流（未覆盖音频模型）](https://help.aliyun.com/zh/model-studio/rate-limit)

### 路线 2（智能语音交互 NLS）

- [实时语音识别 WebSocket 协议](https://help.aliyun.com/zh/isi/user-guide/websocket)
- [实时语音识别接口说明](https://help.aliyun.com/zh/isi/user-guide/api-reference)
- [一句话识别接口说明](https://help.aliyun.com/zh/isi/developer-reference/api-reference-1)
- [一句话识别 RESTful API](https://help.aliyun.com/zh/isi/developer-reference/restful-api-2)
- [一句话识别 Node.js SDK](https://help.aliyun.com/zh/isi/developer-reference/sdk-for-node-js-2)
- [语音合成概述（含 WS 流程、音色列表）](https://help.aliyun.com/zh/isi/user-guide/overview-of-speech-synthesis)
- [语音合成 RESTful API](https://help.aliyun.com/zh/isi/user-guide/restful-api-3)
- [获取 Token](https://help.aliyun.com/zh/isi/getting-started/obtain-an-access-token)
- [并发与 QPS 说明](https://help.aliyun.com/zh/isi/getting-started/faq-about-concurrency-and-monitoring)
- [长文本语音合成 RESTful API](https://help.aliyun.com/zh/isi/user-guide/restful-api)

### 访问方法说明

`help.aliyun.com` 的页面是 JS 渲染的，直接抓 HTML 只能拿到导航壳。
**在文档路径后追加 `.md` 可获得干净的原始 Markdown**（该站提供的「复制 MD 格式」后端）：

```
https://help.aliyun.com/zh/model-studio/cosyvoice-client-events.md   ← 返回纯 Markdown
https://help.aliyun.com/zh/model-studio/cosyvoice-client-events       ← 返回 HTML 壳
```

少数页面（如 `/zh/isi/developer-reference/websocket-1`、`/zh/isi/user-guide/websocket-1`）
即使加 `.md` 也返回 `unsupported content type`，说明该页无 Markdown 版本。
本文中所有 NLS 短句合成 WebSocket 的空白项，正是因为对应页面无法取得内容。
