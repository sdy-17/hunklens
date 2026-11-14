import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * 团队规则加载器：读取全局与项目的 skill 规范，注入 review prompt。
 *
 * 查找顺序：
 *  全局：~/.agent/skills
 *        或在 config.local.json 的 rules.globalDirs 显式指定团队规范目录
 *  项目：<repo>/.agent/skills（可在 rules.projectDirs 显式指定其它目录）
 *
 * skill 形态：目录含 SKILL.md（front-matter 的 name/description 可选），或目录/单文件 .md。
 */

// 团队规范统一放 .agent 目录：全局 ~/.agent/skills，项目 <repo>/.agent/skills
const DEFAULT_GLOBAL_DIRS = [
  path.join(os.homedir(), ".agent", "skills"),
];

const DEFAULT_PROJECT_DIRS = [".agent/skills"];

/** 解析 SKILL.md 的 front-matter（name/description） */
function parseFrontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const meta = {};
  if (m) {
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
      if (kv) meta[kv[1]] = kv[2].trim();
    }
  }
  return { meta, body: m ? text.slice(m[0].length).trim() : text.trim() };
}

function readSkillFromMd(file) {
  try {
    const { meta, body } = parseFrontMatter(fs.readFileSync(file, "utf8"));
    if (!body) return null;
    const base = path.basename(file).replace(/\.md$/, "");
    return {
      name: meta.name || (base === "SKILL" ? path.basename(path.dirname(file)) : base),
      description: meta.description || "",
      body,
      source: file,
    };
  } catch { return null; }
}

function scanDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const skills = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const skillMd = path.join(dir, e.name, "SKILL.md");
      if (fs.existsSync(skillMd)) {
        const s = readSkillFromMd(skillMd);
        if (s) skills.push(s);
      } else {
        // 目录内所有 .md 视为一个规则集
        const mds = fs.readdirSync(path.join(dir, e.name)).filter((f) => f.endsWith(".md"));
        for (const f of mds) {
          const s = readSkillFromMd(path.join(dir, e.name, f));
          if (s) skills.push(s);
        }
      }
    } else if (e.name.endsWith(".md") && e.name !== "README.md") {
      const s = readSkillFromMd(path.join(dir, e.name));
      if (s) skills.push(s);
    }
  }
  return skills;
}

/** 读取某仓库生效的团队规则；cfg.globalDirs 提供时替换默认全局目录 */
export function loadRules(repoDir, cfg = {}) {
  const useProject = cfg.perProject !== false;
  const globalDirs = cfg.globalDirs ? cfg.globalDirs : DEFAULT_GLOBAL_DIRS;
  const projectDirs = useProject && repoDir
    ? (cfg.projectDirs || DEFAULT_PROJECT_DIRS).map((d) => path.join(repoDir, d))
    : [];
  const seen = new Set();
  const skills = [];
  for (const dir of [...globalDirs, ...projectDirs]) {
    for (const s of scanDir(dir)) {
      if (seen.has(s.source)) continue;
      seen.add(s.source);
      skills.push(s);
    }
  }
  return skills;
}

/** 拼接为可注入 prompt 的规则文本。总长 maxChars；单条上限 perSkill；
 *  项目规则（source 在 repoDir 下）排在最前，避免被全局长文档挤掉。 */
export function rulesToPromptText(skills, maxChars = 8000, repoDir = "", perSkill = 3000) {
  if (!skills.length) return "";
  const sorted = repoDir
    ? [...skills].sort((a, b) => (a.source.startsWith(repoDir) ? 0 : 1) - (b.source.startsWith(repoDir) ? 0 : 1))
    : skills;
  let out = "## 团队审阅规范（必须遵守）\n";
  let budget = maxChars - out.length;
  for (const s of sorted) {
    if (budget <= 200) { out += "\n（更多规范因长度限制未注入）"; break; }
    let body = s.body;
    let block = "### " + s.name + (s.description ? "：" + s.description : "") + "\n" + body + "\n";
    if (block.length > perSkill) {
      block = "### " + s.name + (s.description ? "：" + s.description : "") + "\n" + body.slice(0, perSkill - 60) + "\n…（该规范超长已截断）\n";
    }
    if (block.length > budget) { out += "\n（更多规范因长度限制未注入）"; break; }
    out += "\n" + block;
    budget -= block.length + 1;
  }
  return out;
}
