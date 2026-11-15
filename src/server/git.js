import { simpleGit } from "simple-git";

export function gitFor(repoPath) {
  return simpleGit({ baseDir: repoPath });
}

/** 把 `git branch -a` 的输出拆成本地 / 远程（远程去掉 "remotes/" 前缀） */
export function parseBranches(all, current) {
  const locals = [];
  const remotes = [];
  for (const b of all || []) {
    if (!b || b === "HEAD" || b.includes("->")) continue;
    if (b.startsWith("remotes/")) remotes.push(b.slice("remotes/".length));
    else locals.push(b);
  }
  return { current: current || "", locals, remotes };
}

export async function listBranches(repoPath) {
  const s = await gitFor(repoPath).branch(["-a"]);
  return parseBranches(s.all, s.current);
}

/**
 * 让一个远程分支变成可对比的本地分支：本地已有同名分支就直接复用，否则建跟踪分支。
 * remoteBranch 形如 "origin/feature-x"。
 *
 * 注意：这里只建 ref，不切工作区（checkout）。所有 diff 都基于 ref 计算，不需要切换；
 * 而 checkout 遇到未提交改动会直接失败（"Your local changes would be overwritten"），
 * 这个工具的用户几乎总在改着代码审别人的分支，一失败就没法看。
 */
export async function trackRemote(repoPath, remoteBranch) {
  if (!remoteBranch) throw new Error("缺少远程分支名");
  const short = remoteBranch.split("/").slice(1).join("/");
  if (!short) throw new Error("远程分支名不合法：" + remoteBranch);
  const g = gitFor(repoPath);
  const locals = (await g.branchLocal()).all;
  if (locals.includes(short)) return { branch: short, created: false, checkedOut: false };
  await g.raw(["branch", "--track", short, remoteBranch]);
  return { branch: short, created: true, checkedOut: false };
}

export async function checkout(repoPath, branch) {
  await gitFor(repoPath).checkout(branch);
}

export async function fetchAll(repoPath) {
  await gitFor(repoPath).fetch(["--all", "--prune"]);
}

/**
 * 列出 upstream 已被删除的本地分支（git 里显示为 [gone]），例如远程分支合并后被删掉、
 * 本地还留着跟踪分支。当前分支单独返回，调用方决定怎么处理（默认不删）。
 *
 * 注意：只有「跟踪着一个已经不存在的远程分支」才算。纯本地分支（没设 upstream）
 * 或者跟踪分支还在的，一律不碰 —— 用户手写的本地分支不该被这个工具删掉。
 */
export async function goneBranches(repoPath) {
  const g = gitFor(repoPath);
  const fmt = "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)";
  const raw = await g.raw(["for-each-ref", fmt, "refs/heads"]);
  const current = (await g.branchLocal()).current;
  const rows = String(raw).split("\n").filter(Boolean).map((line) => {
    const [branch, upstream, track] = line.split("\t");
    return { branch, upstream: upstream || "", track: track || "" };
  });
  const gone = rows
    .filter((r) => r.upstream && /(^|\s)gone(\s|$)/.test(r.track))
    .map((r) => ({ branch: r.branch, upstream: r.upstream }));
  return { current, gone };
}

/** 判断"已合并"时参考的 ref：当前分支 + 远程默认分支（origin/HEAD、origin/main…） */
async function safeBases(g, current) {
  const out = [];
  if (current) out.push(current);
  try {
    const head = String(await g.raw(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
    if (head) out.push(head);
  } catch (e) { /* 没有 origin/HEAD 就跳过 */ }
  for (const b of ["origin/main", "origin/master", "origin/develop"]) {
    // 注意：simple-git 的 raw() 对非零退出码不抛错，只回空串，所以按输出判断存在性
    const ok = String(await g.raw(["rev-parse", "--verify", "--quiet", b]).catch(() => "")).trim();
    if (ok) out.push(b);
  }
  return [...new Set(out)];
}

/**
 * 已经合并进 bases 里任一 ref 的本地分支集合。
 * 用 git branch --merged 而不是 merge-base --is-ancestor：后者靠退出码表达结果，
 * 而 simple-git 的 raw() 不检查退出码（永远 resolve），会全部误判成"已合并"。
 */
async function mergedBranches(g, bases) {
  const merged = new Set();
  for (const base of bases) {
    try {
      const out = await g.raw(["branch", "--format=%(refname:short)", "--merged", base]);
      for (const line of String(out).split("\n")) {
        const name = line.trim();
        if (name) merged.add(name);
      }
    } catch (e) { /* base 失效就跳过 */ }
  }
  return merged;
}

/**
 * 清理「远程已删除」的分支：先 fetch --prune 剪掉失效的远程跟踪引用，
 * 再删掉 upstream 变 gone 的本地分支。
 *
 * 安全性：
 * - 当前分支永不删（哪怕它的 upstream 也没了），单独报告；
 * - 只删「已经合并进 HEAD 或远程默认分支」的；还有未提交/未合并内容的保留并说明原因，
 *   避免把没合进去的代码删掉。force=true 才连未合并的一起删（-D）。
 * - dryRun 只预览（含每个分支是否已合并），不动任何 ref。
 */
export async function cleanupGoneBranches(repoPath, opts) {
  const { dryRun = true, force = false } = opts || {};
  let pruned = false;
  let pruneError = "";
  try {
    await fetchAll(repoPath);
    pruned = true;
  } catch (e) {
    pruneError = String(e && e.message ? e.message : e).split("\n")[0];
  }
  const g = gitFor(repoPath);
  const { current, gone } = await goneBranches(repoPath);
  const bases = await safeBases(g, current);
  const mergedSet = await mergedBranches(g, bases);
  const targets = [];
  for (const x of gone) {
    if (x.branch === current) continue;
    targets.push({ ...x, merged: mergedSet.has(x.branch) });
  }
  const skipped = gone.filter((x) => x.branch === current)
    .map((x) => ({ branch: x.branch, reason: "当前分支，不删" }));
  if (dryRun) return { pruned, pruneError, current, bases, targets, deleted: [], kept: skipped };

  const deleted = [];
  const kept = skipped.slice();
  for (const t of targets) {
    if (!t.merged && !force) {
      kept.push({ branch: t.branch, reason: "还有未合并的提交，已保留" });
      continue;
    }
    try {
      await g.raw(["branch", "-D", t.branch]);
      deleted.push(t.branch);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      kept.push({
        branch: t.branch,
        reason: /checked out|worktree/i.test(msg) ? "被其它工作区占用" : (msg.split("\n").filter(Boolean)[0] || "删除失败"),
      });
    }
  }
  return { pruned, pruneError, current, bases, targets, deleted, kept };
}

export async function pull(repoPath) {
  return gitFor(repoPath).pull();
}

/** base...compare three-dot diff 文件摘要 */
export async function diffSummary(repoPath, base, compare) {
  const summary = await gitFor(repoPath).diffSummary([base + "..." + compare]);
  return summary.files.map((f) => ({ file: f.file, insertions: f.insertions, deletions: f.deletions, binary: f.binary }));
}

/** 原始 unified diff 文本 */
export async function rawDiff(repoPath, base, compare, file) {
  const args = [base + "..." + compare, "--unified=6"];
  if (file) args.push("--", file);
  return gitFor(repoPath).diff(args);
}

/** 读取某个 ref（分支/commit）下的完整文件内容，用于给 AI 提供 hunk 周边上下文 */
export async function fileAt(repoPath, ref, file) {
  return gitFor(repoPath).show([ref + ":" + file]);
}

/** base..compare 之间的提交列表（一行一条），给 AI 提供变更意图 */
export async function logRange(repoPath, base, compare, limit = 8) {
  const raw = await gitFor(repoPath).raw(["log", "--no-merges", "--oneline", "-n", String(limit), base + ".." + compare]);
  return String(raw).split("\n").map((s) => s.trim()).filter(Boolean);
}

/** 工作区未提交改动 diff */
export async function workdirDiff(repoPath) {
  return gitFor(repoPath).diff(["HEAD", "--unified=6"]);
}
