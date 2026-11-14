"use strict";
var $ = function (s) { return document.querySelector(s); };
function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
var SEV = {
  blocker: { pill: "必须修改", cls: "blocker" },
  warning: { pill: "建议修改", cls: "warning" },
  info: { pill: "无阻塞", cls: "info" }
};
var state = {
  review: { files: {}, hunks: {} },
  fileSev: {}, fileStat: {}, total: 0, done: 0, sev: { blocker: 0, warning: 0, info: 0 },
  started: false, rank: { blocker: 3, warning: 2, info: 1 }
};
var CHAT_HISTORY = [];
var SEL = { file: "", code: "" };

/* ---------------- 布局：侧边栏收起 / 字号 ---------------- */
function readLS(k, d) {
  try { var v = JSON.parse(localStorage.getItem(k)); return v === null || v === undefined ? d : v; }
  catch (e) { return d; }
}
function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 隐私模式忽略 */ } }

var LAYOUT = readLS("hunklens.layout", { rail: true, insp: true });
var FS_STEPS = [0.9, 1, 1.08, 1.16, 1.26];
var fsIdx = Number(readLS("hunklens.fsIdx", 1)) || 0;

function applyLayout() {
  document.body.classList.toggle("hide-rail", !LAYOUT.rail);
  document.body.classList.toggle("hide-insp", !LAYOUT.insp);
  document.body.classList.toggle("show-rail", LAYOUT.rail);
  document.body.classList.toggle("show-insp", LAYOUT.insp);
  $("#railToggle").classList.toggle("is-off", !LAYOUT.rail);
  $("#inspToggle").classList.toggle("is-off", !LAYOUT.insp);
  $("#railToggle").setAttribute("aria-pressed", String(LAYOUT.rail));
  $("#inspToggle").setAttribute("aria-pressed", String(LAYOUT.insp));
}

function togglePanel(which) {
  LAYOUT[which] = !LAYOUT[which];
  writeLS("hunklens.layout", LAYOUT);
  applyLayout();
}

function openInspector(tab) {
  if (!LAYOUT.insp) { LAYOUT.insp = true; writeLS("hunklens.layout", LAYOUT); applyLayout(); }
  if (tab) switchTab(tab);
}

function applyFont() {
  fsIdx = Math.max(0, Math.min(FS_STEPS.length - 1, fsIdx));
  var v = FS_STEPS[fsIdx];
  document.documentElement.style.setProperty("--fs", v);
  $("#fsVal").textContent = Math.round(v * 100) + "%";
  writeLS("hunklens.fsIdx", fsIdx);
}

/* ---------------- 选中代码 → 问 AI ---------------- */
var selAsk = $("#selAsk");

function hideSelAsk() { if (selAsk) selAsk.hidden = true; }

function selectedLineCount(text) { return String(text || "").split("\n").filter(function (s) { return s.trim(); }).length; }

function checkSelection() {
  var sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return hideSelAsk();
  var text = String(sel).replace(/^\n+/, "").replace(/\s+$/, "");
  if (!text.trim()) return hideSelAsk();
  var node = sel.anchorNode;
  var el = node ? (node.nodeType === 3 ? node.parentElement : node) : null;
  if (!el || !el.closest) return hideSelAsk();
  var codeEl = el.closest(".code");
  if (!codeEl) return hideSelAsk();
  var block = codeEl.closest(".file-block");
  var rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return hideSelAsk();
  selAsk.hidden = false;
  selAsk.style.top = Math.min(window.innerHeight - 46, Math.max(8, rect.bottom + 8)) + "px";
  selAsk.style.left = Math.min(window.innerWidth - 104, Math.max(10, rect.right - 30)) + "px";
  selAsk.dataset.file = block ? block.dataset.file : "";
  selAsk.dataset.code = text.slice(0, 6000);
}

function renderSelQuote() {
  var box = $("#selQuote");
  if (!box) return;
  if (!SEL.code) { box.hidden = true; return; }
  box.hidden = false;
  $("#selQuoteCode").textContent = SEL.code.length > 700 ? SEL.code.slice(0, 700) + "\n…（已截断）" : SEL.code;
}

/* ---------------- 基础 ---------------- */
function params() {
  var p = new URLSearchParams();
  p.set("repo", $("#repoSel").value);
  p.set("base", $("#baseSel").value);
  p.set("compare", $("#compareSel").value);
  return p;
}
async function api(url, opts) {
  var r = await fetch(url, opts);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
function postJSON(url, body) {
  return api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/* ---------------- 启动 ---------------- */
async function boot() {
  var repos = await api("/api/repos");
  $("#repoSel").innerHTML = repos.map(function (r) {
    return "<option value=\"" + esc(r.path) + "\">" + esc(r.name) + "</option>";
  }).join("");
  if (!repos.length) return;
  var q = new URLSearchParams(location.search);
  var wantRepo = q.get("repo");
  if (wantRepo && repos.some(function (r) { return r.path === wantRepo; })) $("#repoSel").value = wantRepo;
  await loadBranches(q);
}

async function loadBranches(q) {
  q = q || new URLSearchParams(location.search);
  var b = await api("/api/branches?repo=" + encodeURIComponent($("#repoSel").value));
  var opts = b.locals.map(function (x) { return "<option>" + esc(x) + "</option>"; }).join("");
  $("#baseSel").innerHTML = opts;
  $("#compareSel").innerHTML = opts;
  $("#baseSel").value = q.get("base") && b.locals.indexOf(q.get("base")) >= 0 ? q.get("base") : (b.current || b.locals[0]);
  var other = b.locals.filter(function (x) { return x !== $("#baseSel").value; })[0];
  $("#compareSel").value = q.get("compare") && b.locals.indexOf(q.get("compare")) >= 0 ? q.get("compare") : other;
  await loadRules();
  await loadSession();
  await loadReviewState();
  $("#reqFiles") && $("#reqFiles").addEventListener("keydown", function (e) { if (e.key === "Enter") saveReq(); });
  if (q.get("fs")) {
    var want = Number(q.get("fs")) / 100;
    var best = 0;
    for (var i = 0; i < FS_STEPS.length; i++) if (Math.abs(FS_STEPS[i] - want) < Math.abs(FS_STEPS[best] - want)) best = i;
    fsIdx = best;
    applyFont();
  }
  if (q.get("rail") === "0") { LAYOUT.rail = false; applyLayout(); }
  if (q.get("rail") === "1") { LAYOUT.rail = true; applyLayout(); }
  if (q.get("insp") === "0") { LAYOUT.insp = false; applyLayout(); }
  if (q.get("insp") === "1") { LAYOUT.insp = true; applyLayout(); }
  if (q.get("tab")) switchTab(q.get("tab"));
  if (q.get("auto") === "1") startReview();
}

async function loadRules() {
  try {
    var d = await api("/api/rules?repo=" + encodeURIComponent($("#repoSel").value));
    var el = $("#rulesBadge");
    if (d.count) {
      el.hidden = false;
      el.textContent = "📋 团队规范 ×" + d.count;
      el.title = (d.skills || []).map(function (s) { return s.name; }).join("\n");
    } else { el.hidden = true; }
  } catch (e) { /* 忽略 */ }
}

async function loadReviewState() {
  try {
    state.review = await api("/api/review?" + params());
    if (!state.review.hunks) state.review.hunks = {};
    if (!state.review.files) state.review.files = {};
  } catch (e) { /* 忽略 */ }
}

/* ---------------- 需求文档 ---------------- */
async function loadSession() {
  try {
    var s = await api("/api/session?" + params());
    $("#reqText").value = s.requirements || "";
    $("#reqFiles").value = (s.files || []).join(", ");
    $("#reqState").textContent = (s.requirements || "").trim() || (s.files || []).length
      ? "✓ 已挂载，分析时将对照需求评估" : "";
    renderDocs(s.attachments || []);
  } catch (e) { /* 忽略 */ }
}

/* ---------------- 需求文档：拖拽 / 选择上传 ---------------- */
function docIcon(name) {
  var ext = name.split(".").pop().toLowerCase();
  if (ext === "pdf") return "📕";
  if (ext === "docx" || ext === "doc" || ext === "rtf") return "📘";
  if (ext === "md" || ext === "markdown" || ext === "txt") return "📝";
  return "📄";
}

function renderDocs(list) {
  var box = $("#reqDocs");
  if (!box) return;
  box.innerHTML = (list || []).map(function (a) {
    return "<div class=\"doc-chip\" data-name=\"" + esc(a.name) + "\">"
      + "<span class=\"dico\">" + docIcon(a.name) + "</span>"
      + "<span class=\"dname\" title=\"" + esc(a.name) + "\">" + esc(a.name) + "</span>"
      + "<span class=\"dsize\">" + (a.chars ? (a.chars < 1000 ? a.chars + " 字" : Math.round(a.chars / 100) / 10 + "k 字") : "") + "</span>"
      + "<button class=\"dx\" data-remove=\"" + esc(a.name) + "\" title=\"移除\">×</button></div>";
  }).join("");
}

document.addEventListener("click", function (e) {
  var rm = e.target.closest && e.target.closest("[data-remove]");
  if (!rm) return;
  var name = rm.dataset.remove;
  postJSON("/api/session/attach/remove", {
    repo: $("#repoSel").value, base: $("#baseSel").value, compare: $("#compareSel").value, name: name
  }).then(function (r) { renderDocs(r.attachments || []); toast("已移除 " + name); })
    .catch(function () { toast("移除失败"); });
});

function readAsBase64(file) {
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onload = function () { resolve(String(fr.result).split(",")[1] || ""); };
    fr.onerror = function () { reject(new Error("读取失败")); };
    fr.readAsDataURL(file);
  });
}

async function attachFiles(files) {
  var list = Array.prototype.slice.call(files || []);
  if (!list.length) return;
  switchTab("req");
  for (var i = 0; i < list.length; i++) {
    var file = list[i];
    if (file.size > 20 * 1024 * 1024) { toast(file.name + " 超过 20MB，已跳过"); continue; }
    toast("正在解析 " + file.name + " …");
    try {
      var data = await readAsBase64(file);
      var r = await postJSON("/api/session/attach", {
        repo: $("#repoSel").value, base: $("#baseSel").value, compare: $("#compareSel").value,
        name: file.name, data: data
      });
      renderDocs(r.attachments || []);
      $("#reqState").textContent = "✓ 已添加 " + r.name + "（" + r.chars + " 字），重新 Review 生效";
      toast("已添加 " + file.name);
    } catch (e) {
      toast(file.name + " 解析失败：" + (e.message || ""));
    }
  }
}

$("#reqPick").addEventListener("click", function () { $("#reqFileInput").click(); });
$("#reqFileInput").addEventListener("change", function (e) {
  attachFiles(e.target.files);
  e.target.value = "";
});

var dragDepth = 0;
function showDrop(on) {
  var ov = $("#dropOverlay");
  if (ov) ov.hidden = !on;
}
window.addEventListener("dragenter", function (e) {
  if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") < 0) return;
  e.preventDefault();
  dragDepth++;
  showDrop(true);
});
window.addEventListener("dragover", function (e) {
  if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0) e.preventDefault();
});
window.addEventListener("dragleave", function (e) {
  if (!e.dataTransfer) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) showDrop(false);
});
window.addEventListener("drop", function (e) {
  if (!e.dataTransfer) return;
  e.preventDefault();
  dragDepth = 0;
  showDrop(false);
  if (e.dataTransfer.files && e.dataTransfer.files.length) attachFiles(e.dataTransfer.files);
});

function toast(msg) {
  var t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function () { t.classList.remove("toast"); t.style.opacity = "0"; t.style.transition = "opacity .3s"; }, 2200);
  setTimeout(function () { t.remove(); }, 2600);
}

async function saveReq() {
  var files = $("#reqFiles").value.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
  try {
    await postJSON("/api/session", {
      repo: $("#repoSel").value, base: $("#baseSel").value, compare: $("#compareSel").value,
      requirements: $("#reqText").value, files: files
    });
    $("#reqState").textContent = files.length || $("#reqText").value.trim()
      ? "✓ 已保存（含 " + files.length + " 个文档），重新 Review 生效" : "已清空需求";
    chatPush("ai", "需求文档已保存。重新点「开始 Review」后，AI 会对照需求评估每处改动。");
  } catch (e) { $("#reqState").textContent = "保存失败：" + e.message; }
}

/* ---------------- Review 主流程 ---------------- */
$("#startBtn").addEventListener("click", function () { startReview(); });
$("#swapBtn").addEventListener("click", function () {
  var a = $("#baseSel").value; $("#baseSel").value = $("#compareSel").value; $("#compareSel").value = a;
});
$("#repoSel").addEventListener("change", function () { loadBranches(); });
$("#baseSel").addEventListener("change", function () { resetState(); loadReviewState(); loadSession(); });
$("#compareSel").addEventListener("change", function () { resetState(); loadReviewState(); loadSession(); });

function resetState() {
  state.fileSev = {}; state.fileStat = {}; state.total = 0; state.done = 0;
  state.sev = { blocker: 0, warning: 0, info: 0 }; state.started = false;
  $("#statBadge").hidden = true;
  setProgress("尚未开始", 0);
}

function setProgress(text, pct) {
  $("#progressLine").textContent = text;
  $("#progressBar").style.width = Math.max(0, Math.min(100, pct)) + "%";
}

async function startReview() {
  var btn = $("#startBtn");
  if (btn.disabled) return;
  btn.disabled = true;
  state.started = true;
  state.done = 0; state.total = 0; state.sev = { blocker: 0, warning: 0, info: 0 };
  var area = $("#diffArea");
  area.innerHTML = "";
  $("#fileList").innerHTML = "";
  $("#overviewBox").innerHTML = "<div class=\"empty-hint\">正在生成整体结论…</div>";
  if (!document.querySelector(".tab.is-active") || document.querySelector(".tab.is-active").dataset.tab !== "req") switchTab("overview");
  try {
    var head = await api("/api/diff?" + params());
    state.files = head.files;
    $("#fileCount").textContent = head.files.length;
    renderRail(head.files);
    var blocks = await Promise.all(head.files.map(function (f) {
      return api("/api/diff/file?" + params() + "&file=" + encodeURIComponent(f.file))
        .then(function (d) { return { f: f, parsed: d.parsed }; });
    }));
    var containers = {};
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var map = renderFile(b.f, b.parsed);
      for (var k in map) containers[k] = map[k];
    }
    setProgress("已加载 " + head.files.length + " 个文件，准备 AI 分析…", 3);
    await analyzeStream(containers);
  } catch (e) {
    area.innerHTML = "<div class=\"hero\"><div class=\"hero-icon\">!</div><h1>加载失败</h1><p>" + esc(e.message) + "</p></div>";
  }
  btn.disabled = false;
}

/* ---------------- 文件栏 ---------------- */
function renderRail(files) {
  $("#fileList").innerHTML = files.map(function (f) {
    var name = f.file.split("/").pop();
    return "<div class=\"file-item\" data-file=\"" + esc(f.file) + "\" title=\"" + esc(f.file) + "\">"
      + "<span class=\"fdot pending\" data-dot=\"" + esc(f.file) + "\"></span>"
      + "<svg class=\"file-ico\" viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><path d='M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z'/><path d='M14 3v5h5'/></svg>"
      + "<span class=\"fname\"><bdi>" + esc(name) + "</bdi></span>"
      + "<span class=\"file-stat\"><span class=\"ins\">+" + f.insertions + "</span><span class=\"del\">-" + f.deletions + "</span></span>"
      + "</div>";
  }).join("");
  Array.prototype.forEach.call(document.querySelectorAll(".file-item"), function (el) {
    el.addEventListener("click", function () {
      var t = document.getElementById("f-" + el.dataset.file);
      if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function setFileSev(file, sev) {
  state.fileSev[file] = sev;
  var dot = document.querySelector("[data-dot='" + file.replace(/'/g, "") + "']");
  if (dot) dot.className = "fdot " + sev;
}

/* ---------------- diff 渲染 ---------------- */
function renderFile(f, parsed) {
  var block = document.createElement("div");
  block.className = "file-block";
  block.id = "f-" + f.file;
  block.dataset.file = f.file;
  var html = "<div class=\"file-head\">"
    + "<span class=\"path\" title=\"" + esc(f.file) + "\"><bdi>" + esc(f.file) + "</bdi></span>"
    + "<span class=\"hstat\"><span class=\"chip ins\">+" + f.insertions + "</span><span class=\"chip del\">-" + f.deletions + "</span></span>"
    + "</div>";
  var slots = {};
  var idx = 0;
  parsed.forEach(function (pf) {
    pf.hunks.forEach(function (h) {
      var m = h.header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      var oldLn = m ? +m[1] : 0, newLn = m ? +m[2] : 0;
      var rows = "";
      h.lines.forEach(function (line) {
        var cls = "ctx", sg = " ", o = "", n = "";
        if (line.charAt(0) === "+") { cls = "add"; sg = "+"; n = newLn++; }
        else if (line.charAt(0) === "-") { cls = "del"; sg = "-"; o = oldLn++; }
        else { o = oldLn++; n = newLn++; }
        var code = line.length ? line.slice(1) : "";
        rows += "<div class=\"row " + cls + "\">"
          + "<span class=\"ln\">" + o + "</span><span class=\"ln\">" + n + "</span>"
          + "<span class=\"sg\">" + sg + "</span><code>" + esc(code) + "</code></div>";
      });
      html += "<div class=\"hunk\"><div class=\"code\">"
        + "<div class=\"hunk-head\"><span>" + esc(h.header) + "</span></div>" + rows + "</div>"
        + "<div class=\"ai-card is-pending\" data-slot=\"" + esc(f.file) + ":" + idx + "\">"
        + "<div class=\"pending-note\"><span class=\"pulse\"></span>AI 正在阅读这段改动…</div>"
        + "<div class=\"skel\" style=\"margin-top:10px;height:38px\"></div></div></div>";
      slots[f.file + ":" + idx] = idx;
      idx++;
    });
  });
  block.innerHTML = html;
  $("#diffArea").appendChild(block);
  var map = {};
  for (var k in slots) map[k] = true;
  return map;
}

/* ---------------- SSE 分析 ---------------- */
function analyzeStream(containers) {
  return new Promise(function (resolve) {
    var es = new EventSource("/api/analyze/stream?" + params());
    var startAt = Date.now();
    es.addEventListener("start", function (e) {
      var d = JSON.parse(e.data);
      state.total = d.total;
      setProgress("AI 分析中 " + d.cached + " 个命中缓存 / 共 " + d.total + " 个改动", 4);
    });
    es.addEventListener("hunk", function (e) {
      var d = JSON.parse(e.data);
      state.done++;
      var slot = document.querySelector("[data-slot='" + (d.file + ":" + d.hunkIndex).replace(/'/g, "") + "']");
      if (slot) slot.outerHTML = cardHTML(d.analysis, d.key, d.file, d.hunkIndex, d.cached);
      var sev = (d.analysis && d.analysis.severity) || "info";
      state.sev[sev] = (state.sev[sev] || 0) + 1;
      var prev = state.fileSev[d.file];
      if (!prev || state.rank[sev] > state.rank[prev]) setFileSev(d.file, sev);
      var pct = state.total ? Math.round(state.done / state.total * 100) : 0;
      setProgress("AI 分析中 " + state.done + "/" + state.total, pct);
      updateBadge();
    });
    es.addEventListener("done", function (e) {
      var d = JSON.parse(e.data);
      es.close();
      var secs = Math.round((Date.now() - startAt) / 1000);
      setProgress("✅ 分析完成 · " + d.total + " 个改动 · " + secs + "s" + (d.failed ? " · " + d.failed + " 个失败" : ""), 100);
      loadOverview();
      resolve();
    });
    es.addEventListener("error", function () {
      es.close();
      setProgress("分析中断（可刷新重试）", 0);
      resolve();
    });
  });
}

function updateBadge() {
  var b = state.sev.blocker, w = state.sev.warning, i = state.sev.info;
  var el = $("#statBadge");
  el.hidden = false;
  el.innerHTML = "<span>共 " + (b + w + i) + " 个改动</span>"
    + (b ? "<span class=\"chip del\" style='color:#b91c1c;background:#fee2e2'>" + b + " 必须修改</span>" : "")
    + (w ? "<span class=\"chip\" style='color:#b45309;background:#fef3c7'>" + w + " 建议修改</span>" : "");
}

/* ---------------- AI 卡片 ---------------- */
function cardHTML(a, key, file, hunkIndex, cached) {
  a = a || {};
  var sev = SEV[a.severity] || SEV.info;
  var marked = (state.review.hunks || {})[key];
  var issues = (a.issues || []).filter(function (x) { return x && x.desc; });
  var html = "<div class=\"ai-card sev-" + sev.cls + "\" data-key=\"" + esc(key) + "\">"
    + "<div class=\"ai-head\">"
    + "<span class=\"ai-avatar\">✦</span><span class=\"ai-name\">AI 审阅</span>"
    + "<span class=\"pill " + sev.cls + "\">" + sev.pill + "</span>"
    + "<span class=\"ai-meta\">" + (a.confidence ? "置信度 " + Math.round(a.confidence * 100) + "%" : "") + (cached ? " · 缓存" : "") + "</span>"
    + "</div>";
  if (a.intent) html += "<p class=\"ai-intent\">" + esc(a.intent) + "</p>";
  if (issues.length) {
    html += "<ul class=\"ai-issues\">";
    issues.forEach(function (it) { html += "<li>" + esc(it.desc) + "</li>"; });
    html += "</ul>";
  }
  if (a.suggestion && a.suggestion !== "-") html += "<div class=\"ai-suggest\">" + esc(a.suggestion) + "</div>";
  html += "<div class=\"ai-actions\">"
    + "<button class=\"mini-btn" + (marked === "需修改" ? " is-on" : "") + "\" data-act=\"fix\" data-key=\"" + esc(key) + "\">需修改</button>"
    + "<button class=\"mini-btn" + (marked === "忽略" ? " is-on" : "") + "\" data-act=\"ignore\" data-key=\"" + esc(key) + "\">忽略</button>"
    + "<button class=\"mini-btn\" data-act=\"ask\" data-file=\"" + esc(file) + "\" data-idx=\"" + hunkIndex + "\">追问</button>"
    + "</div></div>";
  return html;
}

document.addEventListener("click", function (e) {
  var btn = e.target.closest ? e.target.closest("[data-act]") : null;
  if (!btn) return;
  var act = btn.dataset.act;
  if (act === "ask") { askAbout(btn.dataset.file, btn.dataset.idx); return; }
  var key = btn.dataset.key;
  state.review.hunks = state.review.hunks || {};
  state.review.hunks[key] = act === "fix" ? "需修改" : "忽略";
  var sib = btn.parentElement.querySelectorAll("[data-act]");
  Array.prototype.forEach.call(sib, function (b) {
    if (b.dataset.act === act) b.classList.add("is-on");
    else if (b.dataset.act === "fix" || b.dataset.act === "ignore") b.classList.remove("is-on");
  });
  postJSON("/api/review", {
    repo: $("#repoSel").value, base: $("#baseSel").value, compare: $("#compareSel").value,
    data: state.review
  }).catch(function () {});
});

/* ---------------- 总览 ---------------- */
async function loadOverview() {
  var box = $("#overviewBox");
  box.innerHTML = "<div class=\"empty-hint\">正在汇总结论…</div>";
  try {
    var r = await postJSON("/api/analyze/overview", {
      repo: $("#repoSel").value, base: $("#baseSel").value, compare: $("#compareSel").value
    });
    var rep = r.report || {};
    function objText(x) {
      if (x === null || x === undefined) return "";
      if (typeof x !== "object") return String(x);
      var keys = ["desc", "title", "text", "risk", "issue", "name", "description", "problem"];
      var head = "";
      for (var i = 0; i < keys.length; i++) if (x[keys[i]]) { head = String(x[keys[i]]); break; }
      if (!head) head = Object.keys(x).map(function (k) { return String(x[k]); }).join(" · ");
      var extra = x.suggestion || x.fix || x.detail || x.why || x.impact;
      return extra ? head + " —— " + String(extra) : head;
    }
    function asList(v) {
      if (!v) return [];
      if (Array.isArray(v)) return v.map(objText).filter(Boolean);
      if (typeof v === "string") return v.split(/\n+/).map(function (s) { return s.replace(/^[-*\d.\s]+/, "").trim(); }).filter(Boolean);
      if (typeof v === "object") return Object.keys(v).map(function (k) { return objText(v[k]); }).filter(Boolean);
      return [String(v)];
    }
    rep.risks = asList(rep.risks);
    rep.testSuggestions = asList(rep.testSuggestions);
    var verdict = state.sev.blocker > 0 ? "risk" : (state.sev.warning > 0 ? "mid" : "ok");
    var vtext = state.sev.blocker > 0 ? "存在 " + state.sev.blocker + " 处必须修改，建议改动后再合入"
      : (state.sev.warning > 0 ? "有 " + state.sev.warning + " 处建议优化，可评估后合入" : "未发现阻塞性问题");
    var html = "<div class=\"ov-verdict " + verdict + "\">" + vtext + "</div>";
    html += "<div class=\"ov-card\"><h4>变更概要</h4><p>" + esc(rep.summary || "—") + "</p></div>";
    if (rep.risks && rep.risks.length) {
      html += "<div class=\"ov-card\"><h4>风险</h4><ul>";
      rep.risks.forEach(function (x) { html += "<li>" + esc(x) + "</li>"; });
      html += "</ul></div>";
    }
    if (rep.testSuggestions && rep.testSuggestions.length) {
      html += "<div class=\"ov-card\"><h4>测试建议</h4><ul>";
      rep.testSuggestions.forEach(function (x) { html += "<li>" + esc(x) + "</li>"; });
      html += "</ul></div>";
    }
    html += "<button class='btn btn-secondary btn-sm' id='ovRefresh'>重新生成结论</button>";
    box.innerHTML = html;
    var rf = document.getElementById("ovRefresh");
    if (rf) rf.addEventListener("click", loadOverview);
  } catch (e) {
    box.innerHTML = "<div class=\"empty-hint\">总览生成失败：" + esc(e.message) + "</div>";
  }
}

/* ---------------- 对话 ---------------- */
function chatPush(role, text) {
  var d = document.createElement("div");
  d.className = "msg " + role;
  d.textContent = text;
  $("#chatMsgs").appendChild(d);
  $("#chatMsgs").scrollTop = $("#chatMsgs").scrollHeight;
  return d;
}

function askAbout(file, idx) {
  openInspector("chat");
  var input = $("#chatInput");
  input.dataset.file = file;
  input.dataset.idx = idx;
  input.placeholder = "关于 " + file.split("/").pop() + " 第 " + (Number(idx) + 1) + " 块改动…";
  input.focus();
}

async function sendChat() {
  var input = $("#chatInput");
  var question = input.value.trim();
  if (!question) return;
  chatPush("user", question);
  input.value = "";
  var loading = chatPush("ai", "思考中…");
  loading.classList.add("loading");
  var file = input.dataset.file || SEL.file || "";
  var hunkLabel = input.dataset.file ? "第 " + (Number(input.dataset.idx) + 1) + " 块改动"
    : (SEL.code ? "选中的 " + selectedLineCount(SEL.code) + " 行代码" : "整体变更");
  var code = SEL.code || "";
  var prior = CHAT_HISTORY.slice(-3).join("\n");
  try {
    var r = await postJSON("/api/ai/followup", {
      repo: $("#repoSel").value, base: $("#baseSel").value, compare: $("#compareSel").value,
      file: file, hunk: hunkLabel, code: code,
      prior: prior, question: question
    });
    loading.classList.remove("loading");
    loading.textContent = r.answer || r.error || "（无回复）";
    CHAT_HISTORY.push("Q: " + question + "\nA: " + String(loading.textContent || "").slice(0, 400));
  } catch (e) {
    loading.classList.remove("loading");
    loading.textContent = "请求失败：" + e.message;
  }
  input.dataset.file = ""; input.dataset.idx = "";
  input.placeholder = "针对本次变更提问…";
  if (SEL.code) { SEL = { file: "", code: "" }; renderSelQuote(); }
}

$("#chatSend").addEventListener("click", sendChat);
$("#chatInput").addEventListener("keydown", function (e) { if (e.key === "Enter") sendChat(); });

$("#railToggle").addEventListener("click", function () { togglePanel("rail"); });
$("#inspToggle").addEventListener("click", function () { togglePanel("insp"); });
$("#fsPlus").addEventListener("click", function () { fsIdx++; applyFont(); });
$("#fsMinus").addEventListener("click", function () { fsIdx--; applyFont(); });

selAsk.addEventListener("click", function () {
  var code = selAsk.dataset.code || "";
  var file = selAsk.dataset.file || "";
  hideSelAsk();
  openInspector("chat");
  SEL = { file: file, code: code };
  renderSelQuote();
  var input = $("#chatInput");
  input.focus();
  input.placeholder = "关于选中代码的 " + file.split("/").pop() + " — 想问什么？";
});

document.addEventListener("mouseup", function (e) {
  if (selAsk && (e.target === selAsk || selAsk.contains(e.target))) return;
  setTimeout(checkSelection, 10);
});
document.addEventListener("selectionchange", function () {
  var s = window.getSelection();
  if (!s || s.isCollapsed) hideSelAsk();
});
document.addEventListener("scroll", hideSelAsk, true);
$("#selClear").addEventListener("click", function () {
  SEL = { file: "", code: "" };
  renderSelQuote();
  $("#chatInput").placeholder = "针对本次变更提问…";
});
applyLayout();
applyFont();

/* ---------------- tab / 导出 ---------------- */
function switchTab(name) {
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
    t.classList.toggle("is-active", t.dataset.tab === name);
  });
  Array.prototype.forEach.call(document.querySelectorAll(".pane"), function (p) {
    p.classList.toggle("is-active", p.dataset.pane === name);
  });
}
Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) {
  t.addEventListener("click", function () { switchTab(t.dataset.tab); });
});

$("#exportBtn").addEventListener("click", function () {
  window.open("/api/export?" + params());
});

/* ---------------- 滚动同步文件栏 ---------------- */
var io = new IntersectionObserver(function (entries) {
  entries.forEach(function (en) {
    if (!en.isIntersecting) return;
    var file = en.target.dataset.file;
    Array.prototype.forEach.call(document.querySelectorAll(".file-item"), function (el) {
      el.classList.toggle("is-active", el.dataset.file === file);
    });
  });
}, { root: $("#diffArea"), rootMargin: "-10px 0px -70% 0px", threshold: 0 });

var mo = new MutationObserver(function () {
  Array.prototype.forEach.call(document.querySelectorAll(".file-block:not([data-io])"), function (b) {
    b.dataset.io = "1";
    io.observe(b);
  });
});
mo.observe($("#diffArea"), { childList: true });

boot();
