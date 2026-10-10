import { describe, expect, it } from "vitest";

import {
  DEFAULT_SPOKEN_MAX_LENGTH,
  extractSpokenSummary,
  resolveSpokenText,
  SPOKEN_BLOCK_END,
  SPOKEN_BLOCK_START,
  splitSentences,
  toSpokenText,
} from "../../src/application/delivery/spoken-text.ts";

describe("toSpokenText — 确定性口语化转换", () => {
  it("移除围栏代码块，不把代码念出来", () => {
    const result = toSpokenText("结果如下：\n```ts\nconst a = 1;\n```\n就是这样。");

    expect(result.removedCodeBlocks).toBe(1);
    expect(result.text).not.toContain("const a = 1");
    expect(result.text).toContain("结果如下");
    expect(result.text).toContain("就是这样");
  });

  it("去掉 markdown 标记：标题、列表、强调、引用、行内代码", () => {
    const result = toSpokenText(
      "# 标题\n- 第一项\n- **重点**内容\n> 引用一句\n\n用 `npm test` 运行。",
      { maxSentences: 10 },
    );

    expect(result.text).not.toContain("#");
    expect(result.text).not.toContain("-");
    expect(result.text).not.toContain("*");
    expect(result.text).not.toContain(">");
    expect(result.text).not.toContain("`");
    expect(result.text).toContain("标题");
    expect(result.text).toContain("重点内容");
    expect(result.text).toContain("npm test");
  });

  it("移除 URL 与表格行（念出来没有意义）", () => {
    const result = toSpokenText(
      "详情见 https://github.com/deadz000/jarvis 这个地址。\n| 列一 | 列二 |\n| --- | --- |\n结束了。",
    );

    expect(result.text).not.toContain("https://");
    expect(result.text).not.toContain("|");
    expect(result.text).toContain("详情见");
    expect(result.text).toContain("结束了");
  });

  it("按句子上限截断，且截断在句子边界", () => {
    const result = toSpokenText("第一句。第二句。第三句。第四句。", { maxSentences: 2 });

    expect(result.text).toBe("第一句。第二句。");
    expect(result.truncated).toBe(true);
  });

  it("超长时在句子边界内截断，不截断句子中间", () => {
    const long = "这是一个很长的句子。".repeat(40);
    const result = toSpokenText(long, { maxLength: 60, maxSentences: 40 });

    expect(result.text.length).toBeLessThanOrEqual(60);
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith("。")).toBe(true);
  });

  it("空输入与纯代码块不会产生空指针", () => {
    expect(toSpokenText("").text).toBe("");
    expect(toSpokenText("```\ncode\n```").text).toBe("");
  });

  it("默认上限约为一口气可播完的长度", () => {
    const result = toSpokenText("很长的一句话。".repeat(100));

    expect(result.text.length).toBeLessThanOrEqual(DEFAULT_SPOKEN_MAX_LENGTH);
  });
});

describe("splitSentences", () => {
  it("按中英文句末标点切分并保留标点", () => {
    expect(splitSentences("第一句。第二句！Third?")).toEqual(["第一句。", "第二句！", "Third?"]);
  });
});

describe("extractSpokenSummary / resolveSpokenText", () => {
  it("能分离出模型给的口语块", () => {
    const output = `## 完整结果\n这里是面板要看的详细内容。\n\n${SPOKEN_BLOCK_START}\n天气是晴，24 度。\n${SPOKEN_BLOCK_END}`;
    const extracted = extractSpokenSummary(output);

    expect(extracted.full).toContain("完整结果");
    expect(extracted.full).not.toContain(SPOKEN_BLOCK_START);
    expect(extracted.spoken).toBe("天气是晴，24 度。");
  });

  it("模型给了口语稿 → 采用它（仍做确定性清洗与限长）", () => {
    const output = `详细内容。\n${SPOKEN_BLOCK_START}**重点**：完成 https://example.com 了。\n${SPOKEN_BLOCK_END}`;
    const resolved = resolveSpokenText(output);

    expect(resolved.fromModel).toBe(true);
    expect(resolved.spoken).not.toContain("*");
    expect(resolved.spoken).not.toContain("https://");
    expect(resolved.full).toContain("详细内容");
  });

  it("模型没给口语稿 → 确定性兜底转换（这就是铁律 7 的兜底）", () => {
    const resolved = resolveSpokenText("# 结果\n- 已完成 **三项** 检查\n```\ncode\n```");

    expect(resolved.fromModel).toBe(false);
    expect(resolved.spoken.length).toBeGreaterThan(0);
    expect(resolved.spoken).not.toContain("#");
    expect(resolved.spoken).not.toContain("*");
    expect(resolved.spoken).not.toContain("code");
  });

  it("模型给了空的口语块 → 回退到确定性转换", () => {
    const resolved = resolveSpokenText(`完整结果在这里。\n${SPOKEN_BLOCK_START}\n\n${SPOKEN_BLOCK_END}`);

    expect(resolved.fromModel).toBe(false);
    expect(resolved.spoken).toContain("完整结果");
  });

  it("没有标记时完整结果原样保留", () => {
    const resolved = resolveSpokenText("就是一段普通文本。");

    expect(resolved.full).toBe("就是一段普通文本。");
    expect(resolved.spoken).toBe("就是一段普通文本。");
  });
});
