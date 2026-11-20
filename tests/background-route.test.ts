import { beforeEach, describe, expect, it, vi } from 'vitest';
import background from '../src/entrypoints/background';
import type { PageReply } from '../src/protocol';

const mocks = vi.hoisted(() => ({
  onMessage: vi.fn(), onConnect: vi.fn(), getTab: vi.fn(), getSession: vi.fn(), reimport: vi.fn(), remove: vi.fn(),
}));
vi.mock('wxt/browser', () => ({ browser: {
  runtime: { id: 'fixture', onMessage: { addListener: mocks.onMessage }, onConnect: { addListener: mocks.onConnect } },
  tabs: { get: mocks.getTab }, storage: { local: { setAccessLevel: async () => {} } },
} }));
vi.mock('../src/core/store', async (original) => ({
  ...await original<typeof import('../src/core/store')>(), getSession: mocks.getSession,
  deleteSession: mocks.remove, reimportSession: mocks.reimport,
}));
vi.mock('../src/settings', () => ({ loadSettings: async () => ({}) }));

const origin = 'https://chat.deepseek.com';
const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
const path = (id: string) => origin + '/a/chat/s/' + id;
const sender = { id: 'fixture', frameId: 0, origin, url: path(a), tab: { id: 13 } };
const state = { type: 'get-state', sessionId: b };
const record = { sessionId: b, title: '', importedAt: 10, updatedAt: 10, leafId: null,
  officialTokens: null, skippedFiles: 0, hasBranches: false, imported: [{ role: 'user', content: 'fixture' }], turns: [] };
const remove = { type: 'delete', sessionId: b, importedAt: 7, expectedUpdatedAt: 9 };
const reimport = { type: 'reimport', record, expectedImportedAt: 7, keepTurns: false, expectedUpdatedAt: 9 };

function dispatch(message: object, source: object = sender) {
  const listener = mocks.onMessage.mock.lastCall![0];
  return new Promise<PageReply<unknown> | undefined>((resolve) => {
    if (listener(message, source, resolve) !== true) resolve(undefined);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getTab.mockResolvedValue({ id: 13, url: path(b) });
  background.main();
});

describe('background route authorization', () => {
  it('resolves an omitted sender.tab.url through the sending tab', async () => {
    expect((await dispatch(state))?.ok).toBe(true);
    expect(mocks.getTab).toHaveBeenCalledWith(13);
    expect(mocks.getSession).toHaveBeenCalledWith(b);
    expect((await dispatch({ ...state, sessionId: a }))?.ok).toBe(false);
    expect(mocks.getSession).toHaveBeenCalledTimes(1);
  });
  it.each([{ url: 'bad' }, { origin: 'null' }, { url: 'https://elsewhere.invalid' }, { frameId: 2 },
    { id: 'other-extension' }, { tab: {} }, { tab: { id: 13, url: 'https://elsewhere.invalid' } }])(
    'rejects an invalid sender %o', async (patch) => {
      expect(await dispatch(state, { ...sender, ...patch })).toBeUndefined();
      expect(mocks.getSession).not.toHaveBeenCalled();
    },
  );
  it.each([{ id: 13 }, { id: 13, url: 'https://elsewhere.invalid' }, { id: 8, url: path(b) },
    { id: 13, url: path(b), pendingUrl: path(a) }])('fails closed for current tab %o', async (tab) => {
    mocks.getTab.mockResolvedValue(tab);
    expect((await dispatch(state, { ...sender, tab: { id: 13, url: path(b) } }))?.ok).toBe(false);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
  it('rejects a closed tab even if the sender URL matches', async () => {
    mocks.getTab.mockRejectedValue(new Error('tab closed'));
    expect((await dispatch({ ...state, sessionId: a }))?.ok).toBe(false);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
  it.each([a, b])('rejects a delayed port run for %s after navigation, even without sender.tab.url', async (target) => {
    // tabs.get returns A at connect and B at run; neither route may use this port now.
    mocks.getTab.mockResolvedValueOnce({ id: 13, url: path(a) });
    const onMessage = vi.fn();
    const finished = Promise.withResolvers<{ type: string; error: string }>();
    mocks.onConnect.mock.lastCall![0]({
      name: 'chat', sender, onMessage: { addListener: onMessage }, onDisconnect: { addListener: vi.fn() },
      postMessage: finished.resolve, disconnect: vi.fn(),
    });
    onMessage.mock.lastCall![0]({ type: 'run', sessionId: target, action: { kind: 'send', text: 'fixture' } });
    expect(await finished.promise).toEqual({ type: 'done', error: '页面已切换到别的对话，请重试' });
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
  it('checks the route again after lock acquisition and forwards the confirmed version', async () => {
    const locks = { request: vi.fn(async (_name, _opts, action) => action({})) };
    vi.stubGlobal('navigator', { locks });
    try {
      expect((await dispatch(remove))?.ok).toBe(true);
      expect(mocks.remove).toHaveBeenCalledWith(b, 7, 9);
      expect((await dispatch(reimport))?.ok).toBe(true);
      expect(mocks.reimport).toHaveBeenCalledWith(record, 7, false, 9);
      mocks.getTab.mockResolvedValueOnce({ id: 13, url: path(b) }).mockResolvedValueOnce({ id: 13, url: path(a) });
      expect((await dispatch(remove))?.ok).toBe(false);
      for (const request of [remove, reimport]) expect((await dispatch({ ...request, expectedUpdatedAt: undefined }))?.ok).toBe(false);
      expect(mocks.remove).toHaveBeenCalledTimes(1);
      expect(mocks.reimport).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllGlobals(); }
  });
});
