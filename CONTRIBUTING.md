# 参与贡献

感谢关注。提 Issue 或 PR 之前，请先看下面几条。

## 提 Issue

- **不要贴 API Key、登录 token、Cookie 或真实对话内容。** 截图前先打码。
- Bug 请写明：扩展版本（`chrome://extensions` 上可见）、Chrome 版本、场景（普通对话 / 7 天不活跃的对话 / 多标签页）、预期结果和实际结果。
- 官网改版导致无法挂载或导入时，请附上浏览器控制台里的报错信息。如果要附接口返回的数据，先删掉其中的正文。

## 开发环境

- Node.js 24 或更新版本
- 运行 `test:browser` 和 `e2e` 需要本机安装 Chrome。也可以用 `CHROME_PATH` 指定可执行文件路径。

```bash
npm ci
npm run dev
```

## 提交 PR 前

请确保以下检查全部通过（CI 也会运行前四项）：

```bash
npm run typecheck
npm test
npm run build
npm run test:browser
npm run e2e
```

- 新功能或修复请补充测试。纯逻辑放在 `src/core/`，测试放在 `tests/`；涉及页面交互的，在 `e2e/regression.mjs` 里加场景。
- 测试数据必须是合成的，不要提交任何真实对话、真实会话 ID 或 Key。
- 对官网保持只读：不要新增对 `chat.deepseek.com` 的写请求。
- 构建产物必须保持纯 ASCII（`wxt.config.ts` 已设置），否则 Chrome 会拒绝加载内容脚本。
- 改动价格表（`src/core/pricing.ts`）时，请注明官方文档的日期和链接。
- 更新 [CHANGELOG.md](CHANGELOG.md) 的 Unreleased 一节。

## 提交信息

建议使用简短的英文祈使句，例如 `Fix citation markers inside formulas`。一个 PR 只做一件事。

## 许可

提交贡献即表示你同意按本项目的 [MIT 许可证](LICENSE) 授权你的代码。
