import { describe, expect, it } from 'vitest';
import notices from '../THIRD_PARTY_NOTICES.md?raw';

const bundled = ['dompurify', 'katex', 'marked', 'preact', 'wxt'];

describe('THIRD_PARTY_NOTICES.md', () => {
  // License texts contain their own "## " headings, so split only on the package headings.
  const sections = notices.split(new RegExp(`\\n(?=## (?:${bundled.join('|')}) \\d)`));

  it.each(bundled)('includes the full license text for %s', (name) => {
    const section = sections.find((s: string) => s.startsWith(`## ${name} `));
    expect(section).toBeDefined();
    expect(section).toMatch(/```text\n[\s\S]*(Copyright|Licensed under the Apache License)[\s\S]*```/);
  });

  it('carries the upstream WXT copyright', () => {
    expect(notices).toContain('Copyright (c) 2023 Aaron');
  });
});
