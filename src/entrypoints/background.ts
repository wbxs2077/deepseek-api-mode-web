import { defineBackground } from 'wxt/utils/define-background';
import { browser, type Browser } from 'wxt/browser';
import { getBalance, MODELS, uploadFile } from '../core/client';
import { parseSendOptions } from '../core/send-options';
import { adoptUpload, retryCleanup, uploadKeyTag } from '../core/cleanup';
import { runChat, StaleRecordError } from '../core/chat';
import { extensionOf, FILE_ID, isOfficialImageUrl, MiB, planFile, type Attachment } from '../core/files';
import {
  attachImportedFile,
  createSession,
  deleteSession,
  dismissStale,
  getSession,
  cleanupCount,
  registerUploads,
  reimportSession,
  releaseUploads,
  type SessionRecord,
} from '../core/store';
import {
  CHAT_PORT,
  IMPORT_IMAGES_PORT,
  sessionIdFromPath,
  toView,
  UPLOAD_CHUNK,
  UPLOAD_PORT,
  type BalanceReply,
  type ChatPortIn,
  type ChatPortOut,
  type ImportImagesIn,
  type ImportImagesOut,
  type PageReplies,
  type PageReply,
  type PageRequest,
  type PopupRequest,
  type SettingsView,
  type UploadPortIn,
  type UploadPortOut,
} from '../protocol';
import { loadSettings, saveSettings } from '../settings';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const lockName = (sessionId: string) => `ds-api-continue:${sessionId}`;
const LIVE_INTERVAL_MS = 50;
const OFFICIAL_IMAGE_LIMIT = 64 * MiB;
// 只转发形如 type/subtype 的 MIME，其余留空，由服务端按内容判断格式。
const MIME = /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,80}$/i;

const CHAT_ORIGIN = 'https://chat.deepseek.com';
const routeError = () => new Error('页面已切换到别的对话，请重试');
const keyError = () => new Error('请先在扩展设置里填写 API Key');

function chatUrl(raw?: string) {
  const url = raw && URL.canParse(raw) ? new URL(raw) : null;
  return url?.protocol === 'https:' && url.origin === CHAT_ORIGIN ? url : null;
}

interface SendingPage { tabId: number; documentId?: string; dispatchedSession?: string | null }

function pageOf(sender: Browser.runtime.MessageSender | undefined): SendingPage | null {
  const tabId = sender?.tab?.id;
  if (!sender || sender.id !== browser.runtime.id || sender.frameId !== 0 || tabId == null || tabId < 0 ||
      !chatUrl(sender.url) || (sender.origin !== undefined && sender.origin !== CHAT_ORIGIN) ||
      (sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active')) return null;
  // sender.url 标识文档来源，SPA 导航后其路径可能仍是首次加载的地址。
  const identity = { tabId, documentId: sender.documentId };
  if (sender.tab?.url === undefined) return identity;
  const url = chatUrl(sender.tab.url);
  return url ? { ...identity, dispatchedSession: sessionIdFromPath(url.pathname) } : null;
}

async function currentSession(page: SendingPage) {
  // 现有的站点 host permission 即可读取匹配的 URL。标签关闭或地址不可见时拒绝。
  const tab = await browser.tabs.get(page.tabId);
  const url = chatUrl(tab.url);
  if (!url || tab.id !== page.tabId || tab.pendingUrl) throw routeError();
  const session = sessionIdFromPath(url.pathname);
  if (page.dispatchedSession !== undefined && page.dispatchedSession !== session) throw routeError();
  return session;
}

function requireSession(id: unknown, current: string | null) {
  if (typeof id !== 'string' || id !== current) throw routeError();
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

// 官网快照里的附件只能是没有内容的官网文件。文件 ID 只由 background 写入，页面不能指定。
function officialAttachment(v: unknown): Attachment | null {
  if (!isObject(v) || typeof v.id !== 'string' || typeof v.name !== 'string' || v.source !== 'official' ||
      (v.kind !== 'image' && v.kind !== 'document') || typeof v.bytes !== 'number' || v.fileId !== null) return null;
  return {
    id: v.id, name: v.name, kind: v.kind, bytes: v.bytes, fileId: null, source: 'official',
    ...(typeof v.officialId === 'string' && { officialId: v.officialId }),
  };
}

// 记录由 content script 从官方历史生成，这里只确认形状并去掉页面不该写入的字段，防止写入残缺数据。
function cleanRecord(v: unknown): SessionRecord | null {
  if (!isObject(v) || typeof v.sessionId !== 'string' || typeof v.title !== 'string' ||
      typeof v.importedAt !== 'number' || typeof v.updatedAt !== 'number' ||
      !(v.leafId === null || typeof v.leafId === 'string') ||
      !(v.officialTokens === null || typeof v.officialTokens === 'number') ||
      typeof v.skippedFiles !== 'number' || typeof v.hasBranches !== 'boolean' ||
      !Array.isArray(v.imported) || !v.imported.length || !Array.isArray(v.turns) || v.turns.length) return null;
  const imported: SessionRecord['imported'] = [];
  for (const m of v.imported) {
    if (!isObject(m) || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null;
    if (m.attachments === undefined) {
      imported.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role !== 'user' || !Array.isArray(m.attachments)) return null;
    const attachments = m.attachments.map(officialAttachment);
    if (attachments.some((a) => !a)) return null;
    imported.push({ role: m.role, content: m.content, attachments: attachments as Attachment[] });
  }
  const { uploadedFileIds: _uploads, uploadOwners: _owners, officialImages, ...rest } = v as unknown as SessionRecord;
  return { ...rest, imported, ...(typeof officialImages === 'boolean' && { officialImages }) };
}

async function settingsView(): Promise<SettingsView> {
  const { apiKey, model, thinking, effort, maxTokens, search } = await loadSettings();
  return { hasKey: !!apiKey, model, thinking, effort, maxTokens, search };
}

async function drainSession(sessionId: string, ids?: string[]) {
  return retryCleanup((await loadSettings()).apiKey, { sessionId, ids });
}

async function handle(message: PageRequest, page: SendingPage): Promise<PageReplies[PageRequest['type']]> {
  if (message.type === 'discard-upload') {
    // SPA 卸载通知可晚于导航。发送方仍须是活跃官网顶层文档，且只可释放后台发给该文档的草稿。
    await currentSession({ tabId: page.tabId });
    if (typeof message.sessionId !== 'string' || typeof message.fileId !== 'string' || !FILE_ID.test(message.fileId)) throw routeError();
    const ids = await releaseUploads(message.sessionId, [message.fileId], page);
    return ids.length > 0 && (await drainSession(message.sessionId, ids)) === 0;
  }
  const session = await currentSession(page);
  switch (message.type) {
    case 'get-state': {
      requireSession(message.sessionId, session);
      const record = await getSession(message.sessionId);
      return { session: record ? toView(record) : null, settings: await settingsView() };
    }
    case 'create': {
      const clean = cleanRecord(message.record);
      if (!clean) throw new Error('导入数据不完整');
      requireSession(clean.sessionId, session);
      const created = await createSession(clean);
      const record = created ? clean : await getSession(clean.sessionId);
      if (!record) throw new Error('无法保存本地记录');
      return { session: toView(record), created };
    }
    case 'reimport': {
      if (!Number.isFinite(message.expectedUpdatedAt)) throw new Error('缺少本地记录版本，请刷新后重试');
      const clean = cleanRecord(message.record);
      if (!clean) throw new Error('导入数据不完整');
      requireSession(clean.sessionId, session);
      const record = await navigator.locks.request(lockName(clean.sessionId), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('这条对话正在发送，请稍后再试');
        requireSession(clean.sessionId, await currentSession(page));
        return reimportSession(clean, message.expectedImportedAt, message.keepTurns, message.expectedUpdatedAt);
      });
      // 旧快照和旧回合引用、新快照不再引用的文件，从 API 账号删除。草稿里的上传不受影响。
      if (record) await drainSession(record.sessionId);
      return record ? toView((await getSession(record.sessionId)) ?? record) : null;
    }
    case 'dismiss-stale': {
      requireSession(message.sessionId, session);
      const record = await dismissStale(message.sessionId, message.importedAt, message.leafId);
      return record ? toView(record) : null;
    }
    case 'delete': {
      if (!Number.isFinite(message.expectedUpdatedAt)) throw new Error('缺少本地记录版本，请刷新后重试');
      requireSession(message.sessionId, session);
      const files = await navigator.locks.request(lockName(message.sessionId), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('这条对话正在发送，请先停止');
        requireSession(message.sessionId, await currentSession(page));
        return deleteSession(message.sessionId, message.importedAt, message.expectedUpdatedAt);
      });
      if (!files) return { deleted: false, filesLeft: 0 };
      return { deleted: true, filesLeft: await drainSession(message.sessionId, files) };
    }
    case 'patch-settings': {
      const { model, thinking, search } = message.patch ?? {};
      const patch: { model?: string; thinking?: boolean; search?: boolean } = {};
      if (model !== undefined) {
        if (!MODELS.includes(model as (typeof MODELS)[number])) throw new Error('未知模型');
        patch.model = model;
      }
      for (const [key, value] of [['thinking', thinking], ['search', search]] as const) {
        if (value === undefined) continue;
        if (typeof value !== 'boolean') throw new Error('设置无效');
        patch[key] = value;
      }
      await saveSettings(patch);
      return settingsView();
    }
    case 'open-settings': {
      try {
        await browser.action.openPopup();
        return true;
      } catch {
        return false;
      }
    }
    default:
      throw new Error('未知请求');
  }
}

function base64ToBytes(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// 长连接的公共部分：校验来源，绑定建连时的会话，断开即中止。
function openPort<In, Out>(port: Browser.runtime.Port, onMessage: (message: In, ctx: PortContext<Out>) => void) {
  const page = pageOf(port.sender);
  if (!page) {
    port.disconnect();
    return;
  }
  const ctx: PortContext<Out> = {
    page,
    // 绑定建连时的会话，旧 port 不能用于另一条会话。
    connectedSession: currentSession(page).catch(() => null),
    controller: new AbortController(),
    open: true,
    post(message) {
      if (!ctx.open) return;
      try {
        port.postMessage(message);
      } catch {}
    },
    close() {
      if (ctx.open) port.disconnect();
      ctx.open = false;
    },
    async check(sessionId) {
      requireSession(sessionId, await ctx.connectedSession);
      requireSession(sessionId, await currentSession(page));
      ctx.controller.signal.throwIfAborted();
    },
  };
  port.onDisconnect.addListener(() => {
    ctx.open = false;
    ctx.controller.abort();
  });
  port.onMessage.addListener((message: In) => onMessage(message, ctx));
}

interface PortContext<Out> {
  page: SendingPage;
  connectedSession: Promise<string | null>;
  controller: AbortController;
  open: boolean;
  post(message: Out): void;
  close(): void;
  check(sessionId: unknown): Promise<void>;
}

function chatPort(port: Browser.runtime.Port) {
  let started = false;
  openPort<ChatPortIn, ChatPortOut>(port, (message, ctx) => {
    if (message?.type === 'stop') ctx.controller.abort();
    else if (message?.type === 'run' && !started) {
      started = true;
      void run(message, ctx).finally(() => ctx.close());
    }
  });

  async function run(message: Extract<ChatPortIn, { type: 'run' }>, ctx: PortContext<ChatPortOut>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let editing = false;
    try {
      await ctx.check(message.sessionId);
      let removed: string[] = [];
      await navigator.locks.request(lockName(message.sessionId), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('这条对话正在另一个标签页发送，请稍后再试');
        const settings = await loadSettings();
        if (!settings.apiKey) throw keyError();
        await ctx.check(message.sessionId);
        editing = message.action?.kind === 'edit';
        let live = { text: '', reasoning: '' };
        const result = await runChat({
          sessionId: message.sessionId,
          expected: message.expected,
          action: message.action,
          config: { ...parseSendOptions(message.options), apiKey: settings.apiKey },
          signal: ctx.controller.signal,
          // runChat 读写 IndexedDB 也会让出执行权，发请求前最后核对一次。
          fetchImpl: async (input, init) => {
            await ctx.check(message.sessionId);
            return fetch(input, init);
          },
          onLive: (text, reasoning) => {
            live = { text, reasoning };
            timer ??= setTimeout(() => {
              timer = undefined;
              ctx.post({ type: 'live', ...live });
            }, LIVE_INTERVAL_MS);
          },
          onTool: (event) => ctx.post({ type: 'tool', event }),
          onRecord: (record) => ctx.post({ type: 'session', session: toView(record) }),
        });
        clearTimeout(timer);
        removed = result.removedFileIds ?? [];
        ctx.post({ type: 'done', error: result.error });
      });
      // 编辑时去掉的附件，确认已无引用后从 API 账号删除。
      await drainSession(message.sessionId, removed);
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof StaleRecordError) ctx.post({ type: 'done', error: e.message, stale: e.latest ? toView(e.latest) : null });
      else ctx.post({ type: 'done', error: errorText(e) });
      if (editing) await drainSession(message.sessionId).catch(console.error);
    }
  }
}

function uploadPort(port: Browser.runtime.Port) {
  let begin: Extract<UploadPortIn, { type: 'begin' }> | null = null;
  let plan: Extract<ReturnType<typeof planFile>, { ok: true }> | null = null;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  let finished = false;
  openPort<UploadPortIn, UploadPortOut>(port, (message, ctx) => {
    if (finished) return;
    const fail = (error: string) => {
      finished = true;
      ctx.post({ type: 'error', error });
      ctx.close();
    };
    try {
      if (message?.type === 'begin' && !begin) {
        const { name, uploadName, size } = message;
        if (typeof name !== 'string' || typeof uploadName !== 'string' || !Number.isSafeInteger(size) || size <= 0) return fail('文件信息无效');
        const planned = planFile(uploadName);
        if (!planned.ok) return fail(planned.reason);
        if (size > planned.maxBytes) return fail(`文件超过 ${planned.maxBytes / MiB} MB 上限`);
        begin = message;
        plan = planned;
        void ctx.check(message.sessionId).then(() => ctx.post({ type: 'next' }), (e) => fail(errorText(e)));
      } else if (message?.type === 'chunk' && begin) {
        if (typeof message.data !== 'string') return fail('上传数据无效');
        const bytes = base64ToBytes(message.data);
        received += bytes.length;
        if (bytes.length > UPLOAD_CHUNK || received > begin.size) return fail('上传数据与文件大小不符');
        parts.push(bytes);
        ctx.post({ type: 'next' });
      } else if (message?.type === 'end' && begin && plan) {
        if (received !== begin.size) return fail('上传数据与文件大小不符');
        finished = true;
        void upload(begin, plan, ctx).finally(() => ctx.close());
      }
    } catch (e) {
      fail(errorText(e));
    }
  });

  async function upload(info: NonNullable<typeof begin>, planned: NonNullable<typeof plan>, ctx: PortContext<UploadPortOut>) {
    try {
      const { apiKey } = await loadSettings();
      if (!apiKey) throw keyError();
      await ctx.check(info.sessionId);
      const record = await getSession(info.sessionId);
      if (!record) throw new Error('这条对话的本机记录已不存在');
      const keyTag = await uploadKeyTag(apiKey);
      await ctx.check(info.sessionId);
      if (planned.kind === 'document') ctx.post({ type: 'parsing' });
      const fileId = await uploadFile({
        apiKey,
        file: new Blob(parts, { type: typeof info.mime === 'string' && MIME.test(info.mime) ? info.mime : '' }),
        name: info.uploadName,
        purpose: planned.purpose,
        signal: ctx.controller.signal,
      });
      // 记录被删除时这个文件无处引用，立即删除。
      const draft = { tabId: ctx.page.tabId, documentId: ctx.page.documentId };
      if (!(await adoptUpload(info.sessionId, fileId, keyTag, () => registerUploads(info.sessionId, [fileId], { keyTag, draft }, record.importedAt)))) {
        await drainSession(info.sessionId, [fileId]);
        throw new Error('这条对话的本机记录已不存在');
      }
      const attachment: Attachment = {
        id: crypto.randomUUID(), name: info.name, kind: planned.kind, bytes: info.size, fileId, source: 'local',
      };
      try {
        await ctx.check(info.sessionId);
        port.postMessage({ type: 'done', attachment } satisfies UploadPortOut);
      } catch (e) {
        await releaseUploads(info.sessionId, [fileId], draft);
        await drainSession(info.sessionId, [fileId]);
        throw e;
      }
    } catch (e) {
      ctx.post({ type: 'error', error: ctx.controller.signal.aborted ? '已取消上传' : errorText(e) });
    }
  }
}

function importImagesPort(port: Browser.runtime.Port) {
  let started = false;
  openPort<ImportImagesIn, ImportImagesOut>(port, (message, ctx) => {
    if (message?.type !== 'start' || started) return;
    started = true;
    void run(message, ctx).finally(() => ctx.close());
  });

  async function run(message: ImportImagesIn, ctx: PortContext<ImportImagesOut>) {
    let failed = 0;
    try {
      await ctx.check(message.sessionId);
      const { apiKey } = await loadSettings();
      if (!apiKey) throw keyError();
      const keyTag = await uploadKeyTag(apiKey);
      const images = Array.isArray(message.images) ? message.images : [];
      await navigator.locks.request(lockName(message.sessionId), { signal: ctx.controller.signal }, async () => {
        const record = await getSession(message.sessionId);
        if (!record || record.importedAt !== message.importedAt) throw new Error('这条对话的本机记录已变化，请重试');
        const pending = new Map<string, { name: string }>();
        for (const m of record.imported) {
          for (const a of m.attachments ?? []) if (a.source === 'official' && a.kind === 'image' && !a.fileId) pending.set(a.id, a);
        }
        const work = images.filter(i => isObject(i) && typeof i.attachmentId === 'string' && isOfficialImageUrl(i.url))
          .flatMap(i => {
            const entry = pending.get(i.attachmentId);
            pending.delete(i.attachmentId);
            return entry ? [{ ...i, name: entry.name }] : [];
          });
        let done = 0;
        ctx.post({ type: 'progress', done, total: work.length, failed });
        for (const { attachmentId, url, name } of work) {
          await ctx.check(message.sessionId);
          try {
            const res = await fetch(url, { credentials: 'omit', signal: ctx.controller.signal });
            const blob = await res.blob();
            if (!res.ok || !blob.type.startsWith('image/') || !blob.size || blob.size > OFFICIAL_IMAGE_LIMIT) throw new Error('图片不可用');
            await ctx.check(message.sessionId);
            const base = name.replace(/\.[^.]*$/, '') || 'image';
            const ext = extensionOf(`x.${blob.type.slice(6)}`) || 'webp';
            const fileId = await uploadFile({ apiKey, file: blob, name: `${base}.${ext}`, purpose: 'user_data', signal: ctx.controller.signal });
            if (!(await adoptUpload(message.sessionId, fileId, keyTag, () => attachImportedFile(message.sessionId, message.importedAt, attachmentId, fileId, keyTag)))) {
              await drainSession(message.sessionId, [fileId]);
              throw new Error('这条对话的本机记录已变化');
            }
          } catch (e) {
            if (ctx.controller.signal.aborted) throw e;
            failed++;
          }
          done++;
          ctx.post({ type: 'progress', done, total: work.length, failed });
        }
      });
      await ctx.check(message.sessionId);
      const record = await getSession(message.sessionId);
      ctx.post({ type: 'done', session: record ? toView(record) : null, failed });
    } catch (e) {
      const record = await ctx.check(message.sessionId).then(() => getSession(message.sessionId)).catch(() => undefined);
      ctx.post({ type: 'done', session: record ? toView(record) : null, failed, error: errorText(e) });
    }
  }
}

export default defineBackground(() => {
  void browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(console.error);

  browser.runtime.onMessage.addListener((message: PageRequest | PopupRequest, sender, sendResponse) => {
    if (message?.type === 'cleanup-status' || message?.type === 'retry-cleanup' || message?.type === 'balance') {
      if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL('/popup.html') || (sender.frameId ?? 0) !== 0) return;
      if (message.type === 'balance') {
        void loadSettings()
          .then((s) => {
            if (!s.apiKey) throw new Error('尚未设置 API Key');
            return getBalance(s.apiKey);
          })
          .then((value) => sendResponse({ ok: true, value } satisfies BalanceReply), (e) => sendResponse({ ok: false, error: errorText(e) } satisfies BalanceReply));
        return true;
      }
      const result = message.type === 'cleanup-status' ? cleanupCount() : loadSettings().then(s => retryCleanup(s.apiKey)).then(cleanupCount);
      void result.then(pending => sendResponse({ ok: true, value: { pending } }), e => sendResponse({ ok: false, error: errorText(e) }));
      return true;
    }
    const page = pageOf(sender);
    if (!page || !isObject(message) || typeof message.type !== 'string') return;
    void handle(message, page).then(
      (value) => sendResponse({ ok: true, value } satisfies PageReply<unknown>),
      (e) => sendResponse({ ok: false, error: errorText(e) } satisfies PageReply<unknown>),
    );
    return true;
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name === CHAT_PORT) chatPort(port);
    else if (port.name === UPLOAD_PORT) uploadPort(port);
    else if (port.name === IMPORT_IMAGES_PORT) importImagesPort(port);
  });
});
