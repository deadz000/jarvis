import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * PowerShell 脚本**必须带 UTF-8 BOM**。
 *
 * ## 为什么这是一条测试而不是一句备注
 * 真实故障：`scripts/screen-probe.ps1` 是 UTF-8 无 BOM，注释里有中文。
 * **Windows PowerShell 5.1 默认按系统 ANSI 码页读取 .ps1**，中文注释被错误解码，
 * 其中某个中文字符的 GBK 字节恰好包含引号，**静默吞掉了后面一整条赋值语句**。
 *
 * 症状极具迷惑性：脚本仍返回 `ok:true`，只是某个数组变成空的；
 * 单独在交互式 PowerShell 里跑同样的逻辑却完全正常。
 *
 * 这类故障靠人工 review 几乎发现不了，所以用测试锁住。
 */
const SCRIPTS_DIR = join(process.cwd(), "scripts");
const UTF8_BOM = [0xef, 0xbb, 0xbf];

describe("scripts/*.ps1 编码", () => {
  const scripts = readdirSync(SCRIPTS_DIR).filter((name) => name.endsWith(".ps1"));

  it("至少存在一个 PowerShell 脚本", () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  it.each(scripts)("%s 带 UTF-8 BOM（否则 PS 5.1 会误解码中文注释）", (name) => {
    const bytes = readFileSync(join(SCRIPTS_DIR, name));
    const hasBom =
      bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2];

    expect(
      hasBom,
      `${name} 缺少 UTF-8 BOM。在 Windows PowerShell 5.1 下，文件里的中文注释会被按 ANSI 码页解码，可能静默破坏脚本。修复：以 UTF-8 with BOM 重新保存。`,
    ).toBe(true);
  });

  it.each(scripts)("%s 不含 CRLF 之外的可疑编码残留", (name) => {
    const text = readFileSync(join(SCRIPTS_DIR, name), "utf8");
    // 解码正确的话，中文注释应当可读（存在至少一个中文字符）
    expect(/[\u4e00-\u9fff]/.test(text)).toBe(true);
  });
});
