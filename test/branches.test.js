import test from "node:test";
import assert from "node:assert/strict";
import { parseBranches } from "../src/server/git.js";

test("parseBranches 拆分本地与远程并忽略 HEAD 指针", () => {
  const r = parseBranches(
    ["main", "feature/x", "remotes/origin/main", "remotes/origin/feature/x", "remotes/origin/HEAD -> origin/main"],
    "feature/x"
  );
  assert.deepEqual(r.locals, ["main", "feature/x"]);
  assert.deepEqual(r.remotes, ["origin/main", "origin/feature/x"]);
  assert.equal(r.current, "feature/x");
});

test("parseBranches 容忍空输入", () => {
  const r = parseBranches(undefined, undefined);
  assert.deepEqual(r.locals, []);
  assert.deepEqual(r.remotes, []);
  assert.equal(r.current, "");
});
