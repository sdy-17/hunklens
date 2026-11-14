import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { OVERVIEW_SYSTEM_PROMPT, SYSTEM_PROMPT, validateOverview, normalizeOverview, buildOverviewPrompt } from "../src/server/ai.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" });

test("总览提示词不能复用单 hunk 契约", () => {
  assert.ok(OVERVIEW_SYSTEM_PROMPT.includes("summary"));
  assert.ok(OVERVIEW_SYSTEM_PROMPT.includes("testSuggestions"));
  assert.ok(!OVERVIEW_SYSTEM_PROMPT.includes("hunkId"), "总览提示词要求了 hunkId，会把模型带回单 hunk 结构");
  assert.ok(SYSTEM_PROMPT.includes("hunkId"), "单 hunk 提示词应保留 hunkId 契约");
  // 用户消息里给的是总览报告要求，系统提示不能再说单 hunk 的字段
  const userMsg = buildOverviewPrompt({ base: "main", compare: "dev", diffStat: "a.txt +1 -0", analyses: "x" });
  assert.ok(userMsg.includes("summary"));
});

test("validateOverview 拒绝单 hunk 结构（静默失败的根因）", () => {
  // 真实模型在错误的系统提示下返回的就是这个形状：合法 JSON，但字段对不上
  const hunkShaped = { hunkId: "@@ -1 +1 @@", intent: "改了什么", severity: "warning", issues: [], suggestion: "", confidence: 1 };
  assert.throws(() => validateOverview(hunkShaped), /summary/);
  assert.throws(() => validateOverview({ summary: "" }), /summary/);
  assert.throws(() => validateOverview({ summary: "ok", risks: "有风险" }), /risks/);
  assert.throws(() => validateOverview({ summary: "ok", testSuggestions: ["a"] }), /testSuggestions/);
  assert.throws(() => validateOverview("not-json-object"), /对象/);
  const ok = { summary: "补了 demo 与配置示例", risks: [{ file: "a.txt", desc: "占位文案", severity: "info" }], testSuggestions: "补一个单测" };
  assert.equal(validateOverview(ok), ok);
});

test("normalizeOverview 把模型常见偏差拉回前端契约", () => {
  assert.deepEqual(normalizeOverview({ summary: " s ", risks: ["直接给字符串"], testSuggestions: ["t1", "t2"] }), {
    summary: "s",
    risks: [{ file: "", desc: "直接给字符串", severity: "info" }],
    testSuggestions: "t1\nt2",
  });
  assert.deepEqual(normalizeOverview({ summary: "s", risks: [{ file: "f", desc: "d", severity: "fatal" }] }), {
    summary: "s",
    risks: [{ file: "f", desc: "d", severity: "info" }],
    testSuggestions: "",
  });
  assert.deepEqual(normalizeOverview({}), { summary: "", risks: [], testSuggestions: "" });
});

// ---- 路由级：/api/analyze/overview 必须 200 且带 summary；模型返回单 hunk 结构时必须 500，而不是空白成功 ----
function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hunklens-overview-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  git(dir, "checkout", "-qb", "feat");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  git(dir, "commit", "-qam", "feat change");
  git(dir, "checkout", "-q", "main");
  return dir;
}

async function withMockLlm(reply, fn) {
  let calls = 0;
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      calls++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const baseURL = "http://127.0.0.1:" + srv.address().port + "/v1";
  try {
    return await fn(baseURL, () => calls);
  } finally {
    srv.close();
    srv.closeAllConnections?.(); // fetch 默认 keep-alive，close() 会等 socket 超时
  }
}

async function postOverview(app, repo) {
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const port = srv.address().port;
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/api/analyze/overview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, base: "main", compare: "feat" }),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    srv.close();
    srv.closeAllConnections?.(); // fetch 默认 keep-alive，close() 会等 socket 超时
  }
}

test("overview 路由：正常模型返回 200 且是总览结构", async () => {
  fs.mkdirSync(path.join(os.tmpdir(), "hunklens-test"), { recursive: true });
  const repo = mkRepo();
  try {
    await withMockLlm(
      { summary: "给 a.txt 补了一行", risks: [{ file: "a.txt", desc: "只是演示", severity: "info" }], testSuggestions: "补一个单测" },
      async (baseURL) => {
        const cfgPath = path.join(repo, "..", path.basename(repo) + "-cfg.json");
        fs.writeFileSync(cfgPath, JSON.stringify({ provider: "openai-compatible", baseURL, apiKey: "k", model: "m" }));
        process.env.HUNKLENS_CONFIG = cfgPath;
        try {
          const { app } = await import("../src/server/index.js");
          const { status, body } = await postOverview(app, fs.realpathSync(repo));
          assert.equal(status, 200, JSON.stringify(body));
          assert.equal(typeof body.report.summary, "string");
          assert.ok(body.report.summary.length > 0);
          assert.ok(Array.isArray(body.report.risks));
          assert.equal(typeof body.report.testSuggestions, "string");
        } finally {
          delete process.env.HUNKLENS_CONFIG;
        }
      },
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("overview 路由：模型返回单 hunk 结构时 500（重试 3 次，不静默成功）", async () => {
  const repo = mkRepo();
  try {
    await withMockLlm({ hunkId: "@@ -1 +1 @@", intent: "x", severity: "info", issues: [], suggestion: "", confidence: 1 }, async (baseURL, calls) => {
      const cfgPath = path.join(os.tmpdir(), "hunklens-bad-" + Date.now() + ".json");
      fs.writeFileSync(cfgPath, JSON.stringify({ provider: "openai-compatible", baseURL, apiKey: "k", model: "m" }));
      process.env.HUNKLENS_CONFIG = cfgPath;
      try {
        const { app } = await import("../src/server/index.js");
        const { status, body } = await postOverview(app, fs.realpathSync(repo));
        assert.equal(status, 500, JSON.stringify(body));
        assert.ok(String(body.error).includes("summary"));
        assert.equal(calls(), 3, "校验失败应重试到 3 次再报错");
      } finally {
        delete process.env.HUNKLENS_CONFIG;
        fs.rmSync(cfgPath, { force: true });
      }
    });
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
