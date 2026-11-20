import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import type { ToolEvent, ToolUse, Usage } from '../../core/client';
import { FLASH_MODEL, MODELS } from '../../core/client';
import { canRegenerate, finishMessage, lastUserIndex, type ChatAction } from '../../core/chat';
import { formatBytes, type Attachment } from '../../core/files';
import { defaultOutput, estimateRequest, isPeak, maxCost, tokens as formatTokens, yuan } from '../../core/pricing';
import { buildRequest, hasFiles } from '../../core/request';
import type { SessionRecord, Turn } from '../../core/store';
import {
  CHAT_PORT,
  IMPORT_IMAGES_PORT,
  LAST_PREVIEW_CHARS,
  officialImageStats,
  sessionIdFromPath,
  type ChatPortIn,
  type ChatPortOut,
  type ImportImagesIn,
  type ImportImagesOut,
  type SessionView,
  type SettingsView,
} from '../../protocol';
import { queriesOf, sourcesOf, withCitations, type Source } from '../../ui/citations';
import { enhanceMarkdown } from '../../ui/enhance';
import { renderMarkdown } from '../../ui/markdown';
import { acceptAttribute, limiter, prepareFile, readLimits, uploadThroughExtension, type DraftFile } from './attachments';
import { readHistory, request } from './history';
import type { Host, Layout } from './mount';

type Mode = 'official' | 'api';
type HistoryCheck = 'pending' | 'confirm' | 'changed' | 'unavailable' | 'ready';
type EditTarget = Pick<SessionView, 'importedAt' | 'updatedAt'> & { targetIndex: number };

type Port = ReturnType<typeof browser.runtime.connect>;

const num = (n: number) => n.toLocaleString('zh-CN');
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const PING_INTERVAL_MS = 20_000;
const UPLOAD_CONCURRENCY = 3;
const uploadSlot = limiter(UPLOAD_CONCURRENCY);
const NEAR_BOTTOM_PX = 80;
const MAX_INPUT_HEIGHT = 200;

export interface AppProps {
  sessionId: string | null;
  layout: Layout | null;
  thread: Host;
  composer: Host;
  notice: Host;
}

export function App({ sessionId, layout, thread: threadHost, composer, notice }: AppProps) {
  const [loaded, setLoaded] = useState(false);
  const [record, setRecordState] = useState<SessionView | null>(null);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [mode, setMode] = useState<Mode>('official');
  const [draft, setDraft] = useState<SessionRecord | null>(null);
  const [stale, setStale] = useState<SessionRecord | null>(null);
  const [check, setCheckState] = useState<HistoryCheck>('pending');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [live, setLive] = useState<{ text: string; reasoning: string } | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [input, setInputState] = useState('');
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [layoutMissing, setLayoutMissing] = useState(false);
  const [files, setFilesState] = useState<DraftFile[]>([]);
  const [fileNote, setFileNote] = useState('');
  const [cleanupNote, setCleanupNote] = useState('');
  const [tool, setTool] = useState<ToolEvent | null>(null);
  const [withImages, setWithImages] = useState(true);
  const [imageProgress, setImageProgress] = useState<{ done: number; total: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const recordRef = useRef<SessionView | null>(null);
  const inputRef = useRef('');
  const generation = useRef(0);
  const port = useRef<Port | null>(null);
  const disconnect = useRef<(() => void) | null>(null);
  const historyRead = useRef<AbortController | null>(null);
  const imagePort = useRef<Port | null>(null);
  const checkRef = useRef<HistoryCheck>('pending');
  const operating = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const filesRef = useRef<DraftFile[]>([]);
  const limits = useMemo(() => readLimits(), []);
  const follow = useRef<() => void>(() => {});

  const setRecord = (next: SessionView | null) => {
    recordRef.current = next;
    setRecordState(next);
  };
  const setInput = (value: string) => {
    inputRef.current = value;
    setInputState(value);
  };
  const setFiles = (update: (current: DraftFile[]) => DraftFile[]) => {
    filesRef.current = update(filesRef.current);
    setFilesState(filesRef.current);
  };

  const setCheck = (next: HistoryCheck) => {
    checkRef.current = next;
    setCheckState(next);
  };
  const onCurrentPage = () => !!sessionId && sessionIdFromPath(location.pathname) === sessionId;

  async function loadInitial(id: string, gen: number) {
    try {
      const { session, settings } = await request({ type: 'get-state', sessionId: id });
      if (gen !== generation.current || !onCurrentPage()) return;
      setSettings(settings);
      setRecord(session);
      setError('');
      setLoaded(true);
      if (session?.turns.length) setMode('api');
    } catch (e) {
      if (gen === generation.current) setError(errorText(e));
    }
  }

  // index.tsx 为每条路由创建独立的组件，卸载时同步作废旧回调并关闭发送端。
  useLayoutEffect(() => {
    const gen = ++generation.current;
    if (sessionId) void loadInitial(sessionId, gen);
    return () => {
      ++generation.current;
      historyRead.current?.abort();
      imagePort.current?.disconnect();
      disconnect.current?.();
      // 离开对话时未发送的附件不再需要，从 API 账号删除。
      if (sessionId) discardDraftFiles(sessionId, filesRef.current);
      filesRef.current = [];
    };
  }, [sessionId]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible' || !sessionId || !onCurrentPage() || port.current || operating.current) return;
      const gen = generation.current;
      const before = recordRef.current;
      void request({ type: 'get-state', sessionId }).then(({ session, settings }) => {
        if (gen !== generation.current || !onCurrentPage() || port.current || operating.current || before !== recordRef.current) return;
        setSettings(settings);
        setLoaded(true);
        if (session?.updatedAt !== before?.updatedAt || session?.importedAt !== before?.importedAt) {
          setRecord(session);
          if (session?.importedAt !== before?.importedAt && mode === 'api') void syncHistory(sessionId);
        }
      }).catch(() => {});
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [sessionId, mode]);

  useLayoutEffect(() => {
    if (mode === 'api' && loaded && sessionId) void syncHistory(sessionId);
    return () => historyRead.current?.abort();
  }, [mode, loaded, sessionId]);

  async function syncHistory(id: string) {
    if (!onCurrentPage()) return;
    historyRead.current?.abort();
    const controller = new AbortController();
    historyRead.current = controller;
    const active = () => !controller.signal.aborted && onCurrentPage();
    setCheck('pending');
    setDraft(null);
    setStale(null);
    setNote('');
    setError('');
    try {
      const fresh = await readHistory(id, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
      if (!active()) return;
      let current = recordRef.current;
      if (current && fresh.leafId !== current.leafId && !current.turns.length) {
        const updated = await request({ type: 'reimport', record: fresh, expectedImportedAt: current.importedAt,
          expectedUpdatedAt: current.updatedAt, keepTurns: true });
        if (!active()) return;
        // 如果别的标签已经续聊，按真实记录重新决定是否需让用户选择。
        current = updated ?? (await request({ type: 'get-state', sessionId: id })).session;
        if (!active()) return;
        setRecord(current);
        if (updated) {
          await attachMissingImages(updated, fresh, generation.current);
          if (!active()) return;
          current = recordRef.current;
        }
      }
      if (!current) {
        setDraft(fresh);
        setCheck('confirm');
      } else if (fresh.leafId !== current.leafId && current.dismissedLeafId !== fresh.leafId) {
        setStale(fresh);
        setCheck('changed');
      } else setCheck('ready');
    } catch (e) {
      if (!active()) return;
      setCheck('unavailable');
      setError(`没能读取官网的最新历史。${errorText(e)}`);
    }
  }

  // 只重新显示当前记录。破坏性操作必须等用户看到新数量后再次确认。
  async function rejectOutdatedConfirmation(id: string, gen: number) {
    const { session } = await request({ type: 'get-state', sessionId: id });
    if (gen !== generation.current || !onCurrentPage()) return;
    setRecord(session);
    if (!session || session.importedAt !== record?.importedAt) await syncHistory(id);
    throw new Error('本机记录已在别处变化，请核对最新消息后重新确认');
  }

  async function operate(task: (gen: number) => Promise<void>) {
    if (operating.current || port.current || !onCurrentPage()) return;
    operating.current = true;
    const gen = generation.current;
    setBusy(true);
    setError('');
    try {
      await task(gen);
    } catch (e) {
      if (gen === generation.current) setError(errorText(e));
    } finally {
      operating.current = false;
      if (gen === generation.current) setBusy(false);
    }
  }

  const confirmDraft = () => operate(async (gen) => {
    if (!draft || checkRef.current !== 'confirm') return;
    const images = withImages ? officialImageList(draft) : [];
    const { session, created } = await request({ type: 'create', record: {
      ...draft, importedAt: Date.now(), updatedAt: Date.now(), officialImages: withImages,
    } });
    if (gen !== generation.current) return;
    setRecord(session);
    setDraft(null);
    if (!created) {
      await syncHistory(session.sessionId);
      if (gen === generation.current) setNote('这条对话已在别的标签页导入，现已显示本机记录');
      return;
    }
    if (images.length) await attachOfficialImages(session, images, gen);
    if (gen !== generation.current) return;
    setCheck('ready');
    requestAnimationFrame(() => textarea.current?.focus());
  });

  // 把官网历史里的图片转存到 API。失败的保留文字占位，不阻止续聊。
  async function attachOfficialImages(session: SessionView, images: ImportImagesIn['images'], gen: number) {
    if (!settings?.hasKey) {
      setNote('设置 API Key 后，可点「补传历史图片」');
      return;
    }
    setImageProgress({ done: 0, total: images.length });
    try {
      const result = await new Promise<Extract<ImportImagesOut, { type: 'done' }>>((resolve) => {
        let p: ReturnType<typeof browser.runtime.connect>;
        try {
          p = browser.runtime.connect({ name: IMPORT_IMAGES_PORT });
        } catch {
          resolve({ type: 'done', session: null, failed: images.length, error: '扩展没有响应，请刷新页面' });
          return;
        }
        imagePort.current = p;
        let finished = false;
        p.onMessage.addListener((message: ImportImagesOut) => {
          if (message.type === 'progress') {
            if (gen === generation.current) setImageProgress({ done: message.done, total: message.total });
          } else {
            if (imagePort.current === p) imagePort.current = null;
            finished = true;
            resolve(message);
          }
        });
        p.onDisconnect.addListener(() => {
          if (imagePort.current === p) imagePort.current = null;
          if (!finished) resolve({ type: 'done', session: null, failed: images.length, error: '与扩展的连接已断开' });
        });
        p.postMessage({ type: 'start', sessionId: session.sessionId, importedAt: session.importedAt, images } satisfies ImportImagesIn);
      });
      if (gen !== generation.current) return;
      if (result.session) setRecord(result.session);
      if (result.error) setNote(`官网图片没有全部带上：${result.error}`);
      else if (result.failed) setNote(`${result.failed} 张官网图片没能带上，已用文字说明代替`);
    } finally {
      if (gen === generation.current) setImageProgress(null);
    }
  }

  const reimport = () => operate(async (gen) => {
    const current = record;
    if (!stale || !current || checkRef.current !== 'changed') return;
    if (!confirm(`重新导入官网的最新历史，并删除这条对话的 ${current.turns.length} 条本机 API 消息？官网对话不受影响。`)) return;
    const updated = await request({ type: 'reimport', record: { ...stale, importedAt: Date.now() }, expectedImportedAt: current.importedAt, expectedUpdatedAt: current.updatedAt, keepTurns: false });
    if (gen !== generation.current) return;
    if (!updated) return rejectOutdatedConfirmation(current.sessionId, gen);
    setRecord(updated);
    setStale(null);
    setEditing(null);
    await attachMissingImages(updated, stale, gen);
    if (gen === generation.current) setCheck('ready');
  });

  // 新快照里尚未转存的官网图片（旧快照已转存的由 background 沿用）。
  async function attachMissingImages(view: SessionView, fresh: SessionRecord, gen: number) {
    const { total, attached, wanted } = view.officialImages;
    if (!wanted || attached >= total) return;
    const images = officialImageList(fresh);
    if (images.length) await attachOfficialImages(view, images, gen);
  }

  // 只读取当前分支的临时图片地址，后台按现有快照过滤并跳过已转存的图片。
  const retryImages = () => operate(async (gen) => {
    const current = recordRef.current;
    if (!current || !settings?.hasKey || checkRef.current !== 'ready') return;
    setNote('');
    const fresh = await readHistory(current.sessionId, AbortSignal.timeout(30_000));
    if (gen !== generation.current || !onCurrentPage()) return;
    const images = officialImageList(fresh);
    if (images.length === 0) {
      setNote('官网当前分支没有可读取的历史图片');
      return;
    }
    await attachOfficialImages(current, images, gen);
    if (gen === generation.current && recordRef.current?.officialImages.attached === current.officialImages.attached) {
      setNote((previous) => previous || '剩余图片在当前官网分支中不可用，可稍后重试');
    }
  });

  const keepSnapshot = () => operate(async (gen) => {
    const current = record;
    if (!stale || !current || checkRef.current !== 'changed') return;
    const updated = await request({ type: 'dismiss-stale', sessionId: current.sessionId, importedAt: current.importedAt, leafId: stale.leafId });
    if (gen !== generation.current) return;
    if (!updated) return rejectOutdatedConfirmation(current.sessionId, gen);
    setRecord(updated);
    setStale(null);
    setCheck('ready');
  });

  const removeRecord = () => operate(async (gen) => {
    const current = record;
    if (!current) return;
    if (!confirm(`删除这条对话的本机记录（${current.turns.length} 条 API 消息）？官网对话不受影响。`)) return;
    const { deleted, filesLeft } = await request({ type: 'delete', sessionId: current.sessionId, importedAt: current.importedAt, expectedUpdatedAt: current.updatedAt });
    if (gen !== generation.current) return;
    if (!deleted) return rejectOutdatedConfirmation(current.sessionId, gen);
    discardDraftFiles(current.sessionId, filesRef.current);
    setFiles(() => []);
    if (filesLeft) setCleanupNote(`${filesLeft} 个远端文件待删除，可在扩展设置中重试`);
    setRecord(null);
    setStale(null);
    setEditing(null);
    setInput('');
    setCheck('pending');
    setMode('official');
  });

  const patchSettings = (patch: { model?: string; thinking?: boolean; search?: boolean }) => operate(async (gen) => {
    const next = await request({ type: 'patch-settings', patch });
    if (gen === generation.current) setSettings(next);
  });

  const openSettings = () => operate(async () => {
    if (!(await request({ type: 'open-settings' }))) setError('请点浏览器工具栏里的扩展图标打开设置');
  });

  function send(action: ChatAction) {
    const current = recordRef.current;
    if (!sessionId || !current || !layout || mode !== 'api' || !onCurrentPage() || current.sessionId !== sessionId ||
        checkRef.current !== 'ready' || operating.current || port.current) return;
    if (action.kind === 'edit' && (!editing || editing.updatedAt !== current.updatedAt || editing.importedAt !== current.importedAt)) return;
    if (!settings?.hasKey) {
      setError('请先设置 API Key');
      return;
    }
    const gen = generation.current;
    const typed = action.kind === 'regenerate' ? null : inputRef.current;
    const sentFiles = action.kind === 'regenerate' ? null : filesRef.current;
    let p: Port;
    try {
      p = browser.runtime.connect({ name: CHAT_PORT });
    } catch {
      setError('扩展没有响应，请刷新页面');
      return;
    }
    port.current = p;
    setSending(true);
    setError('');
    setNote('');
    setLive(null);
    setTool(null);
    let finished = false;
    let ping: ReturnType<typeof setInterval>;
    const finish = (message?: string) => {
      if (finished) return;
      finished = true;
      clearInterval(ping);
      if (port.current === p) {
        port.current = null;
        disconnect.current = null;
      }
      if (gen !== generation.current) return;
      setSending(false);
      setLive(null);
      setTool(null);
      if (message) setError(message);
    };
    disconnect.current = () => {
      finish();
      p.disconnect();
    };
    const post = (message: ChatPortIn) => {
      try { p.postMessage(message); }
      catch { finish('与扩展的连接已断开，请刷新页面'); }
    };
    ping = setInterval(() => post({ type: 'ping' }), PING_INTERVAL_MS);
    let acknowledged = false;
    p.onMessage.addListener((message: ChatPortOut) => {
      if (gen !== generation.current || finished || !onCurrentPage()) return;
      if (message.type === 'live') setLive({ text: message.text, reasoning: message.reasoning });
      else if (message.type === 'tool') setTool(message.event);
      else if (message.type === 'session') {
        setRecord(message.session);
        if (!acknowledged) {
          acknowledged = true;
          if (typed != null && inputRef.current === typed) setInput('');
          // 已发出的附件归这条提问所有，清空编辑区但不删除远端文件。
          if (sentFiles && filesRef.current === sentFiles) setFiles(() => []);
          if (action.kind === 'edit') setEditing(null);
        }
      } else if (message.type === 'done') {
        finish(message.error);
        if ('stale' in message) {
          setRecord(message.stale ?? null);
          if (message.stale?.importedAt !== current.importedAt) void syncHistory(sessionId);
        }
      }
    });
    p.onDisconnect.addListener(() => finish('与扩展的连接已断开。如果刚更新过扩展，请刷新页面'));
    post({
      type: 'run',
      sessionId,
      options: { model: settings.model, thinking: settings.thinking, search: settings.search, maxTokens: settings.maxTokens },
      expected: action.kind === 'edit' && editing
        ? { importedAt: editing.importedAt, updatedAt: editing.updatedAt }
        : { importedAt: current.importedAt, updatedAt: current.updatedAt },
      action,
    } satisfies ChatPortIn);
    follow.current();
  }

  function submit() {
    const text = inputRef.current.trim();
    const current = filesRef.current;
    if (current.some((f) => f.state !== 'ready')) return;
    const attachments = current.map((f) => f.attachment!);
    if (!text && !attachments.length) return;
    send(editing
      ? { kind: 'edit', text, targetIndex: editing.targetIndex, attachments }
      : { kind: 'send', text, ...(attachments.length && { attachments }) });
  }

  function cancelEdit() {
    setEditing(null);
    setInput('');
    if (sessionId) discardDraftFiles(sessionId, filesRef.current);
    setFiles(() => []);
  }

  // ---- 附件 ----

  function addFiles(list: Iterable<File>) {
    if (!sessionId || !record || mode !== 'api') return;
    const incoming = [...list];
    if (!incoming.length) return;
    const room = limits.maxCount - filesRef.current.length;
    const skipped: string[] = [];
    if (incoming.length > room) skipped.push(`每条消息最多 ${limits.maxCount} 个附件`);
    for (const file of incoming.slice(0, Math.max(room, 0))) startUpload(file, skipped);
    setFileNote(skipped.join('；'));
    if (!settings?.hasKey) setError('请先设置 API Key');
  }

  function startUpload(file: File, problems: string[]) {
    const id = sessionId!;
    const gen = generation.current;
    const key = crypto.randomUUID();
    const entry: DraftFile = { key, name: file.name, size: file.size, kind: 'text', state: 'uploading', progress: 0, file };
    setFiles((list) => [...list, entry]);
    const patch = (change: Partial<DraftFile>) => {
      if (gen === generation.current) setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...change } : f)));
    };
    void (async () => {
      const prepared = await prepareFile(file, limits);
      if (!prepared.ok) {
        if (gen !== generation.current) return;
        setFiles((list) => list.filter((f) => f.key !== key));
        problems.push(`${prepared.name}：${prepared.reason}`);
        setFileNote((note) => [note, `${prepared.name}：${prepared.reason}`].filter(Boolean).join('；'));
        return;
      }
      patch({ kind: prepared.kind });
      try {
        const attachment = await uploadSlot(async () => {
          if (!filesRef.current.some((f) => f.key === key)) throw new Error('cancelled');
          const handle = uploadThroughExtension(id, file.name, prepared, (state, progress) => patch({ state, progress }));
          patch({ cancel: handle.cancel });
          return handle.done;
        });
        if (gen !== generation.current || !filesRef.current.some((f) => f.key === key)) {
          // 已移除或已离开对话：上传完成的文件不再需要。
          void request({ type: 'discard-upload', sessionId: id, fileId: attachment.fileId! }).catch(() => {});
          return;
        }
        patch({ state: 'ready', progress: 1, attachment, cancel: undefined });
      } catch (e) {
        if (!filesRef.current.some((f) => f.key === key)) return;
        patch({ state: 'failed', error: errorText(e), cancel: undefined });
      }
    })();
  }

  function removeFile(key: string) {
    const target = filesRef.current.find((f) => f.key === key);
    if (!target) return;
    setFiles((list) => list.filter((f) => f.key !== key));
    target.cancel?.();
    if (sessionId && target.attachment?.fileId && !target.existing) {
      void request({ type: 'discard-upload', sessionId, fileId: target.attachment.fileId }).then((deleted) => {
        if (!deleted) setCleanupNote('远端文件待删除，可在扩展设置中重试');
      }).catch(() => setCleanupNote('未能确认远端删除结果，请查看扩展设置'));
    }
  }

  function retryFile(key: string) {
    const target = filesRef.current.find((f) => f.key === key);
    if (!target?.file) return;
    setFiles((list) => list.filter((f) => f.key !== key));
    const problems: string[] = [];
    startUpload(target.file, problems);
  }

  function switchMode(next: Mode) {
    if (next === mode || !onCurrentPage() || operating.current) return;
    historyRead.current?.abort();
    setCheck('pending');
    setMode(next);
    if (next === 'api') {
      requestAnimationFrame(() => {
        textarea.current?.focus();
        follow.current();
      });
    } else {
      requestAnimationFrame(() => layout?.official?.querySelector('textarea')?.focus());
    }
  }

  function startEdit(turn: Turn, targetIndex: number) {
    if (!record || !onCurrentPage()) return;
    if (sessionId) discardDraftFiles(sessionId, filesRef.current);
    setEditing({ targetIndex, importedAt: record.importedAt, updatedAt: record.updatedAt });
    setInput(turn.content);
    setFiles(() => (turn.attachments ?? []).map((a) => ({
      key: a.id, name: a.name, size: a.bytes, kind: a.kind, state: 'ready', progress: 1, attachment: a, existing: true,
    })));
    setFileNote('');
    requestAnimationFrame(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  // 停在底部附近时，新内容和流式回复跟随到底；用户往上翻后不再跟随。
  useEffect(() => {
    const scroller = layout?.scroller;
    if (!scroller) return;
    const near = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR_BOTTOM_PX;
    let stick = near();
    let lastTop = scroller.scrollTop;
    const toBottom = () => {
      scroller.scrollTop = scroller.scrollHeight;
      lastTop = scroller.scrollTop;
    };
    // 只有往上滚才算离开底部。内容变高时浏览器的滚动锚定也会触发 scroll，不能据此取消跟随。
    const onScroll = () => {
      const top = scroller.scrollTop;
      if (near()) stick = true;
      else if (top < lastTop) stick = false;
      lastTop = top;
    };
    const observer = new ResizeObserver(() => {
      if (stick) toBottom();
    });
    observer.observe(composer.host);
    observer.observe(threadHost.host);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    follow.current = () => {
      stick = true;
      toBottom();
    };
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      follow.current = () => {};
    };
  }, [layout?.scroller]);

  // API 模式下接管拖入页面的文件，避免官网把它上传到官网对话。落在输入区或续聊区时作为附件。
  useEffect(() => {
    if (mode !== 'api' || !layout) return;
    const hasFilesDrag = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    let depth = 0;
    const onEnter = (e: DragEvent) => {
      if (!hasFilesDrag(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFilesDrag(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.dataTransfer!.dropEffect = record ? 'copy' : 'none';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFilesDrag(e)) return;
      e.stopImmediatePropagation();
      if (--depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFilesDrag(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      depth = 0;
      setDragging(false);
      const path = e.composedPath();
      if (path.includes(composer.host) || path.includes(threadHost.host) || path.includes(layout.scroller)) addFiles(e.dataTransfer!.files);
    };
    const options = { capture: true };
    window.addEventListener('dragenter', onEnter, options);
    window.addEventListener('dragover', onOver, options);
    window.addEventListener('dragleave', onLeave, options);
    window.addEventListener('drop', onDrop, options);
    return () => {
      window.removeEventListener('dragenter', onEnter, options);
      window.removeEventListener('dragover', onOver, options);
      window.removeEventListener('dragleave', onLeave, options);
      window.removeEventListener('drop', onDrop, options);
      setDragging(false);
    };
  }, [mode, layout, record, settings]);

  // 在绘制前切换，随后的聚焦才能落到已显示的输入框上。
  useLayoutEffect(() => {
    composer.host.dataset.mode = mode;
  }, [mode]);

  // 保持端口直到后台提交部分回复，使布局恢复时也能显示最新记录。
  const stop = () => {
    try { port.current?.postMessage({ type: 'stop' } satisfies ChatPortIn); }
    catch { disconnect.current?.(); }
  };
  useLayoutEffect(() => {
    if (!layout) stop();
  }, [layout]);

  // 对话页长时间找不到挂载点时，给出一行说明而不是静默失效。
  useEffect(() => {
    setLayoutMissing(false);
    if (!sessionId || layout) return;
    const timer = setTimeout(() => setLayoutMissing(true), 5_000);
    return () => clearTimeout(timer);
  }, [sessionId, layout]);

  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [input, mode]);

  const missingNotice = layoutMissing && createPortal(
    <p class="missing">页面结构已变化，API 续聊暂不可用</p>,
    notice.container,
  );
  if (!sessionId || !layout) return <>{missingNotice}</>;

  const api = mode === 'api';
  const turns = record?.turns ?? [];
  const actionable = api && !busy && !sending;
  const mayGenerate = actionable && check === 'ready';
  const editConflict = editing && (editing.importedAt !== record?.importedAt || editing.updatedAt !== record?.updatedAt);
  const editIndex = lastUserIndex(turns);
  const regenerable = canRegenerate(turns);
  const showThread = turns.length > 0 || live || (api && (record || draft || check === 'pending' || error || note || imageProgress));
  const draftImages = draft ? officialImageStats(draft).total : 0;
  const uploading = files.some((f) => f.state === 'uploading' || f.state === 'parsing');
  const filesBroken = files.some((f) => f.state === 'failed');
  const pendingFiles = hasFiles(files.flatMap((f) => (f.attachment ? [{ attachments: [f.attachment] }] : [])))
    || files.some((f) => f.state !== 'failed');
  const usesFiles = (record?.officialImages.attached ?? 0) > 0 || turns.some((t) => t.attachments?.some((a) => a.fileId)) || pendingFiles;
  const switchedFor = settings && settings.model !== FLASH_MODEL ? (usesFiles ? '含图片或文件' : settings.search ? '已开智能搜索' : null) : null;

  const thread = (showThread || cleanupNote) && (
    <div class="thread">
      <div class="divider"><span>以下为 API 续聊 · 仅保存在本机</span></div>

      {cleanupNote && <p class="note" role="status">{cleanupNote} <button class="link" onClick={openSettings}>打开设置</button></p>}
      {api && record && (
        <details class="context">
          <summary>已导入 {num(record.importedCount)} 条官网消息作为上下文</summary>
          <ContextSummary view={record} />
          <button class="link danger" disabled={!actionable} onClick={removeRecord}>删除本机记录</button>
        </details>
      )}

      {api && record?.officialImages.wanted && record.officialImages.attached < record.officialImages.total && (
        <div class="row">
          <span class="note">{num(record.officialImages.total - record.officialImages.attached)} 张历史图片待补传</span>
          <button disabled={!settings?.hasKey || !mayGenerate || !!imageProgress} onClick={retryImages}>补传历史图片</button>
        </div>
      )}
      {api && loaded && check === 'pending' && !imageProgress && <p class="note">正在核对官网历史…</p>}
      {imageProgress && <p class="note">正在带上官网图片 {num(imageProgress.done)}/{num(imageProgress.total)}…</p>}

      {api && draft && (
        <div class="card">
          <h2>用 API 继续这条对话</h2>
          <ContextSummary view={draftView(draft)} />
          {settings && <CostEstimate record={draft} settings={settings} images={withImages ? draftImages : 0} />}
          {draftImages > 0 && (
            <label class="check">
              <input type="checkbox" checked={withImages} disabled={busy} onChange={(e) => setWithImages(e.currentTarget.checked)} />
              带上官网历史里的 {num(draftImages)} 张图片（上传到你的 API 账号，之后每轮按图片计入输入 tokens，并改用 {FLASH_MODEL}）
            </label>
          )}
          <p class="note">确认后，每次发送都会把这些消息连同新消息发往 api.deepseek.com，按你的 API Key 计费。新回复只保存在本机，官网对话不会被修改。</p>
          <div class="row">
            <button class="primary" disabled={busy} onClick={confirmDraft}>确认并开始</button>
            <button disabled={busy} onClick={() => { setDraft(null); switchMode('official'); }}>取消</button>
          </div>
        </div>
      )}

      {api && stale && record && (
        <div class="card">
          <h2>官网对话有新消息</h2>
          <p>本机快照之后，这条对话在官网有了新的消息。API 续聊目前接在旧快照上。</p>
          <div class="row">
            <button class="primary" disabled={busy} onClick={reimport}>重新导入（删除 {num(record.turns.length)} 条本机消息）</button>
            <button disabled={busy} onClick={keepSnapshot}>继续用旧快照</button>
          </div>
        </div>
      )}

      {turns.map((turn, i) => {
        const isLast = i === turns.length - 1;
        return (
          <TurnView
            key={i}
            turn={turn}
            onCopy={turn.content ? () => navigator.clipboard.writeText(turn.content) : undefined}
            onEdit={mayGenerate && turn.role === 'user' && i === editIndex && !editing ? () => startEdit(turn, i) : undefined}
            onRegenerate={mayGenerate && !editing && isLast && regenerable && !live ? () => send({ kind: 'regenerate' }) : undefined}
          />
        );
      })}
      {sending && tool && <p class="note tool">{describeTool(tool)}</p>}
      {live && <TurnView turn={{ role: 'assistant', content: live.text, reasoning: live.reasoning }} streaming />}

      {!api && turns.length > 0 && <p class="note local-only">以上 API 回复只保存在本机，在官网发送时不会带上。</p>}
      {note && <p class="note">{note}</p>}
      {error && <p class="error" role="alert">{error}</p>}
      {api && !loaded && error && <button disabled={busy} onClick={() => operate((gen) => loadInitial(sessionId, gen))}>重新读取</button>}
      {api && loaded && check === 'unavailable' && (
        <div class="row">
          <button disabled={busy} onClick={() => void syncHistory(sessionId)}>重新读取</button>
          {record && <button disabled={busy} onClick={() => {
            setCheck('ready');
            setError('');
            setNote('本次使用上次导入的官网历史');
          }}>继续用旧快照</button>}
        </div>
      )}
    </div>
  );

  const canSend = mayGenerate && !!record && !!settings?.hasKey && !editConflict && !uploading && !filesBroken &&
    (!!input.trim() || files.length > 0);
  const composerUi = createPortal(
    <div class="composer">
      <div class="switch" role="radiogroup" aria-label="发送方式">
        <button role="radio" aria-checked={!api} class={!api ? 'on' : ''} onClick={() => switchMode('official')}>官网</button>
        <button role="radio" aria-checked={api} class={api ? 'on' : ''} onClick={() => switchMode('api')}>API</button>
      </div>
      {api && (
        <div class={`box${dragging ? ' dragging' : ''}`}>
          {dragging && <div class="drop">{record ? '松开即可添加为 API 附件（不会上传到官网）' : '确认导入后才能添加附件'}</div>}
          {files.length > 0 && (
            <ul class="files">
              {files.map((f) => (
                <li key={f.key} class={`file ${f.state}`} title={f.error ?? f.name}>
                  <span class="file-icon">{f.kind === 'image' ? '🖼' : '📄'}</span>
                  <span class="file-name">{f.name}</span>
                  <span class="file-state">
                    {f.state === 'uploading' ? `上传中 ${Math.round(f.progress * 100)}%`
                      : f.state === 'parsing' ? '解析中…'
                      : f.state === 'failed' ? '失败'
                      : formatBytes(f.size)}
                  </span>
                  {f.state === 'failed' && f.file && <button class="link" onClick={() => retryFile(f.key)}>重试</button>}
                  <button class="link" aria-label={`移除 ${f.name}`} onClick={() => removeFile(f.key)}>×</button>
                </li>
              ))}
            </ul>
          )}
          {fileNote && <p class="note file-note">{fileNote}</p>}
          {editing && (
            <div class="editing">
              {editConflict ? '记录已变化，请取消编辑后重新选择提问。修改稿仍在输入框中。' : '正在编辑最后一条提问，发送后替换它和之后的回复'}
              <button class="link" onClick={cancelEdit}>取消</button>
            </div>
          )}
          <textarea
            ref={textarea}
            value={input}
            rows={2}
            disabled={!record}
            placeholder={record ? '用 API 继续这条对话' : '确认导入后即可发送'}
            onInput={(e) => setInput(e.currentTarget.value)}
            onPaste={(e) => {
              const pasted = [...(e.clipboardData?.files ?? [])];
              if (!pasted.length) return;
              e.preventDefault();
              addFiles(pasted);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                if (canSend) submit();
              } else if (e.key === 'Escape' && editing) {
                cancelEdit();
              }
            }}
          />
          <div class="bar">
            {settings?.hasKey ? (
              <>
                <select class="pill" aria-label="模型" disabled={busy} value={settings.model}
                  onChange={(e) => patchSettings({ model: e.currentTarget.value })}>
                  {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <button class={`pill${settings.thinking ? ' on' : ''}`} aria-pressed={settings.thinking} disabled={busy}
                  onClick={() => patchSettings({ thinking: !settings.thinking })}>深度思考</button>
                <button class={`pill${settings.search ? ' on' : ''}`} aria-pressed={settings.search} disabled={busy}
                  title="联网搜索并阅读消息里的链接，是否搜索由模型判断"
                  onClick={() => patchSettings({ search: !settings.search })}>智能搜索</button>
              </>
            ) : (
              <>
                <span class="note">还没有设置 API Key</span>
                <button class="pill on" onClick={openSettings}>打开设置</button>
              </>
            )}
            <span class="spacer" />
            <input ref={picker} type="file" multiple hidden accept={acceptAttribute(limits) || undefined}
              onChange={(e) => {
                addFiles(e.currentTarget.files ?? []);
                e.currentTarget.value = '';
              }} />
            <button class="attach" aria-label="添加附件" title={`添加附件（最多 ${limits.maxCount} 个，可拖入或粘贴）`}
              disabled={!record || busy || files.length >= limits.maxCount} onClick={() => picker.current?.click()}>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
                d="M20 11.5 12.3 19.2a5 5 0 0 1-7.1-7.1l8.1-8.1a3.3 3.3 0 0 1 4.7 4.7l-8.1 8.1a1.7 1.7 0 0 1-2.4-2.4l7.4-7.4" /></svg>
            </button>
            {sending
              ? <button class="send" aria-label="停止" title="停止" onClick={stop}><span class="stop-icon" /></button>
              : <button class="send" aria-label="发送" title="发送（Enter）" disabled={!canSend} onClick={submit}>↑</button>}
          </div>
          {switchedFor && <p class="note model-note">本条将使用 {FLASH_MODEL}（{switchedFor}）</p>}
        </div>
      )}
    </div>,
    composer.container,
  );

  return <>{thread}{composerUi}{missingNotice}</>;
}

function draftView(record: SessionRecord): SessionView {
  const last = record.imported.at(-1);
  return {
    ...record,
    dismissedLeafId: null,
    skippedUnknownFragments: record.skippedUnknownFragments ?? 0,
    importedCount: record.imported.length,
    lastImported: last ? { role: last.role, content: last.content } : null,
    officialImages: officialImageStats(record),
  };
}

/** 新快照里可以转存的官网图片。 */
function officialImageList(record: SessionRecord): ImportImagesIn['images'] {
  const urls = new Map<string, string>();
  for (const message of record.imported) {
    for (const a of message.attachments ?? []) {
      if (a.source === 'official' && a.kind === 'image' && !a.fileId && a.officialUrl) urls.set(a.id, a.officialUrl);
    }
  }
  return [...urls].map(([attachmentId, url]) => ({ attachmentId, url }));
}

/** 删除编辑区里新上传、还没发出的附件。来自原提问的附件仍被引用，不删除。 */
function discardDraftFiles(sessionId: string, files: DraftFile[]) {
  for (const f of files) {
    f.cancel?.();
    if (f.attachment?.fileId && !f.existing) {
      void request({ type: 'discard-upload', sessionId, fileId: f.attachment.fileId }).catch(() => {});
    }
  }
}

function describeTool(event: ToolEvent) {
  const queries = event.queries?.filter(Boolean) ?? [];
  if (event.type === 'call_started') {
    if (event.kind === 'read_link' || event.kind === 'open_page' || event.url) return `正在阅读 ${event.url ?? '网页'}…`;
    if (event.kind?.includes('image')) return '正在搜索相关图片…';
    return queries.length ? `正在搜索「${queries.join('」「')}」…` : '正在搜索…';
  }
  if (event.type === 'call_completed') return event.status === 'failed' ? '一次搜索没有成功，继续作答…' : '已获取搜索结果，继续思考…';
  return '正在思考…';
}

function ContextSummary({ view }: { view: SessionView }) {
  const last = view.lastImported;
  return (
    <>
      <ul>
        <li>{num(view.importedCount)} 条消息</li>
        {view.officialImages.attached > 0 && <li>已带上官网历史里的 {num(view.officialImages.attached)} 张图片</li>}
        {view.skippedFiles - view.officialImages.attached > 0 && (
          <li>{num(view.skippedFiles - view.officialImages.attached)} 个附件的内容带不过来，已用文字说明代替</li>
        )}
        {view.skippedUnknownFragments > 0 && <li>跳过了 {num(view.skippedUnknownFragments)} 段未识别内容</li>}
        {view.hasBranches && <li>只导入服务端记录的当前分支，请核对最后一条消息</li>}
      </ul>
      {last && (
        <p class="note">
          最后一条（{last.role === 'user' ? '你' : 'DeepSeek'}）：{last.content.slice(0, LAST_PREVIEW_CHARS)}
          {last.content.length > LAST_PREVIEW_CHARS && '…'}
        </p>
      )}
    </>
  );
}

/**
 * 首次续聊前的花费上限：全部输入按未命中缓存计，回复按输出上限计。
 * 官网历史之后每轮都会重发，连续追问时大部分能命中缓存，实际一般低得多。
 */
function CostEstimate({ record, settings, images }: { record: SessionRecord; settings: SettingsView; images: number }) {
  const { input, model, output } = useMemo(() => {
    const built = buildRequest(record.imported, [], { model: settings.model, search: settings.search });
    const effective = images > 0 ? FLASH_MODEL : built.model;
    return {
      input: estimateRequest(built.messages, images),
      model: effective,
      output: settings.maxTokens || defaultOutput(settings.thinking),
    };
  }, [record, settings.model, settings.search, settings.thinking, settings.maxTokens, images]);
  const peak = isPeak(new Date());
  return (
    <ul class="estimate">
      <li>上下文：约 {formatTokens(input)}（{model}）</li>
      <li>
        每次发送预计：最多约 {yuan(maxCost(model, input, output, peak))}（{peak ? '高峰时段' : '空闲时段'}，含最多 {num(output)} tokens 的回复）
        {hasFiles(record.imported) || images > 0 ? '，附件解析内容未计入' : ''}
      </li>
    </ul>
  );
}

function TurnView(props: { turn: Turn; streaming?: boolean; onCopy?: () => Promise<void>; onEdit?: () => void; onRegenerate?: () => void }) {
  const { turn, streaming } = props;
  if (turn.role === 'user') {
    const actions = props.onCopy || props.onEdit || props.onRegenerate;
    return (
      <div class="turn user">
        {!!turn.attachments?.length && <AttachmentList attachments={turn.attachments} />}
        {turn.content && <div class="bubble">{turn.content}</div>}
        {actions && (
          <div class="actions">
            {props.onCopy && <CopyButton copy={props.onCopy} label="复制提问" />}
            {props.onEdit && <button class="link" onClick={props.onEdit}>编辑</button>}
            {props.onRegenerate && <button class="link" onClick={props.onRegenerate}>重试</button>}
          </div>
        )}
      </div>
    );
  }
  return (
    <div class="turn assistant">
      {turn.reasoning && (
        <details open={streaming && !turn.content}>
          <summary>思考过程</summary>
          <div class="reasoning">{turn.reasoning}</div>
        </details>
      )}
      {turn.content
        ? <Markdown text={turn.content} annotations={streaming ? undefined : turn.annotations} />
        : streaming && !turn.reasoning && <span class="note">等待回复…</span>}
      {!streaming && <Sources turn={turn} />}
      {!streaming && (
        <div class="actions">
          {props.onCopy && <CopyButton copy={props.onCopy} />}
          {props.onRegenerate && <button class="link" onClick={props.onRegenerate}>{turn.interrupted ? '重试' : '重新生成'}</button>}
          <span class="meta">
            {turn.interrupted && `${turn.finishStatus ? finishMessage[turn.finishStatus] : '已中断'} · `}
            {turn.model}
            {turn.usage && <UsageLine usage={turn.usage} />}
            {turn.costYuan !== undefined && <span> · 本条约 {yuan(turn.costYuan)}</span>}
            {turn.toolUse && <ToolUseLine use={turn.toolUse} />}
          </span>
        </div>
      )}
    </div>
  );
}

function Markdown({ text, annotations }: { text: string; annotations?: Turn['annotations'] }) {
  const html = useMemo(() => ({ __html: renderMarkdown(withCitations(text, annotations).text) }), [text, annotations]);
  const ref = useRef<HTMLDivElement>(null);
  // Preact 只在 __html 变化时重设 innerHTML，之后在同一份 DOM 上排版公式、加代码复制按钮。
  useLayoutEffect(() => enhanceMarkdown(ref.current), [html]);
  return <div class="markdown" ref={ref} dangerouslySetInnerHTML={html} />;
}

function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  return (
    <ul class="files sent">
      {attachments.map((a) => (
        <li key={a.id} class={`file${a.fileId ? '' : ' missing'}`} title={a.fileId ? a.name : `${a.name}（内容不可用）`}>
          <span class="file-icon">{a.kind === 'image' ? '🖼' : '📄'}</span>
          <span class="file-name">{a.name}</span>
          {a.bytes > 0 && <span class="file-state">{formatBytes(a.bytes)}</span>}
        </li>
      ))}
    </ul>
  );
}

function Sources({ turn }: { turn: Turn }) {
  const sources: Source[] = useMemo(() => sourcesOf(turn.serverToolCalls), [turn.serverToolCalls]);
  const queries = useMemo(() => queriesOf(turn.serverToolCalls), [turn.serverToolCalls]);
  const cited = useMemo(() => withCitations(turn.content, turn.annotations).cited, [turn.content, turn.annotations]);
  // 先列出正文引用（与角标编号一致），再列其余搜到的网页。
  const list = [...cited, ...sources.filter((s) => !cited.some((c) => c.url === s.url))];
  if (!list.length) return null;
  return (
    <details class="sources">
      <summary>已搜索 {num(list.length)} 个网页{queries.length ? `（${queries.slice(0, 3).join('、')}${queries.length > 3 ? '…' : ''}）` : ''}</summary>
      <ol>
        {list.map((s) => {
          const host = (() => { try { return new URL(s.url).hostname; } catch { return ''; } })();
          const site = 'site' in s && s.site ? s.site : host;
          return (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>
              {site && <span class="meta"> · {site}</span>}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function ToolUseLine({ use }: { use: ToolUse }) {
  const parts = [use.search && `搜索 ${num(use.search)} 次`, use.fetch && `阅读 ${num(use.fetch)} 页`, use.imageSearch && `搜图 ${num(use.imageSearch)} 次`]
    .filter(Boolean);
  return parts.length ? <span> · {parts.join('，')}</span> : null;
}

function CopyButton({ copy, label = '复制' }: { copy: () => Promise<void>; label?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1_500);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button class="link" onClick={() => copy().then(() => setState('done'), () => setState('failed'))}>
      {state === 'done' ? '已复制' : state === 'failed' ? '复制失败' : label}
    </button>
  );
}

function UsageLine({ usage }: { usage: Usage }) {
  return <span> · 输入 {num(usage.prompt)}（缓存命中 {num(usage.cacheHit)}）· 输出 {num(usage.completion)}</span>;
}
