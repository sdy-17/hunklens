import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { goneBranches, cleanupGoneBranches } from "../src/server/git.js";

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const branches = (cwd) => sh(cwd, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);

/**
 * 造一个"远程分支被删掉"的现场：
 * - merged：本地分支的远程已删，内容已合进 main → git branch -d 能删
 * - unmerged：本地分支的远程已删，还有没合并的提交 → 默认保留
 * - cur：当前分支的远程也被删了 → 永远不删
 * - localonly：纯本地分支，没有 upstream → 不属于清理范围
 */
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hunklens-clean-"));
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  const work = path.join(base, "work");
  fs.mkdirSync(remote);
  sh(remote, "init", "-q", "--bare");
  sh(base, "clone", "-q", remote, seed);
  sh(seed, "config", "user.email", "t@example.com");
  sh(seed, "config", "user.name", "t");
  fs.writeFileSync(path.join(seed, "a.txt"), "one\n");
  sh(seed, "add", ".");
  sh(seed, "commit", "-qm", "init");
  sh(seed, "branch", "-M", "main");
  sh(seed, "push", "-q", "-u", "origin", "main");

  // merged：提交后推上去，再合回 main
  sh(seed, "checkout", "-qb", "merged");
  fs.writeFileSync(path.join(seed, "m.txt"), "m\n");
  sh(seed, "add", ".");
  sh(seed, "commit", "-qm", "merged work");
  sh(seed, "push", "-q", "-u", "origin", "merged");
  sh(seed, "checkout", "-q", "main");
  sh(seed, "merge", "-q", "--no-ff", "-m", "merge merged", "merged");
  sh(seed, "push", "-q", "origin", "main");

  // unmerged：推上去就不管了，不合并
  sh(seed, "checkout", "-qb", "unmerged", "main");
  fs.writeFileSync(path.join(seed, "u.txt"), "u\n");
  sh(seed, "add", ".");
  sh(seed, "commit", "-qm", "unmerged work");
  sh(seed, "push", "-q", "-u", "origin", "unmerged");

  // cur：最后停留的分支，它的远程也会被删
  sh(seed, "checkout", "-qb", "cur", "main");
  sh(seed, "push", "-q", "-u", "origin", "cur");

  // 纯本地分支（没有 upstream）
  sh(seed, "checkout", "-qb", "localonly", "main");
  fs.writeFileSync(path.join(seed, "l.txt"), "l\n");
  sh(seed, "add", ".");
  sh(seed, "commit", "-qm", "local only");
  sh(seed, "checkout", "-q", "cur");

  sh(base, "clone", "-q", remote, work);
  sh(work, "config", "user.email", "t@example.com");
  sh(work, "config", "user.name", "t");
  // 本地各建一个跟踪分支（后面远程删掉，它们就变成 [gone]）
  sh(work, "checkout", "-q", "-b", "merged", "origin/merged");
  sh(work, "checkout", "-q", "-b", "unmerged", "origin/unmerged");
  sh(work, "checkout", "-q", "-b", "cur", "origin/cur");   // 最后停在 cur，它的远程也会被删
  sh(work, "checkout", "-q", "-b", "localonly", "main");    // 纯本地分支，没有 upstream
  sh(work, "checkout", "-q", "cur");

  // 远程三个分支全删掉，模拟"合并后清理远程分支"
  sh(work, "push", "-q", "origin", "--delete", "merged", "unmerged", "cur");
  return { base, work };
}

test("dryRun 只列出 upstream 已删除的本地分支，不动任何 ref", async () => {
  const { base, work } = fixture();
  try {
    const before = branches(work);
    const d = await cleanupGoneBranches(work, { dryRun: true });

    assert.equal(d.pruned, true);
    assert.equal(d.current, "cur");
    const names = d.targets.map((t) => t.branch).sort();
    // 当前分支 cur 不在待删列表里；纯本地分支 localonly 也不在
    assert.deepEqual(names, ["merged", "unmerged"]);
    // 已合进 main 的判定为可安全删除，没合的不行
    assert.equal(d.targets.find((t) => t.branch === "merged").merged, true);
    assert.equal(d.targets.find((t) => t.branch === "unmerged").merged, false);
    assert.deepEqual(d.deleted, []);
    assert.deepEqual(branches(work), before);
    // 远程跟踪引用已被 prune 掉
    assert.ok(!sh(work, "branch", "-r").includes("origin/merged"));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("确认后删掉已合并的、保留未合并的与当前分支", async () => {
  const { base, work } = fixture();
  try {
    const r = await cleanupGoneBranches(work, { dryRun: false });
    assert.deepEqual(r.deleted, ["merged"]);
    const keptNames = r.kept.map((k) => k.branch).sort();
    assert.deepEqual(keptNames, ["cur", "unmerged"]);
    const unmerged = r.kept.find((k) => k.branch === "unmerged");
    assert.match(unmerged.reason, /未合并/);
    assert.match(r.kept.find((k) => k.branch === "cur").reason, /当前分支/);

    const left = branches(work);
    assert.ok(!left.includes("merged"));
    assert.ok(left.includes("unmerged"));
    assert.ok(left.includes("cur"));
    assert.ok(left.includes("localonly"));
    // 当前分支还是 cur，工作区没被动过
    assert.equal(sh(work, "rev-parse", "--abbrev-ref", "HEAD").trim(), "cur");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("force 才会删掉还有未合并提交的分支", async () => {
  const { base, work } = fixture();
  try {
    await cleanupGoneBranches(work, { dryRun: false });
    assert.ok(branches(work).includes("unmerged"));

    const r = await cleanupGoneBranches(work, { dryRun: false, force: true });
    assert.deepEqual(r.deleted, ["unmerged"]);
    assert.ok(!branches(work).includes("unmerged"));
    // 当前分支无论 force 如何都不会被删
    assert.ok(branches(work).includes("cur"));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("清理完再检查时只剩当前分支，不会重复报错", async () => {
  const { base, work } = fixture();
  try {
    await cleanupGoneBranches(work, { dryRun: false, force: true });
    const again = await cleanupGoneBranches(work, { dryRun: true });
    assert.deepEqual(again.targets.map((t) => t.branch), []);
    // 当前分支的 upstream 也没了，但它永远留在 gone 列表外（单独报告）
    const { gone } = await goneBranches(work);
    assert.deepEqual(gone.map((g) => g.branch), ["cur"]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
