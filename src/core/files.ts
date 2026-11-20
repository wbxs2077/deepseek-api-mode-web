// 附件的分类、上传用途和官网图片地址。依据 2026-11-20 的 API 文档（Files API、文件解析、图像理解）
// 和官网 file_feature 配置。

export type AttachmentKind = 'image' | 'document' | 'text';
export type FilePurpose = 'user_data' | 'text_recognition' | 'rich_layout_recognition';

/** 消息里的一个附件。fileId 为 null 表示内容带不过来，请求里只放文字占位。 */
export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  bytes: number;
  fileId: string | null;
  source: 'local' | 'official';
  /** 官网文件 ID，重新导入时用来复用已上传的图片。 */
  officialId?: string;
  /** 官网图片的临时地址，只在导入过程中存在，不写入本机记录。 */
  officialUrl?: string;
}

export const MiB = 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 20;
const IMAGE_LIMIT = 64 * MiB;
const DOCUMENT_LIMIT = 100 * MiB;
const TEXT_LIMIT = 32 * MiB;

const set = (list: string) => new Set(list.split(' '));
const NATIVE_IMAGES = set('jpg jpeg jfif pjpeg pjp jpe png apng gif webp');
// Chrome 能解码、API 不认的图片，在本地转成 PNG。
const CONVERTIBLE_IMAGES = set('bmp dib avif ico cur svg');
// API 只能对这些图片做文字识别。
const OCR_IMAGES = set('tif tiff');
// 官网接受（由服务端转换）、但 Chrome 无法解码的图片格式。
const UNSUPPORTED_IMAGES = set('svgz xbm avifs blp bufr bw dcx dds emf fit fits flc fli ftc ftu gbr grib h5 hdf hif icb icns ' +
  'iim im j2c j2k jp2 jpc jpf jpx mpeg mpg msp pbm pcd pcx pfm pgm pnm ppm psd pxr qoi ras rgb rgba sgi tga vda vst wmf xpm heic heif');
const LAYOUT_DOCUMENTS = set('pdf doc docx ppt pptx');
// 表格和电子书上传时由服务端转成 Markdown。
const CONVERTED_TEXT = set('xls xlsx epub mobi');

export type FilePlan =
  | { ok: true; kind: AttachmentKind; purpose: FilePurpose; maxBytes: number; convert: boolean }
  | { ok: false; reason: string };

export const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/**
 * 判断一个文件能否作为 API 附件，以及上传用途。accepted 是官网允许的扩展名（不含点），
 * 为空时不按官网清单过滤。
 */
export function planFile(name: string, accepted?: ReadonlySet<string>): FilePlan {
  const ext = extensionOf(name);
  if (!ext) return { ok: false, reason: '无法识别没有扩展名的文件' };
  if (NATIVE_IMAGES.has(ext)) return { ok: true, kind: 'image', purpose: 'user_data', maxBytes: IMAGE_LIMIT, convert: false };
  if (CONVERTIBLE_IMAGES.has(ext)) return { ok: true, kind: 'image', purpose: 'user_data', maxBytes: IMAGE_LIMIT, convert: true };
  if (OCR_IMAGES.has(ext)) return { ok: true, kind: 'document', purpose: 'text_recognition', maxBytes: DOCUMENT_LIMIT, convert: false };
  if (UNSUPPORTED_IMAGES.has(ext)) return { ok: false, reason: '这种图片格式暂不支持，请转换为 PNG 或 JPEG' };
  if (LAYOUT_DOCUMENTS.has(ext)) return { ok: true, kind: 'document', purpose: 'rich_layout_recognition', maxBytes: DOCUMENT_LIMIT, convert: false };
  if (accepted?.size && !accepted.has(ext)) return { ok: false, reason: '官网不支持这种文件格式' };
  return { ok: true, kind: 'text', purpose: 'user_data', maxBytes: CONVERTED_TEXT.has(ext) ? TEXT_LIMIT : TEXT_LIMIT, convert: false };
}

export const FILE_ID = /^[A-Za-z0-9_-]{1,200}$/;

const OFFICIAL_FILES_ORIGIN = 'https://files.deepseeksvc.com';
const OFFICIAL_FILES_PATH = '/api/file';

/**
 * 把 history_messages 里图片的 signed_path 换成官网显示用的地址。ty=p 是官网单图预览，
 * 2026-11-20 核对时是最大的可取尺寸（WebP）。不带 ty 的请求会失败。
 */
export function officialImageUrl(signedPath: unknown): string | undefined {
  if (typeof signedPath !== 'string' || !signedPath) return undefined;
  let source: URL;
  try {
    source = new URL(signedPath, 'https://chat.deepseek.com');
  } catch {
    return undefined;
  }
  const fileId = source.searchParams.get('file_id');
  const state = source.searchParams.get('state');
  if (!fileId || !state) return undefined;
  const url = new URL(OFFICIAL_FILES_PATH, OFFICIAL_FILES_ORIGIN);
  url.searchParams.set('file_id', fileId);
  url.searchParams.set('state', state);
  url.searchParams.set('ty', 'p');
  return url.href;
}

export function isOfficialImageUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const url = new URL(raw);
    return url.origin === OFFICIAL_FILES_ORIGIN && url.pathname === OFFICIAL_FILES_PATH && !url.username && !url.password;
  } catch {
    return false;
  }
}

export const placeholder = (a: Pick<Attachment, 'name' | 'kind'>) =>
  `[附件：${a.name || '未命名'}（${a.kind === 'image' ? '图片' : '文件'}），内容不可用]`;

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < MiB ? `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB` : `${(n / MiB).toFixed(n < 10 * MiB ? 1 : 0)} MB`;
