/**
 * 屏幕帧指纹与变化度量（**纯函数，可确定性单测**）。
 *
 * ## 64 位中值指纹（pHash 的简化形式）
 * 把画面降采样到 8x8 灰度 → 取这 64 个值的**中值**作阈值 →
 * 每个像素高于中值记 1，否则记 0，得到 64 位指纹。
 *
 * 用中值而不是均值：中值对整体明暗变化更稳健（例如系统切换深色/浅色主题时，
 * 均值会整体平移而中值几乎不变，避免把"整体变亮"误判为"画面内容变了"）。
 *
 * ## 大面积色块变化
 * 把画面分成 16x16 色块，比较两帧对应色块的平均色距离，
 * 统计"变化超过阈值"的色块**比例**。用于排除"光标闪动/时钟跳秒"这类
 * 只在极小区域发生的变化 —— 这类变化会让指纹变，但并不代表上下文真的变了。
 *
 * ## 为什么两个条件要 AND
 * 单看指纹：光标闪烁、时钟秒数、视频播放都会触发。
 * 单看色块：整体渐变动画可能触发而实际没有内容变化。
 * 两者同时成立才认为是"有意义的上下文变化"，这是把误报压下去的关键。
 */
import type { ScreenFrame } from "./screen-port.ts";

/** 每个色块的通道差超过该值就认为该色块变了（0-255）。 */
export const DEFAULT_BLOCK_COLOR_THRESHOLD = 30;

/** 64 位中值指纹。`gray` 长度必须是完全平方数。 */
export function medianFingerprint(gray: readonly number[]): { bits: bigint; median: number } {
  if (gray.length === 0) throw new RangeError("灰度数组为空");
  const sorted = [...gray].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;

  let bits = 0n;
  for (let index = 0; index < gray.length; index += 1) {
    // 严格大于中值才置 1；等于中值取 0，保证阈值恒定时结果稳定
    if ((gray[index] ?? 0) > median) bits |= 1n << BigInt(index);
  }
  return { bits, median };
}

/** 指纹十六进制（固定 16 位，便于日志比对）。 */
export function fingerprintToHex(bits: bigint): string {
  return bits.toString(16).padStart(16, "0");
}

/** 两个指纹的汉明距离（不同位的个数）。 */
export function hammingDistance(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let count = 0;
  while (diff > 0n) {
    // 每轮清掉最低位的 1
    diff &= diff - 1n;
    count += 1;
  }
  return count;
}

/**
 * 色块变化比例：变化幅度超过 `threshold` 的色块占比（0~1）。
 * 两帧色块数量不同时按较小的那个比较（例如换了显示器分辨率）。
 */
export function blockChangeRatio(
  previous: ScreenFrame,
  current: ScreenFrame,
  threshold = DEFAULT_BLOCK_COLOR_THRESHOLD,
): number {
  const total = Math.min(previous.blockColors.length, current.blockColors.length);
  if (total === 0) return 0;

  let changed = 0;
  for (let index = 0; index < total; index += 1) {
    const a = previous.blockColors[index];
    const b = current.blockColors[index];
    if (a === undefined || b === undefined) continue;
    const distance = Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
    if (distance > threshold) changed += 1;
  }
  return changed / total;
}
