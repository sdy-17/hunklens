import { spawn } from "node:child_process";

/**
 * 极简 MCP 客户端：只实现 HunkLens 需要的那部分（initialize / tools/list / tools/call）。
 * 传输支持两种：
 *   - http：Streamable HTTP（POST JSON-RPC，响应可能是 JSON 也可能是 SSE；带回 Mcp-Session-Id）
 *   - stdio：本地进程（按行分隔的 JSON-RPC）
 * 目标是「能连上就有工具，连不上就安静降级」，评审流程不能因为某个 MCP 挂掉而失败。
 */

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "hunklens", version: "0.2.0" };
const DEFAULT_TIMEOUT = 60000;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error((label || "MCP 请求") + " 超时 " + ms + "ms")), ms);
    }),
  ]);
}

/** 把 SSE 响应里的 data: 行拼起来，找到 id 匹配的那条 JSON-RPC 响应 */
function pickFromSse(text, id) {
  const blocks = String(text).split(/\r?\n\r?\n/);
  const found = [];
  for (const block of blocks) {
    const dataLines = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    if (!dataLines.length) continue;
    const payload = dataLines.join("\n");
    try {
      const obj = JSON.parse(payload);
      if (Array.isArray(obj)) found.push(...obj);
      else found.push(obj);
    } catch {
      /* 忽略注释 / 心跳 */
    }
  }
  if (!found.length) return null;
  const byId = found.find((o) => o && o.id === id);
  return byId || found[found.length - 1];
}

export class McpServer {
  constructor(spec) {
    this.spec = spec || {};
    this.name = spec.name || "mcp";
    this.url = spec.url || "";
    this.command = spec.command || "";
    this.args = spec.args || [];
    this.env = spec.env || {};
    this.cwd = spec.cwd || undefined;
    this.headers = spec.headers || {};
    this.timeout = spec.timeout || DEFAULT_TIMEOUT;
    this.proc = null;
    this.sessionId = "";
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuf = "";
    this.stderrTail = "";
    this.protocolVersion = PROTOCOL_VERSION;
  }

  get transport() {
    return this.url ? "http" : "stdio";
  }

  async start() {
    if (this.started) return;
    if (this.transport === "stdio") this.spawnChild();
    this.started = true;
    await this.initialize();
  }

  spawnChild() {
    const env = Object.assign({}, process.env, this.env);
    this.proc = spawn(this.command, this.args, { env, cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.on("error", (e) => this.rejectAll(new Error("MCP 进程启动失败: " + e.message)));
    this.proc.on("exit", (code) => this.rejectAll(new Error("MCP 进程已退出 code=" + code)));
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
  }

  onStdout(chunk) {
    this.stdoutBuf += chunk;
    let idx;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error("MCP " + (msg.error.message || JSON.stringify(msg.error))));
      else resolve(msg.result);
    }
  }

  rejectAll(err) {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  async request(method, params, { notify = false } = {}) {
    const id = notify ? undefined : this.nextId++;
    const payload = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    if (!notify) payload.id = id;
    if (this.transport === "stdio") {
      if (!this.proc || !this.proc.stdin.writable) throw new Error("MCP 进程未运行");
      if (notify) { this.proc.stdin.write(JSON.stringify(payload) + "\n"); return null; }
      const p = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
      this.proc.stdin.write(JSON.stringify(payload) + "\n");
      return withTimeout(p, this.timeout, "MCP " + method);
    }
    return this.httpRequest(payload, id, method);
  }

  async httpRequest(payload, id, method) {
    const headers = Object.assign({ "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, this.headers);
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    let res;
    try {
      res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(payload), signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      throw new Error("MCP 连接失败 " + this.url + ": " + (e && e.message ? e.message : e));
    }
    clearTimeout(timer);
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (payload.id === undefined) return null;
    if (res.status === 202) return null;
    if (!res.ok) throw new Error("MCP HTTP " + res.status + " (" + method + "): " + (await res.text()).slice(0, 200));
    const ctype = res.headers.get("content-type") || "";
    const text = await res.text();
    const obj = ctype.includes("text/event-stream") ? pickFromSse(text, id) : safeJson(text);
    if (!obj) throw new Error("MCP 空响应 (" + method + ")");
    if (obj.error) throw new Error("MCP " + (obj.error.message || JSON.stringify(obj.error)));
    return obj.result;
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    if (result && result.protocolVersion) this.protocolVersion = result.protocolVersion;
    this.serverInfo = (result && result.serverInfo) || {};
    await this.request("notifications/initialized", {}, { notify: true });
  }

  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 5; page++) {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      const batch = (result && result.tools) || [];
      tools.push(...batch);
      cursor = result && result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name, args) {
    const result = await this.request("tools/call", { name, arguments: args || {} });
    return toolResultText(result);
  }

  async close() {
    try { if (this.proc) this.proc.kill(); } catch { /* ignore */ }
    this.proc = null;
    this.started = false;
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** MCP tools/call 的结果转成给模型看的纯文本（顺带带上结构化结果的 JSON） */
export function toolResultText(result) {
  if (!result) return "";
  const parts = [];
  const content = Array.isArray(result.content) ? result.content : [];
  for (const c of content) {
    if (!c) continue;
    if (c.type === "text") parts.push(String(c.text || "").trim());
    else if (c.type === "resource" && c.resource) parts.push("[resource " + (c.resource.uri || "") + "] " + (c.resource.text || ""));
    else if (c.type === "image") parts.push("[image " + (c.mimeType || "") + "]");
    else parts.push(JSON.stringify(c));
  }
  if (result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.filter(Boolean).join("\n").trim();
  return result.isError ? "工具返回错误: " + text : text;
}

/** OpenAI 兼容的函数名只允许 [a-zA-Z0-9_-]，这里做双向映射 */
export function toolFunctionName(server, tool) {
  const clean = String(tool).replace(/[^a-zA-Z0-9_-]/g, "_");
  return ("mcp__" + String(server).replace(/[^a-zA-Z0-9_-]/g, "_") + "__" + clean).slice(0, 64);
}

export class McpHub {
  constructor(readConfig) {
    this.readConfig = readConfig || (() => ({}));
    this.servers = [];
    this.routes = new Map();
    this.statuses = [];
    this.loadedAt = 0;
    this.pending = null;
  }

  specs() {
    const cfg = this.readConfig() || {};
    const list = Array.isArray(cfg.servers) ? cfg.servers : [];
    if (cfg.enabled === false) return [];
    return list.filter((s) => s && (s.url || s.command) && s.enabled !== false);
  }

  /** 连接（幂等）：并发初始化，各自失败只记录不抛出 */
  ensure() {
    if (this.pending) return this.pending;
    const specs = this.specs();
    this.pending = this.connectAll(specs).then((statuses) => {
      this.loadedAt = Date.now();
      return statuses;
    }).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async connectAll(specs) {
    if (this.statuses.length && this.loadedAt && Date.now() - this.loadedAt < 60000) return this.statuses;
    this.routes.clear();
    this.servers = [];
    const cfg = this.readConfig() || {};
    const allow = cfg.tools;
    this.statuses = await Promise.all(specs.map(async (spec) => {
      const server = new McpServer(spec);
      const status = { name: server.name, transport: server.transport, ok: false, tools: [], error: "" };
      try {
        await withTimeout(server.start(), spec.timeout || DEFAULT_TIMEOUT, "MCP " + server.name + " 初始化");
        const tools = await withTimeout(server.listTools(), spec.timeout || DEFAULT_TIMEOUT, "MCP " + server.name + " listTools");
        const picked = pickTools(server.name, tools, spec.tools || allow, spec.excludeTools);
        for (const t of picked) {
          this.routes.set(t.fnName, { server, tool: t.name, meta: t });
          status.tools.push(t.name);
        }
        status.ok = picked.length > 0;
        if (!picked.length) status.error = "没有匹配的工具";
        this.servers.push(server);
      } catch (e) {
        status.error = String(e && e.message ? e.message : e).slice(0, 300);
        try { await server.close(); } catch { /* ignore */ }
      }
      return status;
    }));
    return this.statuses;
  }

  status() {
    return this.statuses.map((s) => ({ ...s }));
  }

  /** OpenAI tools 定义（函数名已做 server/tool 映射） */
  toolSpecs() {
    const specs = [];
    for (const [fnName, route] of this.routes.entries()) {
      const meta = route.meta || {};
      specs.push({
        type: "function",
        function: {
          name: fnName,
          description: "[" + route.server.name + "] " + (meta.description || route.tool).slice(0, 900),
          parameters: meta.inputSchema || { type: "object", properties: {} },
        },
      });
    }
    return specs;
  }

  has(fnName) {
    return this.routes.has(fnName);
  }

  async call(fnName, args) {
    const route = this.routes.get(fnName);
    if (!route) throw new Error("未知的 MCP 工具: " + fnName);
    return route.server.callTool(route.tool, args);
  }

  async close() {
    for (const s of this.servers) { try { await s.close(); } catch { /* ignore */ } }
    this.servers = [];
    this.routes.clear();
    this.statuses = [];
  }
}

/** 按白名单（支持 * 与前缀通配）挑工具，并记录 fnName ↔ tool 的映射 */
function pickTools(serverName, tools, allowPatterns, excludePatterns) {
  const allow = Array.isArray(allowPatterns) && allowPatterns.length ? allowPatterns : ["*"];
  const exclude = Array.isArray(excludePatterns) ? excludePatterns : [];
  const out = [];
  for (const t of tools) {
    if (!t || !t.name) continue;
    if (!matchesAny(t.name, allow)) continue;
    if (matchesAny(t.name, exclude)) continue;
    out.push({
      name: t.name,
      fnName: toolFunctionName(serverName, t.name),
      description: t.description || "",
      inputSchema: t.inputSchema || { type: "object", properties: {} },
    });
  }
  return out;
}

export function matchesAny(name, patterns) {
  return patterns.some((p) => {
    if (p === "*") return true;
    if (typeof p !== "string") return false;
    if (p.endsWith("*")) return name.startsWith(p.slice(0, -1));
    if (p.startsWith("*")) return name.endsWith(p.slice(1));
    return name === p;
  });
}
