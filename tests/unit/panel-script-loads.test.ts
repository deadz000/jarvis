import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

/**
 * 面板脚本的**载入期**冒烟测试。
 *
 * ## 为什么需要它
 * 曾经的真实故障：往 `public/index.html` 里插入音频播放代码时，把
 * `events.addEventListener(...)` 写在了 `const events = new EventSource(...)` **之前**。
 * 这触发 TDZ 错误，**从那一行起整段脚本不再执行** —— EventSource 根本没建，
 * 面板永远停在「Master 决策中…」。
 *
 * 后端 API 全部正常，只测 API 永远发现不了：必须**让脚本在真实执行环境里跑一遍**。
 * 这里用最小 DOM shim 执行内联脚本，任何载入期异常都会让测试失败。
 */

interface FakeElement {
  style: Record<string, string>;
  textContent: string;
  innerHTML: string;
  value: string;
  disabled: boolean;
  onclick: unknown;
  classList: {
    add: (name: string) => void;
    remove: (name: string) => void;
    contains: (name: string) => boolean;
    toggle: (name: string) => void;
  };
  addEventListener: () => void;
  appendChild: () => void;
  querySelectorAll: () => unknown[];
}

function fakeElement(): FakeElement {
  const classes = new Set<string>();
  return {
    style: {},
    textContent: "",
    innerHTML: "",
    value: "",
    disabled: false,
    onclick: null,
    classList: {
      add: (name: string) => void classes.add(name),
      remove: (name: string) => void classes.delete(name),
      contains: (name: string) => classes.has(name),
      toggle: (name: string) => void (classes.has(name) ? classes.delete(name) : classes.add(name)),
    },
    addEventListener: () => {},
    appendChild: () => {},
    querySelectorAll: () => [],
  };
}

function buildSandbox(): Record<string, unknown> {
  const elements = new Map<string, FakeElement>();
  const sandbox: Record<string, unknown> = {
    console,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    RegExp,
    Map,
    Set,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      getElementById: (id: string): FakeElement => {
        let element = elements.get(id);
        if (element === undefined) {
          element = fakeElement();
          elements.set(id, element);
        }
        return element;
      },
      createElement: (): FakeElement => fakeElement(),
      querySelectorAll: (): unknown[] => [],
      addEventListener: (): void => {},
    },
    window: { addEventListener: (): void => {} },
    EventSource: class {
      public onopen: unknown = null;
      public onerror: unknown = null;
      public onmessage: unknown = null;
      public addEventListener(): void {}
    },
    AudioContext: class {
      public sampleRate = 24_000;
      public state = "running";
      public currentTime = 0;
      public destination = {};
      public createBuffer(): unknown {
        return { duration: 0, copyToChannel: (): void => {} };
      }
      public createBufferSource(): unknown {
        return { connect: (): void => {}, start: (): void => {}, stop: (): void => {}, onended: null };
      }
      public resume(): Promise<void> {
        return Promise.resolve();
      }
    },
  };
  sandbox["globalThis"] = sandbox;
  return sandbox;
}

describe("public/index.html 面板脚本", () => {
  const html = readFileSync(join(process.cwd(), "public", "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1] ?? "",
  );

  it("至少有一个内联脚本", () => {
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.some((script) => script.includes("EventSource"))).toBe(true);
  });

  it("载入期不抛异常（TDZ、引用未定义变量等都会在这里失败）", () => {
    const sandbox = buildSandbox();

    for (const [index, script] of scripts.entries()) {
      expect(
        () => vm.runInNewContext(script, sandbox, { filename: `public/index.html#script${String(index)}` }),
        `内联脚本 #${String(index)} 载入期抛错`,
      ).not.toThrow();
    }
  });

  it("EventSource 确实被创建（这是「面板能收到推送」的前提）", () => {
    let created = 0;
    const sandbox = buildSandbox();
    sandbox["EventSource"] = class {
      public onopen: unknown = null;
      public onerror: unknown = null;
      public onmessage: unknown = null;
      public constructor() {
        created += 1;
      }
      public addEventListener(): void {}
    };

    for (const script of scripts) {
      vm.runInNewContext(script, sandbox, { filename: "public/index.html<script>" });
    }

    expect(created).toBe(1);
  });
});
