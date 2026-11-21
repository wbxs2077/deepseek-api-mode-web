import { browser } from 'wxt/browser';
import { isEffort, MODELS, type Effort } from './core/client';

export interface Settings {
  apiKey: string;
  model: string;
  thinking: boolean;
  /** 思考强度，默认 high。关闭深度思考时保留，但不发送。 */
  effort: Effort;
  maxTokens: number;
  /** 智能搜索：声明 deepseek_web_search 和 deepseek_read_url。 */
  search: boolean;
}

/** 0 表示不传 max_tokens，跟随官方默认（非思考 8K，思考 64K，最高强度 128K）。与 deepseek-api-mode-android 的选项一致，并保留旧版可选值。 */
export const OUTPUT_LIMITS = [0, 4_096, 8_192, 16_384, 32_768, 65_536];
const DEFAULTS: Settings = { apiKey: '', model: MODELS[0], thinking: true, effort: 'high', maxTokens: 0, search: false };

/** 旧版本没有 effort，按 high 补上；其余已存的值（包括 thinking）原样保留。 */
export async function loadSettings(): Promise<Settings> {
  const saved = await browser.storage.local.get<Settings>(DEFAULTS);
  return {
    ...saved,
    effort: isEffort(saved.effort) ? saved.effort : DEFAULTS.effort,
    maxTokens: OUTPUT_LIMITS.includes(saved.maxTokens) ? saved.maxTokens : DEFAULTS.maxTokens,
  };
}

export const saveSettings = (patch: Partial<Settings>) => browser.storage.local.set(patch);
