import type { Annotation } from '../core/client';
import { mathRanges } from './math';

export interface Source {
  url: string;
  title: string;
  site?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isWebUrl = (raw: unknown): raw is string => {
  if (typeof raw !== 'string') return false;
  try {
    const { protocol } = new URL(raw);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
};

/** 从 server_tool_calls 里取出搜索结果和阅读过的网页，按 URL 去重。 */
export function sourcesOf(calls: unknown[] | undefined): Source[] {
  const seen = new Map<string, Source>();
  const add = (v: unknown) => {
    if (!isObject(v) || !isWebUrl(v.url) || seen.has(v.url)) return;
    seen.set(v.url, {
      url: v.url,
      title: typeof v.title === 'string' && v.title ? v.title : v.url,
      ...(typeof v.site_name === 'string' && v.site_name && { site: v.site_name }),
    });
  };
  for (const step of calls ?? []) {
    if (!isObject(step) || !Array.isArray(step.calls)) continue;
    for (const call of step.calls) {
      if (!isObject(call)) continue;
      if (Array.isArray(call.sources)) call.sources.forEach(add);
      add(call.page);
    }
  }
  return [...seen.values()];
}

/** 搜索用过的查询词。 */
export function queriesOf(calls: unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const step of calls ?? []) {
    if (!isObject(step) || !Array.isArray(step.calls)) continue;
    for (const call of step.calls) {
      const queries = isObject(call) && isObject(call.action) ? call.action.queries : null;
      if (Array.isArray(queries)) for (const q of queries) if (typeof q === 'string' && q && !out.includes(q)) out.push(q);
    }
  }
  return out;
}

// 代码块、行内代码和公式所在的区间（UTF-16 下标），角标不插在这些位置。
function codeRanges(text: string) {
  const ranges: [number, number][] = [];
  for (const re of [/```[\s\S]*?(?:```|$)/g, /`[^`\n]+`/g]) {
    for (const m of text.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
  }
  return [...ranges, ...mathRanges(text)];
}

/**
 * 按 annotations 在正文里插入编号角标（Markdown 链接）。start / end 按 Unicode 码点计数。
 * 同一网页使用同一编号。返回插入后的文本和编号对应的来源。
 */
export function withCitations(text: string, annotations: Annotation[] | undefined): { text: string; cited: Source[] } {
  if (!annotations?.length) return { text, cited: [] };
  // 码点下标 → UTF-16 下标。
  const offsets: number[] = [0];
  for (const ch of text) offsets.push(offsets.at(-1)! + ch.length);
  const numbers = new Map<string, number>();
  const cited: Source[] = [];
  const marks = new Map<number, number[]>();
  const code = codeRanges(text);
  for (const a of [...annotations].sort((x, y) => x.start - y.start)) {
    if (!isWebUrl(a.url) || a.end < 0 || a.end >= offsets.length) continue;
    let at = offsets[a.end]!;
    const inside = code.find(([from, to]) => at > from && at < to);
    if (inside) at = inside[1];
    if (!numbers.has(a.url)) {
      numbers.set(a.url, numbers.size + 1);
      cited.push({ url: a.url, title: a.title || a.url });
    }
    const n = numbers.get(a.url)!;
    const list = marks.get(at) ?? [];
    if (!list.includes(n)) list.push(n);
    marks.set(at, list);
  }
  let out = '';
  let last = 0;
  for (const at of [...marks.keys()].sort((x, y) => x - y)) {
    // 只转义会打断 Markdown 链接的字符，已有的 %XX 保持不变。
    const href = (url: string) => url.replace(/[\s()<>]/g, (c) => (/[()<>]/.test(c) ? `%${c.charCodeAt(0).toString(16).toUpperCase()}` : encodeURIComponent(c)));
    out += text.slice(last, at) + marks.get(at)!.map((n) => ` [\\[${n}\\]](${href(cited[n - 1]!.url)})`).join('');
    last = at;
  }
  return { text: out + text.slice(last), cited };
}
