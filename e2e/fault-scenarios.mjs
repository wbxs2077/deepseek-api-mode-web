// Fault scenarios fixed in 0.3.1: node e2e/fault-scenarios.mjs [unpacked-extension-path]. Run `npm run build` first.
// Every case launches a disposable Chrome profile with synthetic pages and a mocked API.
import { join, resolve } from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..");
const build = resolve(
  process.argv[2] || join(root, ".output/chrome-mv3"),
);
const fixture = JSON.parse(
  await readFile(join(root, "tests/fixtures/history.json"), "utf8"),
);
const { chromium } = await import("playwright");
const origin = "https://chat.deepseek.com";
const fresh = () =>
  `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
let sequence = 100,
  ctx,
  worker,
  extId,
  cdp;
const path = (id) => `/a/chat/s/${id}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const j = JSON.stringify;
const version = JSON.parse(await readFile(join(build, 'manifest.json'), 'utf8')).version;
assert(/^\d+(\.\d+){0,3}$/.test(version), 'Expected a Chrome manifest version');
const results = [], unexpected = [];
const report = { started: new Date().toISOString(), build, version, results };
const reports = join(here, 'reports');
await mkdir(reports, { recursive: true });
const filename = join(reports, `fault-scenarios-v${version}-${report.started.replace(/[:.]/g, '-')}.json`);
let twoImages = false;
async function fingerprint() {
  const h = createHash("sha256");
  async function visit(dir) {
    for (const e of (
      await readdir(join(build, dir), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = dir + e.name;
      if (e.isDirectory()) await visit(name + "/");
      else
        h.update(name + "\0").update(
          createHash("sha256")
            .update(await readFile(join(build, name)))
            .digest(),
        );
    }
  }
  await visit("");
  return h.digest("hex");
}
async function until(fn, label, ms = 5500) {
  const end = Date.now() + ms;
  do {
    const value = await fn();
    if (value) return value;
    await wait(35);
  } while (Date.now() < end);
  throw Error(`Timed out waiting for ${label}`);
}
async function test(name, task) {
  const item = { name, evidence: {} };
  results.push(item);
  unexpected.length = 0;
  twoImages = false;
  try {
    await launch();
    await task(item.evidence);
    item.status = 'PASS';
  } catch (err) {
    item.error = String(err.stack);
    item.status = 'FAIL';
  } finally {
    if (worker) item.workerBlocked = await worker.evaluate(() => blocked).catch(() => ['worker unavailable']);
    item.pageBlocked = [...unexpected];
    if (item.pageBlocked.length || item.workerBlocked?.length) item.status = 'FAIL';
    await ctx?.close();
    ctx = worker = undefined;
    if (item.status !== 'PASS') process.exitCode = 1;
    console.log(item.status, name, item.error?.split('\n')[0] || '');
  }
}
async function routePage(route) {
  const req = route.request(),
    u = new URL(req.url());
  if (u.protocol === "chrome-extension:") return route.continue();
  if (u.origin === origin && req.method() === "GET") {
    if (u.pathname === "/api/v0/chat/history_messages") {
      const id = u.searchParams.get("chat_session_id");
      const data = structuredClone(fixture);
      data.chat_session.id = id;
      if (twoImages) {
        const files = data.chat_messages.flatMap(m => m.fragments).find(f => f.type === 'FILE').files;
        files.push({ ...files[0], id: 'file-c', file_name: 'second.png', signed_path: files[0].signed_path.replace('file-a','file-c') });
      }
      return route.fulfill({
        json: { code: 0, data: { biz_code: 0, biz_data: data } },
      });
    }
    if (req.isNavigationRequest()) {
      const frozen = false;
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><meta charset=utf-8><style>.ds-virtual-list{height:580px;overflow:auto}.sticky{position:sticky;bottom:0}</style><body><script>window.officialDrops=0;addEventListener('drop',()=>officialDrops++);addEventListener('dragover',e=>e.preventDefault())</script><main class="ds-virtual-list"><div class="ds-virtual-list-items">Synthetic history</div><div class="sticky">${frozen ? '<div id="notice">冻结提示 <button id="export">导出历史记录</button></div>' : '<div id="official"><textarea></textarea></div>'}</div></main><script>localStorage.setItem('userToken',JSON.stringify({value:'synthetic-token'}))</script></body></html>`,
      });
    }
    if (u.pathname === "/favicon.ico") return route.fulfill({ status: 204 });
  }
  unexpected.push([req.method(), u.origin + u.pathname]);
  return route.abort();
}
async function mockWorker() {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ apiKey: "synthetic-regression-key" });
    globalThis.calls = [];
    globalThis.blocked = [];
    globalThis.uploads = [];
    globalThis.deletes = [];
    globalThis.officialImageReads = [];
    globalThis.fetch = async (url, opts) => {
      url = String(url);
      if (url === "https://api.deepseek.com/files" && opts?.method === "POST") {
        const form = opts.body;
        const file = form.get("file");
        const id = "file-api-" + (uploads.length + 1);
        uploads.push({ id, purpose: form.get("purpose"), keys: [...form.keys()], name: file.name, type: file.type, size: file.size });
        return Response.json({ id, object: "file", bytes: file.size, filename: file.name, purpose: form.get("purpose") });
      }
      if (url.startsWith("https://api.deepseek.com/files/") && opts?.method === "DELETE") {
        deletes.push(decodeURIComponent(url.split("/").pop()));
        return Response.json({ deleted: true });
      }
      if (url === "https://api.deepseek.com/user/balance") {
        (globalThis.balanceReads ??= []).push(opts?.headers?.Authorization ?? "");
        return Response.json({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12.34", granted_balance: "0.00", topped_up_balance: "12.34" }] });
      }
      if (url.startsWith("https://files.deepseeksvc.com/api/file?")) {
        officialImageReads.push({ url, credentials: opts?.credentials });
        return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]), { headers: { "Content-Type": "image/webp" } });
      }
      if (
        url !== "https://api.deepseek.com/chat/completions" ||
        opts?.method !== "POST"
      ) {
        blocked.push(url);
        throw Error("Blocked unexpected fetch");
      }
      const body = JSON.parse(opts.body),
        lastContent = body.messages.at(-1).content,
        q = (typeof lastContent === "string" ? lastContent : lastContent.filter((p) => p.type === "text").map((p) => p.text).join("\n\n") || "FILES")
          .split("\n\n").at(-1);
      calls.push(body);
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            const chunk = (text) =>
              controller.enqueue(
                enc.encode(
                  "data: " +
                    JSON.stringify({
                      choices: [{ delta: { content: text } }],
                    }) +
                    "\n\n",
                ),
              );
            const end = () => {
              controller.enqueue(
                enc.encode(
                  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                ),
              );
              controller.close();
            };
            chunk('REPLY-' + q);
            end();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };
  });
}
async function page(id) {
  const p = await ctx.newPage();
  await p.goto(origin + (id ? path(id) : "/"));
  const c = await ctx.newCDPSession(p),
    worlds = [];
  c.on("Runtime.executionContextCreated", (e) => worlds.push(e.context));
  await c.send("Runtime.enable");
  const world = await until(
    () =>
      worlds.find(
        (w) => w.auxData?.type === "isolated" && w.origin.includes(extId),
      ),
    "extension world",
  );
  const run = async (code) => {
    const r = await c.send("Runtime.evaluate", {
      contextId: world.id,
      expression: `(()=>{
      const shadow=tag=>{const host=document.querySelector('ds-api-'+tag);return host&&chrome.dom.openOrClosedShadowRoot(host)};
      const comp=shadow('composer'), th=shadow('thread'), input=comp?.querySelector('textarea');
      const buttons=[...(comp?.querySelectorAll('button')??[]),...(th?.querySelectorAll('button')??[])];
      const btn=label=>buttons.find(b=>b.textContent.trim()===label), send=comp?.querySelector('[aria-label="发送"]');
      ${code}})()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails)
      throw Error(
        r.exceptionDetails.exception?.description || r.exceptionDetails.text,
      );
    return r.result.value;
  };
  const click = (label) =>
    run(
      `const b=btn(${j(label)});if(!b||b.disabled)throw Error('Unavailable button '+${j(label)});b.click()`,
    );
  const type = (text) =>
    run(
      `if(!input)throw Error('No API input');input.value=${j(text)};input.dispatchEvent(new Event('input',{bubbles:true}))`,
    );
  const has = (label) => run(`return !!btn(${j(label)})`);
  const text = () => run(`return th?.querySelector('.root')?.innerText??''`);
  const v = { p, c, run, click, type, has, text };
  if (id) await until(() => has("API"), "mode switch");
  return v;
}
const choose = async (v, label) => {
  await until(() => v.has(label), label);
  await v.click(label);
};
const start = async (v) => {
  await choose(v, "API");
  await choose(v, "确认并开始");
  await until(
    () => v.run("return input && !input.disabled"),
    "enabled imported input",
  );
};
const push = (v, id) =>
  v.p.evaluate((path) => history.pushState({}, "", path), path(id));
const row = (id) =>
  worker.evaluate(
    (id) =>
      new Promise((ok, bad) => {
        const r = indexedDB.open("ds-api-continue");
        r.onerror = () => bad(r.error);
        r.onsuccess = () => {
          const db = r.result,
            q = db.transaction("sessions").objectStore("sessions").get(id);
          q.onsuccess = () => {
            db.close();
            ok(q.result ?? null);
          };
          q.onerror = () => bad(q.error);
        };
      }),
    id,
  );
const contents = async (id) =>
  (await row(id))?.turns.map((t) => t.content) ?? null;
async function submit(v, q) {
  await v.type(q);
  await until(() => v.run("return send && !send.disabled"), "send enabled");
  await v.run("send.click()");
}
async function send(v, id, q) {
  await submit(v, q);
  await until(
    async () =>
      (await contents(id))?.at(-1) === "REPLY-" + q &&
      (await v.run(
        `return !!send && th?.textContent.includes(${j("REPLY-" + q)})`,
      )),
    "persisted and rendered reply to " + q,
  );
}
async function confirm(v, expr) {
  const dialog = v.p
    .waitForEvent("dialog", { timeout: 2200 })
    .then(async (d) => {
      const msg = d.message();
      await d.accept();
      return msg;
    });
  const [message] = await Promise.all([dialog, v.run(expr)]);
  return message;
}
async function launch() {
  ctx = await chromium.launchPersistentContext("", {
    // Extensions need a real Chrome build: set CHROME_PATH, or install Chrome for Playwright's "chrome" channel.
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      "--enable-unsafe-extension-debugging",
      "--disable-background-networking",
      "--disable-quic",
      "--no-proxy-server",
      "--host-resolver-rules=MAP * ~NOTFOUND",
    ],
  });
  ctx.setDefaultTimeout(5500);
  await ctx.route("**/*", routePage);
  cdp = await ctx.browser().newBrowserCDPSession();
  report.chrome = (await cdp.send("Browser.getVersion")).product;
  ({ id: extId } = await cdp.send("Extensions.loadUnpacked", { path: build }));
  worker =
    ctx.serviceWorkers().find((w) => w.url().includes(extId)) ??
    (await ctx.waitForEvent("serviceworker", {
      predicate: (w) => w.url().includes(extId),
    }));
  await mockWorker();
}
  const fileInput = (v, files) => v.run(`
    const picker = comp.querySelector('input[type=file]');
    if (!picker) throw Error('No file picker');
    const dt = new DataTransfer();
    for (const [name, type, data] of ${j(files)}) dt.items.add(new File([typeof data === 'string' ? data : new Uint8Array(data)], name, { type }));
    picker.files = dt.files;
    picker.dispatchEvent(new Event('change', { bubbles: true }));`);
  const chips = (v) => v.run(`return [...comp.querySelectorAll('.files .file')].map(li => li.className + '|' + li.textContent)`);
  const lastCall = () => worker.evaluate(() => calls.at(-1));
  // 不带官网图片导入，用于检查纯文字对话的模型选择。
  async function populatedWithoutImages() {
    const id = fresh(), v = await page(id);
    await choose(v, "API");
    await until(() => v.run(`return !!th.querySelector('label.check input')`), "image checkbox");
    await v.run(`th.querySelector('label.check input').click()`);
    await choose(v, "确认并开始");
    await until(() => v.run("return input && !input.disabled"), "input ready");
    await send(v, id, "Q1");
    return { id, v };
  }


  const filesReady = async(v,n)=>until(async()=>(await chips(v)).filter(c=>c.startsWith('file ready')).length===n,'attachments ready');
  const uploadOne=async(v,name)=>{await fileInput(v,[[name,'text/plain','synthetic file']]);await filesReady(v,1);};
  const intercept=async(mode)=>worker.evaluate(mode=>{
    globalThis.auditMode=mode;
    if(globalThis.auditWrapped)return;
    globalThis.auditWrapped=true;
    const orig=globalThis.fetch;globalThis.attempts=[];
    globalThis.fetch=async(url,opts)=>{
      const u=String(url);
      if(opts?.method==='DELETE'){attempts.push(u.split('/').pop());if(auditMode==='delete503')return new Response('{}',{status:503});}
      if(auditMode==='partial' && u==='https://api.deepseek.com/files' && opts?.body?.get('file')?.name==='second.webp') { globalThis.failedUpload=true; return new Response('{}',{status:503}); }
      if(auditMode==='holdUploads' && opts.method==='POST' && u.endsWith('/files')){
        globalThis.auditHolds=(globalThis.auditHolds||0)+1;
        await new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true}));
      }
      if(auditMode==='steps' && u.endsWith('/chat/completions')){
        const body=JSON.parse(opts.body); calls.push(body);
        const call={index:0,reasoning_content:'STEP1',calls:[{kind:'search',id:'mock',signature:'signed-synthetic'}]};
        const frames=[{delta:{reasoning_content:'STEP1'}},{delta:{},server_tool_event:{type:'step_reasoning_done',step:0}},
          {delta:{reasoning_content:'FINAL'}},{delta:{content:'answer'}},{delta:{server_tool_calls:[call]},finish_reason:'stop'}];
        return new Response(frames.map(c=>'data: '+JSON.stringify({choices:[c]})+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
      }
      return orig(url,opts);
    };
  },mode);

// Save the last observation even when a positive assertion times out on the baseline.
async function observe(e, key, read, accept) {
  await until(async () => accept(e[key] = await read()), key);
  return e[key];
}
const names = ['a.txt','b.txt','c.txt'];
const fileIds = async id => (await row(id))?.uploadedFileIds ?? [];
const images = async id => (await row(id)).imported.flatMap(m => m.attachments ?? []).filter(a => a.kind === 'image');
const matches = (v,label) => v.run(`const b=btn(${j(label)});return !!b && b.checkVisibility() && !b.disabled`);
const removeChip = (v,name) => v.run(`comp.querySelector(${j(`[aria-label="移除 ${name}"]`)}).click()`);
const deleteLog = () => worker.evaluate(() => ({attempts: [...attempts], succeeded: [...deletes]}));
const openPopup = async () => {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/popup.html`);
  await p.locator('input[type=password]').waitFor();
  return p;
};
const cleanupStatus = p => p.evaluate(async () => {
  try { return (await chrome.runtime.sendMessage({type:'cleanup-status'})) ?? null; }
  catch (err) { return { error: err.message }; }
});
const retryButton = p => p.getByRole('button', {name:'重试删除',exact:true});
async function cleanupCase(e, wholeSession) {
  const {id,v} = await populatedWithoutImages();
  const initial = await openPopup();
  const empty = await cleanupStatus(initial);
  await initial.close();
  await uploadOne(v,'to-delete.txt');
  const [f] = await fileIds(id);
  assert.ok(f);
  await intercept('delete503');
  if (wholeSession) {
    await send(v,id,'uses-file');
    await v.run(`th.querySelector('details.context').open=true`);
    await confirm(v,`btn('删除本机记录').click()`);
    await until(async () => !(await row(id)), 'local record deleted');
  } else {
    await removeChip(v,'to-delete.txt');
    await until(async () => !(await chips(v)).length,'chip removed');
  }
  await observe(e,'delete503',deleteLog, log => log.attempts.includes(f) && !log.succeeded.includes(f));
  const visibleNotice = () => v.run(`return [th,comp,shadow('notice')].flatMap(s=>[...(s?.children??[])]).filter(n=>n instanceof HTMLElement && n.checkVisibility()).map(n=>n.innerText).join(' ')`);
  e.inlineText = await visibleNotice();
  const p = await openPopup();
  e.emptyStatus = empty;
  e.popupStatus = await cleanupStatus(p);
  e.retryVisible = await retryButton(p).isVisible();
  e.registered = (await fileIds(id)).includes(f);
  if (wholeSession) {
    // User should see the failure where they deleted the conversation, even after the row disappears.
    await observe(e,'inlineText',visibleNotice,text => /(?:未能|没能|失败|待清理|重试删除|未删除|稍后重试|尚未|待删除|未完成|重试.{0,6}清理|未清理|仍有.{0,12}文件)/.test(text));
  }
  // The queue must survive closing/reopening the popup, including after the session row is gone.
  await retryButton(p).waitFor();
  assert.notDeepEqual(e.popupStatus,empty,'pending cleanup must change popup status');
  await p.close();
  const reopened = await openPopup();
  assert.deepEqual(await cleanupStatus(reopened),e.popupStatus);
  await intercept('normal');
  await retryButton(reopened).click(); // exercises retry-cleanup via the production popup
  await observe(e,'retryResult',deleteLog, log => log.succeeded.includes(f));
  await observe(e,'finalStatus',() => cleanupStatus(reopened), status => j(status) === j(empty));
}
try {
  report.fingerprint = await fingerprint();
  await test('取消三个上传后第四个文件能上传并发送', async e => {
    const {id,v} = await populatedWithoutImages();
    await intercept('holdUploads');
    await fileInput(v,names.map(name => [name,'text/plain','synthetic']));
    await until(() => worker.evaluate(() => globalThis.auditHolds === 3),'three in-flight uploads');
    for (const name of names) await removeChip(v,name);
    await intercept('normal');
    await fileInput(v,[['fourth.txt','text/plain','fourth']]);
    await observe(e,'fourth',async () => ({chips:await chips(v), uploads:await worker.evaluate(() => uploads.map(x => x.name)), canSend:await v.run('return !send.disabled')}), s => s.uploads.includes('fourth.txt') && s.canSend && s.chips.some(c=>c.startsWith('file ready')));
    await send(v,id,'with-fourth');
    const [f] = await fileIds(id);
    assert.ok(f);
    assert.deepEqual((await lastCall()).messages.at(-1).content.filter(p=>p.type==='file').map(p=>p.file_id),[f]);
  });
  await test('跨标签发送采用提交时界面显示的配置', async e => {
    await worker.evaluate(() => chrome.storage.local.set({search:false,thinking:false,model:'deepseek-v4-pro'}));
    const {id,v} = await populatedWithoutImages();
    const {v:b} = await populatedWithoutImages();
    await choose(b,'深度思考');
    await until(()=>worker.evaluate(async()=>(await chrome.storage.local.get('thinking')).thinking),'tab B thinking');
    await choose(b,'智能搜索');
    await until(()=>worker.evaluate(async()=>(await chrome.storage.local.get('search')).search),'tab B search');
    await v.type('tab-A');
    e.ui = await v.run(`const ui={model:comp.querySelector('select').value,search:btn('智能搜索').getAttribute('aria-pressed')==='true',thinking:btn('深度思考').getAttribute('aria-pressed')==='true'};if (send.disabled) throw Error('cannot send');send.click();return ui`);
    await until(async()=>(await contents(id))?.at(-1)==='REPLY-tab-A','tab A reply');
    const body = await lastCall();
    e.wire = {model:body.model,tools:(body.tools??[]).map(t=>t.type).sort(),thinking:body.thinking?.type};
    assert.deepEqual(e.wire,{model:e.ui.search?'deepseek-flash':e.ui.model, tools:e.ui.search?['deepseek_read_url','deepseek_web_search']:[],thinking:e.ui.thinking?'enabled':'disabled'});
  });
  await test('搜索中间步和末步的 reasoning 在下一轮分别回放', async e => {
    const {id,v} = await populatedWithoutImages();
    await choose(v,'智能搜索');
    await intercept('steps');
    await submit(v,'search steps');
    await until(async()=>(await contents(id)).at(-1)==='answer','stored search reply');
    await intercept('normal');
    await send(v,id,'followup');
    const old = (await lastCall()).messages.find(m => m.content==='answer');
    e.step = old.server_tool_calls.map(c=>c.reasoning_content);
    e.final = old.reasoning_content;
    assert.deepEqual(e.step,['STEP1']);
    assert.equal(e.final,'FINAL');
  });
  await test('SPA 换页后清理上一会话的未发送草稿附件', async e => {
    const {id,v} = await populatedWithoutImages();
    await intercept('normal');
    await uploadOne(v,'draft.txt');
    await v.type('unsent draft');
    const [f] = await fileIds(id);
    assert.ok(f);
    const before = await contents(id);
    await push(v,fresh());
    await until(()=>v.run(`return !!btn('API')&&!input`),'destination route');
    await start(v);
    e.destination = await v.run(`return {input:input.value,chips:comp.querySelectorAll('.files .file').length}`);
    assert.deepEqual(e.destination,{input:'',chips:0});
    assert.deepEqual(await contents(id),before);
    await observe(e,'source',async()=>({registered:(await fileIds(id)).includes(f),...await deleteLog()}),s=>!s.registered && s.succeeded.includes(f));
  });
  await test('单个附件 DELETE 503 留下任务且能从 popup 重试',e=>cleanupCase(e,false));
  await test('删除会话时的远端失败可见且能在会话消失后重试',e=>cleanupCase(e,true));
  await test('无 key 导入后可补传历史图片并保留已发回合', async e => {
    await worker.evaluate(()=>chrome.storage.local.remove('apiKey'));
    const id = fresh(), v = await page(id);
    await start(v);
    assert.equal((await images(id)).filter(a=>!a.fileId).length,1);
    const p = await openPopup();
    await p.locator('input[type=password]').fill('synthetic-recovery-key');
    await p.getByRole('button',{name:'保存',exact:true}).click();
    await until(() => worker.evaluate(async () => (await chrome.storage.local.get('apiKey')).apiKey === 'synthetic-recovery-key'),'popup persisted key');
    await p.close();
    await v.run(`dispatchEvent(new Event('focus'))`);
    await v.click('官网');
    await choose(v,'API');
    await send(v,id,'preserve-me');
    const turns = (await row(id)).turns;
    e.before = turns.map(t=>t.content);
    await observe(e,'recoveryVisible',()=>matches(v,'补传历史图片'),Boolean);
    await v.click('补传历史图片');
    await observe(e,'images',()=>images(id),list=>list.length===1 && !!list[0].fileId);
    assert.deepEqual((await row(id)).turns,turns);
    assert.ok((await v.text()).includes('REPLY-preserve-me'));
  });
  await test('部分历史图片上传失败后再次点击只处理失败图片', async e => {
    twoImages = true;
    await intercept('partial');
    const id = fresh(),v = await page(id);
    await start(v);
    await until(()=>worker.evaluate(()=>globalThis.failedUpload),'second upload rejected');
    e.before = (await images(id)).map(a=>a.fileId??null);
    assert.ok(e.before[0] && !e.before[1]);
    await observe(e,'retryVisible',()=>matches(v,'补传历史图片'),Boolean);
    await intercept('normal');
    await v.click('补传历史图片');
    await observe(e,'after',async()=>(await images(id)).map(a=>a.fileId??null),list=>list.length===2 && list.every(Boolean));
    assert.equal(e.after[0],e.before[0]);
    e.uploads = await worker.evaluate(()=>uploads.map(x=>x.name));
    assert.equal(e.uploads.length,2);
    assert.equal(new Set(e.uploads).size,2);
  });
} catch (err) {
  report.fatal = String(err.stack);
  process.exitCode = 1;
} finally {
  report.buildChanged = report.fingerprint !== await fingerprint();
  if (report.buildChanged) process.exitCode = 1;
  report.finished = new Date().toISOString();
  report.summary = {pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length};
  await writeFile(filename, JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(filename, report.summary, report.fatal || '');
}
