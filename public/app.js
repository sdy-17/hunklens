const $ = (s) => document.querySelector(s);
let mode = "split";
let state = { repo: "", base: "", compare: "" };

async function loadRepos() {
  const repos = await (await fetch("/api/repos")).json();
  $("#repoSel").innerHTML = repos.map((r) => `<option value="${r.path}">${r.name}</option>`).join("");
  if (repos[0]) { state.repo = repos[0].path; await loadBranches(repos[0].path); }
}

$("#repoSel").addEventListener("change", (e) => { state.repo = e.target.value; loadBranches(e.target.value); });

async function loadBranches(repo) {
  const b = await (await fetch("/api/branches?repo=" + encodeURIComponent(repo))).json();
  const opts = b.locals.map((x) => `<option ${x === b.current ? "selected" : ""}>${x}</option>`).join("");
  $("#baseSel").innerHTML = opts;
  $("#compareSel").innerHTML = opts;
  state.base = b.current; state.compare = b.current;
}

$("#fetchBtn").addEventListener("click", async () => {
  $("#fetchBtn").textContent = "拉取中…";
  await fetch("/api/fetch", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo: state.repo, pull: true }) });
  $("#fetchBtn").textContent = "拉取远程";
  loadBranches(state.repo);
});

$("#diffBtn").addEventListener("click", async () => {
  state.base = $("#baseSel").value; state.compare = $("#compareSel").value;
  const q = "repo=" + encodeURIComponent(state.repo) + "&base=" + encodeURIComponent(state.base) + "&compare=" + encodeURIComponent(state.compare);
  const d = await (await fetch("/api/diff?" + q)).json();
  $("#fileTree").innerHTML = (d.files || []).map((f) =>
    `<div class="file" data-f="${f.file}">${f.file} <small>+${f.insertions} −${f.deletions}</small></div>`).join("");
  $("#fileTree").querySelectorAll(".file").forEach((el) => el.addEventListener("click", () => loadFile(el.dataset.f)));
});

document.querySelectorAll("#mode button").forEach((b) => b.addEventListener("click", () => {
  mode = b.dataset.mode;
  document.querySelectorAll("#mode button").forEach((x) => x.classList.toggle("active", x === b));
}));

async function loadFile(file) {
  const q = "repo=" + encodeURIComponent(state.repo) + "&base=" + encodeURIComponent(state.base)
    + "&compare=" + encodeURIComponent(state.compare) + "&file=" + encodeURIComponent(file);
  const d = await (await fetch("/api/diff/file?" + q)).json();
  const v = $("#diffView");
  v.innerHTML = "";
  for (const f of d.parsed || []) for (const h of f.hunks) {
    const div = document.createElement("div");
    div.className = "hunk";
    div.innerHTML = `<div class="hunk-header">${h.header}</div>` + h.lines.map((l, i) =>
      `<div class="line ${l[0] === "+" ? "line-add" : l[0] === "-" ? "line-del" : ""}">${escapeHtml(l)}`
      + (l[0] === "+" ? `<span class="ai-icon" data-i="${i}">🤖</span>` : "") + "</div>").join("");
    v.appendChild(div);
    div.querySelectorAll(".ai-icon").forEach((ic) =>
      ic.addEventListener("click", (e) => showBubble(div, e.target, file, h)));
  }
}

async function showBubble(hunkDiv, anchor, file, hunk) {
  document.querySelectorAll(".bubble").forEach((b) => b.remove());
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = "AI 分析中…";
  const r = anchor.getBoundingClientRect();
  bubble.style.left = Math.max(8, Math.min(r.left, innerWidth - 540)) + "px";
  bubble.style.top = r.bottom + scrollY + 4 + "px";
  document.body.appendChild(bubble);
  try {
    const res = await fetch("/api/ai/analyze", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file, hunk: hunk.lines.join("\n"), context: hunk.header }) });
    const data = await res.json();
    const a = data.analysis || { severity: "info", intent: "-", issues: [{ desc: data.error || "无结果" }], suggestion: "-" };
    bubble.className = "bubble sev-" + (a.severity || "info");
    bubble.innerHTML = "<b>目的</b> " + esc(a.intent) + "<br><b>问题</b> "
      + ((a.issues || []).map((i) => esc(i.desc)).join("；") || "无") + "<br><b>建议</b> " + esc(a.suggestion || "无");
  } catch (e) { bubble.textContent = "分析失败: " + e; }
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const esc = (s) => String(s ?? "").replace(/</g, "&lt;");
loadRepos();
