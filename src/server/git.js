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

/** 工作区未提交改动 diff */
export async function workdirDiff(repoPath) {
  return gitFor(repoPath).diff(["HEAD", "--unified=6"]);
}
