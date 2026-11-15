import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runToolAgent, chatRaw, stripFence } from "../src/server/agent.js";

/** 一个假的 OpenAI 兼容端点：按请求形状（有没有 tools / response_format）决定回什么 */
async function mockLLM(plan) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (e) { body = {}; }
      calls.push(body);
      const out = plan(body, calls);
      if (out.status && out.status !== 200) {
        res.writeHead(out.status, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: out.error || "nope" } }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: out.content === undefined ? null : out.content, tool_calls: out.tool_calls } }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const cfg = { baseURL: "http://127.0.0.1:" + server.address().port + "/v1", apiKey: "k", model: "m" };
  return {
    cfg,
    calls,
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections && server.closeAllConnections(); }),
  };
}

const toolCall = (name, args) => ({ tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const TOOL = { type: "function", function: { name: "search_repo", parameters: { type: "object", properties: { query: { type: "string" } } } } };

test("模型先调工具、拿到结果后再出 JSON", async () => {
  const llm = await mockLLM((body) => {
    const hasToolResult = (body.messages || []).some((m) => m.role === "tool");
    if (body.tools && !hasToolResult) return toolCall("search_repo", { query: "submitOrder" });
    return { content: JSON.stringify({ hunkId: "h1", intent: "改调用方", severity: "warning", issues: [], suggestion: "", confidence: 0.8 }) };
  });
  try {
    const seen = [];
    const r = await runToolAgent(llm.cfg, {
      system: "S",
      user: "U",
      tools: [TOOL],
      runTool: async (name, args) => {
        seen.push([name, args]);
        return "src/a.js:3: submitOrder(db)";
      },
      maxRounds: 3,
      validator: (o) => { if (!o.intent) throw new Error("缺少 intent"); },
    });
    assert.deepEqual(seen, [["search_repo", { query: "submitOrder" }]]);
    assert.deepEqual(r.used, ["search_repo"]);
    assert.equal(r.obj.severity, "warning");
    assert.equal(r.degraded, undefined);

    // 第一次请求必须带 tools 且不能带 response_format（否则模型不会调工具）
    assert.ok(llm.calls[0].tools);
    assert.equal(llm.calls[0].response_format, undefined);
    // 第二次请求里必须有 tool 角色结果，模型才能"看到"查证结果
    const toolMsg = llm.calls[1].messages.find((m) => m.role === "tool");
    assert.ok(toolMsg);
    assert.match(toolMsg.content, /submitOrder\(db\)/);
    assert.equal(toolMsg.tool_call_id, "call_1");
  } finally {
    await llm.close();
  }
});

test("端点不支持 tools 时自动降级成纯 JSON 请求", async () => {
  const llm = await mockLLM((body) => {
    if (body.tools) return { status: 400, error: "tools is not supported by this model" };
    return { content: JSON.stringify({ intent: "降级后仍然能出结论", severity: "info", issues: [], suggestion: "", confidence: 0.5 }) };
  });
  try {
    const r = await runToolAgent(llm.cfg, {
      system: "S",
      user: "U",
      tools: [TOOL],
      runTool: async () => "noop",
      maxRounds: 3,
    });
    assert.equal(r.degraded, "tools-unsupported");
    assert.equal(r.obj.intent, "降级后仍然能出结论");
    assert.equal(llm.calls.length, 2);
  } finally {
    await llm.close();
  }
});

test("工具轮次用完仍未出结论时强制收口成 JSON", async () => {
  const llm = await mockLLM((body) => {
    if (body.tools) return toolCall("search_repo", { query: "x" });
    return { content: JSON.stringify({ intent: "轮次用尽后的结论", severity: "info", issues: [], suggestion: "", confidence: 0.4 }) };
  });
  try {
    let n = 0;
    const r = await runToolAgent(llm.cfg, {
      system: "S",
      user: "U",
      tools: [TOOL],
      runTool: async () => { n++; return "hit"; },
      maxRounds: 2,
    });
    assert.equal(n, 2);
    assert.equal(r.exhausted, true);
    assert.equal(r.obj.intent, "轮次用尽后的结论");
  } finally {
    await llm.close();
  }
});

test("模型直接给出合法 JSON 时不多问一轮", async () => {
  const llm = await mockLLM(() => ({ content: '{"intent":"直接给结论","severity":"info","issues":[],"suggestion":"","confidence":0.9}' }));
  try {
    const r = await runToolAgent(llm.cfg, { system: "S", user: "U", tools: [TOOL], runTool: async () => "x" });
    assert.equal(r.rounds, 1);
    assert.equal(r.obj.intent, "直接给结论");
    assert.equal(llm.calls.length, 1);
  } finally {
    await llm.close();
  }
});

test("模型用 markdown 包裹 JSON 时也能解析；没有任何工具时走纯 JSON 路径", async () => {
  const llm = await mockLLM(() => ({ content: "```json\n{\"intent\":\"包了代码块\",\"severity\":\"info\",\"issues\":[],\"suggestion\":\"\"}\n```" }));
  try {
    const r = await runToolAgent(llm.cfg, { system: "S", user: "U", tools: [], runTool: async () => "x" });
    assert.equal(r.degraded, "no-tools");
    assert.equal(r.obj.intent, "包了代码块");
    assert.equal(llm.calls[0].response_format.type, "json_object");
  } finally {
    await llm.close();
  }
});

test("chatRaw 把 HTTP 错误连同状态码抛出，stripFence 只剥外层的代码块", async () => {
  assert.equal(stripFence("```json\n{\"a\":1}\n```"), "{\"a\":1}");
  assert.equal(stripFence("  {\"a\":1}  "), "{\"a\":1}");

  const llm = await mockLLM(() => ({ status: 401, error: "bad key" }));
  try {
    await assert.rejects(() => chatRaw(llm.cfg, { model: "m", messages: [] }), (e) => {
      assert.equal(e.status, 401);
      assert.match(e.message, /LLM HTTP 401: .*bad key/);
      return true;
    });
  } finally {
    await llm.close();
  }
});
