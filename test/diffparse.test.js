import { test } from "node:test"; import assert from "node:assert";
import { parseUnifiedDiff } from "../src/server/diffparse.js";

test("parses unified diff into files and hunks", () => {
  const raw = [
    "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts",
    "@@ -1,3 +1,4 @@",
    " context", "-old", "+new", "+new2", " context2",
  ].join("\n");
  const parsed = parseUnifiedDiff(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].file, "a.ts");
  assert.equal(parsed[0].hunks[0].lines.length, 5);
});

test("末尾换行不会产生幽灵空行", () => {
  const raw = ["+++ b/a.ts", "@@ -8,2 +8,3 @@", " ctx", "+added", ""].join("\n");
  const parsed = parseUnifiedDiff(raw);
  assert.equal(parsed[0].hunks[0].lines.length, 2);
  assert.equal(parsed[0].hunks[0].lines[1], "+added");
  // 中间真实的空上下文行仍然保留
  const mid = ["+++ b/a.ts", "@@ -1,2 +1,2 @@", " first", "", " last", ""].join("\n");
  const p2 = parseUnifiedDiff(mid);
  assert.equal(p2[0].hunks[0].lines.length, 3);
  assert.equal(p2[0].hunks[0].lines[1], "");
});
