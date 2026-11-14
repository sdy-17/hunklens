import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadRules, rulesToPromptText } from "../src/server/rules.js";

test("loadRules 读取项目 skill 目录", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hl-"));
  const sd = path.join(dir, ".claude", "skills", "team-js");
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, "SKILL.md"), "---\nname: team-js\ndescription: 团队 JS 规范\n---\n禁止 any；组件用函数式。");
  const skills = loadRules(dir, { perProject: true, globalDirs: [], projectDirs: [".claude/skills"] });
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "team-js");
  assert.ok(skills[0].body.includes("禁止 any"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadRules 读取 globalDirs 且 perProject:false 关闭项目规则", () => {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), "hl-g-"));
  fs.writeFileSync(path.join(g, "common.md"), "# 通用规则\n保持简单。");
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "hl-p-"));
  const sd = path.join(p, "skills", "x");
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, "SKILL.md"), "项目规则");
  const on = loadRules(p, { globalDirs: [g], projectDirs: ["skills"] });
  assert.ok(on.some((s) => s.name === "common"));
  assert.ok(on.some((s) => s.name === "x"));
  const off = loadRules(p, { globalDirs: [g], perProject: false });
  assert.ok(off.some((s) => s.name === "common"));
  assert.ok(!off.some((s) => s.name === "x"));
  fs.rmSync(g, { recursive: true, force: true });
  fs.rmSync(p, { recursive: true, force: true });
});

test("rulesToPromptText 拼接与长度截断", () => {
  const t = rulesToPromptText([{ name: "a", description: "da", body: "规则A" }, { name: "b", body: "规则B" }]);
  assert.ok(t.includes("规则A") && t.includes("规则B") && t.includes("### a"));
  assert.equal(rulesToPromptText([]), "");
  const tiny = rulesToPromptText([{ name: "big", body: "x".repeat(200) }], 100);
  assert.ok(tiny.length < 300);
});
