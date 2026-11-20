import { describe, expect, it } from 'vitest';
import fixture from './fixtures/history.json';
import { branchTo, HistoryFormatError, parseHistory } from '../src/core/tree';
import { mergeConsecutive, toTranscript } from '../src/core/transcript';

const clone = () => structuredClone(fixture) as any;

describe('parseHistory', () => {
  it('reads the session and counts branch points', () => {
    const h = parseHistory(fixture);
    expect(h.sessionId).toBe('00000000-0000-4000-8000-000000000001');
    expect(h.version).toBe(12);
    expect(h.leafId).toBe('10');
    expect(h.messages.size).toBe(10);
    expect(h.branchPoints).toBe(1);
  });

  it('falls back to the largest message_id without current_message_id', () => {
    const data = clone();
    data.chat_session.current_message_id = null;
    expect(parseHistory(data).leafId).toBe('10');
  });

  it.each([
    ['missing chat_messages', (d: any) => delete d.chat_messages],
    ['duplicate message id', (d: any) => (d.chat_messages[1].message_id = String(d.chat_messages[0].message_id))],
    ['missing fragments', (d: any) => delete d.chat_messages[3].fragments],
    ['unknown role', (d: any) => (d.chat_messages[0].role = 'SYSTEM')],
    ['fragment without type', (d: any) => delete d.chat_messages[0].fragments[0].type],
  ])('rejects %s', (_name, mutate) => {
    const data = clone();
    mutate(data);
    expect(() => parseHistory(data)).toThrow(HistoryFormatError);
  });
});

describe('branchTo', () => {
  it('walks the current branch root-first and skips the abandoned one', () => {
    const ids = branchTo(parseHistory(fixture)).map((m) => m.message_id);
    expect(ids).toEqual([1, 2, 3, 4, 7, 8, 9, 10]);
  });

  it('can follow another leaf', () => {
    const ids = branchTo(parseHistory(fixture), '6').map((m) => m.message_id);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rejects a broken parent chain', () => {
    const data = clone();
    data.chat_messages = data.chat_messages.filter((m: any) => m.message_id !== 8);
    expect(() => branchTo(parseHistory(data))).toThrow(/断开/);
  });

  it('rejects a cycle', () => {
    const data = clone();
    data.chat_messages[0].parent_id = 10;
    expect(() => branchTo(parseHistory(data))).toThrow(/成环/);
  });
});

describe('toTranscript', () => {
  const t = toTranscript(branchTo(parseHistory(fixture)));

  it('keeps only request and response text, alternating roles', () => {
    expect(t.messages.map((m) => m.role)).toEqual(
      ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant'],
    );
    expect(t.messages[1]!.content).toBe('**回答一**');
    expect(t.messages[3]!.content).toBe('回答二');
    expect(JSON.stringify(t.messages)).not.toMatch(/思考过程|再想想|AI-generated|被放弃/);
  });

  it('keeps official attachments without content, with an image address only for usable images', () => {
    expect(t.skippedFiles).toBe(2);
    expect(t.messages[2]).toEqual({
      role: 'user',
      content: '看这张图',
      attachments: [{
        id: 'official:file-a', name: '截图.png', kind: 'image', bytes: 2048, fileId: null, source: 'official', officialId: 'file-a',
        officialUrl: 'https://files.deepseeksvc.com/api/file?file_id=file-a&state=synthetic-state&ty=p',
      }],
    });
    expect(t.messages[4]).toEqual({
      role: 'user',
      content: '',
      attachments: [{ id: 'official:file-b', name: '报告.pdf', kind: 'document', bytes: 0, fileId: null, source: 'official', officialId: 'file-b' }],
    });
  });

  it('does not offer images that failed on the official side', () => {
    const data = clone();
    data.chat_messages[2].fragments[0].files[0].status = 'FAILED';
    const [attachment] = toTranscript(branchTo(parseHistory(data))).messages[2]!.attachments!;
    expect(attachment!.officialUrl).toBeUndefined();
  });

  it('reports the official token count of the leaf', () => {
    expect(t.officialTokens).toBe(400);
  });

  it('merges neighbours when an assistant turn has no text', () => {
    const data = clone();
    data.chat_messages[7].fragments = [{ type: 'THINK', content: '只有思考' }];
    const merged = toTranscript(branchTo(parseHistory(data))).messages;
    expect(merged.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(merged[4]).toMatchObject({ content: '问题四', attachments: [{ name: '报告.pdf' }] });
  });

  it('reports unknown fragments without dropping the known text in the same message', () => {
    const data = clone();
    data.chat_messages[0].fragments.push({ type: 'FUTURE_BODY', content: 'unknown text' });
    const transcript = toTranscript(branchTo(parseHistory(data)));
    expect(transcript.skippedUnknownFragments).toBe(1);
    expect(transcript.messages[0]!.content).toBe('问题一');
  });

  it('fails loudly when no text can be read at all', () => {
    const data = clone();
    for (const m of data.chat_messages) m.fragments = [{ type: 'BODY', content: 'x' }];
    expect(() => toTranscript(branchTo(parseHistory(data)))).toThrow(HistoryFormatError);
  });
});

describe('mergeConsecutive', () => {
  it('does not mutate its input', () => {
    const input = [{ role: 'user' as const, content: 'a' }, { role: 'user' as const, content: 'b' }];
    expect(mergeConsecutive(input)).toEqual([{ role: 'user', content: 'a\n\nb' }]);
    expect(input[0]!.content).toBe('a');
  });

  it('keeps attachments of merged messages and skips empty text', () => {
    const file = (id: string) => ({ id, name: id, kind: 'image' as const, bytes: 1, fileId: id, source: 'local' as const });
    const input = [
      { role: 'user' as const, content: '', attachments: [file('a')] },
      { role: 'user' as const, content: 'b', attachments: [file('b')] },
    ];
    expect(mergeConsecutive(input)).toEqual([{ role: 'user', content: 'b', attachments: [file('a'), file('b')] }]);
    expect(input[0]!.attachments).toHaveLength(1);
  });
});
