import fs from "node:fs";
import path from "node:path";

/** 读取配置（HUNKLENS_CONFIG 显式指定 > config.local.json > config.json） */
export function loadConfig(root) {
  if (process.env.HUNKLENS_CONFIG) {
    const p = path.resolve(process.env.HUNKLENS_CONFIG);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  for (const f of ["config.local.json", "config.json"]) {
    const p = root + "/" + f;
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return null;
}

/** 参考 PR-Agent pr-reviewer 的角色设定 */
export const SYSTEM_PROMPT = [
  "你是资深代码审查专家，帮 reviewer 快速看懂一处改动，并挑出真问题。",
  "你拿到的不是一个孤立的 diff：会同时看到「本次变更全貌」（改了哪些文件、哪些位置、哪些提交）、",
  "「本文件的其它改动」，以及「改动附近的代码」（这个文件在改动后的内容，可能含整份文件）。",
  "判断前先在脑子里把这块改动放回整个文件与整个变更里看：它替谁做事、谁在调它、和别的文件是不是配套。",
  "写作要求（很重要，reviewer 要在一眼内读完）：",
  "1. intent：一句话说清这处改动在做什么（作用/目的），要体现它在整个文件/整个变更里的角色，不超过 60 字。",
  "2. issues：只列真正会导致错误、故障、安全或维护代价的问题，最多 3 条，每条不超过 40 字；没有就返回空数组，不要编造，不要凑数。",
  "   优先看这些容易漏的点：上下文里已有的同类逻辑被改坏/重复实现；调用方、类型、配置、导出没跟着改；",
  "   边界与新分支没处理（空值、并发、失败回滚）；和本文件其它改动或别的文件改动互相矛盾。",
  "3. suggestion：给出可执行的改法，最多 60 字；没有必要就返回空字符串。",
  "4. 不要复述 diff，不要写套话（如“建议加强测试”“注意边界”），不要评价与改动无关的代码。",
  "5. 只依据给出的改动与上下文判断，不臆测未提供的代码；上下文里能看到的，就以上下文为准。",
  "6. severity：blocker=线上故障/数据错误/安全问题；warning=性能、边界、可维护性问题；info=无明显问题。",
  "7. 输出严格 JSON，不要 markdown 代码块包裹：",
  '{"hunkId":string,"intent":string,"severity":"blocker"|"warning"|"info","issues":[{"line":number,"desc":string}],"suggestion":string,"confidence":number}',
].join("\n");

/**
 * 总览专用系统提示词。
 * 必须和 SYSTEM_PROMPT（单 hunk 契约）分开：否则模型会按系统提示只返回一个 hunk 的字段，
 * 前端拿不到 summary/risks/testSuggestions，总览区一直是空的（且 JSON 合法，属于静默失败）。
 */
export const OVERVIEW_SYSTEM_PROMPT = [
  "你是资深代码审查专家，负责在逐处改动都分析完之后，给 reviewer 一份整体结论。",
  "只输出一份整体报告：不要逐处复述改动，也不要输出任何「单处改动分析」的字段（这种字段属于逐处分析，不是总览）。",
  "写作要求（reviewer 要一眼读完）：",
  "1. summary：这次改动整体在做什么（作用/目的），不超过 100 字。",
  "2. risks：按风险从高到低列前 3 条，每条 \"file\" 给涉及文件、\"desc\" 不超过 50 字，没有风险就返回空数组，不要凑数。",
  "3. testSuggestions：最值得补的 1-3 个测试，一句话一条，用换行分隔。",
  "4. severity：blocker=线上故障/数据错误/安全问题；warning=性能、边界、可维护性问题；info=无明显问题。",
  "5. 只依据给出的变更统计与逐 hunk 结论判断，不臆测未提供的代码。",
  "6. 输出严格 JSON，不要 markdown 代码块包裹：",
  '{"summary":string,"risks":[{"file":string,"desc":string,"severity":"blocker"|"warning"|"info"}],"testSuggestions":string}',
].join("\n");

/** 总览结果校验：结构不符就抛错，交给 chatJson 重试，避免「合法 JSON 但字段不对」被当成成功 */
export function validateOverview(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("总览结果不是 JSON 对象");
  if (typeof obj.summary !== "string" || !obj.summary.trim()) {
    throw new Error("总览结果缺少 summary 字段（疑似返回了单 hunk 结构）");
  }
  if (obj.risks !== undefined && !Array.isArray(obj.risks)) throw new Error("总览结果 risks 必须是数组");
  if (obj.testSuggestions !== undefined && typeof obj.testSuggestions !== "string") {
    throw new Error("总览结果 testSuggestions 必须是字符串");
  }
  return obj;
}

/** 归一化总览结果：模型偶尔把 risks 写成字符串、testSuggestions 写成数组，这里统一成前端契约 */
export function normalizeOverview(obj) {
  const r = obj || {};
  const SEV = ["blocker", "warning", "info"];
  const risks = Array.isArray(r.risks) ? r.risks : r.risks ? [r.risks] : [];
  return {
    summary: typeof r.summary === "string" ? r.summary.trim() : "",
    risks: risks.map((x) => {
      if (typeof x === "string") return { file: "", desc: x, severity: "info" };
      return {
        file: String(x?.file || ""),
        desc: String(x?.desc || x?.issue || x?.text || ""),
        severity: SEV.includes(x?.severity) ? x.severity : "info",
      };
    }).filter((x) => x.desc),
    testSuggestions: Array.isArray(r.testSuggestions) ? r.testSuggestions.join("\n") : String(r.testSuggestions || ""),
  };
}

export function buildHunkPrompt({ file, hunk, context, commitMsg, codeContext, stat, siblings, changeset }) {
  return [
    "文件: " + file + (stat ? "（" + stat + "）" : ""),
    "改动位置: " + (context || "-"),
    "提交信息: " + (commitMsg || "-"),
    changeset ? "" : null,
    changeset ? "本次变更全貌（用来判断这处改动是否与其它改动配套）:" : null,
    changeset || null,
    siblings ? "" : null,
    siblings ? "本文件的其它改动（同一文件里别处还改了什么）:" : null,
    siblings || null,
    codeContext ? "" : null,
    codeContext ? "改动附近的代码（\"行号|代码\"，这是改动后该文件的内容，用于理解上下文，不需要逐行评论）:" : null,
    codeContext || null,
    "",
    "本次改动（diff）:",
    hunk,
    "",
    "请结合整个文件与整个变更，先用一句话说明这处改动的作用，再判断它是否带来问题，按系统要求输出 JSON。",
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

export function buildFollowupPrompt({ file, hunk, prior, question, code }) {
  const rows = [
    "文件: " + (file || "（未知）"),
    "范围: " + (hunk || "整体变更"),
  ];
  if (code) rows.push("", "Reviewer 选中的代码:", String(code).slice(0, 2000));
  rows.push(
    "",
    "之前的分析结论: " + (prior || "无"),
    "",
    "Reviewer 的问题: " + question,
    "请用中文简洁回答（纯文本，不超过 200 字），必要时给出具体改法。",
  );
  return rows.join("\n");
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
