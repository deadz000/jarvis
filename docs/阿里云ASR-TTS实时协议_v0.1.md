# 阿里云百炼（DashScope）实时语音合成 / 实时语音识别 WebSocket 协议调研

> 调研对象：TTS `qwen-audio-3.0-tts-flash`、ASR `qwen-audio-3.0-asr-flash`、音色 `longanfengyue`
> 调研日期：基于 docs.bailian.console.aliyun.com 当前线上文档（`.md` 原始 Markdown）
> 标注约定：**【文档】**= 官方文档明确写出；**【推断】**= 我从官方样例推断，文档未直接写明；**【文档中未找到】**= 未在任何官方页面找到

全局索引：https://docs.bailian.console.aliyun.com/llms.txt

---

## 0. 结论速览（先看这一段）

| 问题 | 结论 |
|---|---|
| TTS `qwen-audio-3.0-tts-flash` 有没有裸 WebSocket 协议？ | **有**，官方给出完整 `run-task`/`continue-task`/`finish-task` 协议 + **Node.js 官方示例** 【文档】 |
| ASR `qwen-audio-3.0-asr-flash` 支持流式吗？ | **不支持**。它是**非实时（HTTP）**模型 【文档】 |
| 那 ASR 该用哪个型号？ | 流式要用 **`qwen-audio-3.0-asr-flash-streaming`** 或 `qwen-audio-3.1-asr-flash-streaming` 【文档】 |
| 音色 `longanfengyue` 对不对？ | **正确**，`longanfengyue`（龙安风悦，女，30岁，自然亲切音）属于 `qwen-audio-3.0-tts-flash`，无 `_v3.6` 后缀 【文档】 |
| 官方有 Node.js SDK 吗？ | **没有 DashScope Node.js SDK**（只有 Python / Java）。但**不需要 SDK**，官方直接给了 `npm install ws` 的 Node.js 示例 【文档】 |
| 有 HTTP 降级方案吗？ | **都有**：TTS `POST /api/v1/services/audio/tts/SpeechSynthesizer`；ASR `POST /api/v1/services/aigc/multimodal-generation/generation` 【文档】 |
| 能输出 PCM 吗？ | **能**，`format: "pcm"`，采样率 8000/16000/22050/24000/44100/48000 【文档】 |
| 怎么中途取消合成？ | `finish-task` 的 `payload.input.directive = "cancel"` 【文档】 |

---

# 1. TTS WebSocket 协议（`qwen-audio-3.0-tts-flash`）

来源：<https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-tts-websocket-api.md>
　　　<https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-tts-client-events.md>
　　　<https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-tts-server-events.md>

## 1.1 连接 URL 与鉴权

**接口地址【文档】**

| 地域 | URL |
|---|---|
| 华北2（北京） | `wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference` |
| 新加坡 | `wss://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference` |

- `{WorkspaceId}` 替换为真实业务空间 ID（Workspace ID）。
- 文档明确提示：旧域名 `dashscope.aliyuncs.com` / `dashscope-intl.aliyuncs.com` 仍可用，但建议迁移到上述业务空间专属域名。
- **注意**：这里 TTS 用的是 `/api-ws/v1/inference`，**不是** `qwen3-tts-flash-realtime` 那种 OpenAI 兼容的 `/api-ws/v1/realtime?model=...`。两者是不同协议族，不要混。

**请求头【文档】**

| 参数 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `Authorization` | string | **是** | 鉴权令牌，格式为 `Bearer <your_api_key>` |
| `user-agent` | string | 否 | 客户端标识，便于服务端追踪来源 |
| `X-DashScope-WorkSpace` | string | 否 | 阿里云百炼业务空间 ID |
| `X-DashScope-DataInspection` | string | 否 | 是否启用数据合规检测，默认不传或设为 `enable`；非必要请勿启用 |

【文档】原文："Authorization 鉴权在 WebSocket 握手阶段验证。如果 API Key 无效或缺失，握手将失败并返回 HTTP 401/403 错误。"

> 【推断】官方 Node.js 示例里写的是 `Authorization: \`bearer ${apiKey}\``（小写 bearer），而请求头表格写的是 `Bearer <your_api_key>`。HTTP 认证方案名按 RFC 7235 大小写不敏感，两种应都可工作；建议以表格的 `Bearer` 为准。

## 1.2 `run-task`（完整 payload，官方原样 JSON）

**header**【文档，全部必选】

| 字段 | 固定值/说明 |
|---|---|
| `action` | 固定为 `run-task` |
| `task_id` | 客户端生成的任务 ID（**UUID 格式**），需与后续 `continue-task`、`finish-task` 保持一致 |
| `streaming` | 固定为 `duplex` |

**payload**【文档】

| 字段 | 必选 | 取值 |
|---|---|---|
| `task_group` | 是 | 固定 `audio` |
| `task` | 是 | 固定 `tts` |
| `function` | 是 | 固定 `SpeechSynthesizer` |
| `model` | 是 | 模型名称 |
| `input` | 是 | 固定为空对象 `{}`；待合成文本通过 `continue-task` 发送 |
| `parameters` | 是 | 见下表 |

**`payload.parameters` 逐字段【文档】**

| 字段 | 类型 | 必选 | 默认 | 取值范围 / 说明 |
|---|---|---|---|---|
| `text_type` | string | 是 | — | 固定 `PlainText` |
| `voice` | string | 是 | — | 音色。系统音色见音色列表；或复刻/声音设计音色 |
| `format` | string | 否 | `mp3` | `pcm` / `wav` / `mp3` / `opus` |
| `sample_rate` | integer | 否 | `22050` | `8000, 16000, 22050, 24000, 44100, 48000` |
| `volume` | integer | 否 | `50` | `[0, 100]` |
| `rate` | float | 否 | `1.0` | `[0.5, 2.0]`（语速） |
| `pitch` | float | 否 | `1.0` | `[0.5, 2.0]`（音调） |
| `bit_rate` | integer | 否 | `32` | `[6, 510]`；`format` 为 mp3 或 opus 时支持 |
| `enable_ssml` | boolean | 否 | `false` | 设为 `true` 后**仅允许发送一次** `continue-task` |
| `word_timestamp_enabled` | boolean | 否 | `false` | 字级别时间戳；**仅在流式输出模式下可用** |
| `seed` | integer | 否 | `0` | `[0, 65535]`，相同 seed 可复现合成结果 |
| `language_hints` | array[string] | 否 | — | 目标语言 `zh,en,fr,de,ja,ko,ru,pt,th,id,vi,es,it,ms,fil,ar`（数组，但当前版本仅处理第一个元素） |
| `instruction` | string | 否 | — | 指令控制（方言/情感/角色） |
| `enable_aigc_tag` | boolean | 否 | `false` | 添加 AIGC 隐性标识（wav/mp3/opus） |
| `aigc_propagator` | string | 否 | 阿里云UID | `ContentPropagator` 字段 |
| `aigc_propagate_id` | string | 否 | Request ID | `PropagateID` 字段 |
| `hot_fix` | object | 否 | — | `pronunciation`（自定义发音）/ `replace`（文本替换） |

**官方原样 JSON（服务端事件文档中的 run-task 样例）**

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
        "model": "qwen-audio-3.0-tts-flash",
        "parameters": {
            "text_type": "PlainText",
            "voice": "longanlingxi",
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

**改为本项目目标模型/音色（仅替换 model 与 voice，其余结构不变）**

```json
{
    "header": {
        "action": "run-task",
        "task_id": "<uuid-v4>",
        "streaming": "duplex"
    },
    "payload": {
        "task_group": "audio",
        "task": "tts",
        "function": "SpeechSynthesizer",
        "model": "qwen-audio-3.0-tts-flash",
        "parameters": {
            "text_type": "PlainText",
            "voice": "longanfengyue",
            "format": "pcm",
            "sample_rate": 24000,
            "volume": 50,
            "rate": 1.0,
            "pitch": 1.0,
            "enable_ssml": false
        },
        "input": {}
    }
}
```

## 1.3 `continue-task`（发送待合成文本）

**发送时机【文档】**：收到服务端 `task-started` 事件之后。

**数量限制【文档，原文】**

- 单次调用最多发送 **20000 字符**
- 累计最多发送 **200000 字符**
- **发送间隔不得超过 23 秒**，否则连接超时

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

- `payload.input.text`：待合成文本，单次最多 20000 字符，累计最多 200000 字符。【文档】
- 服务端自动分句：完整语句立即合成并返回音频；不完整语句缓存至完整后合成；发送 `finish-task` 时强制合成所有缓存内容。【文档】

## 1.4 `finish-task` 与「中途取消合成」

**正常结束（官方原样）**

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

**取消当前轮次（官方原样，这就是「中途取消」的确切字段路径）**

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

- **确切字段路径**：`payload.input.directive`
- **取值**：当前仅支持 `"cancel"`【文档】
- **语义【文档原文】**："表示取消当前轮次的语音合成任务，服务端会立即返回 `task-finished` 事件，且不会输出后续音频。取消后，可在当前 WebSocket 连接上重新发起语音合成任务（发送新的 `run-task` 事件），无需重新建立连接。"

## 1.5 事件流与音频分片如何返回

### 服务端事件（4 类）【文档】

| `header.event` | 含义 |
|---|---|
| `task-started` | 任务成功开启，之后才能发 `continue-task` |
| `result-generated` | 句子元信息 + 音频分片标记 |
| `task-finished` | 任务结束，可关闭或复用连接开启新任务 |
| `task-failed` | 任务失败，客户端需关闭连接并处理错误 |

### `task-started`（官方原样）

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

### `result-generated`：`payload.output.type` 三个取值【文档】

| `payload.output.type` | 含义 |
|---|---|
| `sentence-begin` | 句子开始，返回待合成的文本内容 |
| `sentence-synthesis` | **标识音频数据块，每个事件后立即通过 WebSocket binary 通道传输一个音频数据帧** |
| `sentence-end` | 句子结束，返回文本内容和用量信息（`usage`） |

其他字段【文档】：
- `payload.output.sentence.index` — 句子编号，从 0 开始
- `payload.output.sentence.words[]` — 字级别时间戳（`text`, `begin_index`, `end_index`, `begin_time`, `end_time`）
- `payload.output.original_text` — 分句后的句子文本内容
- `payload.usage.characters` — 累计计费字符数（出现在 `sentence-end`）

**`sentence-begin` 官方原样**

```json
{
  "header": {
    "task_id": "3f2d5c86-0550-45c0-801f-xxxxxxxxxx",
    "event": "result-generated",
    "attributes": {}
  },
  "payload": {
    "output": {
      "sentence": { "index": 0, "words": [] },
      "type": "sentence-begin",
      "original_text": "床前明月光，"
    }
  }
}
```

**`sentence-synthesis` 官方原样**

```json
{
    "header": {
        "task_id": "3f2d5c86-0550-45c0-801f-xxxxxxxxxx",
        "event": "result-generated",
        "attributes": {}
    },
    "payload": {
        "output": {
            "sentence": { "index": 0, "words": [] },
            "type": "sentence-synthesis"
        }
    }
}
```

**`sentence-end` 官方原样**

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
          { "text": "床", "begin_index": 0, "end_index": 1, "begin_time": 0, "end_time": 263 }
        ]
      },
      "type": "sentence-end",
      "original_text": "床前明月光，"
    },
    "usage": { "characters": 6 }
  }
}
```

### 音频分片机制（两层，都要处理）

1. **文本帧（JSON）**：`header.event == "result-generated"` 且 `payload.output.type == "sentence-synthesis"`
2. **二进制帧（binary）**：紧接该 JSON 之后，通过 WebSocket **binary 通道**传输一个音频数据帧

**【文档】**原话（WebSocket 接入指南交互流程第 5 步）："接收音频：通过 `binary` 通道接收音频流"。
**【文档】**原话（服务端事件 `sentence-synthesis`）："每个事件后立即通过 WebSocket binary 通道传输一个音频数据帧"。

> **实现要点**：Node.js `ws` 的 `message` 回调第二个参数 `isBinary` 必须用来区分——`true` 写音频，`false` 解析 JSON。官方示例就是这么做的。

### `task-finished` / `task-failed` 官方原样

```json
{
  "header": {
    "task_id": "2bf83b9a-baeb-4fda-8d9a-xxxxxxxxxxxx",
    "event": "task-finished",
    "attributes": { "request_uuid": "0a9dba9e-d3a6-45a4-be6d-xxxxxxxxxxxx" }
  },
  "payload": { "usage": { "characters": 13 } }
}
```

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

错误字段路径：`header.error_code` / `header.error_message`【文档】

## 1.6 是否支持输出 PCM / 采样率

**支持输出 PCM。【文档】**

- `format` 取值：`pcm`、`wav`、`mp3`（默认）、`opus`
- `sample_rate` 取值：`8000`、`16000`、`22050`（默认）、`24000`、`44100`、`48000`
- 概述页补充："兼容主流音频格式（PCM、WAV、MP3、Opus），最高支持 48kHz 采样率输出"
- 来源：<https://docs.bailian.console.aliyun.com/zh/model-studio/realtime-tts-user-guide.md>

> **【文档中未找到】** WebSocket `pcm` 输出时的**位深**（如 16-bit）与字节序。文档只写 `sample_rate` 与 `format`，未写位深。
> **【推断】** 结合 ASR 官方 Node.js 示例注释（"PCM16、16 kHz"）以及 HTTP 流式接口的 `data` 为 Base64，PCM 输出极可能是 **16-bit little-endian 单声道**，但这属于推断，落地前必须实测（例如把 `format: pcm, sample_rate: 24000` 的输出按 16-bit LE 解析看波形是否正常）。

## 1.7 限制汇总【文档】

| 项 | 限制 |
|---|---|
| `continue-task` 单次文本 | ≤ 20000 字符 |
| `continue-task` 累计文本 | ≤ 200000 字符 |
| `continue-task` 发送间隔 | **不得超过 23 秒**，否则连接超时 |
| `enable_ssml: true` 时 | 仅允许发送 **1 次** `continue-task`，否则报错 `Text request limit violated, expected 1.` |
| `task_id` | `run-task`、所有 `continue-task`、`finish-task` **必须使用相同 `task_id`**；不同 task_id 会导致音频错乱或任务失败 |
| 连接复用 | 官方建议复用 WebSocket 连接处理多个任务，而非每个任务新建连接 |
| 情感与富语言标签 | 仅 `qwen-audio-3.1-tts-flash`、`qwen-audio-3.0-tts-plus`、`qwen-audio-3.0-tts-flash` 支持，且**仅支持单向流式模式** |
| `instruction` 长度（CosyVoice） | 不超过 100 字符 |

## 1.8 音色核实：`longanfengyue`

来源：<https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list.md>

**核实结论：`longanfengyue` 属于 `qwen-audio-3.0-tts-flash`，写法正确（无需后缀）。【文档】**

| 名称 | voice 参数 | 特质 | 年龄 | 性别 | 语言 |
|---|---|---|---|---|---|
| 龙安风悦 | `longanfengyue` | 自然亲切音 | 30岁 | 女 | 中文（普通话）、英文 |

**重要陷阱**：`qwen-audio-3.0-tts-flash` 下的音色**命名不统一**——`longanfengyue`、`longanyuanfei`、`longanlingxi`、`longanxiaoxin`、`loongmary`、`loongjohn` **无后缀**；而 `longanhuan_v3.6`、`longjielidou_v3.6`、`longpaopao_v3.6`、`longhuohuo_v3.6`、`longchuanshu_v3.6`、`loongeva_v3.6` **带 `_v3.6` 后缀**。

> 官方警告【文档】："所选音色（`voice`）必须属于当前模型（`model`）支持的音色列表，不能跨模型混用。音色不匹配时，服务会返回 `InvalidParameter` 错误，例如 `[cosyvoice:]Engine error [411]: TTS speak operation failed`。"
> **结论：用户配置的 `voice: "longanfengyue"` 可直接使用，不要加 `_v3.6`。**

---

# 2. ASR WebSocket 协议

## 2.1 关键结论：`qwen-audio-3.0-asr-flash` 不支持流式

来源：<https://docs.bailian.console.aliyun.com/zh/model-studio/asr-model.md>

**【文档】`qwen-audio-3.0-asr-flash` 的形态：**

| 模型ID | 模式 | API | 精度增强 | 情感识别 | 说话人分离 | 音频最大时长/大小 |
|---|---|---|---|---|---|---|
| `qwen-audio-3.0-asr-flash` | **非实时** | **HTTP** | 热词、Prompt上下文 | 不支持 | 不支持 | **5分钟 / 2GB** |

- 它属于 **Qwen-Audio-ASR（非实时）** 系列，走 **HTTP** 协议："基于HTTP协议，提交音频文件获取识别结果"。输入方式：**URL / Base64，单次 1 个**。
- 音频格式支持：`aac`、`amr`、`avi`、`flac`、`flv`、`m4a`、`mkv`、`mov`、`mp3`、`mp4`、`mpeg`、`ogg`、`opus`、`wav`、`webm`、`wma`、`wmv`。

> **所以：`qwen-audio-3.0-asr-flash` 既没有 WebSocket 连接，也没有增量（中间）结果。** 它是一次性提交音频、一次性返回完整文本的 HTTP 模型。

**【文档】支持流式（WebSocket）的确切型号：**

| 模型ID | 模式 | API | 精度增强 | 情感识别 | 说话人分离 |
|---|---|---|---|---|---|
| **`qwen-audio-3.0-asr-flash-streaming`** | 实时 | WebSocket | 热词、Prompt上下文 | 不支持 | 不支持 |
| **`qwen-audio-3.1-asr-flash-streaming`** | 实时 | WebSocket | 热词、Prompt上下文 | 不支持 | 不支持 |
| `qwen3-asr-flash-realtime` | 实时 | WebSocket | 不支持 | **支持** | 不支持 |
| `fun-asr-realtime` 系列 | 实时 | WebSocket | 热词 | 不支持 | 不支持 |

- **`qwen-audio-3.0-asr-flash-streaming` 是最贴近用户所选型号的流式替代品**（同一 3.0 代，仅多 `-streaming` 后缀）。
- `qwen-audio-3.1-asr-flash-streaming` 额外支持 `keep_dialect`（保留方言）与 `vad_model`（`near_meeting_16k` / `far_field_meeting_16k`）。
- 官方推荐（asr-model 概述页）："实时（实时语音识别）：基于WebSocket协议，音频流式输入，文本流式输出 …… 推荐使用 `qwen-audio-3.1-asr-flash-streaming`（热词、Prompt上下文、多语种及方言）。"

## 2.2 连接 URL 与鉴权

来源：<https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-websocket-api.md>

**接口地址【文档】**

| 地域 | URL |
|---|---|
| 华北2（北京） | `wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference` |
| 新加坡 | `wss://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference` |

**与 TTS 完全相同的 URL 形态。**

**请求头【文档】**

| 参数 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `Authorization` | string | **是** | 格式为 `Bearer <your_api_key>` |
| `user-agent` | string | 否 | 客户端标识 |
| `X-DashScope-WorkSpace` | string | 否 | 业务空间 ID |
| `X-DashScope-DataInspection` | string | 否 | 数据合规检测，默认不传或 `enable` |

【文档】"Authorization 鉴权在 WebSocket 握手阶段验证。如果 API Key 无效或缺失，握手将失败并返回 HTTP 401/403 错误。"

**交互流程【文档】**：建立连接 → 发送 `run-task` → 收 `task-started` → 发送二进制音频流（**须为单声道音频**）+ 持续收 `result-generated` → 发送 `finish-task` → 收 `task-finished` → 关闭连接。

## 2.3 `run-task` 完整 payload

来源：<https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-client-events.md>

**header（全部必选）【文档】**：`action` = `run-task`；`task_id` = 客户端生成 UUID；`streaming` = `duplex`

**payload【文档】**：`task_group` = `audio`；`task` = `asr`；`function` = `recognition`；`model` = 模型名；`input` = 输入对象（不携带上下文时传 `{}`）；`parameters` = 语音识别参数

**`payload.parameters` 逐字段【文档】**

| 字段 | 类型 | 必选 | 说明 / 取值范围 |
|---|---|---|---|
| `format` | string | **是** | `pcm`、`wav`、`mp3`、`opus`、`speex`、`aac`、`amr`。**约束**：opus/speex 必须使用 Ogg 封装；wav 必须为 PCM 编码；amr 仅支持 AMR-NB 类型 |
| `sample_rate` | integer | **是** | 采样率（Hz），**支持任意采样率** |
| `keep_dialect` | boolean | 否 | **仅 `qwen-audio-3.1-asr-flash-streaming`**。默认 `false` |
| `vad_model` | string | 否 | **仅 3.1**。默认 `far_field_meeting_16k`；可选 `near_meeting_16k`、`far_field_meeting_16k` |
| `vocabulary_id` | string | 否 | 预编译热词列表 ID |
| `vocabulary` | object | 否 | 即时热词，键=热词文本，值=权重，权重 `[1,5]` 或 `50`（超级热词，≤50 个） |
| `language_hints` | array[string] | 否 | 最多 4 个，超出仅前 4 个生效。代码 `zh,en,ja,ko,vi,th,id,ms,tl,hi,ar,fr,de,es,pt,ru,it,nl,sv,da,fi,no,el,pl,cs,hu,ro,bg,hr,sk` |
| `semantic_punctuation_enabled` | boolean | 否 | 默认 `false`。`true`=开启语义断句并关闭 VAD 断句；`false`=开启 VAD 断句并关闭语义断句 |
| `max_sentence_silence` | integer | 否 | VAD 断句静音阈值（ms），默认 **800**，范围 `[200, 6000]` |
| `multi_threshold_mode_enabled` | boolean | 否 | 默认 `false`；仅在 `semantic_punctuation_enabled=false` 时生效 |
| `heartbeat` | boolean | 否 | 默认 `false`。**见 2.6 保活** |
| `speech_noise_threshold` | float | 否 | 范围 `[-1.0, 1.0]`，VAD 灵敏度 |
| `special_word_filter` | string | 否 | 敏感词处理 |

**`payload.input.context`（可选）【文档】**：数组，元素 `{role, content:[{type, text}]}`
- `role`：`user`（前几轮用户识别结果或领域词表）/ `assistant`（前几轮大模型回复）
- `content[].type`：`input_text`（role=user 时）/ `text`（role=assistant 时）
- 约束：`input_text` 和 `text` 各最多 5 条；每轮上下文文本总长 ≤ 400 字符
- 顺序要求：每轮中 `user` 必须在对应 `assistant` 之前

**官方原样 JSON（基本请求）**

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
        "model": "qwen-audio-3.1-asr-flash-streaming",
        "parameters": {
            "format": "pcm",
            "sample_rate": 16000
        },
        "input": {}
    }
}
```

**官方原样 JSON（携带上下文）**

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
        "model": "qwen-audio-3.1-asr-flash-streaming",
        "parameters": {
            "format": "pcm",
            "sample_rate": 16000
        },
        "input": {
            "context": [
                {
                    "role": "user",
                    "content": [
                        { "type": "input_text", "text": "你好啊" }
                    ]
                },
                {
                    "role": "assistant",
                    "content": [
                        { "type": "text", "text": "你好啊，我是通义千问，有什么可以帮助你的？" }
                    ]
                }
            ]
        }
    }
}
```

**官方原样 JSON（即时热词）**

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
        "model": "qwen-audio-3.1-asr-flash-streaming",
        "parameters": {
            "format": "pcm",
            "sample_rate": 16000,
            "vocabulary": {"张三": 5, "李四": 5}
        },
        "input": {}
    }
}
```

## 2.4 `continue-task` 与 `finish-task`

**`continue-task`【文档】**：任务运行中更新对话上下文。`payload.input.context`（结构同 run-task 的 `input.context`）。**注意：ASR 的 `continue-task` 用于更新上下文，不是发送音频。**

```json
{
    "header": {
        "action": "continue-task",
        "task_id": "2bf83b9a-baeb-4fda-8d9a-xxxxxxxxxxxx",
        "streaming": "duplex"
    },
    "payload": {
        "input": {
            "context": [
                {
                    "role": "user",
                    "content": [ { "type": "input_text", "text": "你好啊" } ]
                },
                {
                    "role": "assistant",
                    "content": [ { "type": "text", "text": "你好啊，我是通义千问，有什么可以帮助你的？" } ]
                }
            ]
        }
    }
}
```

**`finish-task`【文档】**：所有音频发送完毕后发送；`payload.input` 固定为 `{}`；服务端响应 `task-finished`。

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

> **注意**：ASR 的 `finish-task` **没有** `directive` 字段（文档中 payload.input 固定为 `{}`）。**【文档中未找到】** ASR 侧的「取消」语义。

## 2.5 服务端事件 / 如何区分中间结果与最终结果

来源：<https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-server-events.md>

**四类事件【文档】**：`task-started`、`result-generated`、`task-finished`、`task-failed`

### `result-generated` 字段路径

```
payload.output.sentence.sentence_end     ← true 最终结果 / false 中间结果   【文档】
payload.output.sentence.sentence_begin   ← true 表示新句子的首个中间结果     【文档】
payload.output.sentence.heartbeat        ← true 表示心跳包，可跳过该结果      【文档】
payload.output.sentence.sentence_id      ← 从 1 递增；heartbeat 为 true 时固定为 0 【文档】
payload.output.sentence.text             ← 识别文本
payload.output.sentence.begin_time / end_time   ← 句子起止时间（ms）
payload.output.sentence.words[]          ← 字时间戳 {begin_time, end_time, text, punctuation}
payload.usage                            ← 累计用量 {duration, input_tokens, output_tokens, total_tokens}
```

**核心判断题**：`sentence_end === true` → 最终结果；`sentence_end === false` → 中间结果。

**官方原样：句子开始结果（中间）**

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
        "begin_time": 0,
        "end_time": null,
        "text": "",
        "sentence_begin": true,
        "sentence_end": false,
        "sentence_id": 1,
        "words": []
      }
    }
  }
}
```

**官方原样：最终结果**

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
        "sentence_id": 1,
        "begin_time": 160,
        "end_time": 1640,
        "text": "欢迎使用阿里云。",
        "channel_id": 0,
        "speaker_id": null,
        "sentence_end": true,
        "words": [
          { "begin_time": 160, "end_time": 520, "text": "欢迎", "punctuation": "", "fixed": true, "speaker_id": null },
          { "begin_time": 520, "end_time": 880, "text": "使用", "punctuation": "", "fixed": true, "speaker_id": null },
          { "begin_time": 880, "end_time": 1640, "text": "阿里云", "punctuation": "。", "fixed": true, "speaker_id": null }
        ],
        "stash": { "sentence_id": 2, "text": "", "begin_time": 1640, "current_time": 1640, "words": [] }
      },
      "text": "欢迎使用阿里云。",
      "request_id": "95372ce8e6704bcc8747da94789c15ca",
      "usage": { "duration": 2, "input_tokens": 85, "output_tokens": 4, "total_tokens": 89 }
    },
    "usage": { "duration": 2, "input_tokens": 85, "output_tokens": 4, "total_tokens": 89 }
  }
}
```

### `task-started` / `task-finished` / `task-failed` 官方原样

```json
{
    "header": { "task_id": "2bf83b9a-baeb-4fda-8d9a-xxxxxxxxxxxx", "event": "task-started", "attributes": {} },
    "payload": {}
}
```

```json
{
  "header": { "task_id": "2bf83b9a-baeb-4fda-8d9a-xxxxxxxxxxxx", "event": "task-finished", "attributes": {} },
  "payload": {
    "output": {},
    "usage": { "duration": 9, "input_tokens": 365, "output_tokens": 12, "total_tokens": 377 }
  }
}
```

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

> **重要**【文档】：`task-finished` = "任务正常结束，**可关闭连接或复用连接**"；`task-failed` = "任务失败，**连接会被关闭，无法复用**"。
> 上面 `task-failed` 样例的 `error_message` 是 `"request timeout after 23 seconds."` —— 说明服务端存在约 23 秒的空闲超时。

## 2.6 上行音频帧格式要求

**【文档】`Qwen-Audio-3.x-ASR-Flash-Streaming`（`qwen-audio-3.1-asr-flash-streaming`、`qwen-audio-3.0-asr-flash-streaming`）：**

| 项 | 要求 | 来源 |
|---|---|---|
| 输入方式 | 二进制（Binary）流 | asr-model.md 音频规格 |
| 音频格式 | `pcm`、`wav`、`mp3`、`opus`、`speex`、`aac`、`amr` | asr-model.md 音频规格 |
| 采样率 | **任意** | asr-model.md 音频规格 |
| 声道 | **所有实时模型均为单声道输入** | asr-model.md 音频规格 |
| 大小/时长 | 不限 | asr-model.md 音频规格 |
| 帧长建议 | 官方示例统一用 **3200 字节**，注释为 "100ms @ 16kHz 16bit 单声道" / "约 0.1s 的 PCM16 音频" | real-time-speech-recognition-user-guide.md Node.js/Java 示例 |
| 发送节奏 | 官方示例 `setTimeout(sendNextChunk, 100)` 模拟实时，即每 100 ms 一帧 | 同上 |

**位深：**
> **【文档中未找到】** 在协议/参数表中**没有** `bit_depth` 之类的字段，也没有文字写明位深。
> **【推断】** 官方示例注释明确写 `PCM16`（`ffmpeg -i your_audio.mp3 -ar 16000 -ac 1 -f s16le your_audio_file.pcm`，`s16le` = signed 16-bit little-endian），因此 **PCM 上行应为 16-bit little-endian 单声道**。这是从官方示例推断，不是参数表明文。

**音频帧的发送方式【文档/示例】**：直接 `ws.send(chunk)`，**裸二进制帧，不带任何 JSON 包装**（与部分 DashScope 老协议不同）。官方 Node.js 示例：
```javascript
const chunk = audioStream.read();
ws.send(chunk);          // 裸 binary
```
> 客户端**不需要**为音频帧构造 `header`/`payload`。

## 2.7 结束与保活

### 结束【文档】
1. 音频发完 → 发送 `finish-task`（`payload.input` 为 `{}`）
2. 继续接收 `result-generated`（可能还有尾包）
3. 收到 `task-finished` → 关闭连接（或复用连接发起新 `run-task`）

### 保活【文档】

`run-task` 的 `parameters.heartbeat`：

> **heartbeat** `boolean`（可选）— 是否启用心跳包。默认值：`false`。
> - `true`：**在持续发送静音音频的情况下，可保持与服务端的连接不中断**。
> - `false`（默认）：即使持续发送静音音频，连接也将在一定时间后因超时而断开。
> 静音音频指的是在音频文件或数据流中没有声音信号的内容。静音音频可以通过多种方法生成，例如使用音频编辑软件如 Audacity 或 Adobe Audition，或者通过命令行工具如 FFmpeg。

服务端侧对应字段【文档】：`payload.output.sentence.heartbeat`（"若为 true，可跳过该结果（心跳包）"），此时 `sentence_id` 固定为 `0`。

> **【推断】保活的完整做法**：客户端设 `heartbeat: true` 后，必须**主动持续发送静音 PCM 帧**（例如全 0 的 16-bit 3200 字节帧，每 100ms 一帧）来维持连接；服务端会回发 `heartbeat: true, sentence_id: 0` 的 `result-generated` 作为应答，客户端应跳过这类结果。文档只写了"启用心跳包 + 持续发送静音音频可保持连接"，**没有**给出客户端主动发送心跳 JSON 的指令，也没有明确心跳应答的方向性。
> **【文档中未找到】** 一个独立的 ASR 心跳 JSON 指令（如 `action: "heartbeat"`）。
> **【文档中未找到】** TTS 侧的显式心跳/保活机制——TTS 文档只给出"`continue-task` 发送间隔不得超过 23 秒"这一约束，靠周期发文本续命。

### 23 秒超时
`task-failed` 官方样例的 `error_message` 即为 `"request timeout after 23 seconds."`，与 TTS 的 23 秒 `continue-task` 间隔上限一致。

---

# 3. Node.js 可行性

## 3.1 官方是否提供 Node.js SDK？

**结论：官方没有提供 DashScope Node.js SDK。只有 Python 和 Java。【文档】**

证据原文（<https://docs.bailian.console.aliyun.com/zh/model-studio/install-sdk.md> 页面首段）：

> 您可以使用阿里云百炼官方的 **DashScope SDK（支持 Python 和 Java）**，也可以通过 OpenAI 官方提供的多语言 SDK（如 Python、Node.js、Java、Go）来调用阿里云百炼的 **OpenAI 兼容接口**。

`install-sdk.md` 的 Tab 结构为：Python、Java、**Node.js**、Go。其中 **Node.js 标签页下只有一个子页「OpenAI」**，内容仅为：

```bash
npm install --save openai
# 或者
yarn add openai
```

即 Node.js 只能用 **OpenAI SDK 调 OpenAI 兼容接口**，**没有任何 DashScope 语音 SDK**。

进一步佐证 —— 各语音模型的「模型接入方式」页列出的 SDK 清单**均无 Node.js**：

| 模型 | 官方 SDK 清单 | 来源 |
|---|---|---|
| Qwen-Audio-TTS | Java SDK、Python SDK、Android SDK、iOS SDK、HarmonyOS SDK | qwen-audio-tts-model-access.md |
| Qwen-Audio-ASR-Streaming | Python SDK、Java SDK、Android SDK、iOS SDK、HarmonyOS SDK | qwen-audio-asr-streaming-model-access.md |
| 非实时 TTS Qwen-Audio-TTS | HTTP API、Java SDK、Python SDK | non-realtime-qwen-audio-tts-api.md |

## 3.2 裸 WebSocket 协议可以直接实现吗？—— 可以，官方给了 Node.js 示例

**结论：必须用裸 WebSocket，而且官方文档明确给出了完整的裸 WebSocket 协议 + Node.js 官方示例代码。不需要 SDK。【文档】**

### 证据 A：TTS —— 官方 Node.js 示例

来源：<https://docs.bailian.console.aliyun.com/zh/model-studio/realtime-tts-user-guide.md>（「Qwen-Audio-TTS」Tab 下的 WebSocket 接入示例，Node.js 标签页）

依赖：
```bash
npm install ws
npm install uuid
```

官方 Node.js 代码（节选，原样）：

```javascript
const WebSocket = require('ws');
const fs = require('fs');
const uuid = require('uuid').v4;

const apiKey = process.env.DASHSCOPE_API_KEY;
const url = 'wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference';
const outputFilePath = 'output.mp3';

fs.writeFileSync(outputFilePath, '');

const ws = new WebSocket(url, {
  headers: {
    Authorization: `bearer ${apiKey}`,
    'X-DashScope-DataInspection': 'enable'
  }
});

let taskStarted = false;
let taskId = uuid();

ws.on('open', () => {
  const runTaskMessage = JSON.stringify({
    header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
    payload: {
      task_group: 'audio',
      task: 'tts',
      function: 'SpeechSynthesizer',
      model: 'qwen-audio-3.0-tts-flash',
      parameters: {
        text_type: 'PlainText',
        voice: 'longanhuan_v3.6',
        format: 'mp3',
        sample_rate: 22050,
        volume: 50,
        rate: 1,
        pitch: 1,
        enable_ssml: false
      },
      input: {}
    }
  });
  ws.send(runTaskMessage);
});

const fileStream = fs.createWriteStream(outputFilePath, { flags: 'a' });
ws.on('message', (data, isBinary) => {
  if (isBinary) {
    fileStream.write(data);            // ← 音频：裸 binary 帧
  } else {
    const message = JSON.parse(data);  // ← 控制：JSON 文本帧
    switch (message.header.event) {
      case 'task-started': taskStarted = true; sendContinueTasks(ws); break;
      case 'task-finished': ws.close(); fileStream.end(); break;
      case 'task-failed': console.error(message.header.error_message); ws.close(); fileStream.end(); break;
      default: break;
    }
  }
});
```

### 证据 B：ASR 实时流式 —— 官方 Node.js 示例

来源：<https://docs.bailian.console.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide.md>（`Qwen-Audio-3.x-ASR-Flash-Streaming / Fun-ASR-Realtime` Tab 的 Node.js 标签页）

依赖：
```bash
npm install ws
npm install uuid
```

官方 Node.js 代码（节选，原样）：

```javascript
const fs = require('fs');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const apiKey = process.env.DASHSCOPE_API_KEY;
const url = 'wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference';
const audioFile = '{YOUR_AUDIO_FILE}';

const TASK_ID = uuidv4().replace(/-/g, '').slice(0, 32);

const ws = new WebSocket(url, {
  headers: { Authorization: `bearer ${apiKey}` }
});

let taskStarted = false;

ws.on('open', () => { sendRunTask(); });

ws.on('message', (data) => {
  const message = JSON.parse(data);
  switch (message.header.event) {
    case 'task-started': taskStarted = true; sendAudioStream(); break;
    case 'result-generated':
      console.log('识别结果：', message.payload.output.sentence.text);
      if (message.payload.usage) console.log('计费时长（秒）：', message.payload.usage.duration);
      break;
    case 'task-finished': ws.close(); break;
    case 'task-failed': console.error(message.header.error_message); ws.close(); break;
  }
});

function sendRunTask() {
  const runTaskMessage = {
    header: { action: 'run-task', task_id: TASK_ID, streaming: 'duplex' },
    payload: {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model: 'qwen-audio-3.1-asr-flash-streaming',
      parameters: { sample_rate: 16000, format: 'wav' },
      input: {}
    }
  };
  ws.send(JSON.stringify(runTaskMessage));
}

function sendAudioStream() {
  const audioStream = fs.createReadStream(audioFile);
  function sendNextChunk() {
    const chunk = audioStream.read();
    if (chunk) { ws.send(chunk); setTimeout(sendNextChunk, 100); }  // 裸 binary，每 100ms
  }
  audioStream.on('readable', () => sendNextChunk());
  audioStream.on('end', () => sendFinishTask());
}
```

### 证据 C：WebSocket 接入指南页是独立可实现的协议说明

`qwen-audio-tts-websocket-api.md` / `qwen-audio-asr-streaming-websocket-api.md` 这两页本身就给出了「接口地址 + 请求头 + 交互流程」三件套，明确说明这是给**直接调用**用的协议，而不是"仅 SDK 内部使用"。

`qwen-audio-tts-model-access.md` 的措辞也是「**通过 WebSocket 接入指南了解连接地址、鉴权及交互流程**」+「**SDK 接入**」并列，两者是**平级并列**的接入方式。

> **没有找到任何"必须使用 SDK"的要求。** 【文档中未找到】任何"必须走 SDK"的表述。相反，`tts-model.md` 明确说："Qwen-Audio-TTS/CosyVoice 和 Qwen 系列的 WebSocket 模型支持通过 DashScope SDK（Java、Python）接入……**其他模型需根据对应的 WebSocket 或 HTTP 协议直接调用**。"

## 3.3 HTTP（非实时）降级方案

### 3.3.1 TTS HTTP 降级

来源：<https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-tts-http-api.md>

> **注意【文档】**："本文描述的功能**仅在华北2（北京）地域可用**。"

**URL**
```
POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer
```

**请求头**：`Authorization: Bearer <your_api_key>`（必选）、`Content-Type: application/json`（必选）、`X-DashScope-SSE: enable`（可选，仅流式合成时使用，固定值 `enable`）

**请求体结构**（官方原样 curl）

```bash
curl -X POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer \
-H "Authorization: Bearer $DASHSCOPE_API_KEY" \
-H "Content-Type: application/json" \
-d '{
    "model": "qwen-audio-3.0-tts-flash",
    "input": {
      "text": "我家的后面有一个很大的花园。",
      "voice": "longanhuan_v3.6",
      "format": "wav",
      "sample_rate": 24000
    }
}'
```

**请求体字段**：`model`（必选）；`input.text`（必选）、`input.voice`（必选）、`input.format`（`mp3` 默认 / `pcm` / `wav` / `opus`）、`input.sample_rate`（`8000、12000、16000、22050（默认）、24000、44100、48000`；`format=opus` 时仅支持 `8000、12000、16000、24000、48000`）、`input.volume`、`input.rate`、`input.bit_rate`（仅 opus）、`input.pitch`、`input.enable_ssml`、`input.word_timestamp_enabled`、`input.seed`、`input.language_hints`、`input.instruction`、`input.enable_aigc_tag`、`input.aigc_propagator`、`input.aigc_propagate_id`、`input.hot_fix`

> ⚠️ **注意差异**：HTTP 接口的 `format`/`sample_rate`/`voice` 在 **`input` 对象内**；WebSocket 接口的同样参数在 **`payload.parameters` 对象内**。两套结构不同，适配器不能共用。

**返回体**：`output.audio.url`（完整音频文件 URL，**有效期 24 小时**）、`output.audio.data`（流式合成时输出 Base64 音频数据；非流式为空）、`output.audio.id`、`output.audio.expires_at`、`output.finish_reason`（`null`/`stop`）、`usage.characters`

### 3.3.2 ASR HTTP 降级（这就是 `qwen-audio-3.0-asr-flash` 的原生形态）

来源：<https://docs.bailian.console.aliyun.com/zh/model-studio/fun-asr-flash-recorded-speech-recognition-http-api.md>

**URL**

| 地域 | URL |
|---|---|
| 华北2（北京） | `POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation` |
| 新加坡 | `POST https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation` |

**请求头**：`Authorization: Bearer <your_api_key>`（必选）、`Content-Type: application/json`（必选）、`X-DashScope-SSE`（`enable` 开启 SSE 流式；`disable` 或不传仅返回最终结果）

**请求体**（官方原样 curl）

```bash
curl --location --request POST 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation' \
     --header "Authorization: Bearer $DASHSCOPE_API_KEY" \
     --header "Content-Type: application/json" \
     --header "X-DashScope-SSE: disable" \
     --data '{
    "model": "qwen-audio-3.1-asr-flash",
    "input": {
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {
                            "data": "{YOUR_AUDIO_URL}"
                        }
                    }
                ]
            }
        ]
    },
    "parameters": {
        "format": "wav",
        "sample_rate": "16000"
    }
}'
```

**`input.messages`**：数组；`role` = `user`（`input_audio` 当前音频 / `input_text` 上下文）或 `assistant`（`text` 上下文）；`content[].type` = `input_audio` / `input_text` / `text`；`input_audio.data` 支持**公网可访问 URL** 或 **Base64 Data URI**（`data:{MIME_TYPE};base64,{BASE64_ENCODED_DATA}`，MIME 如 `audio/wav`、`audio/mpeg`）

**`parameters`**：`format`（必选，`wav`/`mp3`/`opus` 等）、`sample_rate`（可选，**字符串**，如 `"16000"`）、`vocabulary_id`、`vocabulary`、`language_hints`（最多 4 个）、`speaker_diarization_enabled`（仅 3.1，`qwen-audio-3.0-asr-flash` **不支持**）、`keep_dialect`（仅 3.1）

**返回体**：`output.text`（累积完整识别文本）、`output.sentence.{speaker_id, sentence_id, sentence_end, begin_time, end_time, text, channel_id, words[]}`、`usage.{duration, input_tokens, output_tokens, total_tokens}`

> 对 `qwen-audio-3.0-asr-flash`：`parameters.speaker_diarization_enabled`、`parameters.keep_dialect`、`vocabulary`（即时热词）中的**部分能力不支持**。文档明确：**`speaker_diarization_enabled` 仅 `qwen-audio-3.1-asr-flash` 支持**；**即时热词仅 `qwen-audio-3.1-asr-flash`、`qwen-audio-3.0-asr-flash` 支持**。且 "Qwen-Audio-3.0-ASR-Flash 和 Fun-ASR-Flash 的润色顺滑功能默认关闭，暂未开放"。

---

# 4. 「文档明确写到」vs「我从样例推断」汇总

| # | 结论 | 性质 |
|---|---|---|
| 1 | TTS/ASR 流式 URL 均为 `wss://{WorkspaceId}.{region}.maas.aliyuncs.com/api-ws/v1/inference` | **【文档】** |
| 2 | 鉴权 Header 为 `Authorization: Bearer <api_key>`，握手期校验，失败 401/403 | **【文档】** |
| 3 | TTS `run-task`/`continue-task`/`finish-task` 全部字段与官方 JSON | **【文档】** |
| 4 | TTS 取消：`payload.input.directive = "cancel"` | **【文档】** |
| 5 | TTS 音频走 binary 帧，`result-generated` + `payload.output.type="sentence-synthesis"` 为分片标记 | **【文档】** |
| 6 | TTS 支持 `format: "pcm"`，采样率 `8000/16000/22050/24000/44100/48000` | **【文档】** |
| 7 | TTS `continue-task` 单次 ≤ 20000 字符、累计 ≤ 200000 字符、间隔 ≤ 23 秒 | **【文档】** |
| 8 | `longanfengyue` 属于 `qwen-audio-3.0-tts-flash`，无后缀 | **【文档】** |
| 9 | `qwen-audio-3.0-asr-flash` 为非实时 HTTP 模型，不支持流式/增量 | **【文档】** |
| 10 | 流式型号为 `qwen-audio-3.0-asr-flash-streaming` / `qwen-audio-3.1-asr-flash-streaming` | **【文档】** |
| 11 | ASR `result-generated` 用 `payload.output.sentence.sentence_end` 区分中间/最终；`heartbeat` 标记心跳包 | **【文档】** |
| 12 | ASR 上行需**单声道**；`format` 支持 7 种；`sample_rate` 任意 | **【文档】** |
| 13 | ASR 保活：`parameters.heartbeat = true` + 持续发送静音音频 | **【文档】** |
| 14 | 官方**无** DashScope Node.js SDK（仅 Python/Java） | **【文档】** |
| 15 | 官方**给了** TTS 与 ASR 流式的裸 WebSocket **Node.js 示例**（`npm install ws`） | **【文档】** |
| 16 | HTTP 降级接口 URL 与请求体 | **【文档】** |
| 17 | PCM 输出/输入的**位深为 16-bit LE** | **【推断】**（官方示例注释写 `PCM16`/`s16le`，参数表无此字段） |
| 18 | 保活时客户端须主动发静音 PCM 帧（而非发心跳 JSON） | **【推断】**（文档只说"持续发送静音音频"） |
| 19 | Node.js `Authorization` 用小写 `bearer` 也能通过 | **【推断】**（官方示例写小写，表格写 `Bearer`；方案名大小写不敏感） |
| 20 | ASR 侧无取消指令 | **【文档中未找到】** |
| 21 | TTS 侧显式心跳/保活机制 | **【文档中未找到】**（只有 23 秒间隔约束） |
| 22 | TTS WebSocket PCM 输出的位深/字节序 | **【文档中未找到】** |
| 23 | `qwen-audio-3.0-tts-flash` 在新加坡地域是否可用 | **【文档中未找到】**（WS 指南给了新加坡 URL；但 HTTP API 页注明"仅在华北2（北京）地域可用"，WS 侧未明确 —— 上线前请在控制台确认） |

---

# 5. Node.js 适配器最小实现清单

```
连接 → 鉴权 → run-task → 发文本/音频 → 收事件 → 取消/结束 → 关闭
```

## 5.0 公共部分（TTS / ASR 共用）

```
1. 依赖
   npm install ws uuid
   （不需要任何 dashscope SDK）

2. 常量
   REGION        = 'cn-beijing' | 'ap-southeast-1'
   WS_URL        = `wss://${workspaceId}.${regionHost}/api-ws/v1/inference`
   API_KEY       = process.env.DASHSCOPE_API_KEY

3. 建连 + 鉴权（握手期完成）
   const ws = new WebSocket(WS_URL, {
     headers: {
       'Authorization': `Bearer ${API_KEY}`,   // 文档表格写法；官方 Node 示例用小写 bearer
       'user-agent': 'jarvis-adapter/1.0'      // 可选
       // 'X-DashScope-WorkSpace': workspaceId // 可选（已写在域名里时不必再传）
       // 'X-DashScope-DataInspection': 'enable' // 可选，非必要不要开
     }
   });
   → 握手失败（401/403）在 'error' / 'unexpected-response' 事件里捕获

4. 一个 task_id 贯穿全程
   const taskId = uuidv4();          // 文档要求 UUID 格式
   // run-task / 所有 continue-task / finish-task 必须用同一个 task_id
   // 新任务 → 生成新 taskId（连接可复用）

5. 消息分流（关键）
   ws.on('message', (data, isBinary) => {
     if (isBinary)  →  TTS: 音频分片，追加写文件/播放
     else           →  JSON.parse(data)，按 message.header.event 分派
   });

6. 事件分派（两者共有 4 个事件名）
   task-started   → 置 ready=true，开始发送（TTS 文本 / ASR 音频）
   result-generated → TTS: 看 payload.output.type
                      ASR: 看 payload.output.sentence.sentence_end
   task-finished  → 冲掉剩余音频/结果，关闭或复用连接
   task-failed    → 读 header.error_code / header.error_message，关闭连接
                    ⚠️ task-failed 后连接不可复用；task-finished 后可复用

7. 关闭
   ws.close(1000, 'bye')  // 官方 Java 示例即 close(1000, "bye")
```

## 5.1 TTS 流程

```
1) connect（见 5.0）
2) on open → 立即发送 run-task：
   {
     header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
     payload: {
       task_group: 'audio',
       task: 'tts',
       function: 'SpeechSynthesizer',
       model: 'qwen-audio-3.0-tts-flash',
       parameters: {
         text_type: 'PlainText',       // 必选，固定值
         voice: 'longanfengyue',       // ← 已核实属于本模型，无 _v3.6 后缀
         format: 'pcm',                // 需要 PCM 时写 'pcm'；默认 'mp3'
         sample_rate: 24000,           // 8000|16000|22050|24000|44100|48000
         volume: 50,                   // [0,100]
         rate: 1.0,                    // [0.5,2.0]
         pitch: 1.0,                   // [0.5,2.0]
         enable_ssml: false            // 若 true，只允许 1 次 continue-task
         // bit_rate: 32,              // 仅 mp3/opus，[6,510]
         // instruction: '...',        // 方言/情感控制
         // language_hints: ['zh'],
         // word_timestamp_enabled: false
       },
       input: {}                       // TTS 固定为 {}
     }
   }

3) 等 task-started（在此之前不得发 continue-task）
   → 置 ready = true

4) 发文本：continue-task（可按句/按段多次发）
   {
     header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
     payload: { input: { text: '第一段文本' } }
   }
   ⚠️ 单次 ≤ 20000 字符
   ⚠️ 累计 ≤ 200000 字符
   ⚠️ 两次 continue-task 间隔必须 < 23 秒（超时连接断）
      → 适配器需要：文本队列 + 定时 flush（建议阈值 15~20s）

5) 收音频：
   - JSON: header.event === 'result-generated'
       payload.output.type === 'sentence-begin'       → 建句子上下文
       payload.output.type === 'sentence-synthesis'   → 预告：下一帧是音频
       payload.output.type === 'sentence-end'         → 句子结束，读 payload.usage.characters
   - binary 帧 → 追加写入 Buffer / 推给下游播放器
   ⚠️ 用 isBinary 判定，不要试图 JSON.parse 二进制帧

6) 文本全部发完 → 发 finish-task（正常结束）
   {
     header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
     payload: { input: {} }
   }

6') 【取消】中途打断时，改发带 directive 的 finish-task：
   {
     header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
     payload: { input: { directive: 'cancel' } }
   }
   → 服务端立即回 task-finished，不再输出后续音频
   → 可在同一连接上发新的 run-task（新 taskId）继续下一轮

7) 收 task-finished → flush 音频 → 关闭或复用连接
   收 task-failed   → 读 header.error_code / header.error_message → 关闭
```

## 5.2 ASR 流程

```
0) ⚠️ 先纠正模型名
   ❌ qwen-audio-3.0-asr-flash          → 非实时 HTTP，不提供 WebSocket
   ✅ qwen-audio-3.0-asr-flash-streaming → 与用户所选同代，流式
   ✅ qwen-audio-3.1-asr-flash-streaming → 推荐（额外支持 keep_dialect / vad_model）

1) connect（见 5.0，URL 与 TTS 完全相同）

2) on open → 立即发送 run-task：
   {
     header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
     payload: {
       task_group: 'audio',
       task: 'asr',
       function: 'recognition',
       model: 'qwen-audio-3.0-asr-flash-streaming',
       parameters: {
         format: 'pcm',              // pcm|wav|mp3|opus|speex|aac|amr（必选）
         sample_rate: 16000,         // integer，任意（必选）
         semantic_punctuation_enabled: false,  // true=语义断句（关VAD）；false=默认 VAD 断句
         max_sentence_silence: 800,  // [200,6000]，默认 800
         heartbeat: true             // 需要长时间保持连接时开启（见保活）
         // vocabulary: { '张三': 5 },
         // vocabulary_id: '...',
         // language_hints: ['zh'],
         // vad_model: 'far_field_meeting_16k',  // 仅 3.1
         // keep_dialect: false,                 // 仅 3.1
         // special_word_filter: '...'
       },
       input: {}                     // 或 { context: [...] }
     }
   }

3) 等 task-started → 置 ready = true
   （文档：收到 task-started 后才能发送音频）

4) 发音频：裸 binary 帧，ws.send(chunk)
   - 单声道（所有实时模型均要求）
   - PCM 16-bit LE（推断；官方示例注释 PCM16 / s16le）
   - 16 kHz（示例值；文档说采样率任意，但必须与 run-task 的 sample_rate 一致）
   - 建议帧长 3200 字节 ≈ 100ms @16kHz/16bit/mono
   - 建议每 100ms 一帧（官方示例节奏）
   - ⚠️ 不发 JSON 包装，直接 send(Buffer)

5) 收结果：header.event === 'result-generated'
   const s = msg.payload.output.sentence;
   if (s.heartbeat === true) return;              // 心跳包，跳过（sentence_id === 0）
   if (s.sentence_begin === true) { /* 新句开始 */ }
   if (s.sentence_end === true) {
     // 最终结果：s.text 稳定，s.words[] 时间戳已固定
     emit('final', { text: s.text, sentenceId: s.sentence_id, words: s.words });
     // 用量：msg.payload.usage.{duration, input_tokens, output_tokens, total_tokens}
   } else {
     // 中间结果：s.text 可能后续变化
     emit('partial', { text: s.text, sentenceId: s.sentence_id });
   }
   ⚠️ 不要在中间结果上做最终落库；只有 sentence_end === true 才是终稿
   ⚠️ sentence_id 在心跳包中固定为 0，正常结果从 1 递增

6) 保活（长连接空闲时）：
   - run-task 已设 parameters.heartbeat = true
   - 客户端持续发送「静音 PCM 帧」（全 0 的 3200 字节 16-bit 帧，每 ~100ms 一帧）
   - 服务端回 result-generated 且 sentence.heartbeat === true（sentence_id === 0）→ 跳过
   - 【推断】文档只说"持续发送静音音频可保持连接"，未给客户端心跳 JSON 指令

7) 音频发完 → 发 finish-task
   {
     header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
     payload: { input: {} }
   }
   ⚠️ ASR 的 finish-task 没有 directive 字段（文档中 payload.input 固定 {}）
   然后继续收 result-generated（可能有尾包），直到 task-finished

8) 收 task-finished → 关闭或复用连接（新 run-task + 新 taskId）
   收 task-failed   → header.error_code / header.error_message → 关闭连接（不可复用）
   常见 error_message：'request timeout after 23 seconds.'（空闲超时）
```

## 5.3 适配器需要内置的健壮性

| 项 | 处理 |
|---|---|
| `task_id` 一致性 | 一个任务一个 UUID，run-task/continue-task/finish-task 共用；新任务换新 UUID |
| 23 秒空闲超时 | TTS：定时 flush 文本队列（<23s）；ASR：持续发音频或静音帧 + `heartbeat: true` |
| binary vs JSON | 用 `isBinary` 参数分流；ASR 上行用裸 Buffer，TTS 音频下行用裸 Buffer |
| 握手鉴权失败 | 401/403 在 `unexpected-response` / `error` 事件捕获 |
| `task-failed` 后 | 关闭连接（文档：不可复用）；`task-finished` 后可复用 |
| 文本长度 | TTS 单次 ≤20000、累计 ≤200000，需在适配器层分片 |
| 音色/模型匹配 | `voice` 必须属于该 `model` 的音色列表，否则 `InvalidParameter`；`longanfengyue` ↔ `qwen-audio-3.0-tts-flash` 已核实匹配 |
| 取消 | TTS：`finish-task` + `payload.input.directive='cancel'`，然后可在同连接上换新 taskId 重开 |
| PCM 位深 | 【推断】16-bit LE；上线前实测确认，必要时加一个可配置的位深参数 |

---

## 附：全部来源 URL

**TTS**
- 语音合成概述：https://docs.bailian.console.aliyun.com/zh/model-studio/tts-model.md
- 实时语音合成（含 Node.js 示例）：https://docs.bailian.console.aliyun.com/zh/model-studio/realtime-tts-user-guide.md
- Qwen-Audio-TTS 模型接入方式：https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-tts-model-access.md
- Qwen-Audio-TTS WebSocket 接入指南：https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-tts-websocket-api.md
- Qwen-Audio-TTS 客户端事件：https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-tts-client-events.md
- Qwen-Audio-TTS 服务端事件：https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-tts-server-events.md
- Qwen-Audio-TTS 音色列表：https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list.md
- 非实时语音合成 HTTP API：https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-tts-http-api.md

**ASR**
- 语音识别概述（含模型/协议矩阵、音频规格）：https://docs.bailian.console.aliyun.com/zh/model-studio/asr-model.md
- 实时语音识别（含 Node.js 示例）：https://docs.bailian.console.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide.md
- Qwen-Audio-ASR-Streaming 模型接入方式：https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-model-access.md
- Qwen-Audio-ASR-Streaming WebSocket 接入指南：https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-websocket-api.md
- Qwen-Audio-ASR-Streaming 客户端事件：https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-client-events.md
- Qwen-Audio-ASR-Streaming 服务端事件：https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-server-events.md
- 非实时语音识别 HTTP API：https://docs.bailian.console.aliyun.com/zh/model-studio/fun-asr-flash-recorded-speech-recognition-http-api.md

**通用**
- 安装 SDK（证明无 Node.js DashScope SDK）：https://docs.bailian.console.aliyun.com/zh/model-studio/install-sdk.md
- Realtime API 概述（协议/模型支持矩阵）：https://docs.bailian.console.aliyun.com/zh/model-studio/realtime-api-overview.md
- 完整文档索引：https://docs.bailian.console.aliyun.com/llms.txt
