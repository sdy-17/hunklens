import { test } from "node:test"; import assert from "node:assert";
import { scanRepos } from "../src/server/scanner.js";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

test("scanRepos finds git repos up to two levels deep", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "air-"));
  fs.mkdirSync(path.join(tmp, "proj-a", ".git"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "nested", "proj-b", ".git"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "plain"));
  const names = scanRepos(tmp).map((r) => r.name).sort();
  assert.ok(names.includes("proj-a"));
  assert.ok(names.includes("proj-b"));
  assert.ok(!names.includes("plain"));
  fs.rmSync(tmp, { recursive: true, force: true });
});
