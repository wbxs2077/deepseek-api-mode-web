# 更新日志

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.3.3] - 2026-11-20

首次公开发布。

### Changed
- 扩展显示名改为「API 续聊 for DeepSeek（非官方）」，弹窗注明非官方。
- KaTeX 升级到 0.19，修复一个低危安全公告（GHSA-238p-pmpm-9mq7）。
- 端到端回归移入仓库（`e2e/`），Playwright 作为开发依赖，Chrome 路径可用 `CHROME_PATH` 配置。

## [0.3.2] - 2026-11-20

### Added
- 首次确认卡显示估算的上下文 token 和「每次发送预计最多约 ¥x」。
- 每条回复显示「本条约 ¥x」，按返回的用量（含缓存命中）和时段换算。
- 弹窗查询账户余额。
- 公式排版（KaTeX，MathML 输出）、代码块「复制代码」、提问「复制提问」。
- 官网模式下提示本机 API 回复不会随官网发送。

### Changed
- 输出上限默认「跟随官方」（不传 `max_tokens`）。
- 构建输出限定为 ASCII，避免 Chrome 拒绝加载含 U+FFFF 的内容脚本。

## [0.3.1] - 2026-11-20

### Fixed
- 连续取消上传后名额不释放。
- 远端文件删除失败时缺少提示和重试；切换会话后遗留未发送的附件。
- 跨标签页发送时用错设置。
- 联网搜索多步思考在追问时重复回放。
- 历史图片部分转存失败后无法补传。

## [0.3.0] - 2026-11-20

### Added
- 附件：📎 选择、拖拽、粘贴截图；PDF/Word/PPT 图文混排解析；不支持的图片格式在本机转 PNG。
- 可选带上官网历史里的图片。
- 智能搜索（`deepseek_web_search` + `deepseek_read_url`），引用角标和来源列表。
- 每条提问附带 `latest_reminder`（日期与星期）。

## [0.2.x] - 2026-11-20

### Changed
- 从侧栏改为在原对话页内切换「官网 / API」，回复接在官网历史末尾。
- 官网有新消息时提示重新导入或继续用旧快照；编辑与删除在多标签下有版本核对。

## [0.1.x] - 2026-11-19

### Added
- 首个原型：侧栏导入当前对话，用 API Key 续聊。

[Unreleased]: https://github.com/wbxs2077/deepseek-api-mode-web/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/wbxs2077/deepseek-api-mode-web/releases/tag/v0.3.3
