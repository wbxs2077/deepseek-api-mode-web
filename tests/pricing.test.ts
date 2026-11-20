import { describe, expect, it } from 'vitest';
import { parseBalance } from '../src/core/client';
import {
  actualCost, defaultOutput, estimateRequest, estimateTokens, IMAGE_TOKENS, isPeak, maxCost, tokens, yuan,
} from '../src/core/pricing';
import { mathRanges } from '../src/ui/math';
import { withCitations } from '../src/ui/citations';

// 北京时间 = UTC+8。2026-11-20 是星期五。
const beijing = (day: number, hour: number) => new Date(Date.UTC(2026, 10, day, hour - 8, 0));

describe('pricing', () => {
  it('estimates tokens like deepseek-api-mode-android', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens('中文字')).toBe(2);
    expect(estimateTokens('abcdefghij')).toBe(3);
    expect(estimateRequest([{ role: 'user', content: 'abcdefghij' }])).toBe(4 + 3);
    expect(estimateRequest([{ role: 'user', content: [{ type: 'file', file_id: 'f' }, { type: 'text', text: '中文字' }] }], 1))
      .toBe(IMAGE_TOKENS + 4 + 2);
    expect(estimateRequest([{ role: 'assistant', content: '', reasoning_content: 'abcdefghij' }])).toBe(4 + 3);
  });

  it('knows the Beijing peak hours', () => {
    expect(isPeak(beijing(20, 10))).toBe(true);
    expect(isPeak(beijing(20, 13))).toBe(false);
    expect(isPeak(beijing(20, 17))).toBe(true);
    expect(isPeak(beijing(20, 18))).toBe(false);
    expect(isPeak(beijing(21, 10))).toBe(false);
  });

  it('prices the upper bound and the reported usage', () => {
    expect(maxCost('deepseek-flash', 150_000, 8_192, true)).toBeCloseTo(0.3 + 0.065536, 9);
    expect(maxCost('deepseek-flash', 150_000, 8_192, false)).toBeCloseTo((0.3 + 0.065536) / 2, 9);
    expect(maxCost('deepseek-v4-pro', 1_000_000, 0, true)).toBeCloseTo(9, 9);
    expect(actualCost('deepseek-flash', { prompt: 2_000_000, cacheHit: 1_000_000, completion: 1_000_000 }, true)).toBeCloseTo(10.04, 9);
    expect(actualCost('deepseek-v4-pro', { prompt: 1_000_000, cacheHit: 1_000_000, completion: 0 }, false)).toBeCloseTo(0.15, 9);
    expect(defaultOutput(false)).toBe(8_192);
    expect(defaultOutput(true)).toBe(65_536);
    expect(defaultOutput(true, 'max')).toBe(131_072);
  });

  it('formats amounts and token counts', () => {
    expect(yuan(0.3655)).toBe('¥0.37');
    expect(yuan(0.0123)).toBe('¥0.012');
    expect(yuan(0)).toBe('¥0.000');
    expect(yuan(0.0004)).toBe('<¥0.001');
    expect(tokens(8_000)).toBe('8,000 token');
    expect(tokens(152_000)).toBe('15.2 万 token');
  });

  it('summarizes the balance response', () => {
    expect(parseBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00' }] }))
      .toEqual({ available: true, total: '¥110.00' });
    expect(parseBalance({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }, { currency: 'USD', total_balance: '1.00' }] }))
      .toEqual({ available: false, total: '¥0.00 / $1.00' });
    expect(parseBalance(null)).toEqual({ available: false, total: '无余额信息' });
  });
});

describe('math ranges', () => {
  it('finds display and inline formulas but not prices', () => {
    const text = '面积 $S=\\pi r^2$，另有\n$$E=mc^2$$\n价格 $5 和 $10';
    const found = mathRanges(text).map(([a, b]) => text.slice(a, b));
    expect(found).toContain('$S=\\pi r^2$');
    expect(found).toContain('$$E=mc^2$$');
    expect(found.some((s) => s.includes('$5'))).toBe(false);
  });

  it('keeps citation markers out of formulas', () => {
    const text = '公式 $a+b$ 结束';
    // 引用末尾落在公式中间时，角标挪到公式之后。
    const end = [...'公式 $a+'].length;
    const { text: cited } = withCitations(text, [{ url: 'https://example.test/x', title: 'x', start: 0, end }]);
    expect(cited).toContain('$a+b$ [\\[1\\]]');
  });
});
