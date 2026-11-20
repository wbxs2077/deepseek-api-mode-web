// 解析 /api/v0/chat/history_messages 的 biz_data。这是未公开接口，
// 结构不符时抛 HistoryFormatError，由界面提示而不是静默导入残缺上下文。

export class HistoryFormatError extends Error {}

export interface RawFile {
  id?: string;
  file_name?: string;
  is_image?: boolean;
  file_size?: number;
  status?: string;
  signed_path?: string;
}

export interface RawFragment {
  type: string;
  content?: string;
  files?: RawFile[];
}

export interface RawMessage {
  message_id: number | string;
  parent_id: number | string | null;
  role: 'USER' | 'ASSISTANT';
  fragments: RawFragment[];
  accumulated_token_usage?: number;
}

export interface History {
  sessionId: string;
  title: string;
  version: number | null;
  leafId: string | null;
  messages: Map<string, RawMessage>;
  branchPoints: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isId = (v: unknown): v is number | string => typeof v === 'number' || typeof v === 'string';

export function parseHistory(data: unknown): History {
  if (!isObject(data) || !isObject(data.chat_session) || !Array.isArray(data.chat_messages)) {
    throw new HistoryFormatError('响应里没有 chat_session 或 chat_messages');
  }
  const session = data.chat_session;
  if (typeof session.id !== 'string') throw new HistoryFormatError('chat_session.id 缺失');

  const messages = new Map<string, RawMessage>();
  const childCount = new Map<string, number>();
  for (const m of data.chat_messages as unknown[]) {
    if (!isObject(m) || !isId(m.message_id)) throw new HistoryFormatError('消息缺少 message_id');
    if (m.parent_id != null && !isId(m.parent_id)) throw new HistoryFormatError(`消息 ${m.message_id} 的 parent_id 类型不符`);
    if (m.role !== 'USER' && m.role !== 'ASSISTANT') throw new HistoryFormatError(`消息 ${m.message_id} 的角色未知：${String(m.role)}`);
    if (!Array.isArray(m.fragments)) throw new HistoryFormatError(`消息 ${m.message_id} 没有 fragments`);
    for (const f of m.fragments) {
      if (!isObject(f) || typeof f.type !== 'string') throw new HistoryFormatError(`消息 ${m.message_id} 的分片缺少 type`);
    }
    const messageId = String(m.message_id);
    if (messages.has(messageId)) throw new HistoryFormatError(`消息 ${messageId} 的 ID 重复`);
    messages.set(messageId, m as unknown as RawMessage);
    const parent = String(m.parent_id ?? '');
    childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
  }

  let leafId: string | null = null;
  if (isId(session.current_message_id)) {
    leafId = String(session.current_message_id);
  } else if (messages.size) {
    // 与官方网页一致：没有 current_message_id 时取最大的 message_id
    leafId = [...messages.keys()].reduce((a, b) => (Number(b) > Number(a) ? b : a));
  }

  return {
    sessionId: session.id,
    title: typeof session.title === 'string' ? session.title : '',
    version: typeof session.version === 'number' ? session.version : null,
    leafId,
    messages,
    branchPoints: [...childCount.values()].filter((n) => n > 1).length,
  };
}

// 从叶子沿 parent_id 回溯到根，返回根在前的分支。
export function branchTo(history: History, leafId: string | null = history.leafId): RawMessage[] {
  const branch: RawMessage[] = [];
  const seen = new Set<string>();
  let cur = leafId;
  while (cur != null) {
    const m = history.messages.get(cur);
    if (!m) throw new HistoryFormatError(`分支在消息 ${cur} 处断开`);
    if (seen.has(cur)) throw new HistoryFormatError(`消息 ${cur} 的父链成环`);
    seen.add(cur);
    branch.push(m);
    cur = m.parent_id == null ? null : String(m.parent_id);
  }
  return branch.reverse();
}
