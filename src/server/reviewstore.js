import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** 审阅状态持久化：每个 (repo, base, compare) 一份 JSON */
export class ReviewStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  #file(repo, base, compare) {
    const h = createHash("sha1").update([repo, base, compare].join("|")).digest("hex").slice(0, 12);
    return path.join(this.dir, h + ".json");
  }
  load(repo, base, compare) {
    const p = this.#file(repo, base, compare);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
    return { files: {}, hunks: {}, note: "" };
  }
  save(repo, base, compare, data) {
    fs.writeFileSync(this.#file(repo, base, compare), JSON.stringify(data, null, 2));
    return data;
  }
}
