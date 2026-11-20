import { browser } from 'wxt/browser';
import { MODELS } from './core/client';

export interface Settings {
  apiKey: string;
  model: string;
  thinking: boolean;
  maxTokens: number;
  /** 智能搜索：声明 deepseek_web_search 和 deepseek_read_url。 */
  search: boolean;
}

/** 0 表示不传 max_tokens，跟随官方默认（非思考 8K，思考 64K）。与 deepseek-api-mode-android 的选项一致，并保留旧版可选值。 */
export const OUTPUT_LIMITS = [0, 4_096, 8_192, 16_384, 32_768, 65_536];
const DEFAULTS: Settings = { apiKey: '', model: MODELS[0], thinking: true, maxTokens: 0, search: false };

export async function loadSettings(): Promise<Settings> {
  const saved = await browser.storage.local.get<Settings>(DEFAULTS);
  return { ...saved, maxTokens: OUTPUT_LIMITS.includes(saved.maxTokens) ? saved.maxTokens : DEFAULTS.maxTokens };
}

export const saveSettings = (patch: Partial<Settings>) => browser.storage.local.set(patch);
