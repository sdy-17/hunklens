import { chatJson } from "./ai.js";

/**
 * 带工具的评审 agent。
 * 目标不是「把整个仓库塞进提示词」，而是像人一样：看到改动 → 自己搜相关业务代码 / 查代码图谱 / 查需求单 → 再下结论。
 * 所以这里实现一个最小的 function-calling 循环：模型要工具就给工具结果，最后强制它收口成 JSON。
 */

/** 一次非 JSON 强制的对话请求，返回 message（可能带 tool_calls） */
export async function chatRaw(cfg, body) {
  const res = await fetch(cfg.baseURL.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    const err = new Error("LLM HTTP " + res.status + ": " + text);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return (json.choices && json.choices[0] && json.choices[0].message) || {};
}

/** 模型有时仍会包一层 markdown 代码块，这里剥掉后再解析 */
export function stripFence(text) {
  let t = String(text || "").trim();
  // 只有整段被代码块包住时才剥，避免误伤正文里出现的 ``` 片段
  if (!t.startsWith("```")) return t;
  const nl = t.indexOf("\n");
  t = nl < 0 ? t.slice(3) : t.slice(nl + 1);
  const end = t.lastIndexOf("```");
  if (end >= 0) t = t.slice(0, end);
  return t.trim();
}

function tryParse(text) {
  try {
    const obj = JSON.parse(stripFence(text));
    return obj && typeof obj === "object" ? obj : null;
  } catch (e) {
    return null;
  }
}

/** 模型明确表示不支持 tools 时（有的兼容端点如此），降级成纯 JSON 请求 */
function toolsUnsupported(err) {
  const status = Number(err && err.status) || 0;
  if (status === 400 || status === 404 || status === 422 || status === 501) return true;
  const msg = String((err && err.message) || "");
  return /tools? (is|are) not supported|does not support tool|unknown parameter.*tool/i.test(msg);
}

/**
 * runToolAgent：工具循环 + 强制 JSON 收口。
 * 返回 { obj, used, rounds, degraded?, exhausted? }
 */
export async function runToolAgent(cfg, opts) {
  const {
    system,
    user,
    tools,
    runTool,
    maxRounds = 4,
    validator,
    onTool,
    jsonInstruction = "请只输出最终 JSON（不要 markdown 代码块，不要解释）。",
  } = opts || {};

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user || "" });

  const used = [];
  const toolList = Array.isArray(tools) && tools.length ? tools : null;

  if (!toolList || typeof runTool !== "function") {
    const obj = await chatJson(cfg, messages, validator);
    return { obj, used, rounds: 0, degraded: "no-tools" };
  }

  for (let round = 0; round < maxRounds; round++) {
    let message;
    try {
      message = await chatRaw(cfg, {
        model: cfg.model,
        messages,
        temperature: 0.2,
        tools: toolList,
        tool_choice: "auto",
      });
    } catch (err) {
      if (toolsUnsupported(err)) {
        const obj = await chatJson(cfg, messages, validator);
        return { obj, used, rounds: round, degraded: "tools-unsupported" };
      }
      throw err;
    }

    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length) {
      messages.push({ role: "assistant", content: message.content || "", tool_calls: calls });
      for (const call of calls) {
        const name = (call.function && call.function.name) || "";
        let args = {};
        try {
          args = JSON.parse((call.function && call.function.arguments) || "{}");
        } catch (e) {
          args = {};
        }
        used.push(name);
        if (typeof onTool === "function") onTool(name, args);
        let result = "";
        try {
          result = await runTool(name, args);
        } catch (err) {
          result = "工具执行失败: " + ((err && err.message) || err);
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id || name,
          content: String(result == null ? "" : result).slice(0, 6000),
        });
      }
      continue;
    }

    const text = String(message.content || "").trim();
    const direct = tryParse(text);
    if (direct) {
      try {
        if (validator) validator(direct);
        return { obj: direct, used, rounds: round + 1 };
      } catch (e) {
        /* 结构不对，让它按 JSON 重出一遍 */
      }
    }
    if (text) messages.push({ role: "assistant", content: text });
    messages.push({ role: "user", content: jsonInstruction });
    const obj = await chatJson(cfg, messages, validator);
    return { obj, used, rounds: round + 1 };
  }

  messages.push({ role: "user", content: "查证轮次已用完，请基于已有信息" + jsonInstruction });
  const obj = await chatJson(cfg, messages, validator);
  return { obj, used, rounds: maxRounds, exhausted: true };
}
