import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepos } from "./scanner.js";
import * as g from "./git.js";
import { parseUnifiedDiff } from "./diffparse.js";
import { loadConfig, SYSTEM_PROMPT, buildHunkPrompt, chatCompletion } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv.includes("--dir") ? process.argv[process.argv.indexOf("--dir") + 1] : process.cwd();
const PORT = process.env.PORT || 7788;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../../public")));

app.get("/api/repos", (req, res) => {
  res.json(scanRepos(ROOT).map((r) => ({ ...r, root: ROOT })));
});

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

/** AI：分析单个 hunk（M2 扩展为批量 + SSE 流式） */
app.post("/api/ai/analyze", async (req, res) => {
  const cfg = loadConfig(path.join(__dirname, "../.."));
  if (!cfg) return res.status(400).json({ error: "未配置 LLM，请创建 config.local.json" });
  try {
    const text = await chatCompletion(cfg, [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildHunkPrompt(req.body) },
    ]);
    res.json({ analysis: JSON.parse(text) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.listen(PORT, () => console.log("ai-reviewer running at http://localhost:" + PORT + ", scanning " + ROOT));
