import fs from "node:fs";
import path from "node:path";

/** 扫描目录（含子目录，深度 2）下所有 git 仓库，返回 [{ name, path }] */
export function scanRepos(rootDir) {
  const repos = [];
  const visit = (dir, depth) => {
    if (fs.existsSync(path.join(dir, ".git"))) {
      repos.push({ name: path.basename(dir), path: dir });
      return; // 嵌套仓库不深入
    }
    if (depth <= 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) visit(path.join(dir, e.name), depth - 1);
    }
  };
  visit(path.resolve(rootDir), 2);
  return repos;
}
