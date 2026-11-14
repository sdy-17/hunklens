import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepos } from "./scanner.js";
import * as g from "./git.js";
import { parseUnifiedDiff } from "./diffparse.js";
import { loadConfig, SYSTEM_PROMPT, OVERVIEW_SYSTEM_PROMPT, buildHunkPrompt, buildOverviewPrompt, buildFollowupPrompt, chatJson, chatCompletion, validateOverview, normalizeOverview } from "./ai.js";
import { collectHunks, shouldAnalyze, pool } from "./analyze.js";
import { AnalysisCache } from "./cache.js";
import { loadRules, rulesToPromptText } from "./rules.js";
import { SessionStore, sessionContext } from "./session.js";
import { extractDocumentText } from "./doctext.js";
import { ReviewStore } from "./reviewstore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv.includes("--dir") ? process.argv[process.argv.indexOf("--dir") + 1] : process.cwd();
const PORT = process.env.PORT || 7788;
// 默认只监听回环地址：本工具没有鉴权，config.local.json 里还有真实 API key，
// 绑 0.0.0.0 会让同网段任何人打开页面消耗你的模型额度、扫描你所有仓库的 diff。
const argvValue = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined);
const HOST = argvValue("--host") || process.env.HOST || "127.0.0.1";
const LOOPBACK = ["127.0.0.1", "localhost", "::1"].includes(HOST);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../../public")));

const cache = new AnalysisCache(path.join(__dirname, "../../.cache/analysis"));
const store = new ReviewStore(path.join(__dirname, "../../.cache/reviews"));
const sessions = new SessionStore(path.join(__dirname, "../../.cache/sessions"));
const cfg = () => loadConfig(path.join(__dirname, "../.."));

// 团队规则：读取全局 + 项目 skill 规范，注入 review prompt
const rulesText = (repo) => rulesToPromptText(loadRules(repo, (cfg() || {}).rules || {}), 8000, repo || "");
// 审阅会话的需求/方案上下文（对照需求评估改动）
const sessionText = (repo, base, compare) => sessionContext(sessions, repo, base, compare, 6000);

// ---------- 项目 / 分支 ----------
app.get("/api/repos", (req, res) => res.json(scanRepos(ROOT).map((r) => ({ ...r, root: ROOT }))));

app.get("/api/branches", async (req, res) => {
  try { res.json(await g.listBranches(req.query.repo)); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/api/checkout", async (req, res) => {
  try { await g.checkout(req.body.repo, req.body.branch); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post("/api/branch/track", async (req, res) => {
  try {
    const r = await g.trackRemote(req.body.repo, req.body.remote);
    res.json({ ok: true, ...r, ...(await g.listBranches(req.body.repo)) });
  } catch (e) { res.status(500).json({ error: String(e && e.message ? e.message : e) }); }
});

app.post("/api/fetch", async (req, res) => {
  try {
    await g.fetchAll(req.body.repo);
    if (req.body.pull) await g.pull(req.body.repo);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---------- Diff ----------
app.get("/api/diff", async (req, res) => {
  try {
    const { repo, base, compare } = req.query;
    res.json({ files: await g.diffSummary(repo, base, compare) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// 整文件对比：分别读两个 ref 下的完整文件（新增/删除文件时有一侧为空）
app.get("/api/file", async (req, res) => {
  try {
    const { repo, ref, file } = req.query;
    let text = "";
    try { text = await g.fileAt(repo, ref, file); } catch (e) { text = ""; }
    res.json({ file, ref, text: String(text || "") });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/api/diff/file", async (req, res) => {
  try {
    const { repo, base, compare, file } = req.query;
    const text = await g.rawDiff(repo, base, compare, file);
    // 两侧文件行数：客户端据此显示「展开 N 行未改动」，无需先拉整份文件
    const count = (t) => { const s = String(t || "").replace(/\n$/, ""); return s ? s.split("\n").length : 0; };
    const read = async (ref) => { try { return count(await g.fileAt(repo, ref, file)); } catch (e) { return 0; } };
    const [oldTotal, newTotal] = await Promise.all([read(base), read(compare)]);
    res.json({ parsed: parseUnifiedDiff(text), raw: text, oldTotal, newTotal });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---------- AI 批量分析（SSE 流式） ----------
app.get("/api/analyze/stream", async (req, res) => {
  const c = cfg();
  const { repo, base, compare } = req.query;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event, data) => res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
  if (!c) { send("error", { error: "未配置 LLM，请创建 config.local.json（参考 config.example.json）" }); return res.end(); }

  try {
    const files = await g.diffSummary(repo, base, compare);
    const hunks = await collectHunks(repo, base, compare, files);
    send("start", { total: hunks.length, cached: hunks.filter((h) => cache.get(h.key)).length });

    let done = 0, failed = 0;
    await pool(hunks, 3, async (h) => {
      if (res.writableEnded) return;
      const hit = cache.get(h.key);
      if (hit) { done++; send("hunk", { ...h, analysis: hit, cached: true }); return; }
      try {
        const analysis = await chatJson(c, [
          { role: "system", content: SYSTEM_PROMPT + rulesText(repo) + sessionText(repo, base, compare) },
          { role: "user", content: buildHunkPrompt({ file: h.file, hunk: h.lines.join("\n"), context: h.header, codeContext: h.codeContext, stat: h.stat }) },
        ]);
        cache.set(h.key, analysis);
        done++;
        send("hunk", { ...h, analysis, cached: false });
      } catch (e) {
        failed++; done++;
        send("hunk", { ...h, analysis: { severity: "info", intent: "分析失败", issues: [{ line: 0, desc: String(e.message || e).slice(0, 200) }], suggestion: "-" } });
      }
    });
    send("done", { total: hunks.length, failed });
  } catch (e) {
    send("error", { error: String(e) });
  }
  res.end();
});

// ---------- 单 hunk 结果查询（缓存命中查看） ----------
// 单 hunk 结果查询（带缓存写入，前端气泡用）
app.post("/api/ai/analyze/hunk", (req, res) => {
  const { key, file, hunk, context } = req.body;
  let analysis = cache.get(key);
  if (!analysis) {
    // 未命中缓存时返回空，由前端走批量分析；或直接存 request 内容便于调试
    analysis = null;
  }
  res.json({ analysis });
});

// ---------- AI 追问 ----------
app.post("/api/ai/followup", async (req, res) => {
  const c = cfg();
  if (!c) return res.status(400).json({ error: "未配置 LLM" });
  try {
    const answer = await chatCompletion(c, [
      { role: "system", content: "你是代码审查助手，用中文简洁回答，纯文本。" + rulesText(req.body.repo)
        + sessionText(req.body.repo, req.body.base, req.body.compare)
        + (req.body.prior ? "\n\n## 当前需求背景\n" + req.body.prior : "") },
      { role: "user", content: buildFollowupPrompt(req.body) },
    ], { json: false });
    res.json({ answer });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---------- AI 总览报告 ----------
app.post("/api/analyze/overview", async (req, res) => {
  const c = cfg();
  if (!c) return res.status(400).json({ error: "未配置 LLM" });
  try {
    const { repo, base, compare } = req.body;
    const files = await g.diffSummary(repo, base, compare);
    const hunks = await collectHunks(repo, base, compare, files);
    const analyses = hunks.map((h) => {
      const a = cache.get(h.key);
      return a ? "- " + h.file + " " + h.header + " [" + a.severity + "] " + a.intent + (a.issues?.length ? " | 问题: " + a.issues.map((i) => i.desc).join(";") : "") : null;
    }).filter(Boolean).join("\n");
    const diffStat = files.map((f) => f.file + " +" + f.insertions + " -" + f.deletions).join("\n");
    // 总览必须用专用提示词 + schema 校验：复用单 hunk 的 SYSTEM_PROMPT 会让模型只返回
    // 一个 hunk 的字段（合法 JSON 但字段不对），前端读不到 summary，总览区静默空白。
    const report = await chatJson(c, [
      { role: "system", content: OVERVIEW_SYSTEM_PROMPT + rulesText(repo) + sessionText(repo, base, compare) },
      { role: "user", content: buildOverviewPrompt({ base, compare, diffStat, analyses: analyses || "（无分析结果）" }) },
    ], validateOverview);
    res.json({ report: normalizeOverview(report) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---------- 审阅会话（挂需求文档） ----------
app.get("/api/session", (req, res) => {
  const s = sessions.load(req.query.repo, req.query.base, req.query.compare);
  res.json({
    ...s,
    attachments: (s.attachments || []).map((a) => ({ name: a.name, chars: String(a.content || "").length })),
  });
});

// 拖拽上传需求文档：base64 -> 临时文件 -> 抽取文本 -> 存会话
app.post("/api/session/attach", (req, res) => {
  const { repo, base, compare, name, data } = req.body;
  if (!repo || !name || !data) return res.status(400).json({ error: "缺少参数" });
  const safe = String(name).replace(/[\/\\:*?"<>|]/g, "_").slice(0, 120);
  const dir = path.join(__dirname, "../../.cache/uploads");
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, Date.now() + "-" + safe);
  try {
    const buf = Buffer.from(String(data), "base64");
    if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: "文档超过 20MB" });
    fs.writeFileSync(tmp, buf);
    const text = extractDocumentText(tmp, safe).trim();
    if (!text) return res.status(400).json({ error: "文档没有可读文本" });
    const prev = sessions.load(repo, base, compare);
    const attachments = (prev.attachments || []).filter((a) => a.name !== safe);
    attachments.push({ name: safe, content: text.slice(0, 60000) });
    const next = sessions.save(repo, base, compare, { attachments });
    res.json({ ok: true, name: safe, chars: text.length, attachments: next.attachments.map((a) => ({ name: a.name, chars: a.content.length })) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  }
});

app.post("/api/session/attach/remove", (req, res) => {
  const { repo, base, compare, name } = req.body;
  const prev = sessions.load(repo, base, compare);
  const attachments = (prev.attachments || []).filter((a) => a.name !== name);
  const next = sessions.save(repo, base, compare, { attachments });
  res.json({ ok: true, attachments: next.attachments.map((a) => ({ name: a.name, chars: a.content.length })) });
});

app.post("/api/session", (req, res) => {
  const { repo, base, compare, requirements, files } = req.body;
  res.json(sessions.save(repo, base, compare, { requirements: String(requirements || ""), files: Array.isArray(files) ? files : [] }));
});

// ---------- 团队规则查看 ----------
app.get("/api/rules", (req, res) => {
  const skills = loadRules(req.query.repo, (cfg() || {}).rules || {});
  res.json({ count: skills.length, skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source })) });
});

// ---------- 审阅状态 ----------
app.get("/api/review", (req, res) => {
  res.json(store.load(req.query.repo, req.query.base, req.query.compare));
});

app.post("/api/review", (req, res) => {
  const { repo, base, compare, data } = req.body;
  res.json(store.save(repo, base, compare, data));
});

// ---------- 导出 review 结论（markdown） ----------
app.get("/api/export", async (req, res) => {
  try {
    const { repo, base, compare } = req.query;
    const files = await g.diffSummary(repo, base, compare);
    const hunks = await collectHunks(repo, base, compare, files);
    const state = store.load(repo, base, compare);
    const lines = [
      "# Code Review 结论",
      "",
      "- 仓库: \`" + repo + "\`",
      "- 对比: \`" + base + "\` ← \`" + compare + "\`",
      "- 导出时间: " + new Date().toLocaleString("zh-CN"),
      "",
      "## 变更文件（" + files.length + "）",
      "",
      ...files.map((f) => "- " + (state.files?.[f.file] || "未标记") + " \`" + f.file + "\` (+" + f.insertions + " −" + f.deletions + ")"),
      "",
      "## AI 分析详情",
    ];
    for (const h of hunks) {
      const a = cache.get(h.key);
      if (!a) continue;
      lines.push(
        "", "### " + h.file + " " + h.header,
        "", "- **severity**: " + a.severity,
        "- **目的**: " + a.intent,
        "- **问题**: " + ((a.issues || []).map((i) => i.desc).join("；") || "无"),
        "- **建议**: " + (a.suggestion || "无"),
        "- **hunk 标记**: " + (state.hunks?.[h.key] || "无"),
      );
    }
    if (state.note) lines.push("", "## 备注", "", state.note);
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="review-' + base + "-" + compare + '.md"');
    res.send(lines.join("\n"));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// 被测试 import 时只导出 app，不自动占用端口
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  if (!LOOPBACK) {
    console.warn(
      "⚠️  正在监听 " + HOST + "（非回环地址）。HunkLens 没有鉴权，同网段任何人都能读取你所有仓库的 diff 并消耗你的模型额度，请仅在可信网络这么做。",
    );
  }
  app.listen(PORT, HOST, () => console.log("HunkLens running at http://" + HOST + ":" + PORT + ", scanning " + ROOT));
}

export { app, HOST, PORT };
