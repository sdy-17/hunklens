# ai-reviewer

AI 辅助代码审阅器 —— 本地 Web 应用。需求文档见上层目录《AI-代码审阅助手-需求文档.md》。

## 功能（M3 完成度）

- 自动扫描启动目录下所有 git 项目，项目/分支下拉切换
- base ← compare 分支 three-dot diff；支持 fetch/pull 拉取远程、checkout 切分支
- Split（左右分栏）/ Unified（行内）两种 diff 视图
- **AI 逐 hunk 分析**（SSE 流式批量，并发 3）：目的 / severity 分级（blocker/warning/info）/ 问题清单 / 优化建议，锚定在 hunk 旁的悬浮气泡
- 气泡内可直接「追问」，hunk 可标记 需修改/忽略
- 文件级审阅标记 ✅⚠️❌ + 总进度 + blocker 计数（防遗漏）
- AI 总览报告（整体意图、风险清单可点击跳转、测试建议）
- 审阅状态持久化 + hunk 分析结果磁盘缓存（.cache/，二次打开秒出）
- 一键导出 markdown review 结论（有未处理 blocker 时拦截确认）

## 使用

    npm install
    cp config.example.json config.local.json   # 填入 baseURL/apiKey/model
    npm start -- --dir /path/to/工作目录       # 默认扫描启动目录
    # 打开 http://localhost:7788

## 测试

    npm test   # 5 个单测：scanner / diffparse / AI mock（OpenAI 兼容协议、重试）/ skip 规则

## 技术栈

Node 24 + Express + simple-git；前端原生 JS（无构建）；LLM 走 OpenAI 兼容协议（DeepSeek/OpenAI/Ollama 均可）。

> prompt 设计参考 PR-Agent 的 reviewer 角色设定；skip 规则参考 CodeRabbit/PR-Agent 的通用排除清单。
