import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

export default defineConfig({
  srcDir: 'src',
  // KaTeX 的词法正则含 U+FFFF。原样输出后，Chrome 认为内容脚本不是 UTF-8 而拒绝加载，所以输出只用 ASCII。
  vite: () => ({ plugins: [preact()], build: { rolldownOptions: { output: { charset: 'ascii' } } } }),
  manifest: {
    name: 'API 续聊 for DeepSeek（非官方）',
    description: '非官方工具：在 DeepSeek 原对话页切换到 API 模式，用自己的 API Key 续聊，新回复只存在本地。',
    permissions: ['storage'],
    // files.deepseeksvc.com：读取官网历史里的图片，转存到用户的 API 账号。
    host_permissions: ['https://chat.deepseek.com/*', 'https://api.deepseek.com/*', 'https://files.deepseeksvc.com/*'],
    action: { default_title: 'API 续聊 for DeepSeek（非官方）设置' },
  },
  hooks: {
    // Put LICENSE and THIRD_PARTY_NOTICES.md into every build; `wxt zip` builds first, then packs them.
    'build:done': async (wxt) => {
      const { copyLicenses } = await import('./scripts/copy-licenses.mjs');
      await copyLicenses(wxt.config.root, wxt.config.outDir);
    },
  },
});
