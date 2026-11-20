import { officialImageUrl, type Attachment } from './files';
import { HistoryFormatError, type RawMessage } from './tree';

/** 导入的官网消息。附件单独保存，文字占位在组装请求时生成。 */
export interface ApiMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
}

export interface Transcript {
  messages: ApiMessage[];
  skippedFiles: number;
  skippedUnknownFragments: number;
  officialTokens: number | null;
}

// 官方分支 → 开放 API 的消息列表。
// 只取 REQUEST / RESPONSE 正文；THINK、TIP 和搜索类分片不回传。
// 官网附件记为 fileId 为 null 的附件；图片带上临时地址，确认导入时可以转存到 API。
export function toTranscript(branch: RawMessage[]): Transcript {
  const messages: ApiMessage[] = [];
  let skippedFiles = 0;
  let skippedUnknownFragments = 0;

  for (const m of branch) {
    const parts: string[] = [];
    const attachments: Attachment[] = [];
    for (const f of m.fragments) {
      if (m.role === 'USER' && f.type === 'FILE') {
        for (const file of f.files ?? []) {
          skippedFiles++;
          const officialId = typeof file.id === 'string' && file.id ? file.id : undefined;
          const usable = file.is_image === true && (file.status === undefined || file.status === 'SUCCESS');
          attachments.push({
            id: `official:${officialId ?? `${m.message_id}-${attachments.length}`}`,
            name: file.file_name || '未命名',
            kind: file.is_image ? 'image' : 'document',
            bytes: typeof file.file_size === 'number' ? file.file_size : 0,
            fileId: null,
            source: 'official',
            ...(officialId && { officialId }),
            ...(usable && officialImageUrl(file.signed_path) && { officialUrl: officialImageUrl(file.signed_path) }),
          });
        }
      } else if (f.type === (m.role === 'USER' ? 'REQUEST' : 'RESPONSE')) {
        if (typeof f.content === 'string' && f.content.trim()) parts.push(f.content);
      } else if (f.type !== 'THINK' && f.type !== 'TIP' && !f.type.startsWith('SEARCH')) {
        skippedUnknownFragments++;
      }
    }
    if (parts.length || attachments.length) {
      messages.push({
        role: m.role === 'USER' ? 'user' : 'assistant',
        content: parts.join('\n\n'),
        ...(attachments.length && { attachments }),
      });
    }
  }

  if (branch.length && !messages.length) {
    throw new HistoryFormatError('没有从分支里读出任何正文，分片结构可能已变化');
  }
  const last = branch[branch.length - 1]?.accumulated_token_usage;
  return { messages: mergeConsecutive(messages), skippedFiles, skippedUnknownFragments, officialTokens: typeof last === 'number' ? last : null };
}

// 合并相邻的同角色消息，保证 user / assistant 交替。
export function mergeConsecutive(messages: ApiMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = [prev.content, m.content].filter(Boolean).join('\n\n');
      if (m.attachments?.length) prev.attachments = [...(prev.attachments ?? []), ...m.attachments];
    } else {
      out.push({ ...m, ...(m.attachments && { attachments: [...m.attachments] }) });
    }
  }
  return out;
}
