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
  analysis: {},
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
  try {
    var savedMode = localStorage.getItem("hunklens.viewMode");
    if (savedMode === "file") VIEW_MODE = "file";
  } catch (e) {}
  setViewSegUI();
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

/* ---------------- 分支选择：可搜索下拉（本地 / 远程） ---------------- */
var BRANCHES = { current: "", locals: [], remotes: [] };

function comboEl(key) { return document.querySelector(".combo[data-key='" + key + "']"); }
function branchValue(key) { var b = comboEl(key); return b ? b.querySelector("input[type=hidden]").value : ""; }
function shortName(remote) { return String(remote || "").split("/").slice(1).join("/"); }

function setBranch(key, name) {
  var box = comboEl(key);
  if (!box) return;
  box.querySelector("input[type=hidden]").value = name || "";
  box.querySelector(".combo-label").textContent = name || "—";
  box.querySelector(".combo-btn").title = name || "";
}

function branchItemHTML(cls, dataAttr, value, icon, label, mark) {
  return "<button type='button' class='combo-item " + cls + "' " + dataAttr + "='" + esc(value) + "'>"
    + "<span class='bicon'>" + icon + "</span><span class='bname'>" + esc(label) + "</span>"
    + (mark ? "<span class='bmark'>" + esc(mark) + "</span>" : "") + "</button>";
}

function renderComboList(box, filter) {
  var list = box.querySelector(".combo-list");
  var cur = branchValue(box.dataset.key);
  var f = String(filter || "").trim().toLowerCase();
  function hit(b) { return !f || b.toLowerCase().indexOf(f) >= 0; }
  var locals = (BRANCHES.locals || []).filter(hit);
  var remotes = (BRANCHES.remotes || []).filter(hit);
  var html = "";
  if (locals.length) {
    html += "<div class='combo-group'>本地分支</div>";
    html += locals.map(function (b) {
      return branchItemHTML(b === cur ? "is-on" : "", "data-local", b, "•", b, b === BRANCHES.current ? "当前" : "");
    }).join("");
  }
  if (remotes.length) {
    var byRemote = {};
    remotes.forEach(function (r) {
      var p = String(r).split("/");
      var name = p.shift();
      (byRemote[name] = byRemote[name] || []).push({ full: r, short: p.join("/") });
    });
    Object.keys(byRemote).forEach(function (rn) {
      html += "<div class='combo-group'>远程 · " + esc(rn) + "</div>";
      html += byRemote[rn].map(function (it) {
        var exists = (BRANCHES.locals || []).indexOf(it.short) >= 0;
        return branchItemHTML("is-remote" + (it.short === cur ? " is-on" : ""), "data-remote", it.full, "⇣", it.short, exists ? "已检出" : "远程");
      }).join("");
    });
  }
  list.innerHTML = html || "<div class='combo-empty'>没有匹配的分支</div>";
  var on = list.querySelector(".is-on");
  if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
}

function renderCombos() {
  ["base", "compare"].forEach(function (k) {
    var box = comboEl(k);
    if (box && !box.querySelector(".combo-pop").hidden) renderComboList(box, box.querySelector(".combo-search input").value);
  });
}

function openCombo(key) {
  ["base", "compare"].forEach(function (k) {
    var box = comboEl(k);
    if (!box) return;
    var open = k === key;
    box.classList.toggle("is-open", open);
    box.querySelector(".combo-pop").hidden = !open;
    if (open) {
      var input = box.querySelector(".combo-search input");
      input.value = "";
      renderComboList(box, "");
      setTimeout(function () { input.focus(); }, 20);
    }
  });
}

function closeCombos() {
  ["base", "compare"].forEach(function (k) {
    var box = comboEl(k);
    if (!box) return;
    box.classList.remove("is-open");
    box.querySelector(".combo-pop").hidden = true;
  });
}

function onBranchChanged() {
  closeCombos();
  resetState();
  loadReviewState();
  loadSession();
}

async function pickBranch(key, value, isRemote) {
  if (!isRemote) { setBranch(key, value); onBranchChanged(); return; }
  var short = shortName(value);
  if ((BRANCHES.locals || []).indexOf(short) >= 0) { setBranch(key, short); onBranchChanged(); return; }
  toast("正在检出远程分支 " + value + " …");
  try {
    var r = await postJSON("/api/branch/track", { repo: $("#repoSel").value, remote: value });
    BRANCHES = { current: r.current || r.branch, locals: r.locals || [], remotes: r.remotes || [] };
    setBranch(key, r.branch || short);
    toast((r.created ? "已创建本地跟踪分支 " : "已切换分支 ") + (r.branch || short));
    onBranchChanged();
  } catch (e) {
    toast("检出失败：" + (e.message || ""));
  }
}

async function fetchRemotes() {
  toast("正在拉取远程分支…");
  try {
    await postJSON("/api/fetch", { repo: $("#repoSel").value });
    var b = await api("/api/branches?repo=" + encodeURIComponent($("#repoSel").value));
    BRANCHES = b;
    renderCombos();
    toast("已拉取 · 本地 " + (b.locals || []).length + " / 远程 " + (b.remotes || []).length);
  } catch (e) {
    toast("拉取失败：" + (e.message || ""));
  }
}

async function loadBranches(q) {
  q = q || new URLSearchParams(location.search);
  var b = await api("/api/branches?repo=" + encodeURIComponent($("#repoSel").value));
  BRANCHES = b;
  var locals = b.locals || [];
  var wantBase = q.get("base");
  var base = wantBase && (locals.indexOf(wantBase) >= 0 || (b.remotes || []).indexOf(wantBase) >= 0)
    ? wantBase : (b.current || locals[0] || "");
  if ((b.remotes || []).indexOf(base) >= 0) base = shortName(base);
  setBranch("base", base);
  var others = locals.filter(function (x) { return x !== base; });
  var wantCompare = q.get("compare");
  var compare = wantCompare && locals.indexOf(wantCompare) >= 0 ? wantCompare : (others[0] || base);
  setBranch("compare", compare);
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
  var a = branchValue("base"), b = branchValue("compare");
  setBranch("base", b);
  setBranch("compare", a);
  onBranchChanged();
});
$("#repoSel").addEventListener("change", function () { loadBranches(); });

/* 分支下拉：点击展开 / 搜索 / 选择 / 拉取远程 */
document.addEventListener("click", function (e) {
  var btn = e.target.closest ? e.target.closest(".combo-btn") : null;
  if (btn) {
    var key = btn.closest(".combo").dataset.key;
    var box = comboEl(key);
    openCombo(box.classList.contains("is-open") ? "" : key);
    return;
  }
  var item = e.target.closest ? e.target.closest(".combo-item") : null;
  if (item) {
    var k = item.closest(".combo").dataset.key;
    if (item.dataset.local !== undefined) pickBranch(k, item.dataset.local, false);
    else pickBranch(k, item.dataset.remote, true);
    return;
  }
  var fetchBtn = e.target.closest ? e.target.closest(".combo-fetch") : null;
  if (fetchBtn) { fetchRemotes(); return; }
  if (!(e.target.closest && e.target.closest(".combo-pop"))) closeCombos();
});

document.addEventListener("input", function (e) {
  var search = e.target.closest ? e.target.closest(".combo-search input") : null;
  if (search) renderComboList(search.closest(".combo"), search.value);
});

document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") { closeCombos(); return; }
  var box = document.querySelector(".combo.is-open");
  if (!box) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    var items = Array.prototype.slice.call(box.querySelectorAll(".combo-item"));
    if (!items.length) return;
    e.preventDefault();
    var cur = items.indexOf(document.activeElement);
    var next = e.key === "ArrowDown" ? Math.min(items.length - 1, cur + 1) : Math.max(0, cur - 1);
    items[next].focus();
  }
});

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
  state.analysis = {}; HUNKS = {}; FILE_CACHE = {}; jumpIdx = 0;
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
        .then(function (d) { return { f: f, parsed: d.parsed, oldTotal: d.oldTotal, newTotal: d.newTotal }; });
    }));
    var containers = {};
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var map = renderFile(b.f, b.parsed, { oldTotal: b.oldTotal, newTotal: b.newTotal });
      for (var k in map) containers[k] = map[k];
    }
    setProgress("已加载 " + head.files.length + " 个文件，准备 AI 分析…", 3);
    buildJumpIndex();
    syncRailActive();
    if (VIEW_MODE === "file") await applyViewMode("file");
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
var HUNKS = {}; // file -> [{header, lines, oldStart, oldCount, newStart, newCount}]

function renderFile(f, parsed, totals) {
  var block = document.createElement("div");
  block.className = "file-block";
  block.id = "f-" + f.file;
  block.dataset.file = f.file;
  block.dataset.mode = "diff";
  var html = "<div class=\"file-head\">"
    + "<span class=\"path\" title=\"" + esc(f.file) + "\"><bdi>" + esc(f.file) + "</bdi></span>"
    + "<button type=\"button\" class=\"ctx-all\" data-expand-all=\"1\" title=\"展开整份文件的未改动代码\">全部上下文</button>"
    + "<span class=\"hstat\"><span class=\"chip ins\">+" + f.insertions + "</span><span class=\"chip del\">-" + f.deletions + "</span></span>"
    + "</div><div class=\"file-body\">";
  var oldCursor = 1, newCursor = 1;
  var meta = [];
  var slots = {};
  var idx = 0;
  parsed.forEach(function (pf) {
    pf.hunks.forEach(function (h) {
      var m = h.header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      var oldLn = m ? +m[1] : 0, newLn = m ? +m[3] : 0;
      meta.push({
        header: h.header, lines: h.lines,
        oldStart: m ? +m[1] : 0, oldCount: m ? (m[2] === undefined ? 1 : +m[2]) : 0,
        newStart: m ? +m[3] : 0, newCount: m ? (m[4] === undefined ? 1 : +m[4]) : 0
      });
      var gapO = Math.max(0, (m ? +m[1] : 0) - oldCursor);
      var gapN = Math.max(0, (m ? +m[3] : 0) - newCursor);
      if (gapO || gapN) html += gapHTML(f.file, oldCursor, gapO, newCursor, gapN);
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
      html += "<div class=\"hunk\" id=\"h-" + esc(f.file) + "-" + idx + "\" data-hidx=\"" + idx + "\" data-hfile=\"" + esc(f.file) + "\"><div class=\"code\">"
        + "<div class=\"hunk-head\"><span>" + esc(h.header) + "</span></div>" + rows + "</div>"
        + "<div class=\"ai-card is-pending\" data-slot=\"" + esc(f.file) + ":" + idx + "\">"
        + "<div class=\"ai-head\"><span class=\"ai-avatar\">✦</span>"
        + "<span class=\"ai-title\"><span class=\"ai-name\">AI 审阅</span><span class=\"pill pending\">阅读中</span></span></div>"
        + "<div class=\"pending-note\"><span class=\"pulse\"></span>正在读这段改动…</div>"
        + "<div class=\"skel\" style=\"width:94%\"></div>"
        + "<div class=\"skel\" style=\"width:78%\"></div>"
        + "<div class=\"skel\" style=\"width:58%\"></div></div></div>";
      oldCursor = oldLn; newCursor = newLn;
      slots[f.file + ":" + idx] = idx;
      idx++;
    });
  });
  if (totals) {
    var tailO = Math.max(0, (+totals.oldTotal || 0) - oldCursor + 1);
    var tailN = Math.max(0, (+totals.newTotal || 0) - newCursor + 1);
    if (tailO || tailN) html += gapHTML(f.file, oldCursor, tailO, newCursor, tailN);
  }
  html += "</div>";
  block.innerHTML = html;
  block._diffHTML = block.querySelector(".file-body").innerHTML;
  HUNKS[f.file] = meta;
  $("#diffArea").appendChild(block);
  var map = {};
  for (var k in slots) map[k] = true;
  return map;
}

/* ---------------- 未改动上下文：点击展开（GitHub 式） ---------------- */
function gapHTML(file, oc, olen, nc, nlen) {
  if (olen <= 0 && nlen <= 0) return "";
  var n = Math.max(olen, nlen);
  return "<div class=\"ctx-gap\" data-file=\"" + esc(file) + "\" data-oc=\"" + oc + "\" data-olen=\"" + olen
    + "\" data-nc=\"" + nc + "\" data-nlen=\"" + nlen + "\"><div class=\"ctx-gap-main\">"
    + "<button type=\"button\" class=\"ctx-btn\" data-expand=\"1\" title=\"展开这处未改动的代码\">⋯ 展开 "
    + Math.min(20, n) + " 行未改动上下文</button></div><span class=\"ctx-spacer\"></span></div>";
}

async function expandGap(gapEl, step) {
  var file = gapEl.dataset.file;
  var oc = +gapEl.dataset.oc, olen = +gapEl.dataset.olen;
  var nc = +gapEl.dataset.nc, nlen = +gapEl.dataset.nlen;
  var data;
  try { data = await loadWholeFile(file); } catch (e) { return; }
  var total = Math.max(olen, nlen);
  var take = Math.min(step || 20, total);
  if (take <= 0) { gapEl.remove(); return; }
  var rows = "";
  for (var k = 0; k < take; k++) {
    var hasO = k < olen, hasN = k < nlen;
    var oTxt = hasO ? data.oldLines[oc + k - 1] : null;
    var nTxt = hasN ? data.newLines[nc + k - 1] : null;
    var txt = hasO ? oTxt : nTxt;
    rows += "<div class=\"row ctx\"><span class=\"ln\">" + (hasO ? oc + k : "") + "</span>"
      + "<span class=\"ln\">" + (hasN ? nc + k : "") + "</span>"
      + "<span class=\"sg\"> </span><code>" + esc(txt == null ? "" : txt) + "</code></div>";
  }
  var hunk = document.createElement("div");
  hunk.className = "hunk is-ctx";
  hunk.innerHTML = "<div class=\"code\">" + rows + "</div>";
  gapEl.parentNode.insertBefore(hunk, gapEl);
  var leftO = Math.max(0, olen - take), leftN = Math.max(0, nlen - take);
  if (leftO || leftN) {
    gapEl.dataset.oc = oc + Math.min(take, olen);
    gapEl.dataset.olen = leftO;
    gapEl.dataset.nc = nc + Math.min(take, nlen);
    gapEl.dataset.nlen = leftN;
    var bn = Math.max(leftO, leftN);
    var btn = gapEl.querySelector("button");
    if (btn) btn.textContent = "⋯ 再展开 " + Math.min(20, bn) + " 行（还有 " + bn + " 行未改动）";
  } else {
    gapEl.remove();
  }
}

async function expandAllGaps(block) {
  var gaps = Array.prototype.slice.call(block.querySelectorAll(".ctx-gap"));
  for (var i = 0; i < gaps.length; i++) {
    var gEl = gaps[i];
    if (!gEl.parentNode) continue;
    await expandGap(gEl, 100000);
  }
}

document.addEventListener("click", function (e) {
  if (!e.target.closest) return;
  var ex = e.target.closest("[data-expand]");
  if (ex) { var gEl = ex.closest(".ctx-gap"); if (gEl) { e.preventDefault(); expandGap(gEl, 20); } return; }
  var all = e.target.closest("[data-expand-all]");
  if (all) { var blk = all.closest(".file-block"); if (blk) expandAllGaps(blk); return; }
  var gap = e.target.closest(".ctx-gap");
  if (gap) expandGap(gap, 20);
});

/* ---------------- 改动 / 整文件 视图切换 ---------------- */
var FILE_CACHE = {};

function sevOfSlot(file, idx) {
  var a = state.analysis[file + ":" + idx];
  return (a && a.analysis && a.analysis.severity) || "";
}

/** 把「左旧右新」按行对齐：未改动行成对，增删按位置配对 */
function buildCompareRows(oldLines, newLines, hunks) {
  var rows = [];
  var oi = 1, ni = 1, curH = 0;
  function ctx(o, n) { rows.push({ type: "ctx", on: o, nn: n, h: curH }); }
  (hunks || []).forEach(function (h, hi) {
    curH = hi;
    while ((oi < (h.oldStart || 1)) && (oi <= oldLines.length || ni <= newLines.length)) { ctx(oi, ni); oi++; ni++; }
    var dels = [], adds = [];
    function flush() {
      var n = Math.max(dels.length, adds.length);
      for (var i = 0; i < n; i++) {
        var o = dels[i] === undefined ? 0 : dels[i];
        var nn = adds[i] === undefined ? 0 : adds[i];
        rows.push({ type: o ? "del" : "add", on: o, nn: nn, h: curH });
      }
      dels = []; adds = [];
    }
    (h.lines || []).forEach(function (line) {
      var c = line.charAt(0);
      if (c === "+") { adds.push(ni); ni++; }
      else if (c === "-") { dels.push(oi); oi++; }
      else { flush(); ctx(oi, ni); oi++; ni++; }
    });
    flush();
  });
  while (oi <= oldLines.length || ni <= newLines.length) { ctx(oi, ni); oi++; ni++; }
  return rows;
}

function cmpRowHTML(r, oldLines, newLines) {
  var o = r.on ? oldLines[r.on - 1] : null;
  var n = r.nn ? newLines[r.nn - 1] : null;
  return "<div class=\"cmp-row\">"
    + "<span class=\"cmp-ln " + (r.on ? "" : "void") + "\">" + (r.on || "") + "</span>"
    + "<span class=\"cmp-code " + (r.type === "del" ? "del" : (r.on ? "" : "void")) + "\">" + (o === null || o === undefined ? "" : esc(o)) + "</span>"
    + "<span class=\"cmp-ln " + (r.nn ? "" : "void") + "\">" + (r.nn || "") + "</span>"
    + "<span class=\"cmp-code " + (r.type === "add" ? "add" : (r.nn ? "" : "void")) + "\">" + (n === null || n === undefined ? "" : esc(n)) + "</span>"
    + "</div>";
}

function aiCardForSlot(file, idx) {
  var a = state.analysis[file + ":" + idx];
  if (a) return cardHTML(a.analysis, a.key, file, idx, a.cached);
  return "<div class=\"ai-card is-pending\" data-slot=\"" + esc(file + ":" + idx) + "\"><div class=\"ai-head\"><span class=\"ai-avatar\">✦</span>"
    + "<span class=\"ai-title\"><span class=\"ai-name\">AI 审阅</span><span class=\"pill pending\">阅读中</span></span></div>"
    + "<div class=\"pending-note\"><span class=\"pulse\"></span>正在读这段改动…</div>"
    + "<div class=\"skel\" style=\"width:94%\"></div><div class=\"skel\" style=\"width:66%\"></div></div>";
}

var CMP_PAGE = 1500; // 整文件视图一次渲染的行数；超过则分块显示，避免超大文件卡死

function buildCompareHTML(file, data) {
  var oldLines = data.oldLines || [];
  var newLines = data.newLines || [];
  var hunks = HUNKS[file] || [];
  var rows = buildCompareRows(oldLines, newLines, hunks);
  // 先按「改动 / 未改动」分段：AI 卡片永远挂在整段末尾，且分块不会把一段改动切断
  var segs = [];
  rows.forEach(function (r) {
    var changed = r.type !== "ctx";
    var last = segs[segs.length - 1];
    if (!last || last.changed !== changed) segs.push({ changed: changed, rows: [r], hunk: r.h || 0 });
    else last.rows.push(r);
  });
  var limit = data.limit || CMP_PAGE;
  var used = 0, parts = [];
  for (var i = 0; i < segs.length && used < limit; i++) {
    var sg = segs[i];
    // 改动段整体渲染（保证 AI 卡片不被切断）；未改动段可以按行切开
    if (sg.changed) { parts.push({ seg: sg }); used += sg.rows.length; continue; }
    var take = Math.min(sg.rows.length, limit - used);
    parts.push({ rows: sg.rows.slice(0, take) });
    used += take;
  }
  var html = "<div class=\"cmp-note\"><span>整文件对比 · 左 <b>" + esc(branchValue("base")) + "</b> / 右 <b>"
    + esc(branchValue("compare")) + "</b> · 旧 " + oldLines.length + " 行 / 新 " + newLines.length + " 行 · "
    + hunks.length + " 处改动</span></div><div class=\"cmp\">";
  parts.forEach(function (p) {
    if (p.rows) { html += p.rows.map(function (r) { return cmpRowHTML(r, oldLines, newLines); }).join(""); return; }
    var s = p.seg;
    html += s.rows.map(function (r) { return cmpRowHTML(r, oldLines, newLines); }).join("");
    html += "<div class=\"cmp-ai\" data-hfile=\"" + esc(file) + "\" data-hidx=\"" + (s.hunk || 0) + "\">" + aiCardForSlot(file, s.hunk || 0) + "</div>";
  });
  html += "</div>";
  if (used < rows.length) {
    html += "<div class=\"cmp-gap\"><button type=\"button\" data-more=\"1\" data-file=\"" + esc(file) + "\">继续显示剩余 " + (rows.length - used) + " 行</button></div>";
  }
  return html;
}

async function loadWholeFile(file) {
  if (FILE_CACHE[file]) return FILE_CACHE[file];
  var repo = $("#repoSel").value;
  var a = await api("/api/file?repo=" + encodeURIComponent(repo) + "&ref=" + encodeURIComponent(branchValue("base")) + "&file=" + encodeURIComponent(file));
  var b = await api("/api/file?repo=" + encodeURIComponent(repo) + "&ref=" + encodeURIComponent(branchValue("compare")) + "&file=" + encodeURIComponent(file));
  function toLines(t) { var s = String(t || ""); if (!s) return []; return s.replace(/\n$/, "").split("\n"); }
  FILE_CACHE[file] = { oldLines: toLines(a.text), newLines: toLines(b.text) };
  return FILE_CACHE[file];
}

/** 切回「改动」视图时，用已缓存的分析结果替换回占位骨架 */
function restoreDiffCards(body, file) {
  Array.prototype.forEach.call(body.querySelectorAll("[data-slot]"), function (slot) {
    var key = slot.dataset.slot || "";
    var i = key.lastIndexOf(":");
    var idx = Number(key.slice(i + 1));
    var a = state.analysis[key];
    if (a && !isNaN(idx)) slot.outerHTML = cardHTML(a.analysis, a.key, file, idx, a.cached);
  });
}

var VIEW_MODE = "diff"; // diff | file —— 全局，所有文件一起切

function setViewSegUI() {
  var seg = $("#viewSeg");
  if (!seg) return;
  Array.prototype.forEach.call(seg.querySelectorAll("button"), function (b) {
    b.classList.toggle("is-on", b.dataset.mode === VIEW_MODE);
  });
}

async function setFileMode(block, mode) {
  var file = block.dataset.file;
  if (block.dataset.mode === mode) return;
  block.dataset.mode = mode;
  var body = block.querySelector(".file-body");
  if (mode === "diff") {
    body.classList.remove("is-cmp");
    body.innerHTML = block._diffHTML;
    restoreDiffCards(body, file);
    return;
  }
  body.classList.add("is-cmp");
  body.innerHTML = "<div class=\"empty-hint\" style=\"padding:18px\">正在读取两个版本的完整文件…</div>";
  try {
    var data = await loadWholeFile(file);
    body.innerHTML = buildCompareHTML(file, data);
  } catch (e) {
    // 读取失败就退回「改动」视图，保证 AI 结论照常展示
    block.dataset.mode = "diff";
    body.classList.remove("is-cmp");
    body.innerHTML = block._diffHTML;
    restoreDiffCards(body, file);
  }
}

/** 全局切换：一次把所有文件切到「改动」或「整文件」 */
async function applyViewMode(mode) {
  VIEW_MODE = mode === "file" ? "file" : "diff";
  try { localStorage.setItem("hunklens.viewMode", VIEW_MODE); } catch (e) {}
  setViewSegUI();
  var blocks = Array.prototype.slice.call(document.querySelectorAll(".file-block"));
  await Promise.all(blocks.map(function (b) { return setFileMode(b, VIEW_MODE); }));
  buildJumpIndex();
  syncRailActive();
}

document.addEventListener("click", function (e) {
  var viewBtn = e.target.closest ? e.target.closest("#viewSeg button") : null;
  if (viewBtn) { applyViewMode(viewBtn.dataset.mode); return; }
  var more = e.target.closest ? e.target.closest("[data-more]") : null;
  if (more) {
    var mfile = more.dataset.file;
    var mblock = document.getElementById("f-" + mfile);
    var mdata = FILE_CACHE[mfile];
    if (mblock && mdata) {
      mdata.limit = (mdata.limit || CMP_PAGE) + CMP_PAGE;
      mblock.querySelector(".file-body").innerHTML = buildCompareHTML(mfile, mdata);
      buildJumpIndex();
    }
    return;
  }
});

/* ---------------- 快速跳转：改动导航 ---------------- */
var JUMP = [], jumpIdx = 0, jumpSpy = null;

function jumpHeadText(h) {
  var el = h.querySelector(".hunk-head span");
  if (el) return el.textContent;
  var arr = HUNKS[h.dataset.hfile] || [];
  var m = arr[Number(h.dataset.hidx)];
  return (m && m.header) || ("改动 " + (Number(h.dataset.hidx) + 1));
}

function jumpMenuHTML() {
  var html = "", last = null;
  JUMP.forEach(function (h, i) {
    var file = h.dataset.hfile || "";
    if (file !== last) { html += "<div class=\"jm-file\">" + esc(file) + "</div>"; last = file; }
    var sev = sevOfSlot(file, h.dataset.hidx);
    html += "<button type=\"button\" class=\"jm-item" + (i === jumpIdx ? " is-on" : "") + "\" data-jump=\"" + i + "\">"
      + "<span class=\"jm-dot " + sev + "\"></span>"
      + "<span class=\"jm-head\">" + esc(jumpHeadText(h)) + "</span></button>";
  });
  return html;
}

function updateJumpCount() {
  var n = JUMP.length;
  $("#jumpCount").textContent = (n ? Math.min(n, jumpIdx + 1) : 0) + " / " + n;
}

function markJumpMenu() {
  var menu = $("#jumpMenu");
  if (!menu || menu.hidden) return;
  Array.prototype.forEach.call(menu.querySelectorAll("[data-jump]"), function (b) {
    b.classList.toggle("is-on", Number(b.dataset.jump) === jumpIdx);
  });
}

function buildJumpIndex() {
  JUMP = Array.prototype.slice.call(document.querySelectorAll(VIEW_MODE === "file" ? ".file-block .cmp-ai" : ".file-block .hunk:not(.is-ctx)"));
  if (jumpIdx >= JUMP.length) jumpIdx = Math.max(0, JUMP.length - 1);
  var bar = $("#jumpBar");
  bar.hidden = !JUMP.length;
  if (!JUMP.length) { $("#jumpMenu").hidden = true; return; }
  updateJumpCount();
  if (jumpSpy) jumpSpy.disconnect();
  jumpSpy = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      var i = JUMP.indexOf(en.target);
      if (i >= 0 && i !== jumpIdx) { jumpIdx = i; updateJumpCount(); markJumpMenu(); }
    });
  }, { root: $("#diffArea"), rootMargin: "-46% 0px -46% 0px", threshold: 0 });
  JUMP.forEach(function (h) { jumpSpy.observe(h); });
}

function jumpTo(i, opts) {
  if (!JUMP.length) return;
  jumpIdx = Math.max(0, Math.min(JUMP.length - 1, i));
  var el = JUMP[jumpIdx];
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("is-flash");
    setTimeout(function () { el.classList.remove("is-flash"); }, 1300);
  }
  updateJumpCount();
  markJumpMenu();
  if (opts && opts.close) $("#jumpMenu").hidden = true;
}

$("#jumpPrev").addEventListener("click", function () { jumpTo(jumpIdx - 1); });
$("#jumpNext").addEventListener("click", function () { jumpTo(jumpIdx + 1); });
$("#jumpCount").addEventListener("click", function () {
  var menu = $("#jumpMenu");
  if (!menu.hidden) { menu.hidden = true; return; }
  menu.innerHTML = jumpMenuHTML();
  menu.hidden = false;
});
document.addEventListener("click", function (e) {
  var item = e.target.closest ? e.target.closest("[data-jump]") : null;
  if (item) { jumpTo(Number(item.dataset.jump), { close: true }); return; }
  var menu = $("#jumpMenu");
  if (menu && !menu.hidden && !(e.target.closest && (e.target.closest("#jumpMenu") || e.target.closest(".jump-bar")))) menu.hidden = true;
});
document.addEventListener("keydown", function (e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  var t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (document.querySelector(".combo.is-open")) return;
  var k = e.key.toLowerCase();
  if (k === "n" || k === "]") { e.preventDefault(); jumpTo(jumpIdx + 1); }
  else if (k === "p" || k === "[") { e.preventDefault(); jumpTo(jumpIdx - 1); }
});

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
      state.analysis[d.file + ":" + d.hunkIndex] = { analysis: d.analysis, key: d.key, cached: d.cached };
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
  var conf = a.confidence ? Math.round(a.confidence * 100) : 0;
  var html = "<div class=\"ai-card sev-" + sev.cls + "\" data-key=\"" + esc(key) + "\" data-slot=\"" + esc(String(file || "") + ":" + hunkIndex) + "\">"
    + "<div class=\"ai-head\">"
    + "<span class=\"ai-avatar\">✦</span>"
    + "<span class=\"ai-title\"><span class=\"ai-name\">AI 审阅</span>"
    + "<span class=\"pill " + sev.cls + "\">" + sev.pill + "</span></span>"
    + "<span class=\"ai-meta\">"
    + (conf ? "<span class=\"conf-bar\"><i style=\"width:" + Math.max(10, Math.min(100, conf)) + "%\"></i></span><span>" + conf + "%</span>" : "")
    + (cached ? "<span>· 缓存</span>" : "")
    + "</span></div>";
  if (a.intent) html += "<p class=\"ai-intent\">" + esc(a.intent) + "</p>";
  if (issues.length) {
    html += "<ul class=\"ai-issues\">";
    issues.forEach(function (it) { html += "<li>" + esc(it.desc) + "</li>"; });
    html += "</ul>";
  }
  if (a.suggestion && a.suggestion !== "-") html += "<div class=\"ai-suggest\"><span class=\"sug-label\">建议</span>" + esc(a.suggestion) + "</div>";
  html += "<div class=\"ai-actions\">"
    + "<button class=\"mini-btn" + (marked === "需修改" ? " is-on" : "") + "\" data-act=\"fix\" data-key=\"" + esc(key) + "\">需修改</button>"
    + "<button class=\"mini-btn" + (marked === "忽略" ? " is-on" : "") + "\" data-act=\"ignore\" data-key=\"" + esc(key) + "\">忽略</button>"
    + "<button class=\"mini-btn ask\" data-act=\"ask\" data-file=\"" + esc(file) + "\" data-idx=\"" + hunkIndex + "\">追问 →</button>"
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
var railActive = "";
function setRailActive(file) {
  if (file === railActive) return;
  railActive = file;
  Array.prototype.forEach.call(document.querySelectorAll(".file-item"), function (el) {
    el.classList.toggle("is-active", el.dataset.file === file);
  });
}
function syncRailActive() {
  var blocks = $("#diffArea").querySelectorAll(".file-block");
  if (!blocks.length) return;
  var ref = $("#diffArea").getBoundingClientRect().top + 60;
  var cur = blocks[0].dataset.file;
  for (var i = 0; i < blocks.length; i++) {
    if (blocks[i].getBoundingClientRect().top <= ref) cur = blocks[i].dataset.file;
    else break;
  }
  setRailActive(cur);
}
var railRaf = 0;
$("#diffArea").addEventListener("scroll", function () {
  if (railRaf) return;
  railRaf = requestAnimationFrame(function () { railRaf = 0; syncRailActive(); });
}, { passive: true });

boot();
