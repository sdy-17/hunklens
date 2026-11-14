import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepos } from "./scanner.js";
import * as g from "./git.js";
import { parseUnifiedDiff } from "./diffparse.js";
import { loadConfig, SYSTEM_PROMPT, buildHunkPrompt, buildOverviewPrompt, buildFollowupPrompt, chatJson, chatCompletion } from "./ai.js";
import { collectHunks, shouldAnalyze, pool } from "./analyze.js";
import { AnalysisCache } from "./cache.js";
import { loadRules, rulesToPromptText } from "./rules.js";
import { SessionStore, sessionContext } from "./session.js";
import { ReviewStore } from "./reviewstore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv.includes("--dir") ? process.argv[process.argv.indexOf("--dir") + 1] : process.cwd();
const PORT = process.env.PORT || 7788;

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

app.get("/api/diff/file", async (req, res) => {
  try {
    const { repo, base, compare, file } = req.query;
    const text = await g.rawDiff(repo, base, compare, file);
    res.json({ parsed: parseUnifiedDiff(text), raw: text });
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
          { role: "user", content: buildHunkPrompt({ file: h.file, hunk: h.lines.join("\n"), context: h.header }) },
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
      { role: "system", content: "你是代码审查助手，用中文简洁回答，纯文本。" + rulesText(req.body.repo) },
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
    const report = await chatJson(c, [
      { role: "system", content: SYSTEM_PROMPT + rulesText(repo) + sessionText(repo, base, compare) },
      { role: "user", content: buildOverviewPrompt({ base, compare, diffStat, analyses: analyses || "（无分析结果）" }) },
    ]);
    res.json({ report });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---------- 审阅会话（挂需求文档） ----------
app.get("/api/session", (req, res) => {
  res.json(sessions.load(req.query.repo, req.query.base, req.query.compare));
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

app.listen(PORT, () => console.log("HunkLens running at http://localhost:" + PORT + ", scanning " + ROOT));
