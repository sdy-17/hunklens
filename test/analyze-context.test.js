import test from "node:test";
import assert from "node:assert/strict";
import { hunkKey, hunkContextText } from "../src/server/analyze.js";

test("hunkKey 带上 prompt 版本，改提示词后旧缓存失效", () => {
  const a = hunkKey("/r", "main", "feat", "a.js", "@@ -1,1 +1,1 @@", ["+x"]);
  const b = hunkKey("/r", "main", "feat", "a.js", "@@ -1,1 +1,1 @@", ["+x"]);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{40}$/);
  const c = hunkKey("/r", "main", "feat", "a.js", "@@ -1,1 +1,2 @@", ["+x"]);
  assert.notEqual(a, c);
});

test("hunkContextText 输出带行号的周边代码并截断窗口", () => {
  const lines = Array.from({ length: 100 }, (_, i) => "line" + (i + 1));
  const text = hunkContextText(lines, 50, 3, 5);
  assert.match(text, /^45\| line45/);
  assert.match(text, /58\| line58$/);
  assert.ok(!text.includes("44| line44"));
  assert.ok(!text.includes("59| line59"));
  // 边界：起点过靠前时从第 1 行开始
  assert.match(hunkContextText(lines, 2, 1, 5), /^1\| line1/);
  // 文件末尾不越界
  const tail = hunkContextText(lines, 99, 2, 5);
  assert.match(tail, /100\| line100$/);
  // 无上下文时返回空串
  assert.equal(hunkContextText(null, 1, 1), "");
  assert.equal(hunkContextText([], 1, 1), "");
});
