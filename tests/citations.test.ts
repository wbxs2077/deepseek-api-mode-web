import { describe, expect, it } from 'vitest';
import { queriesOf, sourcesOf, withCitations } from '../src/ui/citations';
import { readLimits } from '../src/entrypoints/deepseek.content/attachments';

const cite = (url: string, start: number, end: number) => ({ url, title: '', start, end });

describe('withCitations', () => {
  it('numbers sources by first use and inserts markers at code point offsets', () => {
    // 😀 占两个 UTF-16 单元，偏移按码点计。
    const text = '😀甲乙。丙丁。';
    const { text: out, cited } = withCitations(text, [cite('https://a.test/x', 0, 4), cite('https://b.test/', 4, 7), cite('https://a.test/x', 4, 7)]);
    expect(out).toBe('😀甲乙。 [\\[1\\]](https://a.test/x)丙丁。 [\\[2\\]](https://b.test/) [\\[1\\]](https://a.test/x)');
    expect(cited.map((c) => c.url)).toEqual(['https://a.test/x', 'https://b.test/']);
  });

  it('moves markers out of code and drops non-web or out-of-range links', () => {
    const text = '看 `a b` 和\n```\nx\n```\n完';
    const { text: out } = withCitations(text, [
      cite('https://a.test/', 0, 4),
      cite('https://b.test/', 0, 12),
      cite('javascript:alert(1)', 0, 1),
      cite('https://c.test/', 0, 999),
    ]);
    expect(out).toBe('看 `a b` [\\[1\\]](https://a.test/) 和\n```\nx\n``` [\\[2\\]](https://b.test/)\n完');
  });

  it('escapes characters that would break the link and keeps percent escapes', () => {
    const { text } = withCitations('x', [cite('https://a.test/a (b)%20c', 0, 1)]);
    expect(text).toBe('x [\\[1\\]](https://a.test/a%20%28b%29%20c)');
  });

  it('returns the text unchanged without annotations', () => {
    expect(withCitations('x', undefined)).toEqual({ text: 'x', cited: [] });
  });
});

describe('sourcesOf / queriesOf', () => {
  const calls = [
    { index: 0, calls: [{ kind: 'search', action: { type: 'search', queries: ['q1', 'q2'] },
      sources: [{ url: 'https://a.test/', title: 'A', site_name: 'Site A' }, { url: 'https://a.test/', title: 'dup' }, { url: 'ftp://x' }] }] },
    { index: 1, calls: [{ kind: 'read_link', action: { type: 'read_link', url: 'https://b.test/' }, page: { url: 'https://b.test/', title: '' } },
      { kind: 'search', action: { queries: ['q2'] } }] },
    'garbage',
  ];
  it('collects unique web sources and pages', () => {
    expect(sourcesOf(calls)).toEqual([
      { url: 'https://a.test/', title: 'A', site: 'Site A' },
      { url: 'https://b.test/', title: 'https://b.test/' },
    ]);
  });
  it('collects unique queries', () => {
    expect(queriesOf(calls)).toEqual(['q1', 'q2']);
  });
});

describe('readLimits', () => {
  const store = (value: unknown) => ({ getItem: () => (value === undefined ? null : JSON.stringify(value)) });
  it('reads the default mode from the doubly encoded official cache', () => {
    const configs = [
      { model_type: 'expert', file_feature: { max_input_file_count: 5, support_file_exts: ['pdf'] } },
      { model_type: 'default', is_default: true, file_feature: { max_input_file_count: 50, support_file_exts: ['PDF', 'py'] } },
    ];
    const limits = readLimits(store({ data: JSON.stringify({ model_configs: { value: JSON.stringify(configs) } }) }));
    expect(limits.maxCount).toBe(20);
    expect([...limits.accepted]).toEqual(['pdf', 'py']);
  });
  it('falls back without the cache', () => {
    expect(readLimits(store(undefined))).toEqual({ maxCount: 20, accepted: new Set() });
    expect(readLimits({ getItem: () => '{broken' })).toEqual({ maxCount: 20, accepted: new Set() });
  });
});
