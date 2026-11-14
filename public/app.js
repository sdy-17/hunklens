const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let mode = "split";
let state = { repo: "", base: "", compare: "" };
let hunksByKey = {};   // key -> { file, hunkIndex, header, lines }
let analysisByKey = {};
let review = { files: {}, hunks: {}, note: "" };
let analyzedFiles = new Set(); // file -> 有 AI 结果

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const saveReview = () => fetch("/api/review", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ repo: state.repo, base: state.base, compare: state.compare, data: review }) });

// ---------- 初始化 ----------
async function loadRepos() {
  const repos = await (await fetch("/api/repos")).json();
  $("#repoSel").innerHTML = repos.map((r) => `<option value="${r.path}">${r.name}</option>`).join("");
  if (repos[0]) { state.repo = repos[0].path; await loadBranches(); }
}

$("#repoSel").addEventListener("change", (e) => { state.repo = e.target.value; loadBranches(); });

async function loadBranches() {
  // 团队规则提示
  fetch("/api/rules?repo=" + encodeURIComponent(state.repo)).then((r) => r.json()).then((d) => {
    const el = $("#rulesBadge");
    if (el) {
      el.textContent = d.count ? "📋 已加载 " + d.count + " 条团队规范" : "📋 未检测到团队规范";
      el.title = (d.skills || []).map((s) => s.name + (s.description ? "：" + s.description : "")).join("\n");
    }
  });
  const b = await (await fetch("/api/branches?repo=" + encodeURIComponent(state.repo))).json();
  const opts = b.locals.map((x) => `<option ${x === b.current ? "selected" : ""}>${x}</option>`).join("");
  $("#baseSel").innerHTML = opts; $("#compareSel").innerHTML = opts;
  $("#baseSel").value = b.current;
  // compare 默认选另一个分支（若有）
  const other = b.locals.find((x) => x !== b.current);
  if (other) $("#compareSel").value = other;
  review = await (await fetch("/api/review?repo=" + encodeURIComponent(state.repo)
    + "&base=" + encodeURIComponent($("#baseSel").value)
    + "&compare=" + encodeURIComponent($("#compareSel").value))).json();
}

$("#fetchBtn").addEventListener("click", async () => {
  $("#fetchBtn").textContent = "拉取中…";
  try { await fetch("/api/fetch", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo: state.repo, pull: true }) }); } catch (e) { alert("拉取失败: " + e); }
  $("#fetchBtn").textContent = "拉取远程";
  loadBranches();
});

// ---------- 生成 Diff ----------
$("#diffBtn").addEventListener("click", async () => {
  state.base = $("#baseSel").value; state.compare = $("#compareSel").value;
  const q = qParams();
  const d = await (await fetch("/api/diff?" + q)).json();
  analysisByKey = {}; hunksByKey = {}; analyzedFiles.clear();
  renderFileTree(d.files || []);
  $("#diffView").innerHTML = `<div class="empty">共 ${(d.files || []).length} 个文件变更。点击左侧文件查看，或直接「AI 分析」。</div>`;
  loadReviewPanel();
});

function qParams(file) {
  let q = "repo=" + encodeURIComponent(state.repo) + "&base=" + encodeURIComponent(state.base)
    + "&compare=" + encodeURIComponent(state.compare);
  if (file) q += "&file=" + encodeURIComponent(file);
  return q;
}

// ---------- 文件树 + 状态 ----------
let currentFiles = [];
function renderFileTree(files) {
  currentFiles = files;
  files.sort((a, b) => riskOf(b) - riskOf(a) || a.file.localeCompare(b.file));
  $("#fileTree").innerHTML = files.map((f) => {
    const st = review.files[f.file] || "";
    return `<div class="file ${riskOf(f) ? "risky" : ""}" data-f="${f.file}">
      <span><span class="st" data-st="${f.file}">${st}</span> ${f.file}</span>
      <span class="stat">+${f.insertions} −${f.deletions}</span></div>`;
  }).join("");
  $$("#fileTree .file").forEach((el) => el.addEventListener("click", () => {
    $$("#fileTree .file").forEach((x) => x.classList.remove("active"));
    el.classList.add("active");
    loadFile(el.dataset.f);
  }));
  updateProgress();
}

function riskOf(f) {
  return Object.entries(analysisByKey)
    .filter(([k, a]) => hunksByKey[k] && hunksByKey[k].file === f.file)
    .reduce((n, [, a]) => n + (a.severity === "blocker" ? 2 : a.severity === "warning" ? 1 : 0), 0);
}

function setFileStatus(file, st) {
  review.files[file] = st;
  saveReview();
  const el = document.querySelector(`[data-st="${CSS.escape(file)}"]`);
  if (el) el.textContent = st;
  updateProgress();
}

function updateProgress() {
  const done = currentFiles.filter((f) => review.files[f.file]).length;
  const blockers = Object.values(analysisByKey).filter((a) => a.severity === "blocker").length;
  $("#progress").textContent = currentFiles.length
    ? `已审 ${done}/${currentFiles.length} 文件 · blocker ${blockers} 个` : "";
}

// ---------- 文件 diff 渲染（split / unified） ----------
async function loadFile(file) {
  const d = await (await fetch("/api/diff/file?" + qParams(file))).json();
  const v = $("#diffView");
  v.innerHTML = "";
  v.className = mode === "split" ? "" : "mode-unified";
  const title = document.createElement("div");
  title.className = "file-title";
  title.innerHTML = `<b>${esc(file)}</b>` + ["✅", "⚠️", "❌"].map((m) =>
    `<button data-m="${m}" ${review.files[file] === m ? "class=\"sel\"" : ""}>${m}</button>`).join("")
    + `<span style="color:#57606a">标记审阅状态</span>`;
  title.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    const m = b.dataset.m;
    setFileStatus(file, review.files[file] === m ? "" : m);
    title.querySelectorAll("button").forEach((x) => x.classList.toggle("sel", x.dataset.m === m && review.files[file] === m));
  }));
  v.appendChild(title);

  for (const f of d.parsed || []) for (const h of f.hunks) {
    const key = hunkKeyLocal(file, h);
    hunksByKey[key] = { file, hunkIndex: 0, header: h.header, lines: h.lines };
    const div = document.createElement("div");
    div.className = "hunk";
    div.dataset.key = key;
    const analysis = analysisByKey[key];
    const iconCls = "ai-icon " + (analysis ? ("done " + (analysis.severity === "blocker" ? "has-blocker" : analysis.severity === "warning" ? "has-warning" : "")) : "");
    const icon = `<span class="${iconCls}" data-key="${key}" title="AI 分析">🤖</span>`;
    div.innerHTML = `<div class="hunk-header">${esc(h.header)} ${icon}</div>`
      + (mode === "split" ? renderSplit(h) : renderUnified(h));
    v.appendChild(div);
    div.querySelector(".ai-icon").addEventListener("click", (e) => showBubble(div, e.currentTarget, key));
  }
}

// 简单 hunk key：与后端 sha1 对齐成本高，前端用 header+file 派生（展示用），
// 分析请求直接把 hunk 内容发给后端由后端算真实 key。
function hunkKeyLocal(file, h) {
  let x = 0; const s = file + "|" + h.header + "|" + h.lines.join("\n");
  for (const c of s) { x = (x * 31 + c.codePointAt(0)) | 0; }
  return "k" + (x >>> 0).toString(36) + "-" + h.lines.length;
}

function renderSplit(h) {
  // 侧对侧：del 块和紧随的 add 块按行配对
  const rows = [];
  let i = 0, oldNo = 0, newNo = 0;
  const lines = h.lines;
  // 从 header 提取起始行号
  const m = h.header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (m) { oldNo = +m[1]; newNo = +m[3]; }
  while (i < lines.length) {
    const l = lines[i];
    if (l[0] === " " || l === "") {
      rows.push({ t: "ctx", oldNo, newNo, text: l }); oldNo++; newNo++; i++;
    } else if (l[0] === "-") {
      // 收集连续 del
      const dels = [];
      while (i < lines.length && lines[i][0] === "-") { dels.push(lines[i]); oldNo++; i++; }
      const adds = [];
      while (i < lines.length && lines[i][0] === "+") { adds.push(lines[i]); newNo++; i++; }
      const n = Math.max(dels.length, adds.length);
      for (let j = 0; j < n; j++) {
        rows.push({ t: "pair", del: dels[j] ?? "", add: adds[j] ?? "",
          oldNo: dels[j] ? oldNo - dels.length + j : "",
          newNo: adds[j] ? newNo - adds.length + j : "" });
      }
    } else { // 纯 add（无配对 del）
      rows.push({ t: "add", newNo, text: l }); newNo++; i++;
    }
  }
  return `<table class="diff-t">` + rows.map((r) => {
    if (r.t === "ctx") return `<tr><td class="gutter">${r.oldNo}</td><td class="code">${esc(r.text)}</td>
      <td class="gutter">${r.newNo}</td><td class="code">${esc(r.text)}</td></tr>`;
    if (r.t === "pair") return `<tr><td class="gutter del">${r.oldNo}</td><td class="code line-del">${esc(r.del)}</td>
      <td class="gutter add">${r.newNo}</td><td class="code line-add">${esc(r.add)}</td></tr>`;
    return `<tr><td class="gutter"></td><td class="code"></td>
      <td class="gutter add">${r.newNo}</td><td class="code line-add">${esc(r.text)}</td></tr>`;
  }).join("") + "</table>";
}

function renderUnified(h) {
  const m = h.header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  let oldNo = m ? +m[1] : 0, newNo = m ? +m[3] : 0;
  return `<table class="diff-t">` + h.lines.map((l) => {
    let o = "", n = "", cls = "";
    if (l[0] === "+") { cls = "line-add"; n = newNo++; }
    else if (l[0] === "-") { cls = "line-del"; o = oldNo++; }
    else { o = oldNo++; n = newNo++; }
    return `<tr class="${cls}"><td class="gutter ${cls === "line-del" ? "del" : cls === "line-add" ? "add" : ""}">${o}</td>
      <td class="gutter ${cls === "line-add" ? "add" : ""}">${n}</td><td class="code ${cls}">${esc(l)}</td></tr>`;
  }).join("") + "</table>";
}

// ---------- 模式切换（重渲染当前文件区） ----------
$$("#mode button").forEach((b) => b.addEventListener("click", () => {
  mode = b.dataset.mode;
  $$("#mode button").forEach((x) => x.classList.toggle("active", x === b));
  const active = $("#fileTree .file.active");
  if (active) loadFile(active.dataset.f);
}));

// ---------- AI 批量分析（SSE） ----------
$("#analyzeBtn").addEventListener("click", () => {
  if (!state.base || !state.compare) { alert("先生成 Diff（选择 base/compare 分支）"); return; }
  state.base = $("#baseSel").value; state.compare = $("#compareSel").value;
  $("#analyzeBtn").disabled = true;
  const es = new EventSource("/api/analyze/stream?" + qParams());
  es.addEventListener("start", (e) => {
    const d = JSON.parse(e.data);
    $("#progress").textContent = `AI 分析中 0/${d.total}（缓存 ${d.cached}）…`;
  });
  es.addEventListener("hunk", (e) => {
    const h = JSON.parse(e.data);
    analysisByKey[h.key] = h.analysis;
    const local = Object.keys(hunksByKey).find((k) => hunksByKey[k].file === h.file && hunksByKey[k].header === h.header);
    if (local) analysisByKey[local] = h.analysis;
    analyzedFiles.add(h.file);
    const done = Object.keys(analysisByKey).length;
    $("#progress").textContent = `AI 分析中 ${done} 个 hunk…`;
    refreshIcons();
  });
  es.addEventListener("done", (e) => {
    const d = JSON.parse(e.data);
    $("#progress").textContent = `AI 分析完成${d.failed ? "（" + d.failed + " 个失败）" : ""}`;
    $("#analyzeBtn").disabled = false;
    es.close();
    renderFileTree(currentFiles);
  });
  es.addEventListener("error", (e) => {
    try { const d = JSON.parse(e.data); alert(d.error); } catch {}
    $("#analyzeBtn").disabled = false; es.close();
  });
});

function refreshIcons() {
  $$(".ai-icon").forEach((ic) => {
    const a = analysisByKey[ic.dataset.key];
    if (!a) return;
    ic.classList.remove("pending"); ic.classList.add("done");
    if (a.severity === "blocker") ic.classList.add("has-blocker");
    if (a.severity === "warning") ic.classList.add("has-warning");
    const hd = ic.closest(".hunk-header");
    if (hd) hd.title = a.intent || "";
  });
  updateProgress();
}

// ---------- AI 气泡 ----------
async function showBubble(hunkDiv, anchor, key) {
  removeBubble();
  const info = hunksByKey[key];
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = "分析中…";
  const r = anchor.getBoundingClientRect();
  bubble.style.left = Math.max(8, Math.min(r.left + scrollX, scrollX + innerWidth - 580)) + "px";
  bubble.style.top = r.bottom + scrollY + 4 + "px";
  document.body.appendChild(bubble);
  const answers = [];
  try {
    const res = await fetch("/api/ai/analyze/hunk", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: info.file, hunk: info.lines.join("\n"), context: info.header, key }) });
    const data = await res.json();
    const a = data.analysis || { severity: "info", intent: "-", issues: [{ desc: data.error || "无" }], suggestion: "-" };
    analysisByKey[key] = a;
    bubble.className = "bubble sev-" + (a.severity || "info");
    bubble.innerHTML = `<h4>🤖 AI 分析 <span class="badge ${a.severity}">${a.severity}</span>
      <span style="color:#8c959f;font-weight:400">置信度 ${(Math.round((a.confidence ?? 0.8) * 100))}%</span></h4>
      <div class="sec"><b>目的</b>${esc(a.intent)}</div>
      <div class="sec"><b>问题</b>${(a.issues || []).length ? a.issues.map((i) => esc(i.desc)).join("；") : "无"}</div>
      <div class="sec"><b>建议</b>${esc(a.suggestion || "无")}</div>
      <div class="mark-row">${["needChange", "ignore"].map((m) =>
        `<button data-m="${m}" ${review.hunks[key] === m ? "class=\"sel\"" : ""}>${m === "needChange" ? "❌ 需修改" : "忽略"}</button>`).join("")}</div>
      <div class="ask"><input placeholder="向 AI 追问这一处改动…"><button>问</button></div>
      <div class="answers hidden"></div>`;
    bubble.querySelectorAll(".mark-row button").forEach((b) => b.addEventListener("click", () => {
      review.hunks[key] = review.hunks[key] === b.dataset.m ? "" : b.dataset.m;
      saveReview();
      bubble.querySelectorAll(".mark-row button").forEach((x) => x.classList.toggle("sel", review.hunks[key] === x.dataset.m));
    }));
    const input = bubble.querySelector("input");
    bubble.querySelector(".ask button").addEventListener("click", async () => {
      const q = input.value.trim(); if (!q) return;
      const box = bubble.querySelector(".answers");
      box.classList.remove("hidden"); box.textContent = "思考中…";
      const fr = await fetch("/api/ai/followup", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: info.file, hunk: info.lines.join("\n"), prior: a.intent + "；" + a.suggestion, question: q }) });
      const fd = await fr.json();
      answers.push("Q: " + q + "\nA: " + (fd.answer || fd.error));
      box.textContent = answers.join("\n\n");
      input.value = "";
    });
  } catch (e) { bubble.textContent = "分析失败: " + e; }
}
function removeBubble() { $$(".bubble").forEach((b) => b.remove()); }
document.addEventListener("click", (e) => { if (!e.target.closest(".bubble") && !e.target.closest(".ai-icon")) removeBubble(); });

// ---------- 总览报告 ----------
$("#overviewBtn").addEventListener("click", async () => {
  const panel = $("#overviewPanel");
  panel.classList.remove("hidden");
  panel.innerHTML = "<h3>总览报告</h3>生成中…";
  const res = await fetch("/api/analyze/overview", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo: state.repo, base: state.base, compare: state.compare }) });
  const d = await res.json();
  if (d.error) { panel.innerHTML = "<h3>总览报告</h3>" + esc(d.error); return; }
  const r = d.report;
  panel.innerHTML = `<h3>总览报告</h3>
    <div class="sec">${esc(r.summary)}</div>
    <h3>风险清单</h3>
    ${(r.risks || []).map((x) => `<div class="risk" data-f="${esc(x.file)}"><span class="badge ${x.severity}">${x.severity}</span> ${esc(x.file)} — ${esc(x.desc)}</div>`).join("") || "无"}
    <h3>测试建议</h3><div>${esc(r.testSuggestions || "无")}</div>`;
  panel.querySelectorAll(".risk").forEach((el) => el.addEventListener("click", () => {
    const t = $(`#fileTree .file[data-f="${CSS.escape(el.dataset.f)}"]`);
    if (t) t.click();
  }));
});

// ---------- 导出 ----------
$("#exportBtn").addEventListener("click", () => {
  const blockers = Object.values(analysisByKey).filter((a) => a.severity === "blocker").length;
  const unmarked = currentFiles.filter((f) => !review.files[f.file]).length;
  if (blockers > 0 || unmarked > 0) {
    if (!confirm(`还有 ${blockers} 个 blocker、${unmarked} 个文件未标记审阅，仍要导出结论吗？`)) return;
  }
  window.open("/api/export?" + qParams());
});

function loadReviewPanel() { /* 预留：文件树下方统计 */ }
loadRepos();
