/**
 * 模型选择：把 `.env` + `config/models.json` 解析成可用的 `ModelRuntime` 与模型对象。
 * 集中在一处，避免每个入口/示例各写一遍选择逻辑。
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { ConfigError, type AppConfig } from "../../config/env.ts";
import type { PiModel } from "./pi-worker-runtime.ts";

export interface SelectedModel {
  readonly modelRuntime: ModelRuntime;
  readonly model: PiModel;
  /** 便于日志展示的可用模型列表（不含任何凭据）。 */
  readonly availableLabel: string;
  readonly availableCount: number;
  /** 是否由配置显式指定（而非取第一个可用模型）。 */
  readonly pinned: boolean;
}

export async function selectModel(config: AppConfig): Promise<SelectedModel> {
  const modelRuntime = await ModelRuntime.create(
    config.modelsPath === undefined ? {} : { modelsPath: config.modelsPath },
  );

  const available = await modelRuntime.getAvailable();
  const availableLabel = available.map((model) => `${model.provider}/${model.id}`).join(", ") || "（无）";

  if (config.modelProvider !== undefined && config.modelId !== undefined) {
    const pinned = modelRuntime.getModel(config.modelProvider, config.modelId);
    if (pinned === undefined) {
      throw new ConfigError(
        `找不到模型 ${config.modelProvider}/${config.modelId}；当前有凭据的可用模型：${availableLabel}`,
      );
    }
    return {
      modelRuntime,
      model: pinned,
      availableLabel,
      availableCount: available.length,
      pinned: true,
    };
  }

  const first = available[0];
  if (first === undefined) {
    throw new ConfigError(
      "没有检测到任何「有凭据」的可用模型。请检查 .env 中的 JARVIS_MODEL_API_KEY 或 provider API Key，以及 config/models.json 是否正确。",
    );
  }
  return {
    modelRuntime,
    model: first,
    availableLabel,
    availableCount: available.length,
    pinned: false,
  };
}
