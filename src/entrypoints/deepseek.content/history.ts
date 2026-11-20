import { browser } from 'wxt/browser';
import type { SessionRecord } from '../../core/store';
import { toTranscript } from '../../core/transcript';
import { branchTo, parseHistory } from '../../core/tree';
import type { PageReplies, PageReply, PageRequest } from '../../protocol';

// 官方登录态只在这里使用，不传给扩展的其他部分。对官方只有这一个只读请求。
export async function readHistory(sessionId: string, signal?: AbortSignal): Promise<SessionRecord> {
  let token = '';
  try {
    token = JSON.parse(localStorage.getItem('userToken') ?? 'null')?.value ?? '';
  } catch {}
  if (!token) throw new Error('没有找到 DeepSeek 登录状态，请先登录');
  let json;
  try {
    const res = await fetch(`/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}`, {
      signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch (e) {
    throw new Error(`读取对话失败：${(e as Error).message}`);
  }
  if (json?.code !== 0 || json?.data?.biz_code !== 0) {
    throw new Error(`读取对话失败：${json?.msg || json?.data?.biz_msg || '未知错误'}`);
  }
  const history = parseHistory(json.data.biz_data);
  if (history.sessionId !== sessionId) throw new Error('返回的历史记录与当前对话不符，请重试');
  const transcript = toTranscript(branchTo(history));
  if (!transcript.messages.length) throw new Error('这条对话还没有可导入的消息');
  const now = Date.now();
  return {
    sessionId,
    title: history.title,
    importedAt: now,
    updatedAt: now,
    leafId: history.leafId,
    officialTokens: transcript.officialTokens,
    skippedFiles: transcript.skippedFiles,
    skippedUnknownFragments: transcript.skippedUnknownFragments,
    hasBranches: history.branchPoints > 0,
    imported: transcript.messages,
    turns: [],
  };
}

export async function request<K extends PageRequest['type']>(message: Extract<PageRequest, { type: K }>): Promise<PageReplies[K]> {
  let reply: PageReply<PageReplies[K]> | undefined;
  try {
    reply = await browser.runtime.sendMessage(message);
  } catch {
    throw new Error('扩展没有响应。如果刚更新过扩展，请刷新页面');
  }
  if (!reply) throw new Error('扩展没有响应，请刷新页面');
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}
