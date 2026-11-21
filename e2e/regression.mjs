// Production-build regression: node e2e/regression.mjs [unpacked-extension-path]. Run `npm run build` first.
// Chrome uses a new disposable profile. Only extension resources may pass through routing.
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
const options = new Map();
const config = (id) => {
  if (!options.has(id)) options.set(id, { reads: 0 });
  return options.get(id);
};
const unexpected = [],
  results = [];
const report = { started: new Date().toISOString(), build, results };
const reports = join(here, "reports");
await mkdir(reports, { recursive: true });
const filename = join(reports, `regression-${report.started.replace(/[:.]/g, "-")}.json`);
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
  const pages = new Set(ctx.pages());
  const item = { name, evidence: {} };
  results.push(item);
  try {
    await task(item.evidence);
    item.status = "PASS";
  } catch (e) {
    item.status = "FAIL";
    item.error = String(e.stack);
    process.exitCode = 1;
  } finally {
    for (const o of options.values()) o.release?.();
    for (const p of ctx.pages())
      if (!pages.has(p)) await p.close().catch(() => {});
    console.log(
      item.status,
      name,
      item.error?.split("\n").slice(0, 3).join(" ") || "",
    );
  }
}
async function routePage(route) {
  const req = route.request(),
    u = new URL(req.url());
  if (u.protocol === "chrome-extension:") return route.continue();
  if (u.origin === origin && req.method() === "GET") {
    if (u.pathname === "/api/v0/chat/history_messages") {
      const id = u.searchParams.get("chat_session_id"),
        o = config(id);
      o.reads++;
      if (o.gate) await o.gate;
      if (o.fail) return route.fulfill({ status: 503, json: { code: 503 } });
      const data = structuredClone(fixture);
      data.chat_session.id = id;
      if (o.extra) {
        data.chat_session.current_message_id = 11;
        data.chat_messages.push({
          message_id: 11,
          parent_id: 10,
          role: "USER",
          fragments: [{ type: "REQUEST", content: "NEW-OFFICIAL-" + id }],
        });
      }
      return route.fulfill({
        json: { code: 0, data: { biz_code: 0, biz_data: data } },
      });
    }
    if (req.isNavigationRequest()) {
      const frozen = config(u.pathname.split("/").at(-1)).frozen;
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
    globalThis.streams = {};
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
            const send = (value) => controller.enqueue(enc.encode("data: " + JSON.stringify(value) + "\n\n"));
            if (q.startsWith("SEARCH-")) {
              const calls = [{ index: 0, reasoning_content: "", calls: [{ index: 0, id: "srvtoolu_s_00_x", type: "deepseek_web_search", kind: "search",
                action: { type: "search", queries: ["synthetic query"] }, status: "completed",
                sources: [{ type: "url", url: "https://example.test/one", title: "Synthetic Source One", site_name: "Example" },
                  { type: "url", url: "https://example.test/two", title: "Synthetic Source Two" }] }] }];
              send({ choices: [{ index: 0, delta: {}, server_tool_event: { type: "call_started", step: 0, call: { index: 0, kind: "search", action: { type: "search", queries: ["synthetic query"] } } } }] });
              send({ choices: [{ index: 0, delta: {}, server_tool_event: { type: "call_completed", step: 0, call: { index: 0, kind: "search", status: "completed" } } }] });
              send({ choices: [{ index: 0, delta: { content: "CITED-" + q } }] });
              send({ choices: [{ index: 0, delta: { content: "", server_tool_calls: calls,
                annotations: [{ type: "url_citation", url_citation: { url: "https://example.test/one", title: "Synthetic Source One", start_index: 0, end_index: 5 } }] },
                finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, prompt_cache_hit_tokens: 0, server_tool_use: { tool_search: 1 } } });
              controller.enqueue(enc.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }
            if (q.startsWith("RICH-")) {
              // v0.3.2: formulas, a code block and reported usage.
              send({ choices: [{ index: 0, delta: { content: "REPLY-" + q + " 面积 $S=\\pi r^2$\n\n$$E=mc^2$$\n\n```js\nconst rich = 1;\n```" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 120000, completion_tokens: 2000, prompt_cache_hit_tokens: 100000 } });
              controller.enqueue(enc.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }
            chunk("REPLY-" + q);
            if (q.startsWith("HOLD-")) {
              streams[q] = { chunk, end, aborted: false };
              opts.signal.addEventListener(
                "abort",
                () => {
                  streams[q].aborted = true;
                  try {
                    controller.error(new DOMException("Aborted", "AbortError"));
                  } catch {}
                },
                { once: true },
              );
            } else end();
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
        const r = indexedDB.open("ds-api-continue", 1);
        r.onupgradeneeded = () =>
          r.result.createObjectStore("sessions", { keyPath: "sessionId" });
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
const apiCount = () => worker.evaluate(() => calls.length);
const lastPayload = () => worker.evaluate(() => calls.at(-1).messages);
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
async function populated() {
  const id = fresh(),
    v = await page(id);
  await start(v);
  await send(v, id, "Q1");
  return { id, v };
}
function pauseHistory(o) {
  o.gate = new Promise((r) => (o.release = r));
  return () => {
    o.release();
    delete o.gate;
    delete o.release;
  };
}
async function noSend(v, id, marker, { edit = false, regen = true } = {}) {
  const n = await apiCount(),
    before = await row(id);
  if (edit) await v.run(`btn('编辑')?.click()`);
  if (marker) await v.type(marker);
  await v.run(
    `send?.click();input?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));${regen ? "(btn('重新生成')||btn('重试'))?.click();" : ""}`,
  );
  await wait(350);
  assert.equal(await apiCount(), n, "API called despite unresolved state");
  assert.deepEqual(
    await row(id),
    before,
    "record changed despite unresolved state",
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
try {
  report.fingerprint = await fingerprint();
  report.version = JSON.parse(
    await readFile(join(build, "manifest.json"), "utf8"),
  ).version;
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
  await test("Normal conversation, context and independent drafts", async () => {
    const id = fresh(),
      v = await page(id),
      official = v.p.locator("#official textarea");
    await official.fill("OFFICIAL-DRAFT");
    await start(v);
    assert(!(await official.isVisible()));
    await v.type("API-DRAFT");
    await v.click("官网");
    assert(await official.isVisible());
    assert.equal(await official.inputValue(), "OFFICIAL-DRAFT");
    await v.click("API");
    await until(
      () => v.run(`return input?.value==='API-DRAFT'`),
      "restored API draft",
    );
    await send(v, id, "normal");
    const record = await row(id);
    assert.deepEqual(await contents(id), ["normal", "REPLY-normal"]);
    const payload = await lastPayload();
    // 默认带上官网图片：已转存的写成文件块，其余附件写成文字占位。
    const asText = (m) => {
      const note = (m.attachments ?? []).filter((a) => !a.fileId).map((a) => `[附件：${a.name}（${a.kind === "image" ? "图片" : "文件"}），内容不可用]`);
      const body = [...note, m.content].filter(Boolean).join("\n\n");
      const files = (m.attachments ?? []).filter((a) => a.fileId);
      return { role: m.role, content: files.length ? [...files.map((a) => ({ type: "file", file_id: a.fileId })), { type: "text", text: body }] : body };
    };
    assert.deepEqual(payload.slice(0, -2), record.imported.map(asText));
    assert.equal(payload.at(-2).role, "latest_reminder");
    assert.match(payload.at(-2).content, /^\d{4}-\d{2}-\d{2},星期.,,Web,中文$/);
    assert.deepEqual(payload.at(-1), { role: "user", content: "normal" });
    assert(
      await v.run(
        `return document.querySelector('ds-api-thread').previousElementSibling.matches('.ds-virtual-list-items')`,
      ),
    );
    await v.click("官网");
    assert.match(await v.text(), /REPLY-normal/);
    assert.equal(await official.inputValue(), "OFFICIAL-DRAFT");
  });
  await test("SPA home → B → C, back and forward can actually send", async () => {
    const b = fresh(),
      c = fresh(),
      v = await page(null);
    await push(v, b);
    await start(v);
    await send(v, b, "B1");
    await push(v, c);
    await until(
      () =>
        v.run(
          `return !!btn('API')&&!input&&!th?.textContent.includes('REPLY-B1')`,
        ),
      "new session C",
    );
    await start(v);
    await send(v, c, "C1");
    await v.p.evaluate(() => history.back());
    await until(
      () => v.run(`return th?.textContent.includes('REPLY-B1')`),
      "B restored",
    );
    await send(v, b, "B2");
    await v.p.evaluate(() => history.forward());
    await until(
      () => v.run(`return th?.textContent.includes('REPLY-C1')`),
      "C restored",
    );
    await send(v, c, "C2");
    assert.deepEqual(await contents(b), ["B1", "REPLY-B1", "B2", "REPLY-B2"]);
    assert.deepEqual(await contents(c), ["C1", "REPLY-C1", "C2", "REPLY-C2"]);
  });
  await test("SPA same-task navigation and old submit", async (e) => {
    const { id, v } = await populated(),
      next = fresh(),
      before = await row(id),
      n = await apiCount();
    await v.type("route-race");
    await until(() => v.run("return send && !send.disabled"), "armed send");
    await v.run(`history.pushState({},'',${j(path(next))});send.click()`);
    await until(() => v.run(`return !!btn('API')&&!input`), "destination mode");
    await wait(250);
    e.apiDelta = (await apiCount()) - n;
    assert.equal(e.apiDelta, 0);
    assert.deepEqual(await row(id), before);
    assert.equal(await row(next), null);
  });
  await test("Editing conflict preserves draft and both turns until cancel/reselect", async (e) => {
    const { id, v } = await populated();
    await v.click("编辑");
    await v.type("edited-Q1");
    const writer = await page(id);
    await send(writer, id, "Q2");
    await v.p.bringToFront();
    await v.p.evaluate(() => dispatchEvent(new Event("focus")));
    await until(
      () => v.run(`return th?.textContent.includes('REPLY-Q2')`),
      "refreshed second turn",
    );
    const snapshot = await row(id);
    assert.equal(await v.run("return input?.value"), "edited-Q1");
    e.disabled = await v.run("return !!send?.disabled");
    await noSend(v, id, null);
    assert(e.disabled, "submit should be disabled");
    assert.match(
      await v.run(`return (comp?.textContent??'')+(th?.textContent??'')`),
      /记录已变化，请取消编辑后重新选择提问。修改稿仍在输入框中。/,
    );
    assert.equal(await v.run("return input.value"), "edited-Q1");
    assert.deepEqual(await row(id), snapshot);
    await v.click("取消");
    await v.click("编辑");
    assert.equal(await v.run("return input.value"), "Q2");
    await send(v, id, "edited-Q2");
    assert.deepEqual(await contents(id), [
      "Q1",
      "REPLY-Q1",
      "edited-Q2",
      "REPLY-edited-Q2",
    ]);
  });
  for (const action of ["reimport", "delete"])
    await test(`Stale ${action} requires refreshed count and a second confirmation`, async (e) => {
      const { id, v: writer } = await populated();
      const o = config(id);
      if (action === "reimport") o.extra = true;
      const stale = await page(id);
      const buttonExpr =
        action === "reimport"
          ? `buttons.find(b=>b.textContent.startsWith('重新导入'))`
          : `btn('删除本机记录')`;
      await until(
        () =>
          stale.run(
            `return !!(${buttonExpr})&&th.querySelectorAll('.turn').length===2`,
          ),
        "initial two-turn UI and action",
      );
      if (action === "delete")
        await stale.run(`th.querySelector('details.context').open=true`);
      // Keep the stale page in the background throughout the first click. The writer already checked history.
      await writer.p.bringToFront();
      await send(writer, id, "Q2");
      const before = await row(id);
      e.staleCount = await stale.run(
        `return th.querySelectorAll('.turn').length`,
      );
      assert.equal(e.staleCount, 2);
      e.firstConfirmation = await confirm(stale, `${buttonExpr}.click()`);
      await wait(400);
      assert.deepEqual(
        await row(id),
        before,
        "first stale confirmation removed or modified newer data",
      );
      await until(
        () =>
          stale.run(
            `return th.querySelectorAll('.turn').length===4 && /再次确认|重新确认|重新核对/.test(th.textContent)`,
          ),
        "fresh count and reconfirm notice",
      );
      assert.match(e.firstConfirmation, /2/);
      if (action === "reimport")
        assert.match(await stale.run(`return ${buttonExpr}.textContent`), /4/);
      if (action === "delete")
        await stale.run(`th.querySelector('details.context').open=true`);
      e.secondConfirmation = await confirm(stale, `${buttonExpr}.click()`);
      assert.match(e.secondConfirmation, /4/);
      await until(
        async () =>
          action === "delete"
            ? (await row(id)) === null
            : (await row(id))?.leafId === "11" && !(await contents(id)).length,
        "explicitly confirmed destructive operation",
      );
    });
  await test("Rapid return to API checks changed history within 60 s", async (e) => {
    const { id, v } = await populated(),
      o = config(id);
    await v.click("官网");
    o.extra = true;
    const n = o.reads;
    await v.click("API");
    await until(() => o.reads > n, "fresh history GET");
    await until(() => v.has("继续用旧快照"), "new history decision");
    e.additionalReads = o.reads - n;
  });
  for (const state of ["pending", "changed", "unavailable"])
    await test(`History ${state} blocks send, Enter, edit and regenerate`, async (e) => {
      const { id } = await populated(),
        o = config(id);
      o.extra = true;
      o.fail = state === "unavailable";
      const n = o.reads;
      const release = state === "pending" ? pauseHistory(o) : () => {};
      const v = await page(id);
      await until(() => o.reads > n, "fresh GET");
      if (state !== "pending")
        await until(
          () => v.has("继续用旧快照"),
          "explicit old snapshot choice",
        );
      if (state === "unavailable") assert(await v.has("重新读取"));
      await noSend(v, id, "guard-" + state, { edit: true });
      release();
      await choose(v, "继续用旧快照");
      await send(v, id, "explicit-old-" + state);
      e.prompt = (await lastPayload()).map((m) => m.content);
      assert(!e.prompt.some((s) => s.includes("NEW-OFFICIAL-" + id)));
      assert(e.prompt.includes("REPLY-Q1"));
    });
  for (const state of ["pending", "changed", "unavailable"])
    await test(`Active edit cannot resubmit while history is ${state}`, async () => {
      const { id, v } = await populated(),
        o = config(id);
      await v.click("编辑");
      await v.type("keep-edited-Q1");
      await v.click("官网");
      o.extra = true;
      o.fail = state === "unavailable";
      const n = o.reads;
      const release = state === "pending" ? pauseHistory(o) : () => {};
      await v.click("API");
      await until(() => o.reads > n, "reentry GET while editing");
      if (state !== "pending")
        await until(
          () => v.has("继续用旧快照"),
          "history decision with active edit",
        );
      assert.equal(await v.run("return input?.value"), "keep-edited-Q1");
      assert(await v.has("取消"));
      await noSend(v, id, null);
      release();
      await choose(v, "继续用旧快照");
      assert.equal(await v.run("return input?.value"), "keep-edited-Q1");
    });
  await test("History read retry can recover and import fresh history", async () => {
    const { id } = await populated(),
      o = config(id);
    o.fail = true;
    o.extra = true;
    const v = await page(id);
    await until(() => v.has("继续用旧快照"), "read error choice");
    o.fail = false;
    await choose(v, "重新读取");
    await until(
      () =>
        v.run(`return buttons.some(b=>b.textContent.startsWith('重新导入'))`),
      "successful retry changed history",
    );
    await confirm(
      v,
      `buttons.find(b=>b.textContent.startsWith('重新导入')).click()`,
    );
    await send(v, id, "fresh-history");
    assert(
      (await lastPayload()).some((m) =>
        m.content.includes("NEW-OFFICIAL-" + id),
      ),
    );
    assert.deepEqual(await contents(id), [
      "fresh-history",
      "REPLY-fresh-history",
    ]);
  });
  await test("Frozen notice and real export button stay operable", async () => {
    const id = fresh();
    config(id).frozen = true;
    const v = await page(id);
    await start(v);
    await v.p
      .locator("#export")
      .evaluate((b) => (b.onclick = () => (b.dataset.clicked = "yes")));
    assert(await v.p.locator("#notice").isVisible());
    await v.p.locator("#export").click();
    assert.equal(
      await v.p.locator("#export").getAttribute("data-clicked"),
      "yes",
    );
    await v.click("官网");
    assert(await v.p.locator("#notice").isVisible());
  });
  async function holding(v, id, q) {
    await submit(v, q);
    await until(
      () =>
        v.run(
          `return !!comp?.querySelector('[aria-label="停止"]')&&th.textContent.includes(${j("REPLY-" + q)})`,
        ),
      "first chunk with stop available",
    );
    assert.deepEqual((await contents(id)).slice(-1), [q]);
  }
  async function stopped(id, q) {
    await until(
      async () => {
        const r = await row(id),
          last = r?.turns.at(-1);
        return (
          last?.content === "REPLY-" + q &&
          last.interrupted &&
          (await worker.evaluate(
            async ([id, q]) =>
              streams[q]?.aborted &&
              !(await navigator.locks.query()).held.some((l) =>
                l.name.endsWith(id),
              ),
            [id, q],
          ))
        );
      },
      "partial reply committed, request aborted and lock released",
      7200,
    );
  }
  for (const reason of ["sticky-to-static", "list-lost"])
    await test(`Layout loss ${reason} stops stream, saves partial and remounts`, async () => {
      const id = fresh(),
        v = await page(id),
        q = "HOLD-" + reason;
      await start(v);
      await holding(v, id, q);
      const css = reason === "sticky-to-static";
      await v.p.evaluate((css) => {
        if (css) document.querySelector(".sticky").style.position = "static";
        else
          document.querySelector(".ds-virtual-list-items").className = "lost";
      }, css);
      await until(
        async () => !(await v.p.locator("ds-api-composer").count()),
        "composer removed",
      );
      await stopped(id, q);
      await v.p.evaluate((css) => {
        if (css) document.querySelector(".sticky").style.position = "sticky";
        else
          document.querySelector(".lost").className = "ds-virtual-list-items";
      }, css);
      await until(
        () => v.run(`return th?.textContent.includes(${j("REPLY-" + q)})`),
        "remounted partial",
      );
      await send(v, id, "after-layout");
    });
  await test("SPA disconnect clears heartbeat and commits partial to original session", async (e) => {
    const id = fresh(),
      other = fresh(),
      v = await page(id),
      q = "HOLD-heartbeat";
    await start(v);
    const errors = [];
    v.c.on("Runtime.exceptionThrown", ({ exceptionDetails: d }) =>
      errors.push(d.exception?.description ?? d.text),
    );
    // Keep the real 20 s period. Track the actual interval in the content-script world as well as any late uncaught exception.
    await v.run(`globalThis.heartbeats=new Set();const origSet=setInterval,origClear=clearInterval;
      globalThis.setInterval=function(f,ms,...args){const timer=origSet(f,ms,...args);if(ms===20000)heartbeats.add(timer);return timer};
      globalThis.clearInterval=function(timer){heartbeats.delete(timer);return origClear(timer)}`);
    await holding(v, id, q);
    e.armed = await v.run("return heartbeats.size");
    assert.equal(e.armed, 1);
    await push(v, other);
    await stopped(id, q);
    assert.equal(await row(other), null);
    await wait(20500);
    e.remaining = await v.run("return heartbeats.size");
    e.errors = errors;
    assert.deepEqual(errors, []);
    assert.equal(e.remaining, 0);
  });
  await test("Delayed A history does not appear in B", async (e) => {
    const a = fresh(),
      b = fresh(),
      o = config(a);
    o.extra = true;
    const release = pauseHistory(o),
      v = await page(a);
    await v.click("API");
    await until(() => o.reads === 1, "A GET in flight");
    await v.run(
      `globalThis.oldFrames=[];const observer=new MutationObserver(()=>{if(location.pathname===${j(path(b))}&&shadow('thread')?.textContent.includes(${j("NEW-OFFICIAL-" + a)}))oldFrames.push(true)});observer.observe(th,{subtree:true,childList:true,characterData:true});history.pushState({},'',${j(path(b))})`,
    );
    release();
    await until(() => v.run(`return !!btn('API')&&!input`), "new B session");
    await start(v);
    await send(v, b, "destination");
    e.stalePaints = await v.run("return oldFrames.length");
    assert.equal(e.stalePaints, 0);
    assert.equal(await row(a), null);
    assert(
      !(await lastPayload()).some((m) => m.content === "NEW-OFFICIAL-" + a),
    );
  });
  await test("Late inbound stream delta never renders on destination route", async (e) => {
    const a = fresh(),
      b = fresh(),
      q = "HOLD-inbound",
      v = await page(a);
    await start(v);
    // Delay one real worker message at the content listener boundary. This lets a
    // queued delta arrive after navigation even when normal unmount aborts instantly.
    await v.run(`const connect=chrome.runtime.connect.bind(chrome.runtime);
      chrome.runtime.connect=(...args)=>{
        const port=connect(...args),event=port.onMessage,add=event.addListener.bind(event);
        event.addListener=listener=>add((message,...rest)=>{
          if(message.type==='live' && message.text.includes('LATE-ONLY-A')) {
            globalThis.deliverQueued=()=>listener(message,...rest);
          } else listener(message,...rest);
        });return port;
      }`);
    await holding(v,a,q);
    await worker.evaluate(q=>streams[q].chunk('LATE-ONLY-A'),q);
    await until(()=>v.run(`return typeof deliverQueued==='function'`),'real incoming delta held before UI listener');
    await v.run(`globalThis.latePaints=[];
      new MutationObserver(()=>{if(location.pathname===${j(path(b))} && th.textContent.includes('LATE-ONLY-A'))latePaints.push(true)}).observe(th,{subtree:true,childList:true,characterData:true});
      history.pushState({},'',${j(path(b))});deliverQueued();`);
    e.realDeltaReplayed=true;
    await until(()=>v.run(`return !!btn('API')&&!input`),'destination official mode');
    e.stalePaints = await v.run("return latePaints.length");
    assert.equal(e.stalePaints, 0);
    assert.equal(await row(b), null);
  });
  await test("Completed Markdown is not reparsed on typing or stream chunks", async (e) => {
    const { id, v } = await populated();
    await send(v, id, "stable-markdown");
    await v.run(
      `globalThis.parses=[];const p=Element.prototype, desc=Object.getOwnPropertyDescriptor(p,'innerHTML');Object.defineProperty(p,'innerHTML',{...desc,set(val){if(this.localName==='template')parses.push(String(val));return desc.set.call(this,val)}})`,
    );
    await v.type("x");
    await wait(160);
    e.afterKey = await v.run("return [...parses]");
    const q = "HOLD-markdown";
    await holding(v, id, q);
    await worker.evaluate((q) => streams[q].chunk("-second"), q);
    await until(
      () => v.run(`return th.textContent.includes('HOLD-markdown-second')`),
      "separate second chunk",
    );
    await worker.evaluate((q) => streams[q].end(), q);
    await until(
      async () => (await contents(id)).at(-1) === "REPLY-HOLD-markdown-second",
      "second chunk persisted",
    );
    const parses = await v.run("return [...parses]");
    assert(
      parses.some((s) => s.includes("HOLD-markdown-second")),
      "sanitizer probe must detect new Markdown",
    );
    e.completedParses = parses.filter(
      (s) => s.includes("REPLY-Q1") || s.includes("REPLY-stable-markdown"),
    );
    assert.deepEqual(e.completedParses, []);
  });
  await test("Previously stored turns with optional legacy fields absent", async () => {
    const id = fresh(),
      v = await page(id);
    await start(v);
    await v.p.close();
    await worker.evaluate(
      (id) =>
        new Promise((ok, bad) => {
          const r = indexedDB.open("ds-api-continue", 1);
          r.onerror = () => bad(r.error);
          r.onsuccess = () => {
            const db = r.result,
              tx = db.transaction("sessions", "readwrite"),
              s = tx.objectStore("sessions"),
              q = s.get(id);
            q.onsuccess = () => {
              const record = q.result;
              delete record.skippedUnknownFragments;
              delete record.dismissedLeafId;
              record.turns = [
                { role: "user", content: "legacy user" },
                {
                  role: "assistant",
                  content: "legacy reply",
                  interrupted: true,
                },
              ];
              s.put(record);
            };
            tx.oncomplete = () => {
              db.close();
              ok();
            };
            tx.onabort = () => bad(tx.error);
          };
        }),
      id,
    );
    const next = await page(id);
    await until(
      () =>
        next.run(`return !!input && th.textContent.includes('legacy reply')`),
      "legacy reply and API mode",
    );
    await send(next, id, "next");
    assert.deepEqual(await contents(id), [
      "legacy user",
      "legacy reply",
      "next",
      "REPLY-next",
    ]);
    assert((await lastPayload()).some((m) => m.content === "legacy reply"));
  });
  await test("Saved key masked and native settings popup opens from page", async () => {
    const pop = await ctx.newPage(),
      popupUrl = `chrome-extension://${extId}/popup.html`;
    await pop.goto(popupUrl);
    await pop.getByRole("heading", { name: "API 续聊 for DeepSeek" }).waitFor();
    const text = await pop.locator("main").innerText();
    assert(text.includes("••••••••-key"));
    assert(!text.includes("synthetic-regression-key"));
    // v0.4.0: with a key saved, the input stays hidden until 更换 is clicked, and opens empty.
    assert.equal(await pop.locator("input[type=password]").count(), 0, "input hidden while key saved");
    await pop.getByRole("button", { name: "更换" }).click();
    assert.equal(await pop.locator("input[type=password]").inputValue(), "");
    await pop.getByRole("button", { name: "取消" }).click();
    // v0.3.2: the popup queries the balance through the worker with the saved key.
    await until(async () => (await pop.locator("main").innerText()).includes("账户余额：¥12.34"), "balance shown");
    assert.deepEqual(await worker.evaluate(() => globalThis.balanceReads), ["Bearer synthetic-regression-key"]);
    await pop.getByRole("button", { name: "清除" }).click();
    await until(
      () =>
        worker.evaluate(
          async () => !(await chrome.storage.local.get("apiKey")).apiKey,
        ),
      "key cleared",
    );
    await pop.close();
    const v = await page(fresh());
    await v.click("API");
    await until(() => v.has("打开设置"), "open settings action");
    await v.p.bringToFront();
    const targets = async () =>
      (await cdp.send("Target.getTargets")).targetInfos.filter(
        (t) => t.url === popupUrl,
      );
    assert.equal((await targets()).length, 0);
    await until(()=>v.has("确认并开始"),"stable settings layout");
    const point = await v.run(
      `const b=btn('打开设置');b.scrollIntoView();const r=b.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]`,
    );
    await v.p.mouse.click(...point);
    await until(
      async () => (await targets()).length === 1,
      "new browser action popup",
    );
  });
  // ---- v0.3：附件、官网图片、联网搜索 ----
  // 上一项测试清除了 Key，这里重新设置。
  await worker.evaluate(() => chrome.storage.local.set({ apiKey: "synthetic-regression-key" }));
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

  await test("Official images are carried over with consent and replayed as file parts", async (e) => {
    const readsBefore = await worker.evaluate(() => officialImageReads.length);
    const uploadsBefore = await worker.evaluate(() => uploads.length);
    const id = fresh(), v = await page(id);
    await choose(v, "API");
    await until(async () => /带上官网历史里的 1 张图片/.test(await v.text()), "image checkbox");
    await choose(v, "确认并开始");
    await until(async () => (await row(id))?.imported.some((m) => m.attachments?.some((a) => a.fileId)), "official image uploaded");
    e.imageReads = (await worker.evaluate(() => officialImageReads)).slice(readsBefore);
    e.uploads = (await worker.evaluate(() => uploads)).slice(uploadsBefore);
    assert.equal(e.imageReads.length, 1);
    assert.equal(e.imageReads[0].credentials, "omit");
    assert.match(e.imageReads[0].url, /^https:\/\/files\.deepseeksvc\.com\/api\/file\?file_id=file-a&state=synthetic-state&ty=p$/);
    assert.deepEqual(e.uploads.map((u) => [u.purpose, u.keys.join(","), u.type]), [["user_data", "purpose,file", "image/webp"]]);
    const record = await row(id);
    assert.deepEqual(record.uploadedFileIds, [e.uploads[0].id]);
    assert(!JSON.stringify(record).includes("synthetic-state"), "temporary image address persisted");
    await until(() => v.run("return input && !input.disabled"), "input ready");
    await send(v, id, "after-image");
    const call = await lastCall();
    e.model = call.model;
    assert.equal(call.model, "deepseek-flash");
    assert.deepEqual(call.messages[2], { role: "user", content: [{ type: "file", file_id: e.uploads[0].id }, { type: "text", text: "看这张图" }] });
    assert.equal(call.messages[4].content, "[附件：报告.pdf（文件），内容不可用]");
    await v.run(`th.querySelector('details.context summary').click()`);
    assert.match(await v.text(), /已带上官网历史里的 1 张图片/);
  });

  await test("Unchecking official images keeps placeholders and uploads nothing", async () => {
    const before = await worker.evaluate(() => uploads.length);
    const id = fresh(), v = await page(id);
    await choose(v, "API");
    await until(() => v.run(`return !!th.querySelector('label.check input')`), "image checkbox");
    await v.run(`th.querySelector('label.check input').click()`);
    await choose(v, "确认并开始");
    await until(() => v.run("return input && !input.disabled"), "input ready");
    await send(v, id, "no-image");
    assert.equal(await worker.evaluate(() => uploads.length), before);
    const call = await lastCall();
    assert.equal(call.messages[2].content, "[附件：截图.png（图片），内容不可用]\n\n看这张图");
    assert.equal((await row(id)).officialImages, false);
  });

  await test("Picker uploads use the right purpose, convert BMP, reject PSD and send file parts", async (e) => {
    const { id, v } = await populated();
    const before = await worker.evaluate(() => uploads.length);
    // 1×1 的 24 位 BMP（Chrome 能解码，API 不认），应在本地转成 PNG。
    const bmp = [66,77,58,0,0,0,0,0,0,0,54,0,0,0,40,0,0,0,1,0,0,0,1,0,0,0,1,0,24,0,0,0,0,0,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,0,0,0];
    await fileInput(v, [["notes.md", "text/markdown", "# synthetic"], ["report.pdf", "application/pdf", "%PDF-synthetic"], ["scan.bmp", "image/bmp", bmp], ["layers.psd", "image/vnd.adobe.photoshop", "x"]]);
    await until(async () => (await chips(v)).filter((c) => c.startsWith("file ready")).length === 3, "three ready chips");
    e.note = await v.run(`return comp.querySelector('.file-note')?.textContent ?? ''`);
    assert.match(e.note, /layers\.psd/);
    const made = (await worker.evaluate(() => uploads)).slice(before);
    e.uploads = made;
    assert.deepEqual(made.map((u) => [u.name, u.purpose, u.type]).sort(), [
      ["notes.md", "user_data", "text/markdown"], ["report.pdf", "rich_layout_recognition", "application/pdf"], ["scan.png", "user_data", "image/png"]]);
    await v.type("WITH-FILES");
    await until(() => v.run("return send && !send.disabled"), "send enabled");
    await v.run("send.click()");
    await until(async () => (await contents(id))?.at(-1) === "REPLY-WITH-FILES", "reply with files");
    const call = await lastCall();
    const parts = call.messages.at(-1).content;
    assert.deepEqual(parts.filter((p) => p.type === "file").map((p) => p.file_id).sort(), made.map((u) => u.id).sort());
    assert.deepEqual(parts.at(-1), { type: "text", text: "WITH-FILES" });
    assert.equal(call.messages.at(-2).role, "latest_reminder");
    assert.deepEqual((await row(id)).turns.at(-2).attachments.map((a) => a.name).sort(), ["notes.md", "report.pdf", "scan.bmp"]);
    if (process.env.SHOTS) await v.p.screenshot({ path: join(reports, "files.png") });
    assert.deepEqual(await chips(v), [], "draft chips cleared after send");
    assert.match(await v.text(), /notes\.md/);
  });

  await test("Removing a draft file deletes it remotely; deleting the record deletes all uploads", async (e) => {
    const { id, v } = await populated();
    const imported = (await row(id)).uploadedFileIds ?? [];
    await fileInput(v, [["keep.txt", "text/plain", "keep"], ["drop.txt", "text/plain", "drop"]]);
    await until(async () => (await chips(v)).filter((c) => c.startsWith("file ready")).length === 2, "ready chips");
    const ids = (await row(id)).uploadedFileIds;
    assert.equal(ids.length, imported.length + 2);
    await v.run(`comp.querySelector('[aria-label="移除 drop.txt"]').click()`);
    await until(async () => (await row(id)).uploadedFileIds.length === imported.length + 1, "upload released");
    const remaining = (await row(id)).uploadedFileIds;
    const dropped = ids.find((x) => !remaining.includes(x));
    // The DELETE is sent after the record update commits; wait for it instead of sampling once.
    await until(() => worker.evaluate((x) => deletes.includes(x), dropped), "removed draft file deleted remotely");
    await send(v, id, "KEEP-FILE");
    const kept = (await row(id)).uploadedFileIds;
    await v.run(`th.querySelector('details.context summary').click()`);
    const message = await confirm(v, `btn('删除本机记录').click()`);
    e.message = message;
    await until(async () => !(await row(id)), "record deleted");
    await until(() => worker.evaluate((x) => x.every((f) => deletes.includes(f)), kept), "all uploads deleted remotely");
  });

  await test("Pasted image and dropped file become API attachments; the official page never sees the drop", async (e) => {
    const { id, v } = await populated();
    const before = await worker.evaluate(() => uploads.length);
    await v.run(`
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([137,80,78,71])], 'clip.png', { type: 'image/png' }));
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));`);
    await v.p.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["dropped"], "drop.csv", { type: "text/csv" }));
      const target = document.querySelector("ds-api-composer");
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, composed: true }));
      }
      // 落在页面其他位置的文件也不能交给官网。
      const outside = new DataTransfer();
      outside.items.add(new File(["x"], "outside.txt", { type: "text/plain" }));
      for (const type of ["dragenter", "dragover", "drop"]) {
        document.body.dispatchEvent(new DragEvent(type, { dataTransfer: outside, bubbles: true, cancelable: true }));
      }
    });
    await until(async () => (await chips(v)).filter((c) => c.startsWith("file ready")).length === 2, "pasted and dropped chips");
    e.officialDrops = await v.p.evaluate(() => officialDrops);
    assert.equal(e.officialDrops, 0);
    e.names = (await worker.evaluate(() => uploads)).slice(before).map((u) => u.name).sort();
    assert.deepEqual(e.names, ["clip.png", "drop.csv"]);
    await v.click("官网");
    await v.p.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "official.txt", { type: "text/plain" }));
      document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    assert.equal(await v.p.evaluate(() => officialDrops), 1, "official mode leaves drops to the site");
  });

  await test("Smart search declares both tools, shows progress, citations and sources, and replays tool calls", async (e) => {
    const { id, v } = await populated();
    await choose(v, "智能搜索");
    await until(() => worker.evaluate(async () => (await chrome.storage.local.get("search")).search === true), "search saved");
    await submit(v, "SEARCH-1");
    await until(async () => (await contents(id))?.at(-1) === "CITED-SEARCH-1", "search reply");
    let call = await lastCall();
    assert.deepEqual(call.tools, [{ type: "deepseek_web_search" }, { type: "deepseek_read_url" }]);
    const turn = (await row(id)).turns.at(-1);
    assert.equal(turn.serverToolCalls[0].calls[0].id, "srvtoolu_s_00_x");
    assert.deepEqual(turn.toolUse, { search: 1, fetch: 0, imageSearch: 0 });
    await until(() => v.run(`return !!th.querySelector('.markdown a[href="https://example.test/one"]')`), "citation marker");
    e.sources = await v.run(`return th.querySelector('details.sources summary')?.textContent`);
    assert.match(e.sources, /已搜索 2 个网页/);
    assert.match(await v.text(), /搜索 1 次/);
    if (process.env.SHOTS) {
      await v.run(`th.querySelector('details.sources summary').click()`);
      await v.p.screenshot({ path: join(reports, "search.png") });
    }
    await send(v, id, "AFTER-SEARCH");
    call = await lastCall();
    const replay = call.messages.find((m) => m.role === "assistant" && m.server_tool_calls);
    assert.equal(replay?.server_tool_calls[0].calls[0].id, "srvtoolu_s_00_x");
    await choose(v, "智能搜索");
    await until(() => worker.evaluate(async () => (await chrome.storage.local.get("search")).search === false), "search off");
  });

  await test("deepseek-v4-pro switches to flash with a visible note when search is on", async (e) => {
    const { id, v } = await populatedWithoutImages();
    await v.run(`const s = comp.querySelector('select[aria-label="模型"]'); s.value = 'deepseek-v4-pro'; s.dispatchEvent(new Event('change', { bubbles: true }))`);
    await until(() => worker.evaluate(async () => (await chrome.storage.local.get("model")).model === "deepseek-v4-pro"), "pro saved");
    await send(v, id, "PRO-PLAIN");
    assert.equal((await lastCall()).model, "deepseek-v4-pro");
    await choose(v, "智能搜索");
    await until(() => v.run(`return /本条将使用 deepseek-flash（已开智能搜索）/.test(comp.textContent)`), "flash note");
    await send(v, id, "PRO-SEARCH");
    assert.equal((await lastCall()).model, "deepseek-flash");
    assert.equal((await row(id)).turns.at(-1).model, "deepseek-flash");
    await choose(v, "智能搜索");
    await worker.evaluate(() => chrome.storage.local.set({ model: "deepseek-flash" }));
  });

  await test("v0.4.0 popup effort is remembered and sent only while thinking is on", async (e) => {
    const popupUrl = `chrome-extension://${extId}/popup.html`;
    await worker.evaluate(() => chrome.storage.local.set({ thinking: true }));
    await worker.evaluate(() => chrome.storage.local.remove("effort"));
    let pop = await ctx.newPage();
    await pop.goto(popupUrl);
    const level = (name) => pop.getByRole("radiogroup", { name: "思考强度" }).getByRole("radio", { name, exact: true });
    const checked = async () => {
      for (const name of ["低", "高", "最高"]) if ((await level(name).getAttribute("aria-checked")) === "true") return name;
    };
    await level("高").waitFor();
    assert.equal(await checked(), "高", "default effort");
    await level("最高").click();
    await until(() => worker.evaluate(async () => (await chrome.storage.local.get("effort")).effort === "max"), "max saved");
    await pop.close();

    const { id, v } = await populatedWithoutImages();
    e.withThinking = { thinking: (await lastCall()).thinking, effort: (await lastCall()).reasoning_effort };
    assert.deepEqual(e.withThinking, { thinking: { type: "enabled" }, effort: "max" });
    await choose(v, "深度思考");
    await until(() => worker.evaluate(async () => (await chrome.storage.local.get("thinking")).thinking === false), "thinking off");
    await send(v, id, "NO-THINKING");
    const off = await lastCall();
    assert.deepEqual(off.thinking, { type: "disabled" });
    assert(!("reasoning_effort" in off), "effort omitted without thinking");

    pop = await ctx.newPage();
    await pop.goto(popupUrl);
    await level("最高").waitFor();
    assert.equal(await checked(), "最高", "effort restored");
    assert(await level("最高").isDisabled(), "effort disabled while thinking is off");
    assert.equal(await pop.getByRole("switch", { name: "深度思考" }).isChecked(), false, "thinking switch reflects storage");
    await pop.close();
    await worker.evaluate(() => chrome.storage.local.set({ thinking: true, effort: "high" }));
  });

  await test("v0.3.2 confirm card estimates the cost before the first send", async (e) => {
    const id = fresh(),
      v = await page(id);
    await choose(v, "API");
    await until(() => v.has("确认并开始"), "confirm card");
    const card = await v.text();
    e.card = card.split("\n").filter((l) => /上下文|预计/.test(l));
    assert(/上下文：约 [\d,.]+ (万 )?token（deepseek-flash）/.test(card), "context estimate");
    assert(/按当前导入历史估算，每次发送约 ¥\d+\.\d+（(高峰|空闲)时段，含最多 65,536 tokens 的回复）/.test(card), "cost estimate");
    assert(card.includes("实际按用量扣费"), "cost billed by usage");
    assert(!card.includes("官网历史累计"), "old cumulative line removed");
  });
  await test("v0.3.2 formulas, code copy, question copy, cost and local-only note", async (e) => {
    const id = fresh(),
      v = await page(id);
    await start(v);
    await submit(v, "RICH-1");
    await until(async () => (await contents(id))?.at(-1)?.startsWith("REPLY-RICH-1"), "rich reply saved");
    await until(() => v.run("return !!th?.querySelector('.markdown math')"), "formula rendered");
    const dom = await v.run(`const md=[...th.querySelectorAll('.turn.assistant .markdown')].at(-1);
      return { inline: md.querySelectorAll('.math-inline math').length, display: md.querySelectorAll('.math-display math[display=block]').length,
        raw: md.textContent.includes('$S='), code: md.querySelectorAll('.code-block .code-copy').length,
        codeLabel: md.querySelector('.code-copy')?.getAttribute('aria-label'), textHasButton: md.textContent.includes('复制代码'),
        style: [...md.querySelectorAll('[style]')].length,
        userCopy: [...th.querySelectorAll('.turn.user .actions button')].map(b=>b.textContent.trim()),
        meta: [...th.querySelectorAll('.turn.assistant .meta')].at(-1)?.textContent }`);
    e.dom = dom;
    assert.equal(dom.inline, 1, "inline formula");
    assert.equal(dom.display, 1, "display formula");
    assert(!dom.raw, "raw TeX left in text");
    assert.equal(dom.code, 1, "code copy button");
    assert.equal(dom.codeLabel, "复制代码");
    assert(!dom.textHasButton, "button text leaked into reply text");
    assert.equal(dom.style, 0, "inline styles in sanitized reply");
    assert(dom.userCopy.includes("复制提问"), "question copy");
    assert(/本条约 ¥0\.\d{3}/.test(dom.meta), "actual cost");
    const saved = (await row(id)).turns.at(-1);
    e.cost = saved.costYuan;
    assert(saved.costYuan > 0 && saved.costYuan < 0.1, "stored cost");
    // The last plain 复制 button is still the latest reply's copy, as the real-page harness expects.
    const last = await v.run(`const all=[...th.querySelectorAll('button')].filter(b=>b.textContent.trim()==='复制');
      return all.at(-1)?.closest('.turn')?.classList.contains('assistant')`);
    assert(last, "last 复制 belongs to the assistant reply");
    await v.p.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await v.run(`th.querySelector('.code-copy').click()`);
    await until(() => v.run(`return th.querySelector('.code-copy')?.dataset.state==='done'`), "code copied");
    e.clipboard = await v.p.evaluate(() => navigator.clipboard.readText());
    assert.equal(e.clipboard.trim(), "const rich = 1;");
    await v.run(`[...th.querySelectorAll('.turn.user .actions button')].find(b=>b.textContent.trim()==='复制提问').click()`);
    await until(async () => (await v.p.evaluate(() => navigator.clipboard.readText())) === "RICH-1", "question copied");
    // Official mode keeps the API turns visible and says the site will not send them.
    assert(!(await v.text()).includes("在官网发送时不会带上"));
    await v.click("官网");
    await until(async () => (await v.text()).includes("以上 API 回复只保存在本机，在官网发送时不会带上。"), "local-only note");
    await v.click("API");
    await until(async () => !(await v.text()).includes("在官网发送时不会带上"), "note hidden in API mode");
  });
  await test("Only fixture GETs, local extension resources and mock API", async (e) => {
    e.blocked = await worker.evaluate(() => blocked);
    e.unexpected = unexpected;
    e.interceptedOfficialReads = Array.from(options.values()).reduce(
      (n, o) => n + o.reads,
      0,
    );
    e.mockCalls = await apiCount();
    e.uploads = await worker.evaluate(() => uploads.length);
    e.deletes = await worker.evaluate(() => deletes.length);
    assert(e.mockCalls > 0 && e.interceptedOfficialReads > 0);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(e.blocked, []);
  });
} catch (e) {
  report.fatal = String(e.stack);
  console.error(report.fatal);
  process.exitCode = 1;
} finally {
  await ctx?.close();
  report.finished = new Date().toISOString();
  report.summary = {
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
  };
  if (report.fingerprint && report.fingerprint !== (await fingerprint())) {
    report.buildChanged = true;
    process.exitCode = 1;
  }
  await writeFile(filename, JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(filename, report.summary);
}

