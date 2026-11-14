const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const SEV = { blocker: ["🔴 blocker", "sev-blocker"], warning: ["🟡 warning", "sev-warning"], info: ["🟢 info", "sev-info"] };
let review = { files: {}, hunks: {} };

// ---------- 初始化 ----------
async function loadRepos() {
  const repos = await (await fetch("/api/repos")).json();
  $("#repoSel").innerHTML = repos.map((r) => `<option value="${esc(r.path)}">${esc(r.name)}</option>`).join("");
  if (repos[0]) { $("#repoSel").value = repos[0].path; await loadBranches(); }
}
$("#repoSel").addEventListener("change", loadBranches);

async function loadBranches() {
  const repo = $("#repoSel").value;
  const b = await (await fetch("/api/branches?repo=" + encodeURIComponent(repo))).json();
  const opts = b.locals.map((x) => `<option ${x === b.current ? "selected" : ""}>${esc(x)}</option>`).join("");
  $("#baseSel").innerHTML = opts; $("#compareSel").innerHTML = opts;
  if (b.current) $("#baseSel").value = b.current;
  const other = b.locals.find((x) => x !== $("#baseSel").value);
  if (other) $("#compareSel").value = other;
  review = await (await fetch("/api/review?repo=" + encodeURIComponent(repo)
    + "&base=" + encodeURIComponent($("#baseSel").value)
    + "&compare=" + encodeURIComponent($("#compareSel").value))).json();
  await loadSession();
  await loadRulesBadge();
}

async function loadRulesBadge() {
  const d = await (await fetch("/api/rules?repo=" + encodeURIComponent($("#repoSel").value))).json();
  $("#rulesBadge").textContent = d.count ? "📋 团队规范 ×" + d.count : "";
  $("#rulesBadge").title = (d.skills || []).map((s) => s.name + (s.description ? "：" + s.description : "")).join("\n");
}

// ---------- 需求文档 ----------
async function loadSession() {
  const q = new URLSearchParams({ repo: $("#repoSel").value, base: $("#baseSel").value, compare: $("#compareSel").value });
  const s = await (await fetch("/api/session?" + q)).json();
  $("#reqText").value = s.requirements || "";
  $("#reqFiles").value = (s.files || []).join(", ");
  reqMark(s);
}
function reqMark(s) {
  const has = (s.requirements || "").trim() || (s.files || []).length;
  $("#reqMark").textContent = has ? "✓ 已挂载" : "";
}
$("#reqSave").addEventListener("click", async () => {
  const q = new URLSearchParams({ repo: $("#repoSel").value, base: $("#baseSel").value, compare: $("#compareSel").value });
  const files = $("#reqFiles").value.split(",").map((x) => x.trim()).filter(Boolean);
  const s = await (await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo: $("#repoSel").value, base: $("#baseSel").value, compare: $("#compareSel").value,
      requirements: $("#reqText").value, files }) })).json();
  reqMark(s);
  chatPush("ai", "需求文档已更新，重新点「开始 Review」后 AI 将对照需求分析。");
});

// ---------- 一键 Review ----------
$("#startBtn").addEventListener("click", startReview);

async function startReview() {
  const btn = $("#startBtn");
  btn.disabled = true;
  const area = $("#diffArea");
  area.innerHTML = "";
  $("#chips").innerHTML = "";
  const repo = $("#repoSel").value, base = $("#baseSel").value, compare = $("#compareSel").value;
  const q = new URLSearchParams({ repo, base, compare });
  try {
    const { files } = await (await fetch("/api/diff?" + q)).json();
    renderFileList(files);
    const containers = {};
    for (const f of files) {
      const d = await (await fetch("/api/diff/file?" + q + "&file=" + encodeURIComponent(f.file))).json();
      Object.assign(containers, renderFile(f.file, f.insertions, f.deletions, d.parsed));
    }
    await analyzeStream(q, containers);
  } catch (e) { area.innerHTML = '<div class="placeholder">出错：' + esc(String(e)) + "</div>"; }
  btn.disabled = false;
}

function renderFileList(files) {
  $("#chips").innerHTML = files.map((f) =>
    '<a href="#f-' + esc(f.file) + '">' + esc(f.file) + ' <span class="ins">+' + f.insertions + '</span> <span class="del">-' + f.deletions + "</span></a>").join("");
}

function renderFile(file, ins, del, parsed) {
  const block = document.createElement("div");
  block.className = "file-block";
  block.id = "f-" + file;
  block.innerHTML = '<div class="file-head">📄 ' + esc(file)
    + ' <span class="stat"><span class="ins">+' + ins + '</span> <span class="del">-' + del + '</span></span></div>';
  const containers = {};
  for (const pf of parsed) for (let hi = 0; hi < pf.hunks.length; hi++) {
    const h = pf.hunks[hi];
    const div = document.createElement("div");
    div.className = "hunk";
    const lines = h.lines.map((l) => {
      const cls = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "ctx";
      const sign = l.startsWith("+") ? "+" : l.startsWith("-") ? "-" : " ";
      return '<div class="dline ' + cls + '"><span class="sign">' + sign + "</span>" + esc(l.slice(1)) + "</div>";
    }).join("");
    div.innerHTML = '<div class="hunk-lines"><div class="hunk-header">' + esc(h.header) + "</div>" + lines + "</div>"
      + '<div class="bubble pending">⏳ AI 分析中…</div>';
    block.appendChild(div);
    containers[file + ":" + hi] = div.querySelector(".bubble");
  }
  $("#diffArea").appendChild(block);
  return containers;
}

function analyzeStream(q, containers) {
  return new Promise((resolve) => {
    const es = new EventSource("/api/analyze/stream?" + q);
    let done = 0;
    const prog = $("#progress");
    es.addEventListener("start", (e) => {
      const d = JSON.parse(e.data);
      prog.textContent = "AI 分析 0/" + d.total + "（缓存 " + d.cached + "）";
    });
    es.addEventListener("hunk", (e) => {
      const d = JSON.parse(e.data);
      const el = containers[d.file + ":" + d.hunkIndex];
      if (el) el.outerHTML = bubbleHTML(d.analysis, d.key, d.file, d.hunkIndex, d.cached);
      done++;
      prog.textContent = "AI 分析 " + done;
    });
    es.addEventListener("done", (e) => {
      const d = JSON.parse(e.data);
      prog.textContent = d.failed ? "完成，" + d.failed + " 个失败" : "✅ 分析完成";
      es.close(); resolve();
    });
    es.addEventListener("error", () => { prog.textContent = ""; es.close(); resolve(); });
  });
}

function bubbleHTML(a, key, file, hunkIndex, cached) {
  const sev = SEV[a.severity] || SEV.info;
  const m = (review.hunks || {})[key];
  const issues = (a.issues || []).map((i) => "<li>" + esc(i.desc) + "</li>").join("");
  return '<div class="bubble ' + sev[1] + '" data-key="' + esc(key) + '">'
    + '<span class="sev">' + sev[0] + "</span>" + (cached ? ' <span style="color:var(--muted);font-size:11px">缓存</span>' : "")
    + '<div class="intent">' + esc(a.intent) + "</div>"
    + (issues ? "<ul>" + issues + "</ul>" : "")
    + (a.suggestion ? '<div class="sugg">💡 ' + esc(a.suggestion) + "</div>" : "")
    + '<div class="acts">'
    + '<button class="small" onclick="mark(\'' + esc(key) + '\',1,this)">' + (m === "需修改" ? '<span class="mark fix">需修改 ✓</span>' : "需修改") + "</button>"
    + '<button class="small" onclick="mark(\'' + esc(key) + '\',0,this)">' + (m === "忽略" ? '<span class="mark ignore">忽略 ✓</span>' : "忽略") + "</button>"
    + '<button class="small" onclick="askAbout(\'' + file.replace(/'/g, "") + "\''," + hunkIndex + ')">问 AI</button>'
    + "</div></div>";
}

window.mark = async (key, fix, btn) => {
  review.hunks = review.hunks || {};
  review.hunks[key] = fix ? "需修改" : "忽略";
  await fetch("/api/review", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo: $("#repoSel").value, base: $("#baseSel").value, compare: $("#compareSel").value, data: review }) });
  const acts = btn.parentElement;
  acts.children[0].innerHTML = review.hunks[key] === "需修改" ? '<span class="mark fix">需修改 ✓</span>' : "需修改";
  acts.children[1].innerHTML = review.hunks[key] === "忽略" ? '<span class="mark ignore">忽略 ✓</span>' : "忽略";
};

// ---------- 问 AI ----------
window.askAbout = (file, hunkIndex) => {
  const input = $("#chatInput");
  input.dataset.file = file;
  input.dataset.hunkIndex = hunkIndex;
  input.placeholder = "关于 " + file + " 第 " + (hunkIndex + 1) + " 块的追问…";
  input.focus();
};

$("#chatSend").addEventListener("click", sendChat);
$("#chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

async function sendChat() {
  const input = $("#chatInput");
  const question = input.value.trim();
  if (!question) return;
  chatPush("user", question);
  input.value = "";
  const loading = chatPush("ai", "思考中…");
  const file = input.dataset.file || "";
  const hi = input.dataset.hunkIndex;
  try {
    const r = await (await fetch("/api/ai/followup", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: $("#repoSel").value, base: $("#baseSel").value, compare: $("#compareSel").value,
        file, hunk: file ? "diff " + file + " 第 " + (+hi + 1) + " 块" : "", prior: "", question }) })).json();
    loading.textContent = r.answer || r.error || "（无回复）";
  } catch (e) { loading.textContent = "请求失败：" + e; }
  input.dataset.file = ""; input.dataset.hunkIndex = "";
  input.placeholder = "针对本次变更提问…";
}

function chatPush(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text;
  $("#chatMsgs").appendChild(div);
  $("#chatMsgs").scrollTop = $("#chatMsgs").scrollHeight;
  return div;
}

// ---------- 导出 ----------
$("#exportBtn").addEventListener("click", () => {
  const q = new URLSearchParams({ repo: $("#repoSel").value, base: $("#baseSel").value, compare: $("#compareSel").value });
  window.open("/api/export?" + q);
});

loadRepos();
