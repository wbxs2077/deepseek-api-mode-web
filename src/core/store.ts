import type { Annotation, ToolUse, Usage } from './client';
import type { Attachment } from './files';
import type { ApiMessage } from './transcript';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  /** 用户提问的附件。 */
  attachments?: Attachment[];
  /** 发送时的 latest_reminder 内容，回放时原样放回，保持请求前缀稳定。 */
  reminder?: string;
  reasoning?: string;
  /** 联网回复最后一步的思考，下一轮回放使用。 */
  replayReasoning?: string;
  usage?: Usage;
  /** 按 usage 和完成时段换算的费用（元），旧记录没有。 */
  costYuan?: number;
  model?: string;
  interrupted?: boolean;
  finishStatus?: 'aborted' | 'incomplete' | 'length' | 'content_filter';
  /** 联网工具的调用记录，下一轮原样回传。 */
  serverToolCalls?: unknown[];
  annotations?: Annotation[];
  toolUse?: ToolUse;
}

// 一条官方对话对应一份本地记录：导入时的上下文快照加本地新增的回合。
export interface SessionRecord {
  sessionId: string;
  title: string;
  importedAt: number;
  updatedAt: number;
  leafId: string | null;
  officialTokens: number | null;
  skippedFiles: number;
  skippedUnknownFragments?: number;
  hasBranches: boolean;
  imported: ApiMessage[];
  turns: Turn[];
  /** 用户选择继续用旧快照时，官网分支末尾的消息 ID。官网再有新消息时重新提示。 */
  dismissedLeafId?: string | null;
  /** 这条对话上传到 API 账号的文件，删除本机记录或重新导入时一并删除。 */
  uploadedFileIds?: string[];
  /** 后台记录的上传凭据，仅存 Key 指纹。旧版只有 uploadedFileIds。 */
  uploadOwners?: UploadOwner[];
  /** 导入时选择带上官网历史里的图片。重新导入时沿用。 */
  officialImages?: boolean;
}

/** 记录里仍在引用的 API 文件。 */
export function referencedFileIds(record: Pick<SessionRecord, 'imported' | 'turns'>) {
  const ids = new Set<string>();
  for (const m of [...record.imported, ...record.turns]) {
    for (const a of m.attachments ?? []) if (a.fileId) ids.add(a.fileId);
  }
  return ids;
}

export interface DraftOwner { tabId: number; documentId?: string }
export interface UploadOwner { fileId: string; keyTag: string; draft?: DraftOwner }
// 数组主键只用于清理登记，与 v1 的字符串会话主键互斥。事务同时提交记录变更与删除意图。
const CLEANUP = 'cleanup';
export interface PendingUpload { sessionId: [string, string, string, string]; ticket: string }
function receiptKey(sessionId: string, fileId: string, keyTag: string): PendingUpload['sessionId'] {
  return [CLEANUP, sessionId, keyTag, fileId];
}
function enqueue(store: IDBObjectStore, sessionId: string, fileId: string, keyTag = '') {
  return store.put({ sessionId: receiptKey(sessionId, fileId, keyTag), ticket: crypto.randomUUID() } satisfies PendingUpload);
}
// Persist a known remote ID first. Even a failed/aborted subsequent adoption transaction leaves a retryable receipt.
export const stageUpload = (sessionId: string, fileId: string, keyTag: string) =>
  run('readwrite', s => enqueue(s, sessionId, fileId, keyTag), () => undefined);

const DB_NAME = 'ds-api-continue';
const STORE = 'sessions';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'sessionId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T, R>(
  mode: IDBTransactionMode,
  request: (store: IDBObjectStore) => IDBRequest<T>,
  onSuccess: (value: T, store: IDBObjectStore) => R,
): Promise<R> {
  const db = await open();
  try {
    return await new Promise<R>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result: R;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));

      const req = request(store);
      req.onsuccess = () => {
        try {
          // Queue any follow-up write while this transaction is still active.
          result = onSuccess(req.result, store);
        } catch (error) {
          reject(error);
          tx.abort();
        }
      };
    });
  } finally {
    db.close();
  }
}

const readSession = (sessionId: string) => (store: IDBObjectStore): IDBRequest<SessionRecord | undefined> =>
  store.get(sessionId);

const cleanupRange = () => IDBKeyRange.bound([CLEANUP], [CLEANUP, []]);
export const pendingUploads = (): Promise<PendingUpload[]> =>
  run('readonly', s => s.getAll(cleanupRange()), rows => rows);
export const cleanupCount = () => run('readonly', s => s.count(cleanupRange()), n => n);
export const confirmCleanup = (row: PendingUpload) =>
  run('readwrite', s => s.get(row.sessionId), (current, s) => {
    if (current?.ticket === row.ticket) s.delete(row.sessionId);
  });

// 也保护另一个会话的引用或尚未发送的草稿，即使服务端曾返回重复的文件 ID。
export const liveUploadIds = (): Promise<Set<string>> =>
  run('readonly', s => s.getAll(IDBKeyRange.upperBound([], true)), (records: SessionRecord[]) => {
    const live = new Set<string>();
    for (const record of records) {
      for (const id of record.uploadedFileIds ?? []) live.add(id);
      for (const id of referencedFileIds(record)) live.add(id);
    }
    return live;
  });

function detach(store: IDBObjectStore, record: SessionRecord, candidates: Iterable<string>) {
  const used = referencedFileIds(record);
  const wanted = new Set(candidates);
  const released = new Set((record.uploadedFileIds ?? []).filter(id => wanted.has(id) && !used.has(id)));
  for (const id of released) enqueue(store, record.sessionId, id, record.uploadOwners?.find(o => o.fileId === id)?.keyTag);
  if (released.size) {
    record.uploadedFileIds = record.uploadedFileIds!.filter(id => !released.has(id));
    if (record.uploadOwners) record.uploadOwners = record.uploadOwners.filter(o => !released.has(o.fileId));
  }
  return [...released];
}

function ownsAttachments(record: SessionRecord, turns: Turn[]) {
  const uploaded = new Set(record.uploadedFileIds);
  return turns.every(turn => turn.attachments?.every(a => !a.fileId || uploaded.has(a.fileId)) !== false);
}

export const getSession = (sessionId: string) =>
  run('readonly', readSession(sessionId), (record) => record);

export const putSession = (record: SessionRecord) =>
  run('readwrite', (s) => s.put({ ...record, updatedAt: Date.now() }), (key) => key);

export const createSession = (record: SessionRecord): Promise<boolean> =>
  run('readwrite', readSession(record.sessionId), (current, store) => {
    if (current !== undefined) return false;
    store.add(record);
    return true;
  });

export const appendTurn = (
  sessionId: string,
  importedAt: number,
  turn: Turn,
  expectedTurnCount?: number,
): Promise<SessionRecord | undefined> =>
  run('readwrite', readSession(sessionId), (current, store) => {
    if (!current || current.importedAt !== importedAt) return undefined;
    if (expectedTurnCount !== undefined && current.turns.length !== expectedTurnCount) return undefined;

    if (!ownsAttachments(current, [turn])) return undefined;
    const updated = { ...current, updatedAt: Math.max(Date.now(), current.updatedAt + 1), turns: [...current.turns, turn] };
    store.put(updated);
    return updated;
  });

// 从下标 from 起替换回合，用于重新生成和编辑。updatedAt 不符说明记录已被别处改过。
export const replaceTurns = (
  sessionId: string,
  importedAt: number,
  expectedUpdatedAt: number,
  from: number,
  turns: Turn[],
): Promise<SessionRecord | undefined> =>
  run('readwrite', readSession(sessionId), (current, store) => {
    if (!current || current.importedAt !== importedAt || current.updatedAt !== expectedUpdatedAt) return undefined;
    if (from < 0 || from > current.turns.length) return undefined;

    if (!ownsAttachments(current, turns)) return undefined;
    const updated = { ...current, updatedAt: Math.max(Date.now(), current.updatedAt + 1), turns: [...current.turns.slice(0, from), ...turns] };
    detach(store, updated, referencedFileIds({ imported: [], turns: current.turns.slice(from) }));
    store.put(updated);
    return updated;
  });

// 用新的官网快照替换旧记录。keepTurns 为 false 时删除本地回合，为 true 时只允许替换没有回合的记录。
export const reimportSession = (
  next: SessionRecord,
  expectedImportedAt: number,
  keepTurns: boolean,
  expectedUpdatedAt: number,
): Promise<SessionRecord | undefined> =>
  run('readwrite', readSession(next.sessionId), (current, store) => {
    if (!current || current.importedAt !== expectedImportedAt || current.updatedAt !== expectedUpdatedAt) return undefined;
    if (keepTurns && current.turns.length) return undefined;

    const uploads = [...new Set([...(current.uploadedFileIds ?? []), ...(next.uploadedFileIds ?? [])])];
    const updated = {
      ...next,
      imported: reuseOfficialImages(next.imported, current.imported),
      importedAt: Math.max(next.importedAt, current.importedAt + 1),
      turns: [],
      dismissedLeafId: null,
      uploadedFileIds: uploads,
      uploadOwners: current.uploadOwners,
      officialImages: next.officialImages ?? current.officialImages,
    };
    detach(store, updated, referencedFileIds(current));
    updated.updatedAt = Math.max(updated.importedAt, current.updatedAt + 1);
    store.put(updated);
    return updated;
  });

// 新快照里与旧快照相同的官网图片，沿用已经转存到 API 的文件。
function reuseOfficialImages(next: ApiMessage[], previous: ApiMessage[]): ApiMessage[] {
  const known = new Map<string, string>();
  for (const m of previous) {
    for (const a of m.attachments ?? []) if (a.officialId && a.fileId) known.set(a.officialId, a.fileId);
  }
  if (!known.size) return next;
  return next.map((m) => (m.attachments?.length
    ? { ...m, attachments: m.attachments.map((a) => (a.officialId && !a.fileId && known.has(a.officialId) ? { ...a, fileId: known.get(a.officialId)! } : a)) }
    : m));
}

/** 图片转存改变下次请求的上下文，因此成功后推进版本。无法采用的上传在同一事务登记。 */
export const attachImportedFile = (sessionId: string, importedAt: number, attachmentId: string, fileId: string, keyTag?: string): Promise<boolean> =>
  run('readwrite', readSession(sessionId), (current, store) => {
    const unused = () => {
      if (keyTag) enqueue(store, sessionId, fileId, keyTag);
      return false;
    };
    if (!current || current.importedAt !== importedAt) return unused();
    let found = false;
    const imported = current.imported.map((m) => {
      if (!m.attachments?.some((a) => a.id === attachmentId && !a.fileId)) return m;
      found = true;
      return { ...m, attachments: m.attachments.map((a) => (a.id === attachmentId && !a.fileId ? { ...a, fileId } : a)) };
    });
    if (!found) return unused();
    const uploads = new Set(current.uploadedFileIds ?? []);
    uploads.add(fileId);
    const uploadOwners = [...(current.uploadOwners ?? [])];
    if (keyTag) {
      uploadOwners.push({ fileId, keyTag });
      store.delete(receiptKey(sessionId, fileId, keyTag));
    }
    store.put({ ...current, imported, updatedAt: Math.max(Date.now(), current.updatedAt + 1), uploadedFileIds: [...uploads], uploadOwners });
    return true;
  });

export const dismissStale = (sessionId: string, importedAt: number, leafId: string | null): Promise<SessionRecord | undefined> =>
  run('readwrite', readSession(sessionId), (current, store) => {
    if (!current || current.importedAt !== importedAt) return undefined;
    const updated = { ...current, dismissedLeafId: leafId };
    store.put(updated);
    return updated;
  });

/** 删除成功时返回这条对话上传过的文件 ID，失败时返回 null。 */
export const deleteSession = (sessionId: string, importedAt: number, expectedUpdatedAt: number): Promise<string[] | null> =>
  run('readwrite', readSession(sessionId), (current, store) => {
    if (!current || current.importedAt !== importedAt || current.updatedAt !== expectedUpdatedAt) return null;
    for (const id of current.uploadedFileIds ?? []) enqueue(store, sessionId, id, current.uploadOwners?.find(o => o.fileId === id)?.keyTag);
    store.delete(sessionId);
    return [...(current.uploadedFileIds ?? [])];
  });

// 上传开始前捕获 importedAt；若上传过程中会话被替换或删除，直接登记待清理。
export const registerUploads = (sessionId: string, fileIds: string[], owner?: Omit<UploadOwner, 'fileId'>, importedAt?: number): Promise<boolean> =>
  run('readwrite', readSession(sessionId), (current, store) => {
    if (!current || (importedAt !== undefined && current.importedAt !== importedAt)) {
      if (owner) for (const id of fileIds) enqueue(store, sessionId, id, owner.keyTag);
      return false;
    }
    const uploads = new Set(current.uploadedFileIds);
    for (const id of fileIds) uploads.add(id);
    const uploadOwners = [...(current.uploadOwners ?? [])];
    if (owner) {
      // A repeated remote ID must never transfer another draft's ownership.
      if (fileIds.some(id => current.uploadedFileIds?.includes(id))) return false;
      for (const fileId of new Set(fileIds)) {
        uploadOwners.push({ ...owner, fileId });
        store.delete(receiptKey(sessionId, fileId, owner.keyTag));
      }
    }
    store.put({ ...current, uploadedFileIds: [...uploads], uploadOwners });
    return true;
  });

/** 草稿释放只接受上传时绑定的 tab/document，已发送或导入的附件另由引用检查保护。 */
export const releaseUploads = (sessionId: string, candidates: string[], draft?: DraftOwner): Promise<string[]> =>
  run('readwrite', readSession(sessionId), (current, store) => {
    if (!current) return [];
    const allowed = draft ? candidates.filter(id => current.uploadOwners?.some(o => o.fileId === id &&
      o.draft?.tabId === draft.tabId && o.draft.documentId === draft.documentId)) : candidates;
    const released = detach(store, current, allowed);
    if (released.length) store.put(current);
    return released;
  });
