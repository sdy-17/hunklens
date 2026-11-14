import test from "node:test";
import assert from "node:assert/strict";
import { buildFollowupPrompt } from "../src/server/ai.js";

test("追问 prompt 带上选中代码", () => {
  const p = buildFollowupPrompt({ file: "a.js", hunk: "选中的 2 行代码", question: "为什么要判空?", code: "if (!x) return;" });
  assert.match(p, /文件: a\.js/);
  assert.match(p, /选中的代码:/);
  assert.match(p, /if \(!x\) return;/);
  assert.match(p, /Reviewer 的问题: 为什么要判空\?/);
});

test("追问 prompt 没有选中代码时不出现空段落", () => {
  const p = buildFollowupPrompt({ file: "", hunk: "整体变更", question: "整体有问题吗" });
  assert.doesNotMatch(p, /选中的代码/);
  assert.match(p, /文件: （未知）/);
});

test("选中代码超长会被截断到 2000 字", () => {
  const p = buildFollowupPrompt({ code: "x".repeat(5000), question: "q" });
  assert.equal(p.includes("x".repeat(2001)), false);
  assert.equal(p.includes("x".repeat(2000)), true);
});
