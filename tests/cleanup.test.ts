import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, expect, it, vi } from 'vitest';
import { adoptUpload, retryCleanup, uploadKeyTag } from '../src/core/cleanup';
import { appendTurn, attachImportedFile, cleanupCount, createSession, deleteSession, getSession, pendingUploads,
  registerUploads, reimportSession, releaseUploads, replaceTurns, type SessionRecord } from '../src/core/store';

const session = (sessionId: string): SessionRecord => ({ sessionId, importedAt: 1, updatedAt: 1, title: 'Synthetic',
  leafId: null, officialTokens: null, skippedFiles: 0, hasBranches: false, imported: [], turns: [] });
const key = 'synthetic-upload-credential';
const draft = { tabId: 12, documentId: 'original-document' };
const image = (fileId: string) => ({ id: fileId, name: 'fixture.png', kind: 'image' as const, bytes: 1, fileId, source: 'local' as const });
const register = async (sessionId: string, fileId: string) => {
  const keyTag = await uploadKeyTag(key);
  return adoptUpload(sessionId, fileId, keyTag, () => registerUploads(sessionId, [fileId], { keyTag, draft }, 1));
};
const ok = () => Promise.resolve(Response.json({ deleted: true }));

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  let tail: Promise<unknown> = Promise.resolve();
  vi.stubGlobal('navigator', { locks: { request: (_name: string, action: () => Promise<unknown>) => {
    const result = tail.then(action);
    tail = result.catch(() => undefined);
    return result;
  } } });
});

it('persists a failed delete independently of the conversation and retries only with the upload credential', async () => {
  await createSession(session('A'));
  await register('A', 'file-deleted-session');
  expect(await cleanupCount()).toBe(0);
  await deleteSession('A', 1, 1);
  expect(await getSession('A')).toBeUndefined();
  const fail = vi.fn(async () => new Response(null, { status: 503 }));
  expect(await retryCleanup(key, { sessionId: 'A' }, fail)).toBe(1);
  const send = vi.fn(ok);
  expect(await retryCleanup('', undefined, send)).toBe(1);
  expect(await retryCleanup('second-synthetic-credential', undefined, send)).toBe(1);
  expect(send).not.toHaveBeenCalled();
  expect(JSON.stringify(await pendingUploads())).not.toContain(key);
  await Promise.all([retryCleanup(key, undefined, send), retryCleanup(key, undefined, send)]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(await cleanupCount()).toBe(0);
});

it.each([
  () => Promise.reject(new Error('offline')),
  async () => new Response(null, { status: 404 }),
  async () => new Response(null, { status: 204 }),
  async () => Response.json({ deleted: false }),
  async () => Response.json({ deleted: true, id: 'different-file' }),
])('keeps the ID when the remote response fails to confirm deletion', async fetchImpl => {
  expect(await register('missing', 'file-orphan')).toBe(false);
  expect(await retryCleanup(key, undefined, fetchImpl)).toBe(1);
  expect((await pendingUploads())[0]?.sessionId.at(-1)).toBe('file-orphan');
});

it('keeps the server receipt if persisting a successful upload into the conversation fails', async () => {
  await expect(adoptUpload('A', 'file-orphan', await uploadKeyTag(key), async () => { throw Error('write aborted'); })).rejects.toThrow();
  expect(await cleanupCount()).toBe(1);
  expect(await retryCleanup(key, undefined, ok)).toBe(0);
});

it('rejects a stale attachment after release, and preserves references across other sessions and reimports', async () => {
  await createSession(session('A'));
  await register('A', 'file-shared');
  await createSession({ ...session('B'), turns: [{ role: 'user', content: 'keep', attachments: [image('file-shared')] }] });
  expect(await releaseUploads('A', ['file-shared'], draft)).toEqual(['file-shared']);
  expect(await appendTurn('A', 1, { role: 'user', content: '', attachments: [image('file-shared')] })).toBeUndefined();
  const send = vi.fn(ok);
  expect(await retryCleanup(key, undefined, send)).toBe(1);
  expect(send).not.toHaveBeenCalled();
  await reimportSession(session('B'), 1, false, 1);
  expect(await retryCleanup(key, undefined, send)).toBe(0);
  expect(send).toHaveBeenCalledTimes(1);
});

it('atomically stages edit/reimport removals but keeps other drafts and never stages foreign IDs', async () => {
  await createSession(session('A'));
  for (const id of ['file-first', 'file-second', 'file-draft']) await register('A', id);
  await appendTurn('A', 1, { role: 'user', content: '', attachments: [image('file-first'), image('file-second')] });
  const version = (await getSession('A'))!.updatedAt;
  expect(await replaceTurns('A', 1, version - 1, 0, [])).toBeUndefined();
  const edited = await replaceTurns('A', 1, version, 0, [{ role: 'user', content: '', attachments: [image('file-second')] }]);
  expect((await pendingUploads()).map(r => r.sessionId.at(-1))).toEqual(['file-first']);
  await releaseUploads('A', ['foreign-file', 'file-second'], draft);
  expect(await cleanupCount()).toBe(1);
  const replaced = await reimportSession(session('A'), 1, false, edited!.updatedAt);
  expect(replaced?.uploadedFileIds).toEqual(['file-draft']);
  expect((await pendingUploads()).map(r => r.sessionId.at(-1)).sort()).toEqual(['file-first', 'file-second']);
});

it('bumps the version when adopting an imported image into a conversation with existing turns', async () => {
  await createSession({ ...session('A'), turns: [{ role: 'user', content: 'keep' }],
    imported: [{ role: 'user', content: '', attachments: [{ ...image('fixture'), source: 'official', fileId: null }] }] });
  const tag = await uploadKeyTag(key);
  expect(await adoptUpload('A', 'uploaded', tag, () => attachImportedFile('A', 1, 'fixture', 'uploaded', tag))).toBe(true);
  expect((await getSession('A'))?.updatedAt).toBeGreaterThan(1);
  expect(await deleteSession('A', 1, 1)).toBeNull();
  expect(await attachImportedFile('A', 1, 'fixture', 'redundant', tag)).toBe(false);
  expect((await pendingUploads()).map(r => r.sessionId.at(-1))).toEqual(['redundant']);
});

it('requires explicit retry with matching positive receipt for registered v0.3.0 IDs', async () => {
  await createSession({ ...session('old'), uploadedFileIds: ['legacy-file'],
    turns: [{ role: 'user', content: '', attachments: [image('never-registered')] }] });
  await deleteSession('old', 1, 1);
  const send = vi.fn(ok);
  expect(await retryCleanup(key, { sessionId: 'old' }, send)).toBe(1);
  expect(send).not.toHaveBeenCalled();
  expect(await retryCleanup(key, undefined, send)).toBe(1);
  expect(await retryCleanup(key, undefined, async () => Response.json({ deleted: true, id: 'legacy-file' }))).toBe(0);
});

it('allows late release only from the original tab/document and session, and preserves its adopted draft', async () => {
  await createSession(session('A'));
  await createSession(session('B'));
  await register('A', 'file-ready');
  await register('A', 'file-sent');
  const other = { tabId: 99, documentId: 'other-document' };
  await registerUploads('A', ['other-tab-file'], { keyTag: await uploadKeyTag(key), draft: other }, 1);
  await appendTurn('A', 1, { role: 'user', content: '', attachments: [image('file-sent')] });
  expect(await releaseUploads('B', ['file-ready'], draft)).toEqual([]);
  expect(await releaseUploads('A', ['file-ready'], other)).toEqual([]);
  expect(await releaseUploads('A', ['file-ready'], { ...draft, documentId: 'new-document' })).toEqual([]);
  expect(await releaseUploads('A', ['file-ready', 'other-tab-file', 'file-sent'], draft)).toEqual(['file-ready']);
  expect((await getSession('A'))?.uploadedFileIds).toEqual(['file-sent', 'other-tab-file']);
  expect((await pendingUploads()).map(r => r.sessionId.at(-1))).toEqual(['file-ready']);
});
