import { createHash } from "node:crypto";
import { rawDiff } from "./git.js";
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

export function hunkKey(repo, base, compare, file, hunkHeader, hunkLines) {
  return createHash("sha1").update([repo, base, compare, file, hunkHeader, hunkLines.join("\n")].join("|")).digest("hex");
}

/** 收集一次分支对比中的全部待分析 hunk */
export async function collectHunks(repo, base, compare, files) {
  const out = [];
  for (const f of files.filter((x) => shouldAnalyze(x.file))) {
    try {
      const text = await rawDiff(repo, base, compare, f.file);
      for (const parsed of parseUnifiedDiff(text)) {
        parsed.hunks.forEach((h, i) => out.push({
          file: f.file,
          hunkIndex: i,
          header: h.header,
          lines: h.lines,
          key: hunkKey(repo, base, compare, f.file, h.header, h.lines),
        }));
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
