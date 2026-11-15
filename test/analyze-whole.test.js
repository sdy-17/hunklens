import test from "node:test";
import assert from "node:assert/strict";
import { contextForHunk, siblingHunksText, changesetText } from "../src/server/analyze.js";
import { buildHunkPrompt } from "../src/server/ai.js";

test("contextForHunk：小文件整份给出，让模型看到完整上下文", () => {
  const lines = Array.from({ length: 40 }, (_, i) => "l" + (i + 1));
  const text = contextForHunk(lines, 20, 2);
  assert.match(text, /整份文件，共 40 行/);
  assert.match(text, /1\| l1/);
  assert.match(text, /40\| l40/);
});

test("contextForHunk：大文件给 文件头 + 改动窗口 + 文件尾", () => {
  const lines = Array.from({ length: 1000 }, (_, i) => "l" + (i + 1));
  const text = contextForHunk(lines, 500, 3);
  assert.match(text, /文件共 1000 行/);
  assert.match(text, /^（文件共/, "以说明开头");
  assert.match(text, /1\| l1/, "含文件头");
  assert.match(text, /440\| l440/, "窗口起点 = 500-60");
  assert.match(text, /563\| l563/, "窗口终点 = 500+3+60");
  assert.match(text, /上面略去 415 行/);
  assert.match(text, /下面略去 437 行/);
  assert.match(text, /1000\| l1000$/, "含文件尾");
  assert.ok(!text.includes("300| l300"), "窗口外的正文不再输出");
});

test("contextForHunk：无内容时返回空串", () => {
  assert.equal(contextForHunk(null, 1, 1), "");
  assert.equal(contextForHunk([], 1, 1), "");
});

test("siblingHunksText：列出同一文件其它改动，跳过当前这处", () => {
  const hunks = [
    { header: "@@ -1,2 +1,2 @@", lines: [" ctx", "-old", "+new"] },
    { header: "@@ -80,1 +80,3 @@", lines: ["+a", "+b", "+c"] },
  ];
  const text = siblingHunksText(hunks, 1);
  assert.match(text, /@@ -1,2 \+1,2 @@/);
  assert.match(text, /\+new/);
  assert.ok(!text.includes("@@ -80"), "当前这处不出现在兄弟改动里");
  assert.equal(siblingHunksText(hunks, 0).includes("@@ -1,2"), false);
  // 只有一处改动时没有兄弟段落
  assert.equal(siblingHunksText([hunks[0]], 0), "");
  assert.equal(siblingHunksText(null, 0), "");
});

test("siblingHunksText：单个 hunk 改动行过多时截断", () => {
  const lines = ["@@ -1,20 +1,20 @@"];
  for (let i = 0; i < 20; i++) lines.push("+row" + i);
  const text = siblingHunksText([{ header: "@@ -1,1 +1,1 @@", lines: ["+x"] }, { header: lines[0], lines: lines.slice(1) }], 0);
  assert.match(text, /还有更多行/);
});

test("changesetText：汇总文件、改动位置与提交", () => {
  const entries = [
    { file: "src/a.js", stat: "+10 -2", hunks: [{ header: "@@ -1,2 +1,4 @@" }] },
    { file: "README.md", stat: "+3 -0", hunks: [{ header: "@@ -5,1 +5,4 @@" }] },
  ];
  const text = changesetText(entries, ["abc123 feat: 改了 a.js", "def456 docs: 补 README"]);
  assert.match(text, /涉及 2 个文件 \/ 2 处改动/);
  assert.match(text, /src\/a\.js（\+10 -2）：@@ -1,2 \+1,4 @@/);
  assert.match(text, /README\.md/);
  assert.match(text, /abc123 feat: 改了 a\.js/);
  assert.equal(changesetText([], []), "");
});

test("changesetText：文件过多时截断", () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({ file: "f" + i + ".js", stat: "+1 -0", hunks: [{ header: "@@ -0,0 +1,1 @@" }] }));
  const text = changesetText(entries, [], 5);
  assert.match(text, /还有 25 个文件未列出/);
  assert.ok(!text.includes("f5.js"));
});

test("buildHunkPrompt：带上全貌、本文件其它改动与周围代码", () => {
  const p = buildHunkPrompt({
    file: "src/a.js",
    hunk: "+const x = 1;",
    context: "@@ -1,1 +1,2 @@",
    stat: "+1 -0",
    changeset: "本次分支变更涉及 2 个文件",
    siblings: "@@ -40,1 +40,2 @@\n+y",
    codeContext: "1| import a from \"a\";",
  });
  const order = ["本次变更全貌", "本文件的其它改动", "改动附近的代码", "本次改动（diff）"];
  let last = -1;
  for (const k of order) {
    const at = p.indexOf(k);
    assert.ok(at > last, k + " 出现且顺序正确");
    last = at;
  }
  assert.match(p, /1\| import a/);
});

test("buildHunkPrompt：没有上下文时不产生空段落", () => {
  const p = buildHunkPrompt({ file: "README.md", hunk: "+x" });
  assert.ok(!p.includes("本次变更全貌"));
  assert.ok(!p.includes("本文件的其它改动"));
  assert.ok(!p.includes("改动附近的代码"));
  assert.ok(!/\n\n\n/.test(p), "没有连续空行");
});
