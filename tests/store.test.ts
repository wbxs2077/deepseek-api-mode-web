import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  appendTurn,
  createSession,
  deleteSession,
  dismissStale,
  getSession,
  reimportSession,
  replaceTurns,
  putSession,
  referencedFileIds,
  registerUploads,
  releaseUploads,
  type SessionRecord,
  type Turn,
} from '../src/core/store';

const record = (sessionId: string): SessionRecord => ({
  sessionId,
  title: 't',
  importedAt: 1,
  updatedAt: 1,
  leafId: '10',
  officialTokens: 400,
  skippedFiles: 2,
  hasBranches: true,
  imported: [{ role: 'user', content: 'q' }],
  turns: [],
});

const userTurn: Turn = { role: 'user', content: 'synthetic question' };
const otherTurn: Turn = { role: 'user', content: 'other synthetic question' };
const interruptedTurn: Turn = { role: 'assistant', content: 'synthetic partial', interrupted: true };
const answer: Turn = { role: 'assistant', content: 'synthetic answer' };

describe('store', () => {
  it('keeps sessions apart by id and survives reopening', async () => {
    const a = record('reopen-a');
    const b = { ...record('reopen-b'), turns: [userTurn] };
    await putSession(a);
    await putSession(b);
    expect(await getSession(a.sessionId)).toMatchObject({ turns: [] });
    expect(await getSession(b.sessionId)).toMatchObject({ turns: [userTurn] });
    expect(await getSession('missing')).toBeUndefined();
  });

  it('keeps legacy put as an overwrite and reproduces a lost update from stale snapshots', async () => {
    const { sessionId } = record('legacy-overwrite');
    expect(await putSession(record(sessionId))).toBe(sessionId);
    const [first, second] = await Promise.all([getSession(sessionId), getSession(sessionId)]);
    await putSession({ ...first!, turns: [...first!.turns, userTurn] });
    await putSession({ ...second!, turns: [...second!.turns, otherTurn] });
    const saved = (await getSession(sessionId))!;
    expect(saved.turns).toEqual([otherTurn]);
    expect(saved.updatedAt).toBeGreaterThan(1);
    expect(saved.importedAt).toBe(1);
  });

  it('creates exactly one session for concurrent imports without replacing the winner', async () => {
    const first = record('create-race');
    const second = { ...first, title: 'replacement', importedAt: 2, updatedAt: 3, turns: [userTurn] };
    const [createdFirst, createdSecond] = await Promise.all([createSession(first), createSession(second)]);
    expect([createdFirst, createdSecond].filter(Boolean)).toHaveLength(1);
    expect(await getSession(first.sessionId)).toEqual(createdFirst ? first : second);
  });

  it('appends both turns transactionally when callers use the same stale snapshot', async () => {
    const initial = record('append-race');
    await createSession(initial);
    const [first, second] = await Promise.all([getSession(initial.sessionId), getSession(initial.sessionId)]);
    const [a, b] = await Promise.all([
      appendTurn(first!.sessionId, first!.importedAt, userTurn),
      appendTurn(second!.sessionId, second!.importedAt, otherTurn),
    ]);

    expect(a?.turns.length).toBeDefined();
    expect(b?.turns.length).toBeDefined();
    expect([a!.turns.length, b!.turns.length].sort()).toEqual([1, 2]);
    const saved = (await getSession(initial.sessionId))!;
    expect(saved).toEqual(a!.turns.length === 2 ? a : b);
    expect(saved.turns).toEqual(expect.arrayContaining([userTurn, otherTurn]));
    expect(saved).toEqual({ ...initial, updatedAt: saved.updatedAt, turns: saved.turns });
    expect(saved.updatedAt).toBeGreaterThan(initial.updatedAt);
  });

  it('allows only one append for the same expected turn count and accepts the next count', async () => {
    const { sessionId, importedAt } = record('append-count');
    await createSession(record(sessionId));
    const results = await Promise.all([
      appendTurn(sessionId, importedAt, userTurn, 0),
      appendTurn(sessionId, importedAt, otherTurn, 0),
    ]);
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
    const winner = results.find((result) => result !== undefined)!;
    expect(await getSession(sessionId)).toEqual(winner);

    const partial: Turn = { ...interruptedTurn, finishStatus: 'incomplete' };
    const updated = await appendTurn(sessionId, importedAt, partial, 1);
    expect(updated?.turns).toEqual([...winner.turns, partial]);
    expect(await getSession(sessionId)).toEqual(updated);
  });

  it('rejects failed writes and preserves the record', async () => {
    const initial = record('append-clone-error');
    await createSession(initial);
    const uncloneable = { ...userTurn, callback: () => {} };
    await expect(appendTurn(initial.sessionId, initial.importedAt, uncloneable)).rejects.toMatchObject({
      name: 'DataCloneError',
    });
    expect(await getSession(initial.sessionId)).toEqual(initial);
  });

  it('deletes only the matching session instance and reports a missing record', async () => {
    const target = { ...record('delete-target'), importedAt: 0 };
    const other = record('delete-other');
    await createSession(target);
    await createSession(other);

    expect(await deleteSession(target.sessionId, 1, target.updatedAt)).toBeNull();
    expect(await getSession(target.sessionId)).toEqual(target);
    expect(await deleteSession(target.sessionId, 0, target.updatedAt)).toEqual([]);
    expect(await getSession(target.sessionId)).toBeUndefined();
    expect(await deleteSession(target.sessionId, 0, target.updatedAt)).toBeNull();
    expect(await getSession(other.sessionId)).toEqual(other);
    expect(await deleteSession(other.sessionId, other.importedAt, other.updatedAt)).toEqual([]);
    expect(await getSession(other.sessionId)).toBeUndefined();
  });

  it('rejects stale mutations after deletion and recreation of the same session id', async () => {
    const initial = { ...record('recreated'), turns: [userTurn, interruptedTurn] };
    const { sessionId, importedAt, updatedAt } = initial;
    await createSession(initial);
    expect(await deleteSession(sessionId, importedAt, updatedAt)).toEqual([]);
    expect(await appendTurn(sessionId, importedAt, otherTurn)).toBeUndefined();
    expect(await replaceTurns(sessionId, importedAt, updatedAt, 1, [answer])).toBeUndefined();
    expect(await getSession(sessionId)).toBeUndefined();

    const replacement = { ...initial, importedAt: 2, updatedAt: 2, turns: [otherTurn, interruptedTurn] };
    expect(await createSession(replacement)).toBe(true);
    expect(await appendTurn(sessionId, importedAt, userTurn, 2)).toBeUndefined();
    expect(await replaceTurns(sessionId, importedAt, 2, 1, [answer])).toBeUndefined();
    expect(await deleteSession(sessionId, importedAt, replacement.updatedAt)).toBeNull();
    expect(await getSession(sessionId)).toEqual(replacement);
  });

  it('replaces turns from an index once for the same expected version', async () => {
    const initial = { ...record('replace-race'), turns: [userTurn, interruptedTurn] };
    const { sessionId, importedAt, updatedAt } = initial;
    await createSession(initial);
    expect(await replaceTurns(sessionId, importedAt, updatedAt + 1, 1, [answer])).toBeUndefined();
    expect(await replaceTurns(sessionId, importedAt, updatedAt, 3, [answer])).toBeUndefined();
    expect(await getSession(sessionId)).toEqual(initial);

    const results = await Promise.all([
      replaceTurns(sessionId, importedAt, updatedAt, 1, [answer]),
      replaceTurns(sessionId, importedAt, updatedAt, 1, [answer]),
    ]);
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
    const updated = results.find((result) => result !== undefined)!;
    expect(updated).toEqual({ ...initial, updatedAt: updated.updatedAt, turns: [userTurn, answer] });
    expect(updated.updatedAt).toBeGreaterThan(initial.updatedAt);
    expect(await getSession(sessionId)).toEqual(updated);

    const edited = await replaceTurns(sessionId, importedAt, updated.updatedAt, 0, [otherTurn]);
    expect(edited?.turns).toEqual([otherTurn]);
  });

  it('refreshes a snapshot only when no local turns would be lost', async () => {
    const initial = { ...record('reimport'), turns: [userTurn, answer], dismissedLeafId: '11' };
    await createSession(initial);
    const fresh = { ...record('reimport'), title: 'new', importedAt: 5, updatedAt: 5, leafId: '12', imported: [{ role: 'user' as const, content: 'q2' }] };

    expect(await reimportSession(fresh, initial.importedAt, true, initial.updatedAt)).toBeUndefined();
    expect(await reimportSession(fresh, 99, false, initial.updatedAt)).toBeUndefined();
    expect(await getSession(initial.sessionId)).toEqual(initial);

    const replaced = (await reimportSession(fresh, initial.importedAt, false, initial.updatedAt))!;
    expect(replaced).toMatchObject({ title: 'new', leafId: '12', imported: fresh.imported, turns: [], dismissedLeafId: null });
    expect(replaced.importedAt).toBeGreaterThan(initial.importedAt);
    expect(await getSession(initial.sessionId)).toEqual(replaced);
    // 旧版本号的写入被拒绝。
    expect(await appendTurn(initial.sessionId, initial.importedAt, userTurn)).toBeUndefined();

    const again = { ...fresh, importedAt: 1, leafId: '13' };
    const quiet = (await reimportSession(again, replaced.importedAt, true, replaced.updatedAt))!;
    expect(quiet.leafId).toBe('13');
    expect(quiet.importedAt).toBeGreaterThan(replaced.importedAt);
  });

  it.each(['reimport', 'delete'] as const)('rejects stale %s until reconfirmed for the new turns', async (operation) => {
    const shown = { ...record(`stale-${operation}`), turns: [userTurn, answer] };
    const { sessionId, importedAt } = shown;
    await createSession(shown);
    await appendTurn(sessionId, importedAt, otherTurn, 2);
    const latest = (await appendTurn(sessionId, importedAt, answer, 3))!;
    expect(latest.turns).toEqual([...shown.turns, otherTurn, answer]);
    const next = { ...shown, title: 'fresh snapshot', importedAt: 5 };

    if (operation === 'reimport') {
      expect(await reimportSession(next, importedAt, false, shown.updatedAt)).toBeUndefined();
      expect(await getSession(sessionId)).toEqual(latest);
      const replaced = await reimportSession(next, importedAt, false, latest.updatedAt);
      expect(replaced).toMatchObject({ title: next.title, turns: [] });
      expect(await getSession(sessionId)).toEqual(replaced);
    } else {
      expect(await deleteSession(sessionId, importedAt, shown.updatedAt)).toBeNull();
      expect(await getSession(sessionId)).toEqual(latest);
      expect(await deleteSession(sessionId, importedAt, latest.updatedAt)).toEqual([]);
      expect(await getSession(sessionId)).toBeUndefined();
    }
  });

  it('records a dismissed leaf without touching turns', async () => {
    const initial = { ...record('dismiss'), turns: [userTurn, answer] };
    await createSession(initial);
    expect(await dismissStale(initial.sessionId, 99, '12')).toBeUndefined();
    const updated = await dismissStale(initial.sessionId, initial.importedAt, '12');
    expect(updated).toEqual({ ...initial, dismissedLeafId: '12' });
    expect(await getSession(initial.sessionId)).toEqual(updated);
  });

  it('tracks uploads without changing the record version and releases only unreferenced files', async () => {
    const used = { id: 'u', name: 'u.png', kind: 'image' as const, bytes: 1, fileId: 'file-used', source: 'local' as const };
    const initial = { ...record('uploads'), turns: [{ role: 'user' as const, content: 'q', attachments: [used] }] };
    expect(await registerUploads('uploads', ['file-used'])).toBe(false);
    await createSession(initial);
    expect(await registerUploads('uploads', ['file-used', 'file-draft', 'file-draft'])).toBe(true);
    const saved = (await getSession('uploads'))!;
    expect(saved.uploadedFileIds).toEqual(['file-used', 'file-draft']);
    expect(saved.updatedAt).toBe(initial.updatedAt);
    expect(referencedFileIds(saved)).toEqual(new Set(['file-used']));

    expect(await releaseUploads('uploads', ['file-used'])).toEqual([]);
    expect(await releaseUploads('uploads', ['file-draft', 'file-unknown'])).toEqual(['file-draft']);
    expect((await getSession('uploads'))!.uploadedFileIds).toEqual(['file-used']);
  });

  it('returns uploaded files on delete and keeps them across a reimport', async () => {
    const initial = { ...record('uploads-delete'), uploadedFileIds: ['file-1'], turns: [userTurn] };
    await createSession(initial);
    const replaced = (await reimportSession({ ...record('uploads-delete'), importedAt: 5, uploadedFileIds: ['file-2'] }, 1, false, initial.updatedAt))!;
    expect(replaced.uploadedFileIds).toEqual(['file-1', 'file-2']);
    expect(await deleteSession('uploads-delete', replaced.importedAt, replaced.updatedAt)).toEqual(['file-1', 'file-2']);
  });
});
