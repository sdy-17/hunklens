import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

/**
 * 本地仓库工具：让模型自己去查「这处改动牵动的其它业务代码」。
 * 做法基于 git grep（只扫已跟踪文件，天然绕开 node_modules / 构建产物），
 * 再加一层 relatedContext：从改动里的符号出发，把定义处和调用处的代码片段拼给模型。
 */

const SKIP = [/node_modules\//, /^dist\//, /^build\//, /^out\//, /\.git\//, /^vendor\//,
  // 各种本地缓存/编辑器目录：即使被误提交进仓库，也不该进上下文
  /(^|\/)(\.npmcache|\.npmlogs|\.cache|\.next|\.nuxt|\.turbo|\.parcel-cache|\.venv|\.idea|\.vscode|\.yarn|\.pnpm-store|coverage|tmp)\//,
  /package-lock\.json$/, /yarn\.lock$/, /pnpm-lock\.yaml$/, /\.min\.(js|css)$/, /\.map$/,
  /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|mp4|pdf|zip)$/i, /^\.cache\//];

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]{3,}/g;
const STOP = new Set([
  "const", "return", "function", "import", "export", "default", "async", "await", "throw", "catch",
  "string", "number", "boolean", "object", "array", "record", "unknown", "any", "void", "null",
  "undefined", "true", "false", "this", "self", "window", "document", "console", "JSON", "Object",
  "Array", "String", "Number", "Promise", "Math", "Date", "require", "module", "exports", "process",
  "push", "slice", "split", "join", "map", "filter", "reduce", "forEach", "length", "value", "values",
  "data", "item", "items", "index", "result", "results", "error", "errors", "message", "msg",
  "text", "line", "lines", "file", "files", "path", "paths", "name", "names", "type", "types",
  "props", "state", "event", "target", "then", "finally", "resolve", "reject", "callback", "params",
  "options", "config", "content", "response", "request", "status", "server", "client", "query",
  "should", "would", "could", "which", "there", "these", "those", "when", "with", "from", "into",
  "have", "does", "will", "your", "their", "about", "after", "before", "because", "while",
]);

function skipped(file) {
  return SKIP.some((re) => re.test(file));
}

function git(repo, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: repo, maxBuffer: 8 * 1024 * 1024, timeout }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || "") });
    });
  });
}

function parseGrep(out) {
  const rows = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    const file = m[1].replace(/^\.\//, "");
    if (skipped(file)) continue;
    rows.push({ file, line: Number(m[2]), text: m[3] });
  }
  return rows;
}

export async function searchRepo(repo, { query, include, limit = 15 } = {}) {
  const q = String(query || "").trim();
  if (!q || q.length > 200) return [];
  const args = ["grep", "-n", "-I", "-F", "-w", "-e", q];
  args.push("--", include ? String(include) : ".");
  const { out } = await git(repo, args);
  return parseGrep(out).slice(0, limit);
}


function escapeRe(s) {
  return String(s).replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
}

export async function findDefinition(repo, symbol, limit = 6) {
  const sym = String(symbol || "").trim();
  if (!sym || sym.length > 80) return [];
  const re = new RegExp("(?:function|class|const|let|var|interface|type|enum|def|func)\\s+" + escapeRe(sym) + "\\b");
  const rows = await searchRepo(repo, { query: sym, limit: 60 });
  return rows.filter((r) => re.test(r.text)).slice(0, limit);
}

export function readFileSlice(repo, relPath, { start = 1, lines = 80 } = {}) {
  const root = path.resolve(repo);
  const abs = path.resolve(root, String(relPath || ""));
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("路径不在当前仓库内: " + relPath);
  }
  const raw = fs.readFileSync(abs, "utf8").replace(/\n$/, ""); // 末尾换行不算一行
  const all = raw.split("\n");
  const total = all.length;
  const from = Math.max(1, Number(start) || 1);
  const max = Math.min(240, Math.max(1, Number(lines) || 60));
  const to = Math.min(total, from + max - 1);
  const out = [];
  for (let i = from; i <= to; i++) out.push(String(i).padStart(5, " ") + "| " + all[i - 1]);
  return { text: out.join("\n"), from, to, total };
}

export function identifiersFromHunk(hunkLines, { max = 10 } = {}) {
  const score = new Map();
  for (const line of hunkLines || []) {
    const body = String(line || "").replace(/^[+-]/, " ");
    const hit = body.match(IDENT);
    if (!hit) continue;
    for (const raw of hit) {
      const id = raw.replace(/^\$+/, "");
      if (id.length < 5 || STOP.has(id) || STOP.has(id.toLowerCase())) continue;
      // 打分：被调用 / 大驼峰（类、组件）是业务符号；局部变量声明、作为对象被点访问的多半是噪声
      let s = (score.get(id) || 0) + 1;
      if (line[0] === "+") s += 2;
      if (/^[A-Z]/.test(id)) s += 1;
      if (new RegExp("\\b" + escapeRe(id) + "\\s*\\(").test(body)) s += 3;
      if (new RegExp("(?:const|let|var|function|class)\\s+" + escapeRe(id) + "\\b").test(body)) s -= 2;
      if (new RegExp("\\b" + escapeRe(id) + "\\s*\\.").test(body)) s -= 2;
      score.set(id, s);
    }
  }
  return [...score.entries()]
    .filter((e) => e[1] > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map((e) => e[0]);
}

const IMPORT_RE = /(?:from\s+|require\()\s*["'](\.[^"']+)["']/g;

function resolveImport(dir, spec) {
  const base = path.resolve(dir, spec);
  const tries = [base, base + ".js", base + ".ts", base + ".jsx", base + ".tsx", base + ".mjs", base + ".cjs",
    path.join(base, "index.js"), path.join(base, "index.ts")];
  for (const f of tries) {
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch (e) {
      /* 不存在就继续试下一个后缀 */
    }
  }
  return "";
}

function readExports(absFile) {
  let text = "";
  try {
    text = fs.readFileSync(absFile, "utf8");
  } catch (e) {
    return [];
  }
  const names = [];
  const decl = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = decl.exec(text))) names.push(m[1]);
  const brace = /export\s*\{([^}]*)\}/g;
  while ((m = brace.exec(text))) {
    for (const part of m[1].split(",")) {
      const piece = part.trim();
      if (!piece) continue;
      const as = piece.split(/\s+as\s+/);
      names.push((as[1] || as[0]).trim());
    }
  }
  return [...new Set(names.filter(Boolean))].slice(0, 12);
}

export function importLinks(repo, file, fileLines, { max = 6 } = {}) {
  const root = path.resolve(repo);
  const dir = path.dirname(path.resolve(root, String(file || "")));
  const text = (fileLines || []).join("\n");
  const out = [];
  const seen = new Set();
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(text))) {
    const abs = resolveImport(dir, m[1]);
    if (!abs) continue;
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push({ file: rel, spec: m[1], exports: readExports(abs) });
    if (out.length >= max) break;
  }
  return out;
}

export async function relatedContext(repo, file, hunkLines, opts = {}) {
  const budget = opts.budget || 3200;
  const maxSnippets = opts.maxSnippets || 6;
  const maxSymbols = opts.maxSymbols || 8;
  const symbols = opts.symbols || identifiersFromHunk(hunkLines, { max: maxSymbols });
  const parts = [];
  const files = [];
  const hits = [];
  const used = new Set([String(file)]);
  let size = 0;
  for (const sym of symbols) {
    if (size >= budget * 0.9 || parts.length >= maxSnippets) break;
    const rows = await searchRepo(repo, { query: sym, limit: 6 });
    for (const row of rows) {
      if (used.has(row.file)) continue;
      used.add(row.file);
      hits.push({ symbol: sym, file: row.file, line: row.line });
      let slice = null;
      try {
        slice = readFileSlice(repo, row.file, { start: Math.max(1, row.line - 6), lines: 18 });
      } catch (e) {
        slice = null;
      }
      if (!slice) continue;
      const head = "#### " + row.file + ":" + slice.from + "-" + slice.to + "（提到 " + sym + "）";
      const block = head + "\n" + slice.text;
      if (size + block.length > budget) continue;
      parts.push(block);
      files.push(row.file);
      size += block.length;
      break;
    }
  }
  let imports = [];
  let deps = "";
  if (opts.fileLines && opts.fileLines.length) {
    imports = importLinks(repo, file, opts.fileLines, { max: 6 });
    if (imports.length) {
      deps = "### 本文件依赖的模块（业务上下游线索）\n" + imports
        .map((i) => "- " + i.file + (i.exports.length ? "（导出 " + i.exports.join(", ") + "）" : ""))
        .join("\n");
    }
  }
  const text = parts.length ? parts.join("\n\n") + (deps ? "\n\n" + deps : "") : "";
  return { text, symbols, files, hits, imports };
}

export function localToolSpecs() {
  return [
    {
      type: "function",
      function: {
        name: "search_repo",
        description: "在当前仓库的已跟踪文件里按词搜索一个标识符或字符串（git grep）。用来确认这处改动的调用方、实现处、配置项在哪里。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "要搜索的标识符或字符串，例如函数名、常量名、配置 key" },
            include: { type: "string", description: "可选，限定搜索路径，例如 src/ 或 *.ts" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "读取仓库内某个文件的一段代码（带行号，最多 240 行）。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "仓库内相对路径，例如 src/server/index.js" },
            start: { type: "integer", description: "起始行号，默认 1" },
            lines: { type: "integer", description: "读取行数，默认 60，最多 240" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "find_definition",
        description: "查找某个符号的定义处（函数/类/常量/接口），用来确认这次改动是否改在唯一的定义点上。",
        parameters: {
          type: "object",
          properties: { symbol: { type: "string", description: "符号名" } },
          required: ["symbol"],
        },
      },
    },
  ];
}

export async function runLocalTool(repo, fnName, args = {}) {
  if (fnName === "search_repo") {
    const rows = await searchRepo(repo, { query: args.query, include: args.include, limit: 20 });
    if (!rows.length) return "没有匹配结果";
    return rows.map((r) => r.file + ":" + r.line + ": " + r.text.trim().slice(0, 200)).join("\n");
  }
  if (fnName === "read_file") {
    try {
      const slice = readFileSlice(repo, args.path, { start: args.start, lines: args.lines || 80 });
      return slice.text + "\n…（共 " + slice.total + " 行）";
    } catch (e) {
      return "读取失败: " + e.message;
    }
  }
  if (fnName === "find_definition") {
    const rows = await findDefinition(repo, args.symbol);
    if (!rows.length) return "没有找到定义（可能来自依赖包或动态生成）";
    return rows.map((r) => r.file + ":" + r.line + ": " + r.text.trim().slice(0, 200)).join("\n");
  }
  throw new Error("未知工具: " + fnName);
}
