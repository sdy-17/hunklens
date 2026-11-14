import { createHash } from "node:crypto";
import { rawDiff, fileAt } from "./git.js";
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
const PROMPT_VERSION = "v3-context-concise";

export function hunkKey(repo, base, compare, file, hunkHeader, hunkLines) {
  return createHash("sha1")
    .update([PROMPT_VERSION, repo, base, compare, file, hunkHeader, hunkLines.join("\n")].join("|"))
    .digest("hex");
}

/** 取 hunk 在目标版本文件中的周边代码（带行号），给 AI 提供理解背景 */
export function hunkContextText(fileLines, newStart, newCount, pad = 30) {
  if (!fileLines || !fileLines.length || !newStart) return "";
  const from = Math.max(1, newStart - pad);
  const to = Math.min(fileLines.length, newStart + Math.max(newCount || 1, 1) + pad);
  const out = [];
  for (let i = from; i <= to; i++) out.push(i + "| " + (fileLines[i - 1] ?? ""));
  return out.join("\n");
}

/** 收集一次分支对比中的全部待分析 hunk */
export async function collectHunks(repo, base, compare, files) {
  const out = [];
  for (const f of files.filter((x) => shouldAnalyze(x.file))) {
    try {
      const text = await rawDiff(repo, base, compare, f.file);
      let fileLines = null;
      try {
        const full = await fileAt(repo, compare, f.file); // 文件在对比分支上的完整内容
        fileLines = String(full || "").split("\n");
      } catch { /* 新增/删除文件或二进制：没有上下文可用 */ }
      for (const parsed of parseUnifiedDiff(text)) {
        parsed.hunks.forEach((h, i) => {
          const m = h.header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
          out.push({
            file: f.file,
            hunkIndex: i,
            header: h.header,
            lines: h.lines,
            stat: "+" + f.insertions + " -" + f.deletions,
            codeContext: m ? hunkContextText(fileLines, +m[3], m[4] ? +m[4] : 1) : "",
            key: hunkKey(repo, base, compare, f.file, h.header, h.lines),
          });
        });
      }
    } catch { /* 单文件失败不阻塞整体 */ }
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
