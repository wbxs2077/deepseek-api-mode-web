import { FLASH_MODEL, type ContentPart, type WireMessage } from './client';
import { placeholder, type Attachment } from './files';
import type { Turn } from './store';
import type { ApiMessage } from './transcript';

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** latest_reminder 的内容：日期,星期,地点,平台,语言。地点留空。 */
export function reminderFor(now: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${date},${WEEKDAYS[now.getDay()]},,Web,中文`;
}

// 文件块在前，文字在后。内容带不过来的附件写成文字占位。
function userContent(text: string, attachments: Attachment[] | undefined): string | ContentPart[] {
  const files = (attachments ?? []).filter((a) => a.fileId);
  const notes = (attachments ?? []).filter((a) => !a.fileId).map(placeholder);
  const body = [...notes, text].filter(Boolean).join('\n\n');
  if (!files.length) return body;
  return [
    ...files.map((a) => ({ type: 'file' as const, file_id: a.fileId! })),
    ...(body ? [{ type: 'text' as const, text: body }] : []),
  ];
}

export const hasFiles = (messages: { attachments?: Attachment[] }[]) =>
  messages.some((m) => m.attachments?.some((a) => a.fileId));

export interface BuiltRequest {
  messages: WireMessage[];
  model: string;
  /** 因图片、文件或联网改用 flash 的原因，没有改用时为 null。 */
  switchedFor: 'files' | 'search' | null;
}

/**
 * 组装 /chat/completions 的 messages。imported 是官网快照，turns 是本机回合（已含本次提问）。
 * 本机回合的 reasoning_content 一律回传：用过联网工具后的请求必须带上，否则返回 400；
 * 不带工具时服务端会忽略它，不影响用量。
 */
export function buildRequest(imported: ApiMessage[], turns: ReplayTurn[], options: { model: string; search: boolean }): BuiltRequest {
  const messages: WireMessage[] = [];
  const push = (m: WireMessage) => {
    const prev = messages.at(-1);
    // 相邻的同角色消息合并，保证 user / assistant 交替。
    if (prev && prev.role === m.role && prev.role !== 'latest_reminder') {
      if (prev.role === 'assistant' && m.role === 'assistant') {
        prev.content = [prev.content, m.content].filter(Boolean).join('\n\n');
        return;
      }
      if (prev.role === 'user' && m.role === 'user') {
        prev.content = mergeUser(prev.content, m.content);
        return;
      }
    }
    messages.push(m);
  };

  for (const m of imported) {
    if (m.role === 'user') push({ role: 'user', content: userContent(m.content, m.attachments) });
    else if (m.content.trim()) push({ role: 'assistant', content: m.content });
  }
  for (const t of turns) {
    if (t.role === 'user') {
      const content = userContent(t.content, t.attachments);
      // latest_reminder 必须紧跟 user，合并到上一条 user 时不能插在中间。
      if (t.reminder && messages.at(-1)?.role !== 'user') messages.push({ role: 'latest_reminder', content: t.reminder });
      push({ role: 'user', content });
    } else if (t.content.trim() || t.serverToolCalls?.length) {
      const reasoning = reasoningForReplay(t);
      push({
        role: 'assistant',
        content: t.content,
        ...(reasoning !== undefined && { reasoning_content: reasoning }),
        ...(t.serverToolCalls?.length && { server_tool_calls: t.serverToolCalls }),
      });
    }
  }

  const files = hasFiles(imported) || hasFiles(turns);
  const switchedFor = options.model === FLASH_MODEL ? null : files ? 'files' : options.search ? 'search' : null;
  return { messages, model: switchedFor ? FLASH_MODEL : options.model, switchedFor };
}

type ReplayTurn = Turn & { replayReasoning?: string };

function reasoningForReplay(turn: ReplayTurn): string | undefined {
  if (turn.replayReasoning !== undefined) return turn.replayReasoning;
  // 旧记录只保存全程思考。逐步核对前缀，只有完整匹配才截取末步。
  const full = turn.reasoning ?? '';
  let offset = 0;
  if (turn.serverToolCalls?.length) {
    for (const step of turn.serverToolCalls) {
      if (!step || typeof step !== 'object' || !('reasoning_content' in step)
        || typeof step.reasoning_content !== 'string' || !full.startsWith(step.reasoning_content, offset)) {
        return turn.reasoning;
      }
      offset += step.reasoning_content.length;
    }
    return full.slice(offset);
  }
  return turn.reasoning;
}

function mergeUser(a: string | ContentPart[], b: string | ContentPart[]): string | ContentPart[] {
  if (typeof a === 'string' && typeof b === 'string') return [a, b].filter(Boolean).join('\n\n');
  const parts = (c: string | ContentPart[]): ContentPart[] => (typeof c === 'string' ? (c ? [{ type: 'text', text: c }] : []) : c);
  return [...parts(a), ...parts(b)];
}
