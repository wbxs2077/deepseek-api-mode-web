import type { MarkedExtension, Tokens } from 'marked';

// 回复里的公式：$$…$$、\[…\]（独立成行）和 $…$、\(…\)（行内）。
// 解析时先把公式原文包成带 class 的元素，净化之后再由 KaTeX 在页面里排版（见 enhance.ts）。

const DISPLAY = [/^\$\$([\s\S]+?)\$\$/, /^\\\[([\s\S]+?)\\\]/];
// 行内 $…$ 的两侧不能是空白，结尾 $ 后不能紧跟数字，避免把「$5 和 $10」当成公式。
const INLINE = [/^\\\(([\s\S]+?)\\\)/, /^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/];

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

interface MathToken extends Tokens.Generic {
  type: 'math';
  raw: string;
  text: string;
  display: boolean;
}

function match(src: string, patterns: RegExp[], display: boolean): MathToken | undefined {
  for (const re of patterns) {
    const m = re.exec(src);
    if (m && m[1]!.trim()) return { type: 'math', raw: m[0], text: m[1]!.trim(), display };
  }
  return undefined;
}

const render = (token: Tokens.Generic) => {
  const t = token as MathToken;
  return t.display
    ? `<div class="math math-display">${escape(t.text)}</div>\n`
    : `<span class="math math-inline">${escape(t.text)}</span>`;
};

export const mathExtension: MarkedExtension = {
  extensions: [
    {
      name: 'math',
      level: 'block',
      start: (src) => src.match(/^(?:\$\$|\\\[)/m)?.index,
      tokenizer(src) {
        const token = match(src, DISPLAY, true);
        // 独立公式之后只能是行尾，否则交给行内规则，保持段落完整。
        return token && /^[ \t]*(?:\n|$)/.test(src.slice(token.raw.length)) ? token : undefined;
      },
      renderer: render,
    },
    {
      name: 'math',
      level: 'inline',
      start: (src) => src.match(/\$|\\[[(]/)?.index,
      tokenizer: (src) => match(src, DISPLAY, true) ?? match(src, INLINE, false),
      renderer: render,
    },
  ],
};

/** 公式在正文中的区间（UTF-16 下标），引用角标不插在公式里。 */
export function mathRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const patterns = [...DISPLAY, ...INLINE].map((re) => new RegExp(re.source.slice(1), 'g'));
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const at = m.index;
      if (!ranges.some(([from, to]) => at >= from && at < to)) ranges.push([at, at + m[0].length]);
    }
  }
  return ranges;
}
