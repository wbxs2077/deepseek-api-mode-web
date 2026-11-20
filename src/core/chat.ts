import { streamChat, type ChatResult, type ChatStatus, type ToolEvent } from './client';
import { MAX_FILES_PER_MESSAGE, type Attachment } from './files';
import { actualCost, isPeak } from './pricing';
import { buildRequest, reminderFor } from './request';
import { appendTurn, getSession, replaceTurns, type SessionRecord, type Turn } from './store';

// 一次续聊请求：发送新提问、编辑最后一条提问后重发，或重新生成最后一条回复（含中断后的重试）。
// 编辑时 attachments 是修改后的完整附件列表，省略表示沿用原附件。
export type ChatAction =
  | { kind: 'send'; text: string; attachments?: Attachment[] }
  | { kind: 'edit'; text: string; targetIndex: number; attachments?: Attachment[] }
  | { kind: 'regenerate' };

export interface ChatConfig {
  apiKey: string;
  model: string;
  thinking: boolean;
  maxTokens: number;
  search: boolean;
}

export const finishMessage: Record<Exclude<ChatStatus, 'complete'>, string> = {
  aborted: '已停止',
  incomplete: '回复中断',
  length: '达到输出长度上限',
  content_filter: '回复被内容过滤截断',
};

/** 界面看到的记录已过期。latest 是存储里的当前版本，记录被删除时为 undefined。 */
export class StaleRecordError extends Error {
  constructor(public latest: SessionRecord | undefined) {
    super(latest ? '这条对话的本地记录已在别处更新，已刷新，请核对后再发送' : '这条对话的本地记录已被删除');
  }
}

export const lastUserIndex = (turns: Turn[]) => turns.findLastIndex((t) => t.role === 'user');

/** 最后一条是未回复的提问，或是紧跟在提问后的回复时，可以重新生成。 */
export function canRegenerate(turns: Turn[]) {
  const last = turns.at(-1);
  return last?.role === 'user' || (last?.role === 'assistant' && turns.at(-2)?.role === 'user');
}

export interface RunChatOptions {
  sessionId: string;
  /** 编辑使用开始编辑时的版本，其他操作使用提交时的版本。与存储不符时抛 StaleRecordError。 */
  expected: { importedAt: number; updatedAt: number };
  action: ChatAction;
  config: ChatConfig;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  onRecord?: (record: SessionRecord) => void;
  onLive?: (text: string, reasoning: string) => void;
  onTool?: (event: ToolEvent) => void;
}

export interface RunChatResult {
  record: SessionRecord;
  error?: string;
  /** 编辑时被移除的附件，由调用方核对是否已无引用后从 API 账号删除。 */
  removedFileIds?: string[];
}

// 附件必须是这条对话已上传的文件，防止把别的文件 ID 拼进请求。
function checkAttachments(record: SessionRecord, attachments: Attachment[]) {
  if (attachments.length > MAX_FILES_PER_MESSAGE) throw new Error(`每条消息最多 ${MAX_FILES_PER_MESSAGE} 个附件`);
  const uploaded = new Set(record.uploadedFileIds ?? []);
  for (const a of attachments) {
    if (a.fileId && !uploaded.has(a.fileId)) throw new Error('附件不属于这条对话，请重新添加');
  }
}

// 停止时保存已收到的部分。重新生成只在收到新正文后才替换旧回复。
export async function runChat(opts: RunChatOptions): Promise<RunChatResult> {
  const { sessionId, action, config, signal } = opts;
  const latest = await getSession(sessionId);
  if (!latest || latest.importedAt !== opts.expected.importedAt || latest.updatedAt !== opts.expected.updatedAt) {
    throw new StaleRecordError(latest);
  }
  if (signal?.aborted) return { record: latest };
  let record = latest;
  const { importedAt } = record;
  async function commit(write: Promise<SessionRecord | undefined>) {
    const next = await write;
    if (!next) throw new Error('本地记录已变化，无法保存本次消息');
    record = next;
    opts.onRecord?.(next);
  }

  let replaceFrom: number | null = null;
  let removedFileIds: string[] | undefined;
  if (action.kind === 'regenerate') {
    if (!canRegenerate(record.turns)) throw new Error('没有可以重新生成的回复');
    if (record.turns.at(-1)?.role === 'assistant') replaceFrom = record.turns.length - 1;
  } else {
    const text = action.text.trim();
    let attachments = action.attachments;
    let index = -1;
    if (action.kind === 'edit') {
      index = lastUserIndex(record.turns);
      if (index < 0) throw new Error('没有可以编辑的提问');
      if (action.targetIndex !== index) throw new StaleRecordError(record);
      attachments ??= record.turns[index]!.attachments;
      const kept = new Set((attachments ?? []).map((a) => a.fileId));
      removedFileIds = (record.turns[index]!.attachments ?? []).flatMap((a) => (a.fileId && !kept.has(a.fileId) ? [a.fileId] : []));
    }
    if (!text && !attachments?.length) throw new Error('消息为空');
    checkAttachments(record, attachments ?? []);
    const turn: Turn = {
      role: 'user',
      content: text,
      ...(attachments?.length && { attachments }),
      reminder: reminderFor((opts.now ?? (() => new Date()))()),
    };
    if (action.kind === 'send') await commit(appendTurn(sessionId, importedAt, turn, record.turns.length));
    else await commit(replaceTurns(sessionId, importedAt, record.updatedAt, index, [turn]));
  }
  if (signal?.aborted) return { record, removedFileIds };

  const replacing = replaceFrom;
  const context = replacing == null ? record.turns : record.turns.slice(0, replacing);
  const request = buildRequest(record.imported, context, { model: config.model, search: config.search });
  const save = (turn: Turn) => commit(replacing == null
    ? appendTurn(sessionId, importedAt, turn, record.turns.length)
    : replaceTurns(sessionId, importedAt, record.updatedAt, replacing, [turn]));
  async function saveReply(result: Readonly<ChatResult>) {
    if (!result.text && (replacing != null || (!result.reasoning && !result.serverToolCalls?.length))) return false;
    const status = result.status === 'complete' && !result.text ? 'incomplete' : result.status;
    const finished = (opts.now ?? (() => new Date()))();
    await save({
      role: 'assistant',
      content: result.text,
      reasoning: result.reasoning || undefined,
      ...(result.replayReasoning !== undefined && { replayReasoning: result.replayReasoning }),
      usage: result.usage ?? undefined,
      // 按完成时的时段换算，之后价格表变动也不改写旧记录。
      ...(result.usage && { costYuan: actualCost(request.model, result.usage, isPeak(finished)) }),
      model: request.model,
      interrupted: status !== 'complete' || undefined,
      finishStatus: status !== 'complete' ? status : undefined,
      ...(result.serverToolCalls?.length && { serverToolCalls: result.serverToolCalls }),
      ...(result.annotations.length && { annotations: result.annotations }),
      ...(result.toolUse && { toolUse: result.toolUse }),
    });
    return true;
  }

  const result = await streamChat({
    apiKey: config.apiKey,
    model: request.model,
    thinking: config.thinking,
    maxTokens: config.maxTokens || undefined,
    search: config.search,
    signal,
    fetchImpl: opts.fetchImpl,
    messages: request.messages,
    onDelta: opts.onLive,
    onTool: opts.onTool,
    onStreamError: async (partial) => { await saveReply(partial); },
  });
  if (await saveReply(result)) return { record, removedFileIds };
  if (result.status === 'aborted') return { record, removedFileIds };
  return { record, removedFileIds, error: result.status === 'complete' ? '模型没有返回内容' : finishMessage[result.status] };
}
