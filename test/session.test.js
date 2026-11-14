import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionStore, sessionContext } from "../src/server/session.js";

test("会话保存/读取与需求上下文注入", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-s-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hl-r-"));
  fs.writeFileSync(path.join(repo, "prd.md"), "需求：支持导出 CSV。");
  const s = new SessionStore(dir);
  s.save(repo, "main", "feat", { requirements: "本次要加导出功能", files: ["prd.md", "../escape.md"] });
  const ctx = sessionContext(s, repo, "main", "feat");
  assert.ok(ctx.includes("本次要加导出功能"));
  assert.ok(ctx.includes("支持导出 CSV"));
  assert.ok(!ctx.includes("escape"), "路径逃逸文件被忽略");
  // 空会话无上下文
  assert.equal(sessionContext(s, repo, "main", "other"), "");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});
