import fs from "node:fs";
import path from "node:path";

/** hunk 分析结果磁盘缓存（按 hunkKey），重启不丢 */
export class AnalysisCache {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.mem = new Map();
    // 启动时加载已有缓存
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try { this.mem.set(f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); } catch {}
    }
  }
  get(key) { return this.mem.get(key) ?? null; }
  set(key, value) {
    this.mem.set(key, value);
    try { fs.writeFileSync(path.join(this.dir, key + ".json"), JSON.stringify(value)); } catch {}
  }
  size() { return this.mem.size; }
}
