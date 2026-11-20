import { describe, expect, it } from 'vitest';
import { deleteFile, uploadFile } from '../src/core/client';
import { isOfficialImageUrl, officialImageUrl, planFile } from '../src/core/files';

describe('planFile', () => {
  it.each([
    ['photo.JPG', 'image', 'user_data', false],
    ['anim.webp', 'image', 'user_data', false],
    ['scan.bmp', 'image', 'user_data', true],
    ['logo.svg', 'image', 'user_data', true],
    ['icon.avif', 'image', 'user_data', true],
    ['fax.tiff', 'document', 'text_recognition', false],
    ['report.pdf', 'document', 'rich_layout_recognition', false],
    ['slides.PPTX', 'document', 'rich_layout_recognition', false],
    ['letter.doc', 'document', 'rich_layout_recognition', false],
    ['sheet.xlsx', 'text', 'user_data', false],
    ['book.epub', 'text', 'user_data', false],
    ['main.py', 'text', 'user_data', false],
    ['notes.md', 'text', 'user_data', false],
  ])('plans %s as %s / %s', (name, kind, purpose, convert) => {
    expect(planFile(name)).toMatchObject({ ok: true, kind, purpose, convert });
  });

  it('rejects formats that neither Chrome nor the API can read', () => {
    expect(planFile('layers.psd')).toMatchObject({ ok: false });
    expect(planFile('phone.HEIC')).toMatchObject({ ok: false });
    expect(planFile('noext')).toMatchObject({ ok: false });
  });

  it('applies the official extension list only to formats it does not handle itself', () => {
    const accepted = new Set(['py', 'pdf']);
    expect(planFile('main.py', accepted)).toMatchObject({ ok: true });
    expect(planFile('archive.zip', accepted)).toMatchObject({ ok: false, reason: '官网不支持这种文件格式' });
    expect(planFile('photo.png', accepted)).toMatchObject({ ok: true });
  });

  it('uses the size limits of the Files API', () => {
    const limit = (name: string) => (planFile(name) as { maxBytes: number }).maxBytes / 1024 / 1024;
    expect([limit('a.png'), limit('a.pdf'), limit('a.txt'), limit('a.xlsx')]).toEqual([64, 100, 32, 32]);
  });
});

describe('official image addresses', () => {
  it('rewrites signed_path to the preview on files.deepseeksvc.com', () => {
    expect(officialImageUrl('https://chat.deepseek.com/file?file_id=abc&state=s%2Bt'))
      .toBe('https://files.deepseeksvc.com/api/file?file_id=abc&state=s%2Bt&ty=p');
    expect(officialImageUrl('/file?file_id=abc&state=x')).toBe('https://files.deepseeksvc.com/api/file?file_id=abc&state=x&ty=p');
  });

  it.each([undefined, '', 'https://chat.deepseek.com/file?file_id=abc', 'not a url ::'])('ignores %s', (path) => {
    expect(officialImageUrl(path)).toBeUndefined();
  });

  it('accepts only the official file endpoint', () => {
    expect(isOfficialImageUrl('https://files.deepseeksvc.com/api/file?file_id=a&state=b&ty=p')).toBe(true);
    expect(isOfficialImageUrl('https://files.deepseeksvc.com.evil.test/api/file')).toBe(false);
    expect(isOfficialImageUrl('https://files.deepseeksvc.com/other')).toBe(false);
    expect(isOfficialImageUrl('https://user:pw@files.deepseeksvc.com/api/file')).toBe(false);
  });
});

describe('Files API client', () => {
  it('uploads with purpose before file and returns the id', async () => {
    let body: FormData | undefined;
    let headers: Record<string, string> = {};
    const id = await uploadFile({
      apiKey: 'sk-test',
      file: new Blob(['synthetic'], { type: 'text/plain' }),
      name: 'a.txt',
      purpose: 'user_data',
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe('https://api.deepseek.com/files');
        body = init!.body as FormData;
        headers = init!.headers as Record<string, string>;
        return Response.json({ id: 'file-api-0123', object: 'file' });
      },
    });
    expect(id).toBe('file-api-0123');
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect([...body!.keys()]).toEqual(['purpose', 'file']);
    expect((body!.get('file') as File).name).toBe('a.txt');
  });

  it('turns HTTP errors and malformed ids into readable errors', async () => {
    const upload = (res: Response) => uploadFile({ apiKey: 'k', file: new Blob(['x']), name: 'a.pdf', purpose: 'rich_layout_recognition', fetchImpl: async () => res });
    await expect(upload(Response.json({ error: { message: 'too big' } }, { status: 413 }))).rejects.toThrow('文件过大：too big');
    await expect(upload(Response.json({ id: '../evil' }))).rejects.toThrow('文件 ID');
  });

  it('treats a missing file as deleted and refuses odd ids', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      seen.push(`${init!.method} ${url}`);
      return new Response(null, { status: url.toString().endsWith('gone') ? 404 : 500 });
    };
    expect(await deleteFile('k', 'file-gone', fetchImpl)).toBe(true);
    expect(await deleteFile('k', 'file-err', fetchImpl)).toBe(false);
    expect(await deleteFile('k', '../x', fetchImpl)).toBe(false);
    expect(seen).toEqual(['DELETE https://api.deepseek.com/files/file-gone', 'DELETE https://api.deepseek.com/files/file-err']);
  });
});
