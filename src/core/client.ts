import { FILE_ID, type FilePurpose } from './files';
import { createSseParser } from './sse';

export const API_BASE = 'https://api.deepseek.com';
export const MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;
/** 图片、文件和联网工具只适用的模型。 */
export const FLASH_MODEL = 'deepseek-flash';

/** 思考强度。只在开启深度思考时作为 reasoning_effort 发送。 */
export const EFFORTS = ['low', 'high', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
export const isEffort = (value: unknown): value is Effort => EFFORTS.some((candidate) => candidate === value);

export interface Usage {
  prompt: number;
  cacheHit: number;
  completion: number;
}

/** usage.server_tool_use 中的计数。 */
export interface ToolUse {
  search: number;
  fetch: number;
  imageSearch: number;
}

/** message.annotations 中的引用。start / end 按 content 的 Unicode 码点计数。 */
export interface Annotation {
  url: string;
  title: string;
  start: number;
  end: number;
}

/** 流式输出中的 server_tool_event，只保留显示进度所需的字段。 */
export interface ToolEvent {
  type: 'step_reasoning_done' | 'call_started' | 'call_completed';
  kind?: string;
  queries?: string[];
  url?: string;
  status?: string;
}

export type ChatStatus = 'complete' | 'aborted' | 'incomplete' | 'length' | 'content_filter';

export interface ChatResult {
  text: string;
  reasoning: string;
  /** 末步思考。空串表示该步没有思考，未开启思考时可省略。 */
  replayReasoning?: string;
  finish: string | null;
  usage: Usage | null;
  aborted: boolean;
  status: ChatStatus;
  serverToolCalls: unknown[] | null;
  annotations: Annotation[];
  toolUse: ToolUse | null;
}

/** 请求里的消息。latest_reminder 是 DeepSeek 扩展角色。 */
export type WireMessage =
  | { role: 'latest_reminder'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string; reasoning_content?: string; server_tool_calls?: unknown[] };

export type ContentPart = { type: 'text'; text: string } | { type: 'file'; file_id: string };

export interface ChatOptions {
  apiKey: string;
  model: string;
  thinking: boolean;
  messages: WireMessage[];
  /** 声明 deepseek_web_search 和 deepseek_read_url。 */
  search?: boolean;
  maxTokens?: number;
  /** 只在 thinking 为 true 时发送。 */
  effort?: Effort;
  signal?: AbortSignal;
  /** 正文与全程思考的累计值，供前端显示。 */
  onDelta?: (text: string, reasoning: string) => void;
  /** 流抛错前交付已解析的状态，包括最后一个纯工具事件。 */
  onStreamError?: (partial: Readonly<ChatResult>) => Promise<void>;
  onTool?: (event: ToolEvent) => void;
  fetchImpl?: typeof fetch;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function describe(status: number, detail: string): string {
  const known: Record<number, string> = {
    401: 'API Key 无效',
    402: 'API 余额不足',
    408: '上传超时',
    413: '文件过大',
    429: '触发了 API 限流，请稍后再试',
    504: '文件解析超时',
  };
  return (known[status] ?? `DeepSeek API 返回 HTTP ${status}`) + (detail ? `：${detail}` : '');
}

async function failure(res: Response) {
  let detail = '';
  try {
    detail = (await res.json())?.error?.message ?? '';
  } catch {}
  return new ApiError(res.status, describe(res.status, detail));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function readAnnotations(raw: unknown): Annotation[] {
  if (!Array.isArray(raw)) return [];
  const out: Annotation[] = [];
  for (const a of raw) {
    const c = isObject(a) && a.type === 'url_citation' && isObject(a.url_citation) ? a.url_citation : null;
    if (!c || typeof c.url !== 'string' || !Number.isInteger(c.start_index) || !Number.isInteger(c.end_index)) continue;
    out.push({ url: c.url, title: typeof c.title === 'string' && c.title ? c.title : c.url, start: c.start_index as number, end: c.end_index as number });
  }
  return out;
}

function readToolEvent(raw: unknown): ToolEvent | null {
  if (!isObject(raw) || typeof raw.type !== 'string') return null;
  if (raw.type !== 'step_reasoning_done' && raw.type !== 'call_started' && raw.type !== 'call_completed') return null;
  const call = isObject(raw.call) ? raw.call : raw;
  const action = isObject(call.action) ? call.action : {};
  return {
    type: raw.type,
    ...(typeof call.kind === 'string' && { kind: call.kind }),
    ...(Array.isArray(action.queries) && { queries: action.queries.filter((q): q is string => typeof q === 'string') }),
    ...(typeof action.url === 'string' && { url: action.url }),
    ...(typeof call.status === 'string' && { status: call.status }),
  };
}

// 流式调用 /chat/completions。取消时返回已收到的部分（aborted=true）。
export async function streamChat(opts: ChatOptions): Promise<ChatResult> {
  const result: ChatResult = {
    text: '', reasoning: '', finish: null, usage: null, aborted: false, status: 'incomplete',
    ...(opts.thinking && { replayReasoning: '' }),
    serverToolCalls: null, annotations: [], toolUse: null,
  };
  let sawDone = false;
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      signal: opts.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        ...(opts.maxTokens === undefined ? {} : { max_tokens: opts.maxTokens }),
        stream: true,
        stream_options: { include_usage: true },
        thinking: { type: opts.thinking ? 'enabled' : 'disabled' },
        ...(opts.thinking && opts.effort && { reasoning_effort: opts.effort }),
        ...(opts.search && { tools: [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }] }),
      }),
    });
    if (!res.ok || !res.body) throw await failure(res);

    const parser = createSseParser((data, atEof) => {
      if (!data || sawDone || opts.signal?.aborted) return;
      if (data === '[DONE]') {
        sawDone = true;
        return;
      }

      let event;
      try {
        event = JSON.parse(data);
      } catch (error) {
        // The connection may have ended partway through its last data line.
        if (atEof && error instanceof SyntaxError) return;
        throw error;
      }
      if (!isObject(event)) throw new Error('DeepSeek API returned an invalid stream event');
      if (event.error) {
        const detail = isObject(event.error) && typeof event.error.message === 'string' ? event.error.message : 'Unknown stream error';
        throw new Error(`DeepSeek API: ${detail}`);
      }

      const choice = Array.isArray(event.choices) && isObject(event.choices[0]) ? event.choices[0] : null;
      const delta = choice && isObject(choice.delta) ? choice.delta : null;
      const text = typeof delta?.content === 'string' ? delta.content : '';
      const reasoning = typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : '';
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason) result.finish = choice.finish_reason;
      const tool = readToolEvent(choice?.server_tool_event ?? delta?.server_tool_event);
      result.text += text;
      result.reasoning += reasoning;
      if (reasoning) result.replayReasoning = (result.replayReasoning ?? '') + reasoning;
      if (tool?.type === 'step_reasoning_done' && result.replayReasoning !== undefined) {
        result.replayReasoning = '';
      }
      if (Array.isArray(delta?.server_tool_calls)) result.serverToolCalls = delta.server_tool_calls;
      if (Array.isArray(delta?.annotations)) result.annotations = readAnnotations(delta.annotations);
      if (isObject(event.usage)) {
        const usage = event.usage;
        result.usage = {
          prompt: count(usage.prompt_tokens),
          cacheHit: count(usage.prompt_cache_hit_tokens),
          completion: count(usage.completion_tokens),
        };
        if (isObject(usage.server_tool_use)) {
          const t = usage.server_tool_use;
          result.toolUse = { search: count(t.tool_search), fetch: count(t.tool_fetch), imageSearch: count(t.tool_image_search) };
        }
      }
      if (tool) opts.onTool?.(tool);
      if (text || reasoning) opts.onDelta?.(result.text, result.reasoning);
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const cancelReader = () => {
      // A failed or slow cancellation must not replace the result or stream error.
      void reader.cancel().catch(() => {});
    };
    opts.signal?.addEventListener('abort', cancelReader, { once: true });
    try {
      while (!sawDone && !opts.signal?.aborted) {
        const { done, value } = await reader.read();
        if (opts.signal?.aborted) break;
        if (done) {
          parser.feed(decoder.decode());
          parser.end();
          break;
        }
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } finally {
      opts.signal?.removeEventListener('abort', cancelReader);
      cancelReader();
      reader.releaseLock();
    }
  } catch (error) {
    const signal = opts.signal;
    if (!signal?.aborted || (error !== signal.reason && !(error instanceof Error && error.name === 'AbortError'))) {
      await opts.onStreamError?.(result);
      throw error;
    }
  }

  if (opts.signal?.aborted) {
    result.aborted = true;
    result.status = 'aborted';
  } else if (result.finish === 'length' || result.finish === 'content_filter') {
    result.status = result.finish;
  } else if (sawDone && result.finish === 'stop') {
    result.status = 'complete';
  }
  // insufficient_system_resource、aborted 等其他结束原因按回复中断处理。
  return result;
}

export interface UploadOptions {
  apiKey: string;
  file: Blob;
  name: string;
  purpose: FilePurpose;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

// 上传一个文件并返回 file_id。文档在服务端解析完成后才返回。
export async function uploadFile(opts: UploadOptions): Promise<string> {
  const form = new FormData();
  // 文档上传要求 purpose 在 file 之前。
  form.append('purpose', opts.purpose);
  form.append('file', opts.file, opts.name);
  const res = await (opts.fetchImpl ?? fetch)(`${API_BASE}/files`, {
    method: 'POST',
    signal: opts.signal,
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    body: form,
  });
  if (!res.ok) throw await failure(res);
  const id = (await res.json())?.id;
  if (typeof id !== 'string' || !FILE_ID.test(id)) throw new Error('上传返回的文件 ID 无法识别');
  return id;
}

/** 删除 API 账号里的文件。已经不存在（404）也算成功。 */
/** GET /user/balance 的摘要：各币种总余额，例如「¥110.00」，多个币种用「 / 」连接。 */
export interface Balance {
  available: boolean;
  total: string;
}

export async function getBalance(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<Balance> {
  const res = await fetchImpl(`${API_BASE}/user/balance`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
  if (!res.ok) throw await failure(res);
  return parseBalance(await res.json());
}

export function parseBalance(json: unknown): Balance {
  const infos = isObject(json) && Array.isArray(json.balance_infos) ? json.balance_infos : [];
  const parts = infos.filter(isObject).map((info) => {
    const currency = typeof info.currency === 'string' ? info.currency : '';
    const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `;
    return `${symbol}${typeof info.total_balance === 'string' ? info.total_balance : '—'}`;
  });
  return { available: isObject(json) && json.is_available === true, total: parts.length ? parts.join(' / ') : '无余额信息' };
}

export async function deleteFile(apiKey: string, fileId: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!FILE_ID.test(fileId)) return false;
  try {
    const res = await fetchImpl(`${API_BASE}/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}
