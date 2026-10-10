/**
 * 演示服务端（实施计划 §8 Milestone Alpha）。
 *
 * 用 Node 内置 `node:http`，不引入任何 Web 框架：
 * - `GET /`            静态面板
 * - `GET /api/state`   当前快照
 * - `GET /api/events`  SSE 实时推送快照（每次状态变化）
 * - `POST /api/chat`   聊天输入 → 完整 Master 决策链路
 * - `POST /api/cancel` 面板取消（用户直接指令）
 * - `POST /api/audio/stop`          模拟「用户开口 → 停播」
 * - `POST /api/audio/replay-stale`  投递已失效代次的分片，证明旧代次不复活
 */
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

import type { JarvisRuntime, RuntimeSnapshot } from "../../application/runtime.ts";
import type { Logger } from "../../observability/logger.ts";

export interface DemoServerOptions {
  readonly runtime: JarvisRuntime;
  readonly publicDir: string;
  readonly port: number;
  readonly host?: string;
  readonly logger?: Logger;
  /** SSE 心跳间隔，防止代理断开空闲连接。 */
  readonly heartbeatMs?: number;
}

export interface StartedServer {
  readonly url: string;
  readonly port: number;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

export class DemoServer {
  private readonly options: DemoServerOptions;
  private readonly sseClients = new Set<ServerResponse>();
  private server: Server | undefined;
  private unsubscribeRuntime: (() => void) | undefined;
  private heartbeat: NodeJS.Timeout | undefined;

  public constructor(options: DemoServerOptions) {
    this.options = options;
  }

  public async start(): Promise<StartedServer> {
    const host = this.options.host ?? "127.0.0.1";
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;

    this.unsubscribeRuntime = this.options.runtime.onUpdate((snapshot) => {
      this.broadcast(snapshot);
    });

    const heartbeatMs = this.options.heartbeatMs ?? 15_000;
    this.heartbeat = setInterval(() => {
      for (const client of this.sseClients) client.write(": ping\n\n");
    }, heartbeatMs);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, host, () => {
        resolve();
      });
    });

    return { url: `http://${host}:${String(this.options.port)}`, port: this.options.port };
  }

  public async stop(): Promise<void> {
    this.unsubscribeRuntime?.();
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    for (const client of this.sseClients) client.end();
    this.sseClients.clear();

    const server = this.server;
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    this.server = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    try {
      if (request.method === "GET" && (path === "/" || path === "/index.html")) {
        const html = await readFile(join(this.options.publicDir, "index.html"), "utf8");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(html);
        return;
      }

      if (request.method === "GET" && path === "/api/state") {
        sendJson(response, 200, this.options.runtime.snapshot());
        return;
      }

      if (request.method === "GET" && path === "/api/events") {
        this.attachSse(response);
        return;
      }

      if (request.method === "POST" && path === "/api/chat") {
        const body = await readJsonBody(request);
        const text = typeof body["text"] === "string" ? body["text"].trim() : "";
        if (text.length === 0) {
          sendJson(response, 400, { ok: false, error: "text 不能为空" });
          return;
        }
        const decision = await this.options.runtime.handleUserInput(text);
        sendJson(response, 200, { ok: true, decision });
        return;
      }

      if (request.method === "POST" && path === "/api/cancel") {
        const body = await readJsonBody(request);
        const taskId = typeof body["taskId"] === "string" ? body["taskId"] : "";
        if (taskId.length === 0) {
          sendJson(response, 400, { ok: false, error: "taskId 不能为空" });
          return;
        }
        const result = await this.options.runtime.cancelTask(taskId);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }

      if (request.method === "POST" && path === "/api/speech") {
        const body = await readJsonBody(request);
        const active = body["active"] === true;
        this.options.runtime.setSpeechActive(active);
        sendJson(response, 200, { ok: true, speechActive: active });
        return;
      }

      if (request.method === "POST" && path === "/api/audio/stop") {
        this.options.runtime.stopPlayback();
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && path === "/api/audio/replay-stale") {
        sendJson(response, 200, { ok: true, ...this.options.runtime.replayStaleChunk() });
        return;
      }

      sendJson(response, 404, { ok: false, error: `未知路由：${request.method ?? "?"} ${path}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn("demo.request_failed", { path, error: message });
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: message });
      else response.end();
    }
  }

  private attachSse(response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(`data: ${JSON.stringify(this.options.runtime.snapshot())}\n\n`);
    this.sseClients.add(response);
    response.on("close", () => {
      this.sseClients.delete(response);
    });
  }

  private broadcast(snapshot: RuntimeSnapshot): void {
    if (this.sseClients.size === 0) return;
    const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of this.sseClients) client.write(payload);
  }
}
