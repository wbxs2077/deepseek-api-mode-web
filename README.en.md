# API Continue for DeepSeek (browser extension)

[![CI](https://github.com/wbxs2077/deepseek-api-mode-web/actions/workflows/ci.yml/badge.svg)](https://github.com/wbxs2077/deepseek-api-mode-web/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[中文](README.md) · [Disclaimer](DISCLAIMER.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

> **Unofficial. Not affiliated with DeepSeek.** It relies on an undocumented endpoint and the site's page structure, so a redesign may break it. Messages are billed to your own API key. Read the [disclaimer](DISCLAIMER.md) first.

A Chrome (Manifest V3) extension. On a `chat.deepseek.com` conversation page it adds an "Official / API" switch above the input box. In API mode you keep typing in the same place. The extension continues the conversation with your own [DeepSeek Platform](https://platform.deepseek.com/) API key. New replies are appended below the official history, stored only on your machine, and never written back to the site.

Typical use: the website stops continuing long conversations that have been inactive for 7 days, but the old messages stay readable. This extension lets you continue them in place.

The UI is in Chinese. An Android counterpart is at [deepseek-api-mode-android](https://github.com/wbxs2077/deepseek-api-mode-android).

## Features

- In-page "Official / API" switch with separate drafts
- Streaming, reasoning with low/high/max effort, smart search (web search and URL reading) with citations
- Attachments: picker, drag and drop, pasted screenshots. PDF, Word and PowerPoint use layout-aware parsing.
- Optionally carries images from the official history
- Shows an estimated cost before sending, the cost of each reply, and your balance in the popup
- KaTeX formulas, code-block copy, question copy
- Edit the last question, regenerate, stop and retry

## Install

Not on the Chrome Web Store yet. Build from source (Node.js 24+), or download a zip from [Releases](https://github.com/wbxs2077/deepseek-api-mode-web/releases).

```bash
git clone https://github.com/wbxs2077/deepseek-api-mode-web.git
cd deepseek-api-mode-web
npm ci
npm run build        # output: .output/chrome-mv3/
```

Then open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick `.output/chrome-mv3`. Click the toolbar icon to enter your API key. The popup also sets the default model, deep thinking, reasoning effort (low, high or max; default high, used only while deep thinking is on), smart search and the output limit.

## Permissions and privacy

- `storage`: holds the API key and settings. The key is stored unencrypted in `chrome.storage.local` with `TRUSTED_CONTEXTS` access. Page scripts cannot read it, and it is only sent to `api.deepseek.com`.
- `chat.deepseek.com`: mounts the UI and reads the current conversation with `GET /api/v0/chat/history_messages`. The site's login token is used only inside the page for that same-origin request. The extension never calls any write endpoint on the site.
- `api.deepseek.com`: chat completions, file upload and delete, balance.
- `files.deepseeksvc.com`: preview images from the official history, only when you opt in.
- Conversations live in the extension's IndexedDB on your machine. There is no telemetry.

## Cost

Every send includes the imported history and the local turns, billed to your key. The amount shown before you start is an estimate for the currently imported history only: it assumes no input hits the cache and the reply uses the full output limit. Token counts are estimated and parsed attachment content is not included. Later questions and new turns make the context longer, so each send costs more. Much of the history usually hits the cache on follow-ups; you are billed by actual usage, as shown on the API platform. The price table is in [`src/core/pricing.ts`](src/core/pricing.ts).

## Development

```bash
npm test              # unit tests (Vitest, offline)
npm run typecheck
npm run build
npm run test:browser  # mount tests, needs a local Chrome
npm run e2e           # build + end-to-end regression, needs a local Chrome
```

The end-to-end suites use synthetic pages and a mocked API. They need no login and cost nothing. Set `CHROME_PATH` to choose the Chrome binary.

## License

[MIT](LICENSE) © 2026 wbxs2077. Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). "DeepSeek" is a trademark of its owner; this project is not affiliated with or endorsed by DeepSeek.
