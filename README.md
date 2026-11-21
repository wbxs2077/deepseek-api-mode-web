# API 续聊 for DeepSeek（网页插件）

[![CI](https://github.com/wbxs2077/deepseek-api-mode-web/actions/workflows/ci.yml/badge.svg)](https://github.com/wbxs2077/deepseek-api-mode-web/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.en.md) · [免责声明](DISCLAIMER.md) · [更新日志](CHANGELOG.md) · [参与贡献](CONTRIBUTING.md)

> **非官方工具，与 DeepSeek 无关联。** 依赖官网未公开的接口和页面结构，官网改版时可能失效。发送消息按你自己的 API Key 计费。使用前请阅读[免责声明](DISCLAIMER.md)。

一个 Chrome 扩展（Manifest V3）。在 `chat.deepseek.com` 的原对话页底部切换「官网 / API」。切到 API 后，在原输入框的位置提问，扩展用你自己的 [DeepSeek 开放平台](https://platform.deepseek.com/) API Key 续聊。新回复接在官网历史末尾，和旧消息一起滚动，只保存在本机，官网对话不会被修改。

**适用场景：** 官网因算力不足，不再支持 7 天不活跃的长对话，旧消息仍可查看。用这个扩展可以在原页面接着聊。

同类的 Android 版本见 [deepseek-api-mode-android](https://github.com/wbxs2077/deepseek-api-mode-android)。

## 功能

- 原页面内切换「官网 / API」，两边草稿互不影响
- 流式回复、深度思考（可选低/高/最高三档强度）、智能搜索（联网搜索与读链接），带引用角标和来源列表
- 附件：📎 选择、拖拽、粘贴截图；PDF/Word/PPT 用图文混排解析
- 可选带上官网历史里的图片
- 发送前显示估算花费，每条回复显示用量和「本条约 ¥x」，弹窗内查询余额
- 公式排版（KaTeX）、代码块复制、提问复制
- 编辑最后一条提问、重新生成、停止与重试；断流与截断有标注
- 官网有新消息时提示重新导入或继续用旧快照

## 安装

暂未上架 Chrome 应用商店，需从源码构建，或下载 [Releases](https://github.com/wbxs2077/deepseek-api-mode-web/releases) 里的 zip。

### 从源码构建

需要 Node.js 24 或更新版本。

```bash
git clone https://github.com/wbxs2077/deepseek-api-mode-web.git
cd deepseek-api-mode-web
npm ci
npm run build        # 产物在 .output/chrome-mv3/
```

### 加载到 Chrome

1. 打开 `chrome://extensions`，开启右上角的「开发者模式」。
2. 点「加载已解压的扩展程序」，选择 `.output/chrome-mv3` 文件夹（用 Releases 的 zip 时，选择解压后的文件夹）。
3. 更新时，在扩展卡片上点「重新加载」，再刷新已打开的 DeepSeek 页面。

## 使用

1. 点工具栏的扩展图标，在弹窗里填 API Key。建议用一个专用、余额有限的 Key。弹窗里会显示账户余额，还可以选默认模型、深度思考、思考强度、智能搜索和输出上限。思考强度有低、高、最高三档，默认高，只在开启深度思考时生效。输出上限默认跟随官方，开深度思考时最多 64K tokens，最高强度时最多 128K。
2. 打开一条对话，在输入框上方点「API」。官方输入框换成 API 输入框。
3. 第一次在某条对话切到 API 时，历史末尾会显示确认卡，列出：
   - 消息数和估算的上下文 token
   - 按当前导入历史估算的每次发送花费
   - 跳过的内容和分支的最后一条消息

   官网历史里有图片时，可以勾选「带上官网历史里的 N 张图片」。点「确认并开始」后，扩展保存一份快照，并把勾选的图片转存到你的 API 账号。
4. 发送后回复流式显示。回复下方有复制、重新生成、用量和「本条约 ¥x」。最后一条提问可以编辑，编辑后替换它和其后的回复。
5. 切回「官网」后，官方输入框和原草稿都会恢复。API 回复仍显示，末尾会提示这些回复只在本机，在官网发送时不会带上。已有本机回复的对话再次打开时，默认处于 API 模式。
6. 如果导入之后你又在官网继续聊过，再切到 API 时会让你选：重新导入（删除本机回复），或继续用旧快照。
7. **附件**：点输入框里的 📎、把文件拖到页面上，或在 API 输入框里粘贴截图。每条消息最多 20 个。
8. **智能搜索**：打开后由模型自行判断是否搜索，也会阅读你贴的链接。回复正文带编号角标，下方可展开来源。
9. 每条新提问会附带当天日期和星期（`latest_reminder`），让模型知道「今天」是哪天。

### 费用

每次发送都会把导入的消息和本机回合一起发往 `api.deepseek.com`，按你的 Key 计费。确认卡上的金额只按**当前导入的历史**估算：假设全部输入都没命中缓存，回复也用满输出上限。token 数是估算值，附件解析出的内容不计入；后续提问和新回合会让上下文变长，每次发送的花费也会随之增加。连续追问时大部分历史能命中缓存，实际按用量扣费，以开放平台账单为准。价格表在 [`src/core/pricing.ts`](src/core/pricing.ts)。

### 附件格式

| 文件 | 处理 | API 上传用途 |
| --- | --- | --- |
| JPEG、PNG、GIF、WebP | 原样上传 | `user_data`，上限 64 MB |
| BMP、AVIF、SVG、ICO | 在本机转成 PNG 后上传 | `user_data` |
| TIFF | 只识别其中的文字 | `text_recognition` |
| PDF、Word、PowerPoint | 图文混排解析，文档里的图表也交给模型 | `rich_layout_recognition`，上限 100 MB |
| 文本、代码、CSV、JSON、Excel、EPUB、MOBI | 上传，表格和电子书由服务端转成 Markdown | `user_data`，上限 32 MB |
| PSD、HEIC 等 | 选择时提示不支持 | — |

- 文件上传到你 API 账号的 Files API，**不会上传到官网**。
- 有图片或文件的对话，以及开了智能搜索的提问，会自动改用 `deepseek-flash`（只有它能读图片），输入框下方会提示。
- 移除附件、删除本机记录或重新导入时，扩展会从你的 API 账号删除不再引用的文件。删除失败时，可以在弹窗里重试。

## 权限与隐私

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存 API Key 和设置 |
| `chat.deepseek.com` | 在对话页挂载界面，读取当前对话的历史 |
| `api.deepseek.com` | 调用开放 API：对话、上传/删除文件、查询余额 |
| `files.deepseeksvc.com` | 读取官网历史图片的预览图（仅在你勾选「带上图片」时） |

- **API Key** 存在 `chrome.storage.local`，访问级别为 `TRUSTED_CONTEXTS`，DeepSeek 页面和内容脚本都读不到，只发往 `api.deepseek.com`。Key 在磁盘上**没有加密**。
- **官网登录态**：内容脚本读取页面的 `localStorage.userToken`，只用于同源读取 `GET /api/v0/chat/history_messages`。登录态不离开页面，也不交给扩展后台。
- 扩展**不调用任何官网写接口**。官网对话不会被修改，官网也看不到 API 回复。
- 对话记录保存在扩展的 IndexedDB 里，只在本机。
- **无遥测、无统计**，除上表列出的域名外不访问其他网络。
- 回复中的 Markdown 图片和外部资源默认过滤；链接在新标签页打开。

## 已知限制

- `history_messages` 是未公开接口，页面挂载也依赖官网的页面结构。官网改版后可能无法导入或挂载，这时扩展会停下并提示。
- 官网历史里只有图片能带过来，用的是预览图。历史文档带不过来，模型只能看到占位说明。
- 只导入服务端记录的当前分支。编辑和重新生成直接覆盖，不保留本地分支，并且只能编辑最后一条提问。
- 没有截断和摘要。超出 API 的 1M tokens 上下文时，请求会失败。
- 文件上传期间关闭页面，服务端可能已经解析并计费，但扩展没拿到文件 ID，这样的文件不会被自动删除。
- 界面目前只有中文。

## 开发

```bash
npm ci
npm run dev           # 开发模式，自动重载
npm test              # 单元测试（Vitest，不访问网络）
npm run typecheck     # 类型检查
npm run build         # 生产构建
npm run test:browser  # 挂载测试（需要本机 Chrome）
npm run e2e           # 构建后跑完整回归（需要本机 Chrome）
npm run zip           # 打包 Releases 用的 zip
```

`test:browser` 和 `e2e` 用 Playwright 驱动本机安装的 Chrome，默认用 `chrome` 通道，也可以用 `CHROME_PATH` 指定路径。端到端测试全部使用合成页面和模拟的 API，不需要登录，也不产生费用，报告写到 `e2e/reports/`。

### 架构

```
chat.deepseek.com 对话页
  └─ content script（Preact，渲染在 closed shadow root 里）
       · <ds-api-thread>：续聊区，放在虚拟列表之后，同一滚动容器内
       · <ds-api-composer>：分段控件和 API 输入框，放在 sticky 输入区里
       · 同源 GET history_messages（登录态不出 content script）
            │ runtime 消息；流式增量和附件分块走长连接
  background service worker
       · 只接受 chat.deepseek.com 顶层页面、且会话 ID 与地址一致的消息
       · 读 Key 和设置，读写 IndexedDB，流式请求 api.deepseek.com
       · 上传与删除文件；读取官网历史图片并转存
  popup：API Key、余额、默认设置、待删除文件
```

| 路径 | 职责 |
| --- | --- |
| `src/core/` | 与浏览器扩展接口无关的逻辑：历史解析（`tree.ts`、`transcript.ts`）、请求组装（`request.ts`）、流式客户端（`client.ts`、`sse.ts`）、续聊流程（`chat.ts`）、存储（`store.ts`）、附件（`files.ts`）、价格（`pricing.ts`） |
| `src/entrypoints/background.ts` | 消息校验和路由、长连接、文件清理，同一会话的写操作用 Web Locks 互斥 |
| `src/entrypoints/deepseek.content/` | 挂载（`mount.ts`）、界面（`App.tsx`）、附件上传（`attachments.ts`）、读历史（`history.ts`） |
| `src/entrypoints/popup/` | 设置弹窗 |
| `src/ui/` | Markdown 渲染与净化、公式、引用角标、代码复制 |
| `tests/` | 单元测试。`fixtures/history.json` 是按接口结构手写的合成数据 |
| `e2e/` | 生产构建的端到端回归 |

官网改版时，通常需要修改的地方：
- 历史接口的字段变了：改 `tree.ts` 和 `transcript.ts`，并更新测试夹具。
- 页面结构变了：改 `mount.ts`。挂载只依赖 `ds-virtual-list` 这类语义类名和节点结构。

## 参与贡献

欢迎提 Issue 和 PR，请先读 [CONTRIBUTING.md](CONTRIBUTING.md)。**提 Issue 时不要贴 API Key、登录信息或真实对话内容。** 安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

[MIT](LICENSE) © 2026 wbxs2077。打包进扩展的第三方库的许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

「DeepSeek」是其权利人的商标。本项目与 DeepSeek 没有关联，也未获其认可。
