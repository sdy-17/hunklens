# ai-reviewer

AI 辅助代码审阅器 —— 本地 Web 应用。见需求文档 v0.2。

## 使用

    npm install
    npm start -- --dir /path/to/workdir   # 默认扫描启动目录
    # 打开 http://localhost:7788

## 配置 LLM（config.local.json）

    { "provider": "openai-compatible", "baseURL": "https://api.deepseek.com/v1", "apiKey": "sk-...", "model": "deepseek-chat" }
