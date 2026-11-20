import { beforeEach, describe, expect, it, vi } from 'vitest';
import { limiter, uploadThroughExtension, type UploadHandle } from '../src/entrypoints/deepseek.content/attachments';
import type { Attachment } from '../src/core/files';
import type { UploadPortOut } from '../src/protocol';

const connect = vi.hoisted(() => vi.fn());
vi.mock('wxt/browser', () => ({ browser: { runtime: { connect } } }));

function event<Args extends unknown[]>() {
  let listener: (...args: Args) => void;
  return {
    addListener(fn: typeof listener) { listener = fn; },
    emit(...args: Args) { listener(...args); },
  };
}

function mockPort() {
  return {
    onMessage: event<[UploadPortOut]>(), onDisconnect: event<[]>(),
    postMessage: vi.fn(), disconnect: vi.fn(),
  };
}

const file = new File(['sample'], 'synthetic.txt', { type: 'text/plain' });
const attachment: Attachment = { id: 'local', fileId: 'remote', name: file.name, bytes: file.size, kind: 'text', source: 'local' };
const start = (input = file, onState = vi.fn()) => uploadThroughExtension('session', input.name,
  { ok: true, file: input, uploadName: input.name, kind: 'text' }, onState);
// Drain pending promise reactions, including the limiter's finally and queued continuations.
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => connect.mockReset());

describe('upload cancellation', () => {
  it('settles before a pending file read completes and never opens a port', async () => {
    const input = new File(['a'], 'read.txt');
    const read = Promise.withResolvers<ArrayBuffer>();
    vi.spyOn(input, 'arrayBuffer').mockReturnValue(read.promise);
    const handle = start(input);
    handle.cancel();
    handle.cancel();
    await expect(handle.done).rejects.toThrow('已取消上传');
    read.resolve(new ArrayBuffer(1));
    await nextTurn();
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(['uploading', 'parsing'] as const)('ignores late events after cancel during %s', async (phase) => {
    const port = mockPort();
    connect.mockReturnValue(port);
    port.disconnect.mockImplementation(() => port.onDisconnect.emit());
    const state = vi.fn();
    const handle = start(file, state);
    await nextTurn();
    port.onMessage.emit({ type: 'next' });
    if (phase === 'parsing') {
      port.onMessage.emit({ type: 'next' });
      port.onMessage.emit({ type: 'parsing' });
    }
    expect(state).toHaveBeenLastCalledWith(phase, 1);
    const posts = port.postMessage.mock.calls.length;
    state.mockClear();
    handle.cancel();
    handle.cancel();
    port.onMessage.emit({ type: 'next' });
    port.onMessage.emit({ type: 'parsing' });
    port.onMessage.emit({ type: 'done', attachment });
    port.onMessage.emit({ type: 'error', error: 'late' });
    await expect(handle.done).rejects.toThrow('已取消上传');
    expect(port.disconnect).toHaveBeenCalledTimes(1);
    expect(port.postMessage).toHaveBeenCalledTimes(posts);
    expect(state).not.toHaveBeenCalled();
  });

  it.each(['error', 'disconnect'] as const)('retries the same file after %s and preserves success after cancel', async (failure) => {
    const first = mockPort(), retry = mockPort();
    connect.mockReturnValueOnce(first).mockReturnValueOnce(retry);
    const slot = limiter(1);
    const failed = start();
    const reason = expect(slot(() => failed.done)).rejects.toThrow(failure === 'error' ? 'synthetic failure' : '上传中断');
    const result = slot(async () => {
      const handle = start();
      await nextTurn();
      retry.onMessage.emit({ type: 'done', attachment });
      handle.cancel();
      retry.onDisconnect.emit();
      return handle.done;
    });
    await nextTurn();
    if (failure === 'error') first.onMessage.emit({ type: 'error', error: 'synthetic failure' });
    else first.onDisconnect.emit();
    failed.cancel();
    await reason;
    await expect(result).resolves.toEqual(attachment);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('returns all three slots to queued uploads, one per cancellation', async () => {
    const ports = Array.from({ length: 6 }, mockPort);
    for (const port of ports) connect.mockReturnValueOnce(port);
    const slot = limiter(3);
    const active: UploadHandle[] = [];
    const enqueue = () => slot(() => {
      const handle = start();
      active.push(handle);
      return handle.done;
    });
    const cancelled = Promise.allSettled([enqueue(), enqueue(), enqueue()]);
    const queued = Promise.all([enqueue(), enqueue(), enqueue()]);
    await nextTurn();
    expect(connect).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      active[i]!.cancel();
      active[i]!.cancel();
      await nextTurn();
      expect(connect).toHaveBeenCalledTimes(4 + i);
    }
    expect((await cancelled).map(r => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    for (const port of ports.slice(3)) port.onMessage.emit({ type: 'done', attachment });
    await expect(queued).resolves.toEqual([attachment, attachment, attachment]);
  });
});
