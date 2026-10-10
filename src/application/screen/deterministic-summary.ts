/**
 * 确定性屏幕摘要（纯逻辑，无厂商依赖）。
 *
 * ## 为什么它必须存在
 * 模型摘要是**概率性调用**（网络、配额、token 上限都可能失败）。
 * 如果失败就静默丢弃，屏幕上下文会出现**无声的缺口** ——
 * 调用方无法区分「屏幕没变化」和「摘要失败了」。
 *
 * 所以失败时退回这里：只陈述可确定的事实（这一批几帧、分辨率、观测时段），
 * 并**明确标注摘要未生成**。信息量弱，但诚实。
 */
import type { ScreenFrame, ScreenSummary } from "./screen-port.ts";

export const MAX_DETERMINISTIC_SUMMARY_LENGTH = 200;

export function deterministicScreenSummary(
  frames: readonly ScreenFrame[],
  at: number,
  reason = "模型调用失败",
): ScreenSummary {
  const first = frames[0];
  const last = frames[frames.length - 1];
  const size = first === undefined ? "未知" : `${String(first.width)}x${String(first.height)}`;
  const spanMs = first !== undefined && last !== undefined ? Math.max(0, last.capturedAt - first.capturedAt) : 0;

  const text =
    `屏幕在约 ${(spanMs / 1000).toFixed(0)} 秒内发生了 ${String(frames.length)} 次明显变化` +
    `（分辨率 ${size}），但内容摘要未能生成（${reason}）。`;

  return {
    text: text.length <= MAX_DETERMINISTIC_SUMMARY_LENGTH ? text : `${text.slice(0, MAX_DETERMINISTIC_SUMMARY_LENGTH - 1)}…`,
    at,
    frameCount: frames.length,
    fromModel: false,
  };
}
