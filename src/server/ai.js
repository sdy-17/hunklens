import fs from "node:fs";

/** 读取配置（config.local.json 优先），返回 provider 配置 */
export function loadConfig(root) {
  for (const f of ["config.local.json", "config.json"]) {
    const p = root + "/" + f;
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return null;
}

export const SYSTEM_PROMPT = '你是资深代码审查专家。只针对给出的 diff 与上下文分析，不臆测未提供的代码。'
  + '输出严格 JSON：{"hunkId":string,"intent":string,"severity":"blocker"|"warning"|"info",'
  + '"issues":[{"line":number,"desc":string}],"suggestion":string,"confidence":number}';

export function buildHunkPrompt({ file, hunk, context, commitMsg }) {
  return '文件: ' + file + '\n提交信息: ' + (commitMsg || '-') + '\n\n上下文:\n' + (context || '')
    + '\n\n改动:\n' + hunk + '\n\n请分析该改动的目的、问题与优化建议。';
}

/** 调用 OpenAI 兼容接口（/chat/completions），返回文本（应为 JSON 字符串） */
export async function chatCompletion(cfg, messages) {
  const res = await fetch(cfg.baseURL.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.2, response_format: { type: "json_object" } }),
  });
  if (!res.ok) throw new Error("LLM HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}
