# 安全策略 / Security Policy

## 报告漏洞

请**不要**在公开 Issue 里描述安全漏洞。请使用 GitHub 的私密漏洞报告：在仓库的 **Security** 页点 **Report a vulnerability**。

报告里请写明受影响的版本、复现步骤和影响范围。**不要附上真实的 API Key、登录信息或对话内容。** 收到报告后，会尽快确认并修复。

## 敏感数据说明

- API Key 保存在 `chrome.storage.local`，访问级别为 `TRUSTED_CONTEXTS`，只发往 `api.deepseek.com`。Key 在磁盘上没有加密，建议使用专用、余额有限的 Key，必要时在开放平台随时作废。
- 官网登录态只在页面内用于读取当前对话历史，不交给扩展后台，也不发往其他地方。
- 对话记录只保存在本机的扩展 IndexedDB 里。

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private reporting (**Security → Report a vulnerability**). Never include real API keys, login tokens, or conversation content.
