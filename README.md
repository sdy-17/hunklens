# HunkLens — AI 辅助本地代码审阅工具

> 给被 AI 生成代码淹没的 Reviewer 用的：本地 Web 界面看分支 diff，**AI 逐块分析每处改动**（目的 / 问题 / 优化建议），结果以悬浮气泡直接锚在改动旁边。

![Node](https://img.shields.io/badge/node-%E2%89%A518-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## 它解决什么问题

AI 写代码的时代，一个人一天要 review 的 diff 多到看不过来：逐文件读太慢，还容易漏。HunkLens 把 review 变成：

1. 选仓库、选两个分支 → 左右分栏（或行内）看 diff，体验同 GitLab；
2. 点「AI 分析」→ 每一处改动（hunk）旁边出现气泡：**这段改动的目的、有没有问题、severity、怎么改更好**；
3. 气泡里可以**继续追问**；确认有问题的标记「需修改」，看完的标记「忽略」，全部处理完才允许导出结论，**防遗漏**；
4. 一键导出 Markdown review 结论。

所有分析结果落盘缓存，同一段 diff 只分析一次。

## 快速开始

```bash
git clone https://github.com/sdy-17/hunklens.git
cd hunklens
npm install
```

配置你的 LLM（OpenAI 兼容协议即可，DeepSeek / OpenAI / 通义 / 本地 Ollama 均可）：

```bash
cp config.example.json config.local.json
# 编辑 config.local.json：
```

```json
{
  "provider": "openai-compatible",
  "baseURL": "https://api.deepseek.com/v1",
  "apiKey": "sk-你的key",
  "model": "deepseek-chat"
}
```

启动（`--dir` 指定要扫描的代码根目录，其下两级内的 git 仓库都会出现在下拉框里）：

```bash
npm start -- --dir ~/work
```

打开 http://localhost:7788 → 选仓库和分支 → 「生成 Diff」→「AI 分析」→ 点改动旁的 🤖 看气泡。

## 核心功能

| 功能 | 说明 |
|---|---|
| 分栏 / 行内 diff | split 和 unified 两种模式一键切换，删增行自动配对 |
| 分支对比 | 本地任意两分支 three-dot 对比；支持 fetch / pull / checkout |
| AI 逐块分析 | 每个 hunk 返回 `{intent, severity: blocker\|warning\|info, issues[], suggestion, confidence}`，SSE 流式逐个返回，并发 3 |
| 悬浮气泡 | 意图 / 问题 / 建议直接锚在改动上；支持针对该 hunk 追问 |
| 审阅状态管理 | 「需修改 / 忽略」标记持久化；导出前有 blocker 或未标记会拦截确认 |
| 总览报告 | 全部 hunk 分析完可生成整体 summary + 风险清单 + 测试建议 |
| 结果缓存 | hunk 级磁盘缓存（内容寻址），重复分析零耗时零费用 |
| 导出结论 | Markdown 一键下载 |
| 团队规范注入 | 见下节，团队的 review 规范自动进入 AI prompt |

## 团队规范（skill 规则注入）

团队 review 规范统一放 `.agent` 目录，HunkLens **递归自动检测布局**并注入每次 AI 审阅的 prompt：

- **全局**：`~/.agent`　**项目**：仓库下 `.agent`
- 任意深度（≤5 层）的 `SKILL.md`（支持 front-matter `name` / `description`）和独立 `.md` 都能识别
- 项目规范排在最前；总注入 8000 字、单条 3000 字，超长自动截断
- 页面顶部徽标显示加载了几条，悬停可看清单

示例：

```
~/.agent/skills/js-style/SKILL.md
---
name: js-style
description: 团队 JS 规范
---
禁止 any；组件一律函数式；提交信息用中文。
```

目录结构不同或要多加目录时，在 `config.local.json` 覆盖：

```json
"rules": { "globalDirs": ["/path/to/team-skills"], "projectDirs": [".claude/skills"], "perProject": true }
```

> 注意：分析结果按 hunk 内容缓存，修改规范后请删除 `.cache/analysis` 重新分析。

## 配置参考

`config.local.json`（不入库）：

| 字段 | 说明 |
|---|---|
| `baseURL` | OpenAI 兼容 API 地址 |
| `apiKey` | 密钥 |
| `model` | 模型名 |
| `rules.globalDirs` | 全局规范目录数组（替换默认 `~/.agent`） |
| `rules.projectDirs` | 项目规范目录数组（替换默认 `.agent`） |
| `rules.perProject` | `false` 关闭项目级规范 |

启动参数：`npm start -- --dir <扫描根目录>`，端口默认 7788（`PORT=xxx` 可改）。

## 架构

```
public/            原生 HTML/CSS/JS 前端（零框架，双栏 diff 渲染 + SSE 气泡）
src/server/
  index.js         Express API（diff / SSE 分析 / 追问 / 总览 / 审阅状态 / 导出）
  scanner.js       扫描根目录下的 git 仓库（深度 2）
  git.js           simple-git 封装（分支 / checkout / fetch / three-dot diff）
  diffparse.js     unified diff 解析器
  analyze.js       hunk 收集、跳过规则（lock/dist/图片…）、并发池
  ai.js            OpenAI 兼容客户端、prompt 构建、严格 JSON 解析（重试 3 次）
  rules.js         团队规范加载（.agent 自动检测 + 长度预算）
  cache.js         hunk 级分析缓存（磁盘 JSON）
  reviewstore.js   审阅标记持久化
test/              node:test 单测
```

设计参考了 PR-Agent 的 prompt 纪律与 CodeRabbit 的产出形态（总览三段式 / severity 分级 / 路径过滤），但形态完全不同：不做平台机器人，纯本地、任何 git 仓库即开即用。

## 开发

```bash
npm test                          # 全部单测
node src/server/index.js --dir .  # 直接启动
```

## License

[MIT](LICENSE)
