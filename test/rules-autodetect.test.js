import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadRules } from "../src/server/rules.js";

test("自动检测：.agent 下任意深度的 SKILL.md 和 .md 都能找到", () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "hl-ad-"));
  // 布局A：.agent/<skill>/SKILL.md（无 skills 中间层）
  const a = path.join(p, ".agent", "commit-style");
  fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(a, "SKILL.md"), "---\nname: commit-style\n---\n提交信息用中文。");
  // 布局B：.agent/rules/frontend/js.md（深层散文件）
  const b = path.join(p, ".agent", "rules", "frontend");
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(b, "js.md"), "禁止 var。");
  // 干扰项：node_modules 与隐藏目录不扫
  const n = path.join(p, ".agent", "node_modules", "x");
  fs.mkdirSync(n, { recursive: true });
  fs.writeFileSync(path.join(n, "SKILL.md"), "不该被找到");
  const skills = loadRules(p, { globalDirs: [] });
  const names = skills.map((s) => s.name);
  assert.ok(names.includes("commit-style"), "SKILL.md 布局");
  assert.ok(names.includes("js"), "深层散 md");
  assert.ok(!skills.some((s) => s.body.includes("不该被找到")), "忽略 node_modules");
  fs.rmSync(p, { recursive: true, force: true });
});
