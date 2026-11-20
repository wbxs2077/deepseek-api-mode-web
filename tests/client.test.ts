import { describe, expect, it } from 'vitest';
import { ApiError, streamChat } from '../src/core/client';
import { createSseParser } from '../src/core/sse';

const event = (delta: object, extra: object = {}) =>
  `data: ${JSON.stringify({ choices: [{ delta, ...extra }] })}\n\n`;

function sseResponse(chunks: string[], signal?: AbortSignal, hang = false): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (!hang) controller.close();
      signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    },
  });
  return new Response(body, { status: 200 });
}

const done = 'data: [DONE]\n\n';

const base = { apiKey: 'sk-test', model: 'deepseek-flash', thinking: true, messages: [{ role: 'user' as const, content: 'hi' }] };

describe('createSseParser', () => {
  it('reassembles lines split at arbitrary positions', () => {
    const seen: string[] = [];
    const p = createSseParser((d) => seen.push(d));
    const text = 'data: {"a":1}\r\n\r\n: comment\ndata: {"b":"多字节"}\n\ndata: [DONE]';
    for (const ch of text) p.feed(ch);
    p.end();
    expect(seen).toEqual(['{"a":1}', '{"b":"多字节"}', '[DONE]']);
  });
});

describe('streamChat', () => {
  it('sends the expected request and accumulates text, reasoning and usage', async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const deltas: string[] = [];
    const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 80, completion_tokens: 7 } })}\n\n`;
    const result = await streamChat({
      ...base,
      onDelta: (text, reasoning) => deltas.push(`${reasoning}|${text}`),
      fetchImpl: async (url, init) => {
        request = { url: String(url), init: init! };
        return sseResponse([
          event({ reasoning_content: '想' }),
          event({ content: '你' }) + event({ content: '好' }, { finish_reason: 'stop' }),
          usage,
          done,
        ]);
      },
    });

    expect(request!.url).toBe('https://api.deepseek.com/chat/completions');
    expect((request!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(request!.init.body as string)).toEqual({
      model: 'deepseek-flash',
      messages: base.messages,
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'enabled' },
    });
    expect(result).toEqual({
      text: '你好', reasoning: '想', replayReasoning: '想', finish: 'stop', aborted: false, status: 'complete',
      usage: { prompt: 100, cacheHit: 80, completion: 7 },
      serverToolCalls: null, annotations: [], toolUse: null,
    });
    expect(deltas).toEqual(['想|', '想|你', '想|你好']);
  });

  it.each([
    { name: 'EOF mid-reply', finish: null, terminator: '' },
    { name: 'stop followed by EOF', finish: 'stop', terminator: '' },
    { name: '[DONE] without stop', finish: null, terminator: done },
    { name: 'unknown finish reason', finish: 'tool_calls', terminator: done },
  ])('keeps partial text after $name', async ({ finish, terminator }) => {
    const partial = event({ content: 'partial', reasoning_content: 'thought' }, { finish_reason: finish });
    const result = await streamChat({ ...base, fetchImpl: async () => sseResponse([partial, terminator]) });
    expect(result).toMatchObject({ text: 'partial', reasoning: 'thought', finish, aborted: false, status: 'incomplete' });
  });

  it.each([
    ['length', true],
    ['length', false],
    ['content_filter', true],
    ['content_filter', false],
  ])('returns %s with finishing content ([DONE] received: %s)', async (finish, includeDone) => {
    const result = await streamChat({
      ...base,
      fetchImpl: async () => sseResponse([
        event({ content: 'partial ' }),
        event({ content: 'reply' }, { finish_reason: finish }),
        includeDone ? done : '',
      ]),
    });
    expect(result).toMatchObject({ text: 'partial reply', finish, aborted: false, status: finish });
  });

  it('sends max_tokens only when requested', async () => {
    await streamChat({
      ...base,
      maxTokens: 1024,
      fetchImpl: async (_, init) => {
        expect(JSON.parse(init!.body as string)).toMatchObject({ max_tokens: 1024 });
        return sseResponse([event({}, { finish_reason: 'stop' }), done]);
      },
    });
  });

  it('returns previously parsed text if EOF cuts the final JSON line short', async () => {
    const result = await streamChat({
      ...base,
      fetchImpl: async () => sseResponse([event({ content: 'partial' }), 'data: {"choices":']),
    });
    expect(result).toMatchObject({ text: 'partial', finish: null, aborted: false, status: 'incomplete' });
  });

  it('rejects a malformed data line and leaves the last onDelta available to the caller', async () => {
    const response = sseResponse([event({ content: 'partial' }), 'data: {"choices":\n\n'], undefined, true);
    const deltas: string[] = [];
    await expect(streamChat({
      ...base,
      onDelta: (text) => deltas.push(text),
      fetchImpl: async () => response,
    })).rejects.toBeInstanceOf(SyntaxError);
    expect(deltas).toEqual(['partial']);
    expect(response.body!.locked).toBe(false);
  });

  it('rejects an error in a successful HTTP response', async () => {
    const response = sseResponse(['data: {"error":{"message":"stream failed"}}\n\n']);
    await expect(streamChat({ ...base, fetchImpl: async () => response })).rejects.toThrow('stream failed');
  });

  it('cancels and releases the reader at [DONE] even if the stream stays open', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunks = event({ content: 'reply' }, { finish_reason: 'stop' }) + done + 'data: invalid\n\n';
        controller.enqueue(new TextEncoder().encode(chunks));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await streamChat({ ...base, fetchImpl: async () => new Response(body) });
    expect(result).toMatchObject({ text: 'reply', finish: 'stop', status: 'complete' });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it('rejects a read error after delivering the previous delta and releases the reader', async () => {
    const failure = new TypeError('stream disconnected');
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        controller.enqueue(new TextEncoder().encode(event({ content: 'partial' })));
      },
    });
    const deltas: string[] = [];
    await expect(streamChat({
      ...base,
      onDelta: (text) => {
        deltas.push(text);
        controller.error(failure);
      },
      fetchImpl: async () => new Response(body),
    })).rejects.toBe(failure);
    expect(deltas).toEqual(['partial']);
    expect(body.locked).toBe(false);
  });

  it('decodes a multi-byte character split across network chunks', async () => {
    const bytes = new TextEncoder().encode(event({ content: '好' }));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const cut = bytes.indexOf(0xe5) + 1; // 「好」的第一个字节之后
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    const result = await streamChat({ ...base, fetchImpl: async () => new Response(body) });
    expect(result.text).toBe('好');
  });

  it('keeps the partial reply when aborted mid-stream', async () => {
    const ac = new AbortController();
    const result = await streamChat({
      ...base,
      signal: ac.signal,
      onDelta: () => ac.abort(),
      fetchImpl: async () => sseResponse([event({ content: '半句' })], ac.signal, true),
    });
    expect(result).toMatchObject({ text: '半句', aborted: true, finish: null, status: 'aborted' });
  });

  it.each([
    [401, 'API Key 无效'],
    [402, 'API 余额不足'],
    [429, '限流'],
    [500, 'HTTP 500'],
  ])('maps HTTP %i to a readable error', async (status, text) => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: 'detail-from-server' } }), { status });
    const err = await streamChat({ ...base, fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(status);
    expect(err.message).toContain(text);
    expect(err.message).toContain('detail-from-server');
  });

  it('rethrows network failures that are not a cancel', async () => {
    const fetchImpl = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(streamChat({ ...base, fetchImpl })).rejects.toThrow('Failed to fetch');
  });
});

describe('streamChat with web tools', () => {
  it('declares both tools, reports tool progress, and keeps calls, citations and tool usage', async () => {
    let body: any;
    const tools: unknown[] = [];
    const calls = [{ index: 0, reasoning_content: '', calls: [{ index: 0, id: 'srvtoolu_s_00', type: 'deepseek_web_search', kind: 'search',
      action: { type: 'search', queries: ['合成查询'] }, status: 'completed', sources: [{ type: 'url', url: 'https://example.test/a', title: 'A' }] }] }];
    const chunk = (choice: object, extra: object = {}) => `data: ${JSON.stringify({ choices: [{ index: 0, ...choice }], ...extra })}\n\n`;
    const result = await streamChat({
      ...base,
      search: true,
      onTool: (e) => tools.push(e),
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init!.body as string);
        return sseResponse([
          chunk({ delta: {}, server_tool_event: { type: 'step_reasoning_done', step: 0 } }),
          chunk({ delta: {}, server_tool_event: { type: 'call_started', step: 0, call: { index: 0, kind: 'search', action: { type: 'search', queries: ['合成查询'] } } } }),
          chunk({ delta: {}, server_tool_event: { type: 'call_completed', step: 0, call: { index: 0, kind: 'search', status: 'completed' } } }),
          chunk({ delta: { content: '答案' } }),
          chunk({ delta: { content: '', server_tool_calls: calls, annotations: [
            { type: 'url_citation', url_citation: { url: 'https://example.test/a', title: '', start_index: 0, end_index: 2 } },
            { type: 'other' },
          ] }, finish_reason: 'stop' }, { usage: { prompt_tokens: 9, completion_tokens: 2, prompt_cache_hit_tokens: 0, server_tool_use: { tool_search: 1 } } }),
          done,
        ]);
      },
    });
    expect(body.tools).toEqual([{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }]);
    expect(tools).toEqual([
      { type: 'step_reasoning_done' },
      { type: 'call_started', kind: 'search', queries: ['合成查询'] },
      { type: 'call_completed', kind: 'search', status: 'completed' },
    ]);
    expect(result).toMatchObject({
      text: '答案', replayReasoning: '', status: 'complete', serverToolCalls: calls,
      annotations: [{ url: 'https://example.test/a', title: 'https://example.test/a', start: 0, end: 2 }],
      toolUse: { search: 1, fetch: 0, imageSearch: 0 },
    });
  });

  it('omits tools when search is off', async () => {
    await streamChat({
      ...base,
      fetchImpl: async (_url, init) => {
        expect(JSON.parse(init!.body as string)).not.toHaveProperty('tools');
        return sseResponse([event({}, { finish_reason: 'stop' }), done]);
      },
    });
  });

  it.each(['insufficient_system_resource', 'aborted'])('marks finish reason %s as interrupted', async (finish) => {
    const result = await streamChat({ ...base, fetchImpl: async () => sseResponse([event({ content: 'x' }, { finish_reason: finish }), done]) });
    expect(result.status).toBe('incomplete');
  });
});
