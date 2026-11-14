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
