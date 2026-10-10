/**
 * Windows 屏幕图像采集：只在**摘要时**物化一张降采样 JPEG。
 *
 * 与 `WindowsScreenCapture`（每轮轮询用的数值探针）分开的原因：
 * 图像编码比数值提取贵，而且图像是敏感数据的载体 ——
 * 让它的存在时间尽可能短、产生次数尽可能少。
 */
import { execFile } from "node:child_process";
import { join } from "node:path";

import type { Logger } from "../../observability/logger.ts";
import type { ScreenImage, ScreenImagePort } from "../../application/screen/screen-port.ts";
import { defaultPowerShellPath,DEFAULT_PROBE_TIMEOUT_MS } from "./windows-screen-capture.ts";

export const DEFAULT_IMAGE_MAX_WIDTH = 1_024;
export const DEFAULT_IMAGE_JPEG_QUALITY = 60;
export const DEFAULT_IMAGE_RELATIVE_PATH = join("scripts", "screen-image.ps1");

export interface WindowsScreenImageOptions {
  readonly scriptPath?: string;
  readonly powershellPath?: string;
  readonly timeoutMs?: number;
  readonly maxWidth?: number;
  readonly jpegQuality?: number;
  readonly logger?: Logger;
}

interface ScreenImageProbeResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly byteLength: number;
  readonly base64: string;
}

export class WindowsScreenImage implements ScreenImagePort {
  private readonly scriptPath: string;
  private readonly powershellPath: string;
  private readonly timeoutMs: number;
  private readonly maxWidth: number;
  private readonly jpegQuality: number;
  private readonly logger: Logger | undefined;

  public constructor(workspace: string, options: WindowsScreenImageOptions = {}) {
    this.scriptPath = options.scriptPath ?? join(workspace, DEFAULT_IMAGE_RELATIVE_PATH);
    this.powershellPath = options.powershellPath ?? defaultPowerShellPath();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.maxWidth = options.maxWidth ?? DEFAULT_IMAGE_MAX_WIDTH;
    this.jpegQuality = options.jpegQuality ?? DEFAULT_IMAGE_JPEG_QUALITY;
    this.logger = options.logger;
  }

  public async captureImage(): Promise<ScreenImage> {
    if (process.platform !== "win32") {
      throw new Error(`屏幕图像采集仅支持 Windows，当前平台：${process.platform}`);
    }

    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        this.powershellPath,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          this.scriptPath,
          "-MaxWidth",
          String(this.maxWidth),
          "-JpegQuality",
          String(this.jpegQuality),
        ],
        { timeout: this.timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (error, out, stderr) => {
          if (error !== null) {
            const detail = stderr.length > 0 ? `；stderr：${stderr.slice(0, 200)}` : "";
            reject(new Error(`屏幕图像探针执行失败：${error.message}${detail}`));
            return;
          }
          resolve(out.toString());
        },
      );
    });

    let parsed: ScreenImageProbeResult;
    try {
      parsed = JSON.parse(stdout) as ScreenImageProbeResult;
    } catch {
      throw new Error(`屏幕图像探针输出无法解析为 JSON（前 200 字符）：${stdout.slice(0, 200)}`);
    }

    if (parsed.ok !== true) {
      throw new Error(`屏幕图像探针报告失败：${parsed.error ?? "未知原因"}`);
    }
    if (typeof parsed.base64 !== "string" || parsed.base64.length === 0) {
      throw new Error("屏幕图像探针未返回图片数据");
    }

    this.logger?.debug("screen.image_captured", {
      width: parsed.width,
      height: parsed.height,
      byteLength: parsed.byteLength,
    });

    return {
      jpegBase64: parsed.base64,
      width: parsed.width,
      height: parsed.height,
      capturedAt: Date.now(),
      byteLength: parsed.byteLength,
    };
  }
}
