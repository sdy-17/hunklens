import { createHash } from "node:crypto";
import { rawDiff, fileAt, logRange } from "./git.js";
import { parseUnifiedDiff } from "./diffparse.js";

/** 不进入 AI 分析的文件（照搬 PR-Agent/CodeRabbit 的通用排除规则） */
const SKIP = [
  /package-lock\.json$/, /yarn\.lock$/, /pnpm-lock\.yaml$/, /composer\.lock$/, /Cargo\.lock$/,
  /\.min\.(js|css)$/, /(^|\/)dist\//, /(^|\/)build\//, /(^|\/)vendor\//, /(^|\/)\.npmcache\//,
  /\.(png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|mp4|mov|pdf|zip|gz)$/i,
];

export function shouldAnalyze(file) {
  return !SKIP.some((p) => p.test(file));
}

/** prompt/上下文版本：变更后旧缓存自动失效 */
const PROMPT_VERSION = "v4-whole-change";

/** 这样大小的文件直接整份给模型，比截窗口更准 */
const SMALL_FILE_LINES = 300;
/** 大文件：改动前后各留多少行 */
const CONTEXT_PAD = 60;
/** 大文件：文件头（imports / 常量 / 导出）留多少行 */
const HEAD_LINES = 24;

export function hunkKey(repo, base, compare, file, hunkHeader, hunkLines) {
  return createHash("sha1")
    .update([PROMPT_VERSION, repo, base, compare, file, hunkHeader, hunkLines.join("\n")].join("|"))
    .digest("hex");
}

function numbered(fileLines, from, to) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(i + "| " + (fileLines[i - 1] ?? ""));
  return out.join("\n");
}

/** 取 hunk 在目标版本文件中的周边代码（带行号），给 AI 提供理解背景 */
export function hunkContextText(fileLines, newStart, newCount, pad = 30) {
  if (!fileLines || !fileLines.length || !newStart) return "";
  const from = Math.max(1, newStart - pad);
  const to = Math.min(fileLines.length, newStart + Math.max(newCount || 1, 1) + pad);
  return numbered(fileLines, from, to);
}

/**
 * 给模型看的「上下代码」：小文件整份给，大文件给 文件头 + 改动窗口 ±60 行 + 文件尾。
 * 逐 hunk 单独看 diff 容易误判（例如改的是调用方，被调用的定义在别处），所以把整份给出去。
 */
export function contextForHunk(fileLines, newStart, newCount) {
  if (!fileLines || !fileLines.length || !newStart) return "";
  const total = fileLines.length;
  if (total <= SMALL_FILE_LINES) {
    return "（整份文件，共 " + total + " 行）\n" + numbered(fileLines, 1, total);
  }
  const from = Math.max(1, newStart - CONTEXT_PAD);
  const to = Math.min(total, newStart + Math.max(newCount || 1, 1) + CONTEXT_PAD);
  const parts = [];
  if (from > 1) {
    parts.push(numbered(fileLines, 1, Math.min(HEAD_LINES, from - 1)));
    if (from - 1 > HEAD_LINES) parts.push("…（上面略去 " + (from - 1 - HEAD_LINES) + " 行）");
  }
  parts.push(numbered(fileLines, from, to));
  if (to < total) {
    parts.push("…（下面略去 " + (total - to) + " 行）");
    parts.push(numbered(fileLines, total - Math.min(HEAD_LINES, total - to) + 1, total));
  }
  return "（文件共 " + total + " 行，下面是完整文件头 + 改动窗口 + 文件尾）\n" + parts.join("\n");
}

/** 同一文件里其它 hunk 的改动行（让模型知道这个文件整体被改了什么） */
export function siblingHunksText(hunks, currentIndex, maxLines = 60) {
  if (!Array.isArray(hunks) || hunks.length < 2) return "";
  const rows = [];
  hunks.forEach((h, i) => {
    if (i === currentIndex) return;
    rows.push(h.header);
    let n = 0;
    for (const line of h.lines) {
      if (!/^[+-]/.test(line)) continue;
      if (n >= 8) { rows.push("…（该处改动还有更多行）"); break; }
      rows.push(line);
      n++;
    }
  });
  const capped = rows.length > maxLines ? rows.slice(0, maxLines).concat(["…（更多改动已略去）"]) : rows;
  return capped.join("\n");
}

/**
 * 本次分支变更的全貌：涉及哪些文件、各改了什么位置、有哪些提交。
 * 逐 hunk 分析时也带上它，模型才能判断「这个改动是否与其它改动配套」。
 */
export function changesetText(entries, commits, maxFiles = 24) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return "";
  const totalHunks = list.reduce((n, e) => n + (e.hunks || []).length, 0);
  const rows = ["本次分支变更涉及 " + list.length + " 个文件 / " + totalHunks + " 处改动："];
  list.slice(0, maxFiles).forEach((e) => {
    const hunks = (e.hunks || []).map((h) => h.header).join("，");
    rows.push("- " + e.file + "（" + (e.stat || "") + "）" + (hunks ? "：" + hunks : ""));
  });
  if (list.length > maxFiles) rows.push("…还有 " + (list.length - maxFiles) + " 个文件未列出");
  if (commits && commits.length) {
    rows.push("", "相关提交：");
    commits.slice(0, 8).forEach((c) => rows.push("- " + c));
  }
  return rows.join("\n");
}

/** 收集一次分支对比中的全部待分析 hunk */
export async function collectHunks(repo, base, compare, files) {
  const analyzable = files.filter((x) => shouldAnalyze(x.file));
  const entries = [];
  for (const f of analyzable) {
    try {
      const text = await rawDiff(repo, base, compare, f.file);
      let fileLines = null;
      try {
        const full = await fileAt(repo, compare, f.file); // 文件在对比分支上的完整内容
        fileLines = String(full || "").split("\n");
      } catch { /* 新增/删除文件或二进制：没有上下文可用 */ }
      const hunks = parseUnifiedDiff(text).flatMap((p) => p.hunks);
      if (hunks.length) entries.push({ file: f, fileLines, hunks });
    } catch { /* 单文件失败不阻塞整体 */ }
  }

  let commits = [];
  try { commits = await logRange(repo, base, compare); } catch { /* 取不到提交列表不影响分析 */ }
  const changeset = changesetText(
    entries.map((e) => ({
      file: e.file.file,
      stat: "+" + e.file.insertions + " -" + e.file.deletions,
      hunks: e.hunks.map((h) => h.header),
    })),
    commits,
  );

  const out = [];
  for (const entry of entries) {
    entry.hunks.forEach((h, i) => {
      const m = h.header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      const siblings = siblingHunksText(entry.hunks, i);
      out.push({
        file: entry.file.file,
        hunkIndex: i,
        header: h.header,
        lines: h.lines,
        stat: "+" + entry.file.insertions + " -" + entry.file.deletions,
        codeContext: m ? contextForHunk(entry.fileLines, +m[3], m[4] ? +m[4] : 1) : "",
        siblings,
        changeset,
        key: hunkKey(repo, base, compare, entry.file.file, h.header, h.lines),
      });
    });
  }
  return out;
}

/** 有界并发执行 */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
  return results;
}
