import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** 审阅会话：一次 (repo, base, compare) 对应一个会话，可挂需求文档/方案。
 *  存储 .cache/sessions/<sha1>.json —— { requirements, files } */
export class SessionStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  #file(repo, base, compare) {
    const key = crypto.createHash("sha1").update([repo, base, compare].join("|")).digest("hex").slice(0, 12);
    return path.join(this.dir, key + ".json");
  }
  load(repo, base, compare) {
    try { return JSON.parse(fs.readFileSync(this.#file(repo, base, compare), "utf8")); }
    catch { return { requirements: "", files: [], attachments: [] }; }
  }
  save(repo, base, compare, data) {
    const file = this.#file(repo, base, compare);
    const prev = this.load(repo, base, compare);
    const next = { ...prev, ...data };
    fs.writeFileSync(file, JSON.stringify(next, null, 2));
    return next;
  }
}

/** 读取会话挂载的需求文档内容：requirements 文本 + files（相对 repo 的路径）内容。
 *  总长限制 maxChars，防止 token 爆炸。 */
export function sessionContext(store, repo, base, compare, maxChars = 6000) {
  const s = store.load(repo, base, compare);
  const parts = [];
  if (s.requirements?.trim()) parts.push("### 需求/方案描述\n" + s.requirements.trim());
  for (const a of s.attachments || []) {
    const text = String(a.content || "").trim();
    if (text) parts.push("### 需求文档：" + a.name + "\n" + text);
  }
  for (const f of s.files || []) {
    try {
      const full = path.join(repo, f);
      // 防路径逃逸：必须在 repo 内
      if (!path.resolve(full).startsWith(path.resolve(repo))) continue;
      const text = fs.readFileSync(full, "utf8").trim();
      if (text) parts.push("### 需求文档：" + f + "\n" + text);
    } catch { /* 文件不存在则跳过 */ }
  }
  if (!parts.length) return "";
  let out = "## 本次变更的需求/方案背景（请对照需求评估改动是否符合意图，指出偏差）\n";
  for (const p of parts) {
    if (out.length + p.length > maxChars) { out += "\n（需求材料过长已截断）"; break; }
    out += "\n" + p + "\n";
  }
  return out;
}
