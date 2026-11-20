// Run with npm run test:browser (needs a local Chrome; set CHROME_PATH to override).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

import { chromium } from 'playwright';
let browser, bundle;
before(async () => {
  const result = await build({
    configFile: false, publicDir: false, logLevel: 'silent',
    build: { write: false, lib: {
      entry: fileURLToPath(new URL('../src/entrypoints/deepseek.content/mount.ts', import.meta.url)),
      name: 'mount', formats: ['iife'],
    } },
  });
  bundle = result[0].output.find(entry => entry.type === 'chunk').code;
  browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    args: ['--disable-background-networking'],
  });
});
after(async () => browser?.close());

async function fixture(t, contents) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.context().setOffline(true);
  await page.setContent(`<main class="ds-virtual-list"><div class="ds-virtual-list-items"></div>
    <footer style="position:sticky;bottom:0">${contents}</footer></main>`);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    mount.installPageStyle();
    const thread = mount.createHost('thread'), composer = mount.createHost('composer');
    window.composer = composer.host;
    composer.host.dataset.mode = 'api';
    window.keeper = mount.keepMounted(thread.host, composer.host, layout => { window.layout = layout; });
    keeper.setEnabled(true);
  });
  await page.waitForFunction(() => !!window.layout);
  return page;
}
const frozen = '<div id="warning">冻结提示 <button id="export">导出历史记录</button></div>';

test('frozen prompt and export stay visible and usable in API mode', async t => {
  const p = await fixture(t, frozen);
  assert.equal(await p.locator('#warning').isVisible(), true);
  await p.locator('#export').click({ timeout: 1000 });
});

test('CSS-only loss of sticky unmounts both hosts and later recovers', async t => {
  const p = await fixture(t, frozen);
  await p.evaluate(() => { document.querySelector('footer').style.position = 'static'; });
  await p.waitForFunction(() => window.layout === null, null, { timeout: 4500 });
  assert.equal(await p.locator('ds-api-thread,ds-api-composer').count(), 0);
  await p.locator('#export').click();
  await p.evaluate(() => { document.querySelector('footer').style.position = 'sticky'; });
  await p.waitForFunction(() => !!window.layout, null, { timeout: 4500 });
  assert.equal(await p.locator('ds-api-thread,ds-api-composer').count(), 2);
});

const official = '<section id="official" style="display:grid"><textarea>官方草稿</textarea></section>';

test('mode switches preserve the native field, draft, selection and display', async t => {
  const p = await fixture(t, official + frozen);
  const field = p.locator('#official textarea');
  assert.equal(await field.isVisible(), false);
  assert.equal(await p.locator('#export').isVisible(), true);
  await p.evaluate(() => { composer.dataset.mode = 'official'; });
  assert.equal(await p.locator('#official').evaluate(el => getComputedStyle(el).display), 'grid');
  await field.fill('保留这份草稿');
  await field.evaluate(el => {
    window.nativeField = el;
    el.setSelectionRange(1, 3);
    composer.dataset.mode = 'api';
  });
  assert.equal(await field.isVisible(), false);
  await p.evaluate(() => { composer.dataset.mode = 'official'; });
  await field.focus();
  assert.deepEqual(await field.evaluate(el => [el === window.nativeField, document.activeElement === el,
    el.value, el.selectionStart, el.selectionEnd]), [true, true, '保留这份草稿', 1, 3]);
});

test('replacement, in-place freeze, disable and dispose release the original node', async t => {
  const p = await fixture(t, official);
  await p.evaluate(() => {
    window.old = layout.official;
    const replacement = document.createElement('section');
    replacement.innerHTML = '<textarea>替换草稿</textarea>';
    old.replaceWith(replacement);
  });
  await p.waitForFunction(() => layout.official !== old && layout.official?.textContent === '替换草稿');
  assert.equal(await p.evaluate(() => old.outerHTML), official);
  assert.equal(await p.locator('textarea').isVisible(), false);
  assert.equal(await p.evaluate(html => {
    layout.official.innerHTML = html;
    return !!document.querySelector('#export').getClientRects().length;
  }, frozen), true);
  await p.waitForFunction(() => layout.official === null);
  await p.locator('#export').click();
  await p.evaluate(() => { document.querySelector('footer').append(old); });
  await p.waitForFunction(() => layout.official === old);
  assert.equal(await p.locator('#official').isVisible(), false);
  await p.evaluate(() => keeper.setEnabled(false));
  await p.waitForFunction(() => window.layout === null);
  assert.equal(await p.locator('#official').evaluate(el => el.outerHTML), official);
  await p.evaluate(() => keeper.setEnabled(true));
  await p.waitForFunction(() => window.layout?.official === old);
  await p.evaluate(() => keeper.dispose());
  assert.equal(await p.locator('#official').evaluate(el => el.outerHTML), official);
  assert.equal(await p.locator('textarea').isVisible(), true);
  assert.equal(await p.locator('ds-api-thread,ds-api-composer').count(), 0);
});

test('layout mismatch notice allows a click through to the native export button', async t => {
  const p = await fixture(t, frozen);
  await p.evaluate(() => {
    document.querySelector('footer').style.position = 'static';
    const button = document.querySelector('#export');
    button.style.cssText = 'position:fixed;right:20px;bottom:20px';
    button.onclick = () => { button.textContent = '已导出'; };
    const notice = mount.createHost('notice');
    notice.container.textContent = '页面结构已变化，API 续聊暂不可用';
    document.body.append(notice.host);
  });
  await p.waitForFunction(() => window.layout === null);
  await p.locator('#export').click({ timeout: 1000 });
  assert.equal(await p.locator('#export').textContent(), '已导出');
});
