import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, McpHub, toolFunctionName, toolResultText } from "../src/server/mcpc.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 放在 test/ 之外的 fixtures/：node --test 会把 test/ 下所有 .js 当测试文件跑
const FIXTURE = path.join(__dirname, "..", "fixtures", "mock-mcp-stdio.js");

/** 一个 Streamable HTTP MCP：initialize/tools/list 用 JSON 与 SSE 两种响应都覆盖 */
async function httpFixture() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let msg = {};
      try { msg = JSON.parse(body); } catch (e) { msg = {}; }
      const id = msg.id;
      const reply = (result) => {
        res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "sess-1" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      };
      if (msg.method === "initialize") {
        return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock-http" } });
      }
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      if (msg.method === "tools/list") {
        // SSE 分支：HunkLens 必须能从 event-stream 里挑出 id 匹配的那条
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: message\n");
        res.write("data: " + JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} }) + "\n\n");
        res.write("event: message\n");
        res.write("data: " + JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [
          { name: "requirement_get", description: "查飞书需求单", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
        ] } }) + "\n\n");
        return res.end();
      }
      if (msg.method === "tools/call") {
        return reply({ content: [{ type: "text", text: "需求单 M-123：登录页要支持扫码" }] });
      }
      return reply({});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
}

test("stdio：initialize → tools/list → tools/call 全链路", async () => {
  const s = new McpServer({ name: "mock", command: process.execPath, args: [FIXTURE], timeout: 15000 });
  try {
    await s.start();
    assert.equal(s.transport, "stdio");
    const tools = await s.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["graph_query", "graph_stats"]);

    const text = await s.callTool("graph_query", { q: "submitOrder" });
    assert.match(text, /callers of submitOrder: a\.js:12, b\.js:30/);
    assert.match(text, /"callers":2/, "结构化结果也要带上");

    const bad = await s.callTool("nope", {});
    assert.match(bad, /^工具返回错误: no such tool: nope/);
  } finally {
    await s.close();
  }
});

test("http：JSON 与 SSE 两种响应都能解析，并带回 session id", async () => {
  const { server, port } = await httpFixture();
  const s = new McpServer({ name: "graph", url: "http://127.0.0.1:" + port + "/mcp", timeout: 15000 });
  try {
    await s.start();
    assert.equal(s.transport, "http");
    assert.equal(s.sessionId, "sess-1");
    const tools = await s.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["requirement_get"]);
    const text = await s.callTool("requirement_get", { id: "M-123" });
    assert.match(text, /需求单 M-123/);
  } finally {
    await s.close();
    await new Promise((r) => { server.close(r); server.closeAllConnections && server.closeAllConnections(); });
  }
});

test("连不上的 MCP 只记录状态，不影响其它 server 与整个 hub", async () => {
  const hub = new McpHub(() => ({
    servers: [
      { name: "mock", command: process.execPath, args: [FIXTURE], timeout: 15000 },
      { name: "dead", url: "http://127.0.0.1:1/mcp", timeout: 1200 },
    ],
  }));
  try {
    const statuses = await hub.ensure();
    assert.equal(statuses.length, 2);
    const mock = statuses.find((s) => s.name === "mock");
    const dead = statuses.find((s) => s.name === "dead");
    assert.equal(mock.ok, true);
    assert.equal(dead.ok, false);
    assert.ok(dead.error.length > 0);

    const names = hub.toolSpecs().map((t) => t.function.name);
    assert.ok(names.includes("mcp__mock__graph_query"));
    assert.ok(names.every((n) => n.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(n)));
    assert.equal(hub.has("mcp__mock__graph_query"), true);
    assert.equal(hub.has("mcp__dead__anything"), false);
    assert.match(await hub.call("mcp__mock__graph_query", { q: "x" }), /callers of x/);
  } finally {
    await hub.close();
  }
});

test("hub 支持白名单 / 排除名单，enabled=false 时整体停用", async () => {
  let cfg = { tools: ["graph_query"], servers: [{ name: "mock", command: process.execPath, args: [FIXTURE], timeout: 15000 }] };
  const hub = new McpHub(() => cfg);
  try {
    await hub.ensure();
    assert.deepEqual(hub.toolSpecs().map((t) => t.function.name), ["mcp__mock__graph_query"]);
    await hub.close();

    cfg = { servers: [{ name: "mock", command: process.execPath, args: [FIXTURE], timeout: 15000, excludeTools: ["graph_query"] }] };
    const hub2 = new McpHub(() => cfg);
    await hub2.ensure();
    assert.deepEqual(hub2.toolSpecs().map((t) => t.function.name), ["mcp__mock__graph_stats"]);
    await hub2.close();

    const hub3 = new McpHub(() => ({ enabled: false, servers: [{ name: "mock", command: process.execPath, args: [FIXTURE] }] }));
    assert.deepEqual(await hub3.ensure(), []);
    assert.deepEqual(hub3.toolSpecs(), []);
  } finally {
    /* 已各自 close */
  }
});

test("函数名映射与结果归一化", () => {
  assert.equal(toolFunctionName("graphify", "graph.query/v2"), "mcp__graphify__graph_query_v2");
  assert.equal(toolFunctionName("meegle", "tool").length <= 64, true);
  assert.equal(toolResultText({ content: [{ type: "text", text: " ok " }], structuredContent: { a: 1 } }), "ok\n{\"a\":1}");
  assert.equal(toolResultText(null), "");
});
