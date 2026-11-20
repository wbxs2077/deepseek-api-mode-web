// Regenerates THIRD_PARTY_NOTICES.md from the licenses of packages bundled into the extension.
// Run after changing dependencies: node scripts/third-party-notices.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const modules = fileURLToPath(new URL('../node_modules/', import.meta.url));
// Packages whose code ends up in the built extension. DOMPurify is dual-licensed; we use Apache-2.0.
const bundled = [
  { name: 'dompurify', file: 'LICENSE', note: 'Dual-licensed MPL-2.0 OR Apache-2.0; used under Apache-2.0.' },
  { name: 'katex', file: 'LICENSE' },
  { name: 'marked', file: 'LICENSE' },
  { name: 'preact', file: 'LICENSE' },
  { name: 'wxt', file: null, note: 'Runtime helpers only. MIT License, see https://github.com/wxt-dev/wxt/blob/main/LICENSE.' },
];

let out = '# Third-party notices\n\nThe built extension includes code from the following packages.\n';
for (const pkg of bundled) {
  const dir = join(modules, pkg.name);
  const meta = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  out += `\n## ${pkg.name} ${meta.version}\n\nLicense: ${meta.license}`;
  if (meta.homepage) out += ` · ${meta.homepage}`;
  out += '\n';
  if (pkg.note) out += `\n${pkg.note}\n`;
  if (pkg.file) {
    let text;
    for (const candidate of [pkg.file, 'LICENSE', 'LICENSE.md']) {
      try { text = await readFile(join(dir, candidate), 'utf8'); break; } catch {}
    }
    if (!text) throw new Error(`No license file for ${pkg.name}`);
    out += '\n```text\n' + text.replace(/\r\n/g, '\n').trim() + '\n```\n';
  }
}
await writeFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), out);
console.log('THIRD_PARTY_NOTICES.md updated');
