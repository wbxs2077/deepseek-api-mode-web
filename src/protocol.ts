// 对话页 content script 与 background 之间的消息。
import type { Balance, ToolEvent } from './core/client';
import type { ChatAction } from './core/chat';
import type { Attachment } from './core/files';
import type { SendOptions } from './core/send-options';
import type { SessionRecord, Turn } from './core/store';

/** 页面看到的本地记录。导入的上下文只带条数和最后一条，Key 不出 background。 */
export interface SessionView {
  sessionId: string;
  title: string;
  importedAt: number;
  updatedAt: number;
  leafId: string | null;
  dismissedLeafId: string | null;
  officialTokens: number | null;
  skippedFiles: number;
  skippedUnknownFragments: number;
  hasBranches: boolean;
  importedCount: number;
  lastImported: { role: 'user' | 'assistant'; content: string } | null;
  /** 官网历史里的图片：总数、已转存到 API 的数量，以及是否选择带上。 */
  officialImages: { total: number; attached: number; wanted: boolean };
  turns: Turn[];
}

export interface SettingsView extends SendOptions {
  hasKey: boolean;
}

export type PageRequest =
  | { type: 'get-state'; sessionId: string }
  | { type: 'create'; record: SessionRecord }
  | { type: 'reimport'; record: SessionRecord; expectedImportedAt: number; expectedUpdatedAt: number; keepTurns: boolean }
  | { type: 'dismiss-stale'; sessionId: string; importedAt: number; leafId: string | null }
  | { type: 'delete'; sessionId: string; importedAt: number; expectedUpdatedAt: number }
  | { type: 'discard-upload'; sessionId: string; fileId: string }
  | { type: 'patch-settings'; patch: { model?: string; thinking?: boolean; search?: boolean } }
  | { type: 'open-settings' };

export interface PageState {
  session: SessionView | null;
  settings: SettingsView;
}

export type PageReply<T> = { ok: true; value: T } | { ok: false; error: string };

/** 仅扩展弹窗可请求文件清理和余额查询。 */
export type PopupRequest = { type: 'cleanup-status' } | { type: 'retry-cleanup' } | { type: 'balance' };
export type PopupReply = PageReply<{ pending: number }>;
export type BalanceReply = PageReply<Balance>;

export interface PageReplies {
  'get-state': PageState;
  create: { session: SessionView; created: boolean };
  reimport: SessionView | null;
  'dismiss-stale': SessionView | null;
  /** 删除成功时返回没能从 API 账号删除的文件数。 */
  delete: { deleted: boolean; filesLeft: number };
  'discard-upload': boolean;
  'patch-settings': SettingsView;
  'open-settings': boolean;
}

/** 发送期间的长连接，名称为 CHAT_PORT。页面断开即中止请求。 */
export const CHAT_PORT = 'chat';
export type ChatPortIn =
  /** options 由页面在发送时取快照，后台用 parseSendOptions 校验。edit 的版本和 targetIndex 取自开始编辑时。 */
  | { type: 'run'; sessionId: string; expected: { importedAt: number; updatedAt: number }; action: ChatAction; options: SendOptions }
  | { type: 'stop' }
  | { type: 'ping' };
export type ChatPortOut =
  | { type: 'live'; text: string; reasoning: string }
  | { type: 'tool'; event: ToolEvent }
  | { type: 'session'; session: SessionView }
  | { type: 'done'; error?: string; stale?: SessionView | null };

/**
 * 上传一个本地文件的长连接。runtime 消息只能传 JSON，文件按 UPLOAD_CHUNK 字节切块、以 base64 发送。
 * 页面断开即中止上传。uploadName 是实际上传的文件名（图片转码后扩展名会变）。
 */
export const UPLOAD_PORT = 'upload';
export const UPLOAD_CHUNK = 1024 * 1024;
export type UploadPortIn =
  | { type: 'begin'; sessionId: string; name: string; uploadName: string; size: number; mime: string }
  | { type: 'chunk'; data: string }
  | { type: 'end' };
export type UploadPortOut =
  | { type: 'next' }
  | { type: 'parsing' }
  | { type: 'done'; attachment: Attachment }
  | { type: 'error'; error: string };

/** 把官网历史里的图片转存到 API 的长连接。地址只在这次传输中使用，不写入本机记录。 */
export const IMPORT_IMAGES_PORT = 'import-images';
export type ImportImagesIn = { type: 'start'; sessionId: string; importedAt: number; images: { attachmentId: string; url: string }[] };
export type ImportImagesOut =
  | { type: 'progress'; done: number; total: number; failed: number }
  | { type: 'done'; session: SessionView | null; failed: number; error?: string };

export const LAST_PREVIEW_CHARS = 160;

export function officialImageStats(record: Pick<SessionRecord, 'imported' | 'officialImages'>) {
  let total = 0;
  let attached = 0;
  for (const m of record.imported) {
    for (const a of m.attachments ?? []) {
      if (a.source !== 'official' || a.kind !== 'image') continue;
      total++;
      if (a.fileId) attached++;
    }
  }
  return { total, attached, wanted: record.officialImages !== false };
}

export function toView(record: SessionRecord): SessionView {
  const last = record.imported.at(-1);
  return {
    sessionId: record.sessionId,
    title: record.title,
    importedAt: record.importedAt,
    updatedAt: record.updatedAt,
    leafId: record.leafId,
    dismissedLeafId: record.dismissedLeafId ?? null,
    officialTokens: record.officialTokens,
    skippedFiles: record.skippedFiles,
    skippedUnknownFragments: record.skippedUnknownFragments ?? 0,
    hasBranches: record.hasBranches,
    importedCount: record.imported.length,
    lastImported: last ? { role: last.role, content: last.content.slice(0, LAST_PREVIEW_CHARS + 1) } : null,
    officialImages: officialImageStats(record),
    turns: record.turns,
  };
}

export const sessionIdFromPath = (path: string) =>
  path.match(/^\/a\/chat\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i)?.[1] ?? null;
