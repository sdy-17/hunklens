import fs from "node:fs";

/** 读取配置（config.local.json 优先） */
export function loadConfig(root) {
  for (const f of ["config.local.json", "config.json"]) {
    const p = root + "/" + f;
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return null;
}

/** 参考 PR-Agent pr-reviewer 的角色设定 */
export const SYSTEM_PROMPT = [
  "你是一位资深代码审查专家，正在辅助人工 reviewer 审阅一段 diff。",
  "规则：",
  "1. 只针对给出的 diff 和上下文分析，不臆测未提供的代码。",
  "2. severity 定义：blocker=可能导致线上故障/数据错误/安全漏洞；warning=性能、边界条件、可维护性问题；info=风格或纯解释。",
  "3. 没有问题时 issues 返回空数组，不要编造问题。",
  "4. 输出严格 JSON，不要 markdown 代码块包裹：",
  '{"hunkId":string,"intent":string,"severity":"blocker"|"warning"|"info","issues":[{"line":number,"desc":string}],"suggestion":string,"confidence":number}',
].join("\n");

export function buildHunkPrompt({ file, hunk, context, commitMsg }) {
  return [
    "文件: " + file,
    "Hunk: " + (context || ""),
    "提交信息: " + (commitMsg || "-"),
    "",
    "改动内容:",
    hunk,
    "",
    "请分析该改动的目的、问题与优化建议，按系统要求输出 JSON。",
  ].join("\n");
}

export function buildOverviewPrompt({ base, compare, diffStat, analyses }) {
  return [
    "以下是分支 " + base + " → " + compare + " 的变更统计和逐 hunk AI 分析结论，",
    "请输出严格 JSON（不要 markdown 包裹）：",
    '{"summary":string,"risks":[{"file":string,"desc":string,"severity":"blocker"|"warning"|"info"}],"testSuggestions":string}',
    "summary=整体改动意图；risks=按风险排序的 Top 问题清单；testSuggestions=建议补充的测试。",
    "",
    "变更统计:",
    diffStat,
    "",
    "逐 hunk 分析结论:",
    analyses,
  ].join("\n");
}

export function buildFollowupPrompt({ file, hunk, prior, question }) {
  return [
    "文件: " + file,
    "改动:",
    hunk,
    "",
    "之前的分析结论: " + (prior || "无"),
    "",
    "Reviewer 的问题: " + question,
    "请用中文简洁回答（纯文本，不超过 200 字）。",
  ].join("\n");
}

/** 调用 OpenAI 兼容接口 */
export async function chatCompletion(cfg, messages, { json = true } = {}) {
  const body = { model: cfg.model, messages, temperature: 0.2 };
  if (json) body.response_format = { type: "json_object" };
  const res = await fetch(cfg.baseURL.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("LLM HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
  return (await res.json()).choices?.[0]?.message?.content ?? "";
}

/** JSON 输出 + 校验失败重试（照搬 PR-Agent 的 retry 思路，最多 2 次） */
export async function chatJson(cfg, messages, validator) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const text = await chatCompletion(cfg, messages);
      const obj = JSON.parse(text.replace(/^\`\`\`json?\s*|\s*\`\`\`$/g, ""));
      if (validator) validator(obj);
      return obj;
    } catch (e) { last = e; }
  }
  throw last;
}
