// 价格与 token 估算，依据 api-docs.deepseek.com 的「模型 & 价格」和「Token 用量计算」（2026-11-20 核对）。
// 只用于提示；实际扣费以 API 返回的用量为准。与 deepseek-api-mode-android 的 Pricing.java 保持一致。
import { FLASH_MODEL, type Usage, type WireMessage } from './client';

export const CONTEXT_TOKENS = 1_000_000;
/** 图像理解文档：单张图片约占 1,024 个输入 token。 */
export const IMAGE_TOKENS = 1_024;

// 高峰时段每百万 token 的价格：缓存命中输入、缓存未命中输入、输出。空闲时段减半。
const PRICES: Record<string, [number, number, number]> = {
  [FLASH_MODEL]: [0.04, 2, 8],
  'deepseek-v4-pro': [0.3, 9, 27],
};
const prices = (model: string) => PRICES[model] ?? PRICES[FLASH_MODEL]!;

/** 中文等宽字符约 0.6 token，其余字符约 0.3 token。 */
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) tokens += ch.codePointAt(0)! >= 0x2e80 ? 0.6 : 0.3;
  return Math.ceil(tokens);
}

/**
 * 估算一次请求的输入 token：正文、回放的思考、工具记录和每条消息的固定开销。
 * 文件解析出的内容无法预先计量，图片另按 IMAGE_TOKENS 计入。
 */
export function estimateRequest(messages: WireMessage[], images = 0): number {
  let total = images * IMAGE_TOKENS;
  for (const m of messages) {
    total += 4;
    if (typeof m.content === 'string') total += estimateTokens(m.content);
    else for (const part of m.content) if (part.type === 'text') total += estimateTokens(part.text);
    if (m.role === 'assistant') {
      total += estimateTokens(m.reasoning_content);
      if (m.server_tool_calls?.length) total += estimateTokens(JSON.stringify(m.server_tool_calls));
    }
  }
  return total;
}

/** 不传 max_tokens 时 API 的默认输出上限：非思考 8K，思考 64K（max 强度 128K）。 */
export const defaultOutput = (thinking: boolean, effort = 'high') => (!thinking ? 8_192 : effort === 'max' ? 131_072 : 65_536);

/** 北京时间工作日 9:00–12:00、14:00–18:00。无法判断法定节假日，一律按高峰，保证「最多」成立。 */
export function isPeak(date: Date): boolean {
  const beijing = new Date(date.getTime() + 8 * 3_600_000);
  const day = beijing.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = beijing.getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

const scale = (cost: number, peak: boolean) => (peak ? cost : cost / 2);

/** 上限：全部输入未命中缓存，回复用满输出上限。 */
export const maxCost = (model: string, input: number, output: number, peak: boolean) => {
  const [, miss, out] = prices(model);
  return scale((input * miss + output * out) / 1_000_000, peak);
};

export const actualCost = (model: string, usage: Usage, peak: boolean) => {
  const [hit, miss, out] = prices(model);
  const cached = Math.min(usage.cacheHit, usage.prompt);
  return scale((cached * hit + (usage.prompt - cached) * miss + usage.completion * out) / 1_000_000, peak);
};

/** 「¥0.31」「¥0.012」：小额保留三位小数，避免看起来像免费。 */
export function yuan(value: number): string {
  if (value > 0 && value < 0.001) return '<¥0.001';
  return `¥${value.toFixed(value < 0.1 ? 3 : 2)}`;
}

/** 一万以下写「8,000 token」，以上写「15.2 万 token」。 */
export const tokens = (value: number) =>
  value < 10_000 ? `${value.toLocaleString('en-US')} token` : `${(value / 10_000).toFixed(1)} 万 token`;
