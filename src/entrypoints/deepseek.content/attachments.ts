import { browser } from 'wxt/browser';
import { MAX_FILES_PER_MESSAGE, planFile, type Attachment } from '../../core/files';
import { UPLOAD_CHUNK, UPLOAD_PORT, type UploadPortIn, type UploadPortOut } from '../../protocol';

// 官网把每种模式的附件配置缓存在 localStorage，2026-11-20 核对的结构为
// { model_configs: { value: [{ model_type, file_feature: { max_input_file_count, max_upload_file_size, support_file_exts } }] } }，
// 外层可能被序列化多次。读不到时只按扩展自身的规则判断。
const FEATURE_KEY = '__ds_remote_feature_store_model';

export interface FileLimits {
  maxCount: number;
  /** 官网允许的扩展名（不含点）。为空表示不按官网清单过滤。 */
  accepted: Set<string>;
}

function findModelConfigs(value: unknown, depth = 0): unknown[] | null {
  if (depth > 6 || value == null) return null;
  if (typeof value === 'string') {
    if (!value.includes('model_configs') && !value.includes('file_feature')) return null;
    try {
      return findModelConfigs(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) return value.some((v) => typeof v === 'object' && v && 'file_feature' in v) ? value : null;
  if (typeof value !== 'object') return null;
  for (const [key, inner] of Object.entries(value)) {
    const found = key === 'model_configs' ? findModelConfigs(inner, depth + 1) ?? findModelConfigs((inner as { value?: unknown })?.value, depth + 1)
      : findModelConfigs(inner, depth + 1);
    if (found) return found;
  }
  return null;
}

export function readLimits(storage: Pick<Storage, 'getItem'> = localStorage): FileLimits {
  const limits: FileLimits = { maxCount: MAX_FILES_PER_MESSAGE, accepted: new Set() };
  try {
    const configs = findModelConfigs(storage.getItem(FEATURE_KEY)) as { is_default?: boolean; file_feature?: Record<string, unknown> }[] | null;
    const feature = (configs?.find((c) => c.is_default) ?? configs?.[0])?.file_feature;
    if (!feature) return limits;
    if (typeof feature.max_input_file_count === 'number' && feature.max_input_file_count > 0) {
      limits.maxCount = Math.min(feature.max_input_file_count, MAX_FILES_PER_MESSAGE);
    }
    if (Array.isArray(feature.support_file_exts)) {
      for (const ext of feature.support_file_exts) if (typeof ext === 'string' && ext) limits.accepted.add(ext.toLowerCase());
    }
  } catch {}
  return limits;
}

export const acceptAttribute = (limits: FileLimits) => [...limits.accepted].map((ext) => `.${ext}`).join(',');

/** 编辑框里的一个附件。existing 表示来自正在编辑的提问，移除时不立即删除远端文件。 */
export interface DraftFile {
  key: string;
  name: string;
  size: number;
  kind: Attachment['kind'];
  state: 'uploading' | 'parsing' | 'ready' | 'failed';
  progress: number;
  attachment?: Attachment;
  error?: string;
  existing?: boolean;
  file?: File;
  cancel?: () => void;
}

export type Prepared = { ok: true; file: File; uploadName: string; kind: Attachment['kind'] } | { ok: false; name: string; reason: string };

// Chrome 能解码、API 不认的图片转成 PNG。SVG 不能用 createImageBitmap 直接解码，改用 <img>。
async function toPng(file: File): Promise<File> {
  let source: ImageBitmap | HTMLImageElement;
  try {
    source = await createImageBitmap(file);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      source = img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const width = 'naturalWidth' in source ? source.naturalWidth : source.width;
  const height = 'naturalHeight' in source ? source.naturalHeight : source.height;
  if (!width || !height) throw new Error('图片尺寸无效');
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.drawImage(source, 0, 0);
  if ('close' in source) source.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new File([blob], file.name.replace(/\.[^.]*$/, '') + '.png', { type: 'image/png' });
}

export async function prepareFile(file: File, limits: FileLimits): Promise<Prepared> {
  const plan = planFile(file.name, limits.accepted);
  if (!plan.ok) return { ok: false, name: file.name, reason: plan.reason };
  if (!file.size) return { ok: false, name: file.name, reason: '文件是空的' };
  if (plan.convert) {
    try {
      const png = await toPng(file);
      if (png.size > plan.maxBytes) return { ok: false, name: file.name, reason: '转换后的图片太大' };
      return { ok: true, file: png, uploadName: png.name, kind: 'image' };
    } catch {
      return { ok: false, name: file.name, reason: '无法读取这张图片，请转换为 PNG 或 JPEG' };
    }
  }
  if (file.size > plan.maxBytes) return { ok: false, name: file.name, reason: `超过 ${plan.maxBytes / 1024 / 1024} MB 上限` };
  return { ok: true, file, uploadName: file.name, kind: plan.kind };
}

function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export interface UploadHandle {
  done: Promise<Attachment>;
  cancel: () => void;
}

/** 经 background 上传一个文件。onState 报告进度（0–1）和文档解析阶段。 */
export function uploadThroughExtension(
  sessionId: string,
  displayName: string,
  prepared: Extract<Prepared, { ok: true }>,
  onState: (state: 'uploading' | 'parsing', progress: number) => void,
): UploadHandle {
  let cancel!: () => void;
  const done = new Promise<Attachment>((resolve, reject) => {
    let port: ReturnType<typeof browser.runtime.connect> | null = null;
    let settled = false;
    const finish = (result: Attachment | Error) => {
      if (settled) return;
      settled = true;
      if (result instanceof Error) {
        reject(result);
        try { port?.disconnect(); } catch { /* 端口可能已失效 */ }
      } else {
        resolve(result);
      }
    };
    const fail = (message: string) => finish(new Error(message));
    cancel = () => fail('已取消上传');
    void prepared.file.arrayBuffer().then((buffer) => {
      if (settled) return;
      const bytes = new Uint8Array(buffer);
      let offset = 0;
      try {
        port = browser.runtime.connect({ name: UPLOAD_PORT });
      } catch {
        return fail('扩展没有响应，请刷新页面');
      }
      const post = (message: UploadPortIn) => {
        if (settled) return;
        try {
          port!.postMessage(message);
        } catch {
          fail('与扩展的连接已断开，请刷新页面');
        }
      };
      port.onMessage.addListener((message: UploadPortOut) => {
        if (settled) return;
        if (message.type === 'next') {
          if (offset >= bytes.length) {
            post({ type: 'end' });
            return;
          }
          const chunk = bytes.subarray(offset, offset + UPLOAD_CHUNK);
          offset += chunk.length;
          onState('uploading', offset / bytes.length);
          post({ type: 'chunk', data: toBase64(chunk) });
        } else if (message.type === 'parsing') {
          onState('parsing', 1);
        } else if (message.type === 'done') {
          finish(message.attachment);
        } else if (message.type === 'error') {
          fail(message.error);
        }
      });
      port.onDisconnect.addListener(() => fail('上传中断'));
      post({ type: 'begin', sessionId, name: displayName, uploadName: prepared.uploadName, size: bytes.length, mime: prepared.file.type });
    }, () => fail('无法读取文件'));
  });
  return { done, cancel };
}

/** 并发上限，避免同时上传过多文档（官网账号同时解析上限为 15）。 */
export function limiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T,>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}
