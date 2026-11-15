/**
 * 测试用的 stdio MCP server：只实现 initialize / tools/list / tools/call。
 * 用真实的行分隔 JSON-RPC，验证 HunkLens 的 stdio 客户端（而不是假装它能用）。
 */
process.stdin.setEncoding("utf8");
let buf = "";

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(msg) {
  if (!msg || msg.id === undefined || msg.id === null) return; // 通知不回包
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "mock-mcp", version: "0.0.1" },
    } });
  }
  if (msg.method === "tools/list") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "graph_query", description: "查代码图谱：谁调用了这个函数", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
      { name: "graph_stats", description: "图谱规模统计", inputSchema: { type: "object", properties: {} } },
    ] } });
  }
  if (msg.method === "tools/call") {
    const name = msg.params && msg.params.name;
    if (name === "graph_query") {
      return send({ jsonrpc: "2.0", id: msg.id, result: {
        content: [{ type: "text", text: "callers of " + ((msg.params.arguments || {}).q || "?") + ": a.js:12, b.js:30" }],
        structuredContent: { callers: 2 },
      } });
    }
    return send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "no such tool: " + name }] } });
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found: " + msg.method } });
}

process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch (e) {
      /* 测试 fixture：坏包直接忽略 */
    }
  }
});
