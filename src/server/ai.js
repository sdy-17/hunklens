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
  "你是资深代码审查专家，帮 reviewer 快速看懂一处改动，并挑出真问题。",
  "写作要求（很重要，reviewer 要在一眼内读完）：",
  "1. intent：一句话说清这处改动在做什么（作用/目的），结合给定的周边代码理解，不超过 60 字。",
  "2. issues：只列真正会导致错误、故障、安全或维护代价的问题，最多 3 条，每条不超过 40 字；没有就返回空数组，不要编造，不要凑数。",
  "3. suggestion：给出可执行的改法，最多 60 字；没有必要就返回空字符串。",
  "4. 不要复述 diff，不要写套话（如“建议加强测试”“注意边界”），不要评价与改动无关的代码。",
  "5. 只依据给出的改动与上下文判断，不臆测未提供的代码。",
  "6. severity：blocker=线上故障/数据错误/安全问题；warning=性能、边界、可维护性问题；info=无明显问题。",
  "7. 输出严格 JSON，不要 markdown 代码块包裹：",
  '{"hunkId":string,"intent":string,"severity":"blocker"|"warning"|"info","issues":[{"line":number,"desc":string}],"suggestion":string,"confidence":number}',
].join("\n");

export function buildHunkPrompt({ file, hunk, context, commitMsg, codeContext, stat }) {
  return [
    "文件: " + file + (stat ? "（" + stat + "）" : ""),
    "改动位置: " + (context || "-"),
    "提交信息: " + (commitMsg || "-"),
    codeContext ? "" : null,
    codeContext ? "改动附近的代码（\"行号|代码\"，仅用于理解上下文，不需要逐行评论）:" : null,
    codeContext || null,
    "",
    "本次改动（diff）:",
    hunk,
    "",
    "请先用一句话说明这处改动的作用，再判断它是否带来问题，按系统要求输出 JSON。",
  ].filter((x) => x !== null).join("\n");
}

export function buildOverviewPrompt({ base, compare, diffStat, analyses }) {
  return [
    "以下是分支 " + base + " → " + compare + " 的变更统计和逐 hunk AI 分析结论，",
    "请输出严格 JSON（不要 markdown 包裹）：",
    '{"summary":string,"risks":[{"file":string,"desc":string,"severity":"blocker"|"warning"|"info"}],"testSuggestions":string}',
    "summary=整体改动在做什么，不超过 100 字；risks=按风险排序的前 3 个问题，每条不超过 50 字，没问题就给空数组；testSuggestions=最值得补的 1-3 个测试，同样简短。",
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
