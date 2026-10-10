/**
 * 屏幕帧文件存储：把"有效变化"的帧写到磁盘，**摘要完成后立即删除**。
 *
 * ## 定位：磁盘是待摘要帧的临时缓冲，不是帧仓库
 * 帧的持久存在时间上界 ≈ 攒批窗口（最长 5 分钟），之后必然被删除。
 * 这样做的原因：要把**整批最多 3 张图**一起发给模型，
 * 就必须先把它们暂存在某处 —— 内存缓冲会占用进程内存且崩溃即丢，
 * 磁盘缓冲则能在崩溃后由下次启动的 `cleanupOrphans()` 清理干净。
 *
 * ## 隐私边界（务必记住）
 * 这些文件**含屏幕画面本身**，因此：
 * - 目录在 `.data/` 下（已被 gitignore，绝不入库）；
 * - 启动时清空遗留帧；
 * - 摘要一完成就删除，不等待、不累积；
 * - 删除失败会记录警告，而不是静默留下文件。
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  PersistedFrameRef,
  ScreenFrameStorePort,
  ScreenImage,
} from "../../application/screen/screen-port.ts";
import type { Logger } from "../../observability/logger.ts";

export const FRAME_FILE_EXTENSION = ".jpg";

export interface FileScreenFrameStoreOptions {
  readonly directory: string;
  readonly logger?: Logger;
}

export class FileScreenFrameStore implements ScreenFrameStorePort {
  private readonly directory: string;
  private readonly logger: Logger | undefined;

  public constructor(options: FileScreenFrameStoreOptions) {
    this.directory = options.directory;
    this.logger = options.logger;
  }

  public get dir(): string {
    return this.directory;
  }

  public async save(image: ScreenImage): Promise<PersistedFrameRef> {
    await mkdir(this.directory, { recursive: true });
    // 文件名带毫秒时间戳（便于按时间排序排查）+ 短随机后缀（避免同毫秒冲突）
    const name = `${String(image.capturedAt)}-${randomUUID().slice(0, 8)}${FRAME_FILE_EXTENSION}`;
    const path = join(this.directory, name);
    const bytes = Buffer.from(image.jpegBase64, "base64");
    await writeFile(path, bytes);

    this.logger?.debug("screen.frame_persisted", { path, byteLength: bytes.length });

    return {
      path,
      width: image.width,
      height: image.height,
      byteLength: bytes.length,
      capturedAt: image.capturedAt,
    };
  }

  public async read(ref: PersistedFrameRef): Promise<ScreenImage> {
    const bytes = await readFile(ref.path);
    return {
      jpegBase64: bytes.toString("base64"),
      width: ref.width,
      height: ref.height,
      capturedAt: ref.capturedAt,
      byteLength: bytes.length,
    };
  }

  public async remove(refs: readonly PersistedFrameRef[]): Promise<number> {
    let removed = 0;
    for (const ref of refs) {
      try {
        await rm(ref.path, { force: true });
        removed += 1;
      } catch (error) {
        // 删除失败必须说出来：留下的是含画面的文件
        this.logger?.warn("screen.frame_delete_failed", {
          path: ref.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return removed;
  }

  public async cleanupOrphans(): Promise<number> {
    try {
      const entries = await readdir(this.directory);
      const orphans = entries.filter((name) => name.endsWith(FRAME_FILE_EXTENSION));
      let removed = 0;
      for (const name of orphans) {
        try {
          await rm(join(this.directory, name), { force: true });
          removed += 1;
        } catch {
          // 单个删除失败不阻塞其余清理
        }
      }
      if (removed > 0) {
        this.logger?.warn("screen.orphan_frames_cleaned", {
          count: removed,
          reason: "进程上次未正常结束，遗留的待摘要帧已清理",
        });
      }
      return removed;
    } catch (error) {
      // 目录不存在是正常情况（还没采过帧）
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger?.warn("screen.orphan_cleanup_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return 0;
    }
  }

  public async pendingCount(): Promise<number> {
    try {
      const entries = await readdir(this.directory);
      return entries.filter((name) => name.endsWith(FRAME_FILE_EXTENSION)).length;
    } catch {
      return 0;
    }
  }
}
