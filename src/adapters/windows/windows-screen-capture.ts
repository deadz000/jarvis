/**
 * Windows 屏幕采集适配器。
 *
 * 实现方式：**调用 PowerShell 探针脚本**（`scripts/screen-probe.ps1`），
 * 在 .NET 侧完成「截屏 → 降采样」，只把紧凑数值数组返回。
 *
 * 这样做的两个理由：
 * 1. **隐私**：原始帧不落盘，也不进入 Node 的堆（只有 64 个灰度值 + 768 个色块通道值）；
 * 2. **零依赖**：不引入原生截图模块，Node 也不需要图像解码库。
 *
 * 代价：每次采集要起一个 PowerShell 进程（本机实测约 375ms）——
 * 对 5s 节流的使用方式完全可以接受，但**不适合高频采集**。
 */
import { execFile } from "node:child_process";
import { join } from "node:path";

import type { Logger } from "../../observability/logger.ts";
import { fingerprintToHex, medianFingerprint } from "../../application/screen/fingerprint.ts";
import type { ScreenCapturePort, ScreenFrame, ScreenProbeSample } from "../../application/screen/screen-port.ts";

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
export const DEFAULT_PROBE_RELATIVE_PATH = join("scripts", "screen-probe.ps1");

/** 默认的 Windows PowerShell 路径（本机没有 pwsh 7，5.1 可用）。 */
export function defaultPowerShellPath(): string {
  const fromEnv = process.env["JARVIS_POWERSHELL"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export interface WindowsScreenCaptureOptions {
  /** 探针脚本路径；默认相对工作区。 */
  readonly scriptPath?: string;
  readonly powershellPath?: string;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

export class WindowsScreenCapture implements ScreenCapturePort {
  private readonly scriptPath: string;
  private readonly powershellPath: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger | undefined;

  public constructor(workspace: string, options: WindowsScreenCaptureOptions = {}) {
    this.scriptPath = options.scriptPath ?? join(workspace, DEFAULT_PROBE_RELATIVE_PATH);
    this.powershellPath = options.powershellPath ?? defaultPowerShellPath();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.logger = options.logger;
  }

  public async isAvailable(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    try {
      await this.capture();
      return true;
    } catch (error) {
      this.logger?.debug("screen.probe_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  public async capture(): Promise<ScreenFrame> {
    if (process.platform !== "win32") {
      throw new Error(`屏幕采集仅支持 Windows，当前平台：${process.platform}`);
    }

    const stdout = await this.runProbe();
    let sample: ScreenProbeSample;
    try {
      sample = JSON.parse(stdout) as ScreenProbeSample;
    } catch {
      throw new Error(`屏幕探针输出无法解析为 JSON（前 200 字符）：${stdout.slice(0, 200)}`);
    }

    if (sample.ok !== true) {
      throw new Error(`屏幕探针报告失败：${sample.error ?? "未知原因"}`);
    }
    if (!Array.isArray(sample.gray) || sample.gray.length === 0) {
      throw new Error("屏幕探针未返回灰度数据");
    }

    return toScreenFrame(sample);
  }

  private runProbe(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        this.powershellPath,
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath],
        { timeout: this.timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error !== null) {
            const detail = stderr.length > 0 ? `；stderr：${stderr.slice(0, 200)}` : "";
            reject(new Error(`屏幕探针执行失败：${error.message}${detail}`));
            return;
          }
          resolve(stdout.toString());
        },
      );
    });
  }
}

/** 把探针输出转换为去像素化的帧摘要。 */
export function toScreenFrame(sample: ScreenProbeSample): ScreenFrame {
  const { bits, median } = medianFingerprint(sample.gray);

  const blockColors: Array<{ r: number; g: number; b: number }> = [];
  for (let index = 0; index + 2 < sample.rgb.length; index += 3) {
    blockColors.push({
      r: sample.rgb[index] ?? 0,
      g: sample.rgb[index + 1] ?? 0,
      b: sample.rgb[index + 2] ?? 0,
    });
  }

  return {
    capturedAt: sample.capturedAtMs,
    width: sample.width,
    height: sample.height,
    fingerprint: bits,
    fingerprintHex: fingerprintToHex(bits),
    grayMedian: median,
    blockColors,
    blockSize: sample.blockSize,
  };
}
