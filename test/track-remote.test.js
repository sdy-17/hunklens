import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { trackRemote, listBranches } from "../src/server/git.js";

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** 建一个带远程分支 + 脏工作区的仓库，模拟"一边改自己代码、一边审别人分支"的现实场景 */
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hunklens-track-"));
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
  sh(seed, "checkout", "-qb", "feat");
  fs.writeFileSync(path.join(seed, "a.txt"), "one\ntwo\n");
  sh(seed, "commit", "-qam", "feat");
  sh(seed, "push", "-q", "-u", "origin", "feat");
  sh(seed, "checkout", "-q", "main");
  sh(base, "clone", "-q", remote, work);
  sh(work, "config", "user.email", "t@example.com");
  sh(work, "config", "user.name", "t");
  // 未提交改动：老实现 git checkout 会以 "Your local changes would be overwritten" 失败
  fs.appendFileSync(path.join(work, "a.txt"), "dirty\n");
  return { base, work };
}

test("远程分支只建本地跟踪分支，不动工作区（脏工作区也能用）", async () => {
  const { base, work } = fixture();
  try {
    const before = sh(work, "rev-parse", "--abbrev-ref", "HEAD").trim();
    assert.equal(before, "main");

    const r = await trackRemote(work, "origin/feat");
    assert.deepEqual(r, { branch: "feat", created: true, checkedOut: false });

    // 工作区原样：还是 main，未提交改动没被覆盖
    assert.equal(sh(work, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main");
    assert.equal(fs.readFileSync(path.join(work, "a.txt"), "utf8"), "one\ndirty\n");
    // feat 指向远程同一个 commit，且已建立跟踪关系
    assert.equal(sh(work, "rev-parse", "feat").trim(), sh(work, "rev-parse", "origin/feat").trim());
    assert.equal(sh(work, "rev-parse", "--abbrev-ref", "feat@{upstream}").trim(), "origin/feat");

    const b = await listBranches(work);
    assert.ok(b.locals.includes("feat"));
    assert.ok(b.remotes.includes("origin/feat"));

    // 幂等：再来一次只是复用，不报错
    assert.deepEqual(await trackRemote(work, "origin/feat"), { branch: "feat", created: false, checkedOut: false });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("远程分支名不合法时报错而不是瞎猜", async () => {
  await assert.rejects(() => trackRemote("/tmp", ""), /缺少远程分支名/);
  await assert.rejects(() => trackRemote("/tmp", "nope"), /远程分支名不合法/);
});
