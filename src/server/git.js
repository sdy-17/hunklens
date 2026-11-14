import { simpleGit } from "simple-git";

export function gitFor(repoPath) {
  return simpleGit({ baseDir: repoPath });
}

export async function listBranches(repoPath) {
  const s = await gitFor(repoPath).branch(["-a"]);
  return {
    current: s.current,
    locals: s.all.filter((b) => !b.startsWith("remotes/")),
    remotes: s.all.filter((b) => b.startsWith("remotes/")),
  };
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
