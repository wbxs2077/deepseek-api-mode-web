import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { canRegenerate, runChat, StaleRecordError, type ChatAction } from '../src/core/chat';
import type { Attachment } from '../src/core/files';
import { actualCost, isPeak } from '../src/core/pricing';
import { createSession, getSession, type SessionRecord, type Turn } from '../src/core/store';

const enc = new TextEncoder();
const event = (delta: object, extra: object = {}) => `data: ${JSON.stringify({ choices: [{ delta, ...extra }] })}\n\n`;
const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, prompt_cache_hit_tokens: 40, completion_tokens: 3 } })}\n\n`;
const done = 'data: [DONE]\n\n';
const complete = (text: string) => [event({ content: text }, { finish_reason: 'stop' }), usage, done];

// 按顺序返回预设的流。fail 为 true 时在已发送的片段之后报错（断流）。
function fakeApi(...replies: { chunks: string[]; fail?: boolean; hang?: boolean }[]) {
  const bodies: unknown[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    const reply = replies.shift()!;
    const chunks = [...reply.chunks];
    // 逐次读取时才交付片段，断流在片段全部交付后发生（error() 会丢弃仍在队列里的片段）。
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init!.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      },
      pull(controller) {
        const next = chunks.shift();
        if (next != null) controller.enqueue(enc.encode(next));
        else if (reply.fail) controller.error(new TypeError('network error'));
        else if (!reply.hang) controller.close();
        else return new Promise(() => {});
      },
    }, { highWaterMark: 0 });
    return new Response(body, { status: 200 });
  };
  return { fetchImpl, bodies };
}

const config = { apiKey: 'sk-test', model: 'deepseek-flash', thinking: false, effort: 'high' as const, maxTokens: 8192, search: false };
const NOW = new Date(2026, 10, 20, 9, 30);
const REMINDER = '2026-11-20,星期五,,Web,中文';
const now = () => NOW;
const user = (content: string): Turn => ({ role: 'user', content });
/** 本次发送写入的提问带上发送时的 latest_reminder。 */
const sent = (content: string, extra: Partial<Turn> = {}): Turn => ({ role: 'user', content, reminder: REMINDER, ...extra });
const assistant = (content: string, extra: Partial<Turn> = {}): Turn => ({ role: 'assistant', content, ...extra });

let seq = 0;
async function seed(turns: Turn[] = [], uploadedFileIds?: string[]): Promise<SessionRecord> {
  const record: SessionRecord = {
    sessionId: `chat-${++seq}`,
    title: 't',
    importedAt: 1,
    updatedAt: 1,
    leafId: '2',
    officialTokens: 10,
    skippedFiles: 0,
    hasBranches: false,
    imported: [{ role: 'user', content: 'synthetic q' }, { role: 'assistant', content: 'synthetic a' }],
    turns,
    ...(uploadedFileIds && { uploadedFileIds }),
  };
  await createSession(record);
  return record;
}

const run = (record: SessionRecord, action: ChatAction, fetchImpl: typeof fetch, signal?: AbortSignal, extra: Partial<typeof config> = {}) =>
  runChat({ sessionId: record.sessionId, expected: record, action, config: { ...config, ...extra }, fetchImpl, signal, now });

describe('runChat', () => {
  it('appends the question and the reply with imported history as context', async () => {
    const record = await seed();
    const api = fakeApi({ chunks: complete('synthetic reply') });
    const seen: SessionRecord[] = [];
    const { record: saved, error } = await runChat({
      sessionId: record.sessionId, expected: record, action: { kind: 'send', text: '  next  ' }, config,
      fetchImpl: api.fetchImpl, onRecord: (r) => seen.push(r), now,
    });
    expect(error).toBeUndefined();
    expect(saved.turns).toEqual([
      sent('next'),
      assistant('synthetic reply', { model: 'deepseek-flash', usage: { prompt: 50, cacheHit: 40, completion: 3 },
        costYuan: actualCost('deepseek-flash', { prompt: 50, cacheHit: 40, completion: 3 }, isPeak(NOW)) }),
    ]);
    expect(seen.map((r) => r.turns.length)).toEqual([1, 2]);
    expect(await getSession(record.sessionId)).toEqual(saved);
    expect((api.bodies[0] as { messages: unknown }).messages).toEqual([
      ...record.imported,
      { role: 'latest_reminder', content: REMINDER },
      { role: 'user', content: 'next' },
    ]);
  });

  it('rejects a stale view without writing', async () => {
    const record = await seed([user('a')]);
    const api = fakeApi();
    const error = await run({ ...record, updatedAt: 0 }, { kind: 'send', text: 'b' }, api.fetchImpl).catch((e) => e);
    expect(error).toBeInstanceOf(StaleRecordError);
    expect((error as StaleRecordError).latest).toEqual(record);
    expect(api.bodies).toHaveLength(0);
  });

  it('keeps the partial reply when the stream breaks and retries it in place', async () => {
    const record = await seed();
    const api = fakeApi({ chunks: [event({ content: 'part' })], fail: true }, { chunks: complete('whole') });
    await expect(run(record, { kind: 'send', text: 'q' }, api.fetchImpl)).rejects.toThrow('network error');
    const broken = (await getSession(record.sessionId))!;
    expect(broken.turns).toEqual([sent('q'), assistant('part', { model: 'deepseek-flash', interrupted: true, finishStatus: 'incomplete' })]);
    expect(canRegenerate(broken.turns)).toBe(true);

    const { record: retried } = await run(broken, { kind: 'regenerate' }, api.fetchImpl);
    expect(retried.turns).toHaveLength(2);
    expect(retried.turns[1]).toMatchObject({ content: 'whole', interrupted: undefined });
    expect((api.bodies[1] as { messages: unknown[] }).messages.at(-1)).toEqual({ role: 'user', content: 'q' });
  });

  it('regenerates a completed reply and keeps the old one when nothing new arrives', async () => {
    const record = await seed([user('q'), assistant('old')]);
    const api = fakeApi({ chunks: [], fail: true }, { chunks: complete('new') });
    await expect(run(record, { kind: 'regenerate' }, api.fetchImpl)).rejects.toThrow();
    expect((await getSession(record.sessionId))!.turns).toEqual(record.turns);

    const { record: regenerated } = await run(record, { kind: 'regenerate' }, api.fetchImpl);
    expect(regenerated.turns.map((t) => t.content)).toEqual(['q', 'new']);
    expect((api.bodies[1] as { messages: unknown[] }).messages).toHaveLength(3);
  });

  it('answers an unanswered question when regenerating', async () => {
    const record = await seed([user('q')]);
    const api = fakeApi({ chunks: complete('a') });
    const { record: saved } = await run(record, { kind: 'regenerate' }, api.fetchImpl);
    expect(saved.turns.map((t) => t.content)).toEqual(['q', 'a']);
    expect(canRegenerate(saved.turns)).toBe(true);
  });

  it('edits the last question and replaces everything after it', async () => {
    const record = await seed([user('q1'), assistant('a1'), user('q2'), assistant('a2')]);
    const api = fakeApi({ chunks: complete('a2 edited') });
    const { record: saved } = await run(record, { kind: 'edit', targetIndex: 2, text: 'q2 edited' }, api.fetchImpl);
    expect(saved.turns.map((t) => t.content)).toEqual(['q1', 'a1', 'q2 edited', 'a2 edited']);
    expect((api.bodies[0] as { messages: { content: string }[] }).messages.map((m) => m.content))
      .toEqual(['synthetic q', 'synthetic a', 'q1', 'a1', REMINDER, 'q2 edited']);
  });

  it('preserves both rounds when a Q1 edit is submitted after another tab adds Q2', async () => {
    const editing = await seed([user('q1'), assistant('a1')]);
    const edit = { kind: 'edit', targetIndex: 0, text: 'q1 revised' } as const;
    const otherTab = fakeApi({ chunks: complete('a2') });
    const { record: refreshed } = await run(editing, { kind: 'send', text: 'q2' }, otherTab.fetchImpl);
    const api = fakeApi({ chunks: complete('replacement') });

    // Check both the edit-start version and a caller that refreshed its version but retained the draft.
    for (const view of [editing, refreshed]) {
      await expect(run(view, edit, api.fetchImpl)).rejects.toBeInstanceOf(StaleRecordError);
      expect(await getSession(editing.sessionId)).toEqual(refreshed);
      expect(api.bodies).toHaveLength(0);
    }
  });

  it.each<ChatAction>([{ kind: 'send', text: 'new' }, { kind: 'edit', targetIndex: 0, text: 'edit' }])(
    'preserves the record when $kind is already stopped before the first write', async (action) => {
      const record = await seed([user('q1'), assistant('a1')]);
      const api = fakeApi();
      const result = await run(record, action, api.fetchImpl, AbortSignal.abort());
      expect(result.record).toEqual(record);
      expect(await getSession(record.sessionId)).toEqual(record);
      expect(api.bodies).toHaveLength(0);
    },
  );

  it('saves what arrived when stopped and reports nothing else', async () => {
    const record = await seed();
    const controller = new AbortController();
    const api = fakeApi({ chunks: [event({ content: 'half' })], hang: true });
    const pending = runChat({
      sessionId: record.sessionId, expected: record, action: { kind: 'send', text: 'q' }, config,
      fetchImpl: api.fetchImpl, signal: controller.signal,
      onLive: () => controller.abort(),
    });
    const { record: saved, error } = await pending;
    expect(error).toBeUndefined();
    expect(saved.turns[1]).toMatchObject({ content: 'half', interrupted: true, finishStatus: 'aborted' });
  });

  it('reports an empty reply without saving an assistant turn', async () => {
    const record = await seed();
    const api = fakeApi({ chunks: [event({}, { finish_reason: 'stop' }), done] });
    const { record: saved, error } = await run(record, { kind: 'send', text: 'q' }, api.fetchImpl);
    expect(error).toBe('模型没有返回内容');
    expect(saved.turns).toEqual([sent('q')]);
  });

  it('refuses empty input and impossible actions', async () => {
    const empty = await seed();
    const api = fakeApi();
    await expect(run(empty, { kind: 'send', text: '  ' }, api.fetchImpl)).rejects.toThrow('消息为空');
    await expect(run(empty, { kind: 'edit', targetIndex: 0, text: 'x' }, api.fetchImpl)).rejects.toThrow('没有可以编辑的提问');
    await expect(run(empty, { kind: 'regenerate' }, api.fetchImpl)).rejects.toThrow('没有可以重新生成的回复');
    expect(api.bodies).toHaveLength(0);
  });

  it('sends attachments, saves tool results and uses flash when the chosen model cannot read files', async () => {
    const pic: Attachment = { id: 'a1', name: 'p.png', kind: 'image', bytes: 3, fileId: 'file-api-1', source: 'local' };
    const record = await seed([], ['file-api-1']);
    const calls = [{ index: 0, calls: [{ id: 'srvtoolu_1', signature: 'sig' }] }];
    const final = `data: ${JSON.stringify({ choices: [{ delta: { content: '', server_tool_calls: calls }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, server_tool_use: { tool_search: 2 } } })}\n\n`;
    const api = fakeApi({ chunks: [event({ content: 'seen' }), final, done] });
    const { record: saved } = await runChat({
      sessionId: record.sessionId, expected: record, action: { kind: 'send', text: '', attachments: [pic] },
      config: { ...config, model: 'deepseek-v4-pro', search: true }, fetchImpl: api.fetchImpl, now,
    });
    const body = api.bodies[0] as any;
    expect(body.model).toBe('deepseek-flash');
    expect(body.tools).toHaveLength(2);
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'file', file_id: 'file-api-1' }] });
    expect(saved.turns).toEqual([
      sent('', { attachments: [pic] }),
      assistant('seen', { model: 'deepseek-flash', usage: { prompt: 1, cacheHit: 0, completion: 1 },
        costYuan: actualCost('deepseek-flash', { prompt: 1, cacheHit: 0, completion: 1 }, isPeak(NOW)), serverToolCalls: calls, toolUse: { search: 2, fetch: 0, imageSearch: 0 } }),
    ]);
  });

  it('refuses attachments that were not uploaded for this conversation', async () => {
    const record = await seed([], ['file-api-1']);
    const api = fakeApi();
    const foreign: Attachment = { id: 'x', name: 'x.png', kind: 'image', bytes: 1, fileId: 'file-api-other', source: 'local' };
    await expect(run(record, { kind: 'send', text: 'q', attachments: [foreign] }, api.fetchImpl)).rejects.toThrow('附件不属于这条对话');
    expect(await getSession(record.sessionId)).toEqual(record);
  });

  it('keeps attachments on edit unless replaced, and reports the dropped ones', async () => {
    const a: Attachment = { id: 'a', name: 'a.png', kind: 'image', bytes: 1, fileId: 'file-a', source: 'local' };
    const b: Attachment = { id: 'b', name: 'b.pdf', kind: 'document', bytes: 1, fileId: 'file-b', source: 'local' };
    const record = await seed([{ ...user('q'), attachments: [a, b] }, assistant('r')], ['file-a', 'file-b']);
    const api = fakeApi({ chunks: complete('kept') }, { chunks: complete('dropped') });
    const kept = await run(record, { kind: 'edit', targetIndex: 0, text: 'q2' }, api.fetchImpl);
    expect(kept.record.turns[0]!.attachments).toEqual([a, b]);
    expect(kept.removedFileIds).toEqual([]);
    const dropped = await run(kept.record, { kind: 'edit', targetIndex: 0, text: 'q3', attachments: [a] }, api.fetchImpl);
    expect(dropped.record.turns[0]!.attachments).toEqual([a]);
    expect(dropped.removedFileIds).toEqual(['file-b']);
  });

  it.each(['末步', ''])('displays all reasoning and persists only %j for top-level replay', async (final) => {
    const record = await seed();
    const live: string[] = [];
    const steps = ['查', '读'];
    const calls = steps.map((reasoning_content, index) => ({ index, reasoning_content, calls: [{ signature: `sig${index}` }] }));
    const api = fakeApi({ chunks: [
      ...steps.flatMap((reasoning_content, step) => [event({ reasoning_content }),
        event({}, { server_tool_event: { type: 'step_reasoning_done', step } })]),
      ...Array.from(final, (reasoning_content) => event({ reasoning_content })),
      event({ content: 'a1', server_tool_calls: calls }, { finish_reason: 'stop' }), done,
    ] }, { chunks: complete('a2') });
    await runChat({ sessionId: record.sessionId, expected: record, action: { kind: 'send', text: 'q1' },
      config: { ...config, search: true, thinking: true, effort: 'max' }, fetchImpl: api.fetchImpl, now,
      onLive: (_, reasoning) => live.push(reasoning) });
    expect((api.bodies[0] as { reasoning_effort?: string }).reasoning_effort).toBe('max');
    expect(live.at(-1)).toBe('查读' + final);
    const saved = (await getSession(record.sessionId))!;
    expect(saved.turns[1]).toMatchObject({ reasoning: '查读' + final, replayReasoning: final, serverToolCalls: calls });
    await run(saved, { kind: 'send', text: 'q2' }, api.fetchImpl);
    expect((api.bodies[1] as { messages: unknown[] }).messages.at(-3)).toEqual({
      role: 'assistant', content: 'a1', reasoning_content: final, server_tool_calls: calls,
    });
  });

  it.each(['abort', 'EOF', 'error', 'error after reasoning'])('keeps the replay boundary on %s', async (ending) => {
    const record = await seed();
    const controller = new AbortController();
    const final = ending === 'error after reasoning' ? '未完' : '';
    const api = fakeApi({ chunks: [event({ reasoning_content: '查' }),
      event({}, { server_tool_event: { type: 'step_reasoning_done', step: 0 } }),
      ...(final ? [event({ reasoning_content: final, content: '部分正文' })] : []),
    ], fail: ending.startsWith('error') }, { chunks: complete('a2') });
    const pending = runChat({ sessionId: record.sessionId, expected: record, action: { kind: 'send', text: 'q1' },
      config: { ...config, search: true, thinking: true }, fetchImpl: api.fetchImpl, signal: controller.signal, now,
      onTool: () => { if (ending === 'abort') controller.abort(); } });
    if (ending.startsWith('error')) await expect(pending).rejects.toThrow('network error');
    else await pending;
    const saved = (await getSession(record.sessionId))!;
    expect(saved.turns[1]).toMatchObject({ reasoning: '查' + final, replayReasoning: final,
      interrupted: true, finishStatus: ending === 'abort' ? 'aborted' : 'incomplete' });
    await run(saved, { kind: 'send', text: 'q2' }, api.fetchImpl);
    const messages = (api.bodies[1] as { messages: unknown[] }).messages;
    if (final) expect(messages).toContainEqual({ role: 'assistant', content: '部分正文', reasoning_content: final });
    else expect(messages.slice(record.imported.length)).not.toContainEqual(expect.objectContaining({ role: 'assistant' }));
  });

  it('replays reasoning and tool calls of earlier replies in the next request', async () => {
    const calls = [{ index: 0, calls: [] }];
    const record = await seed([user('q1'), assistant('a1', { reasoning: 'r1', serverToolCalls: calls })]);
    const api = fakeApi({ chunks: complete('a2') });
    await run(record, { kind: 'send', text: 'q2' }, api.fetchImpl, undefined, { search: true });
    expect((api.bodies[0] as any).messages.slice(-3)).toEqual([
      { role: 'assistant', content: 'a1', reasoning_content: 'r1', server_tool_calls: calls },
      { role: 'latest_reminder', content: REMINDER },
      { role: 'user', content: 'q2' },
    ]);
  });
});
