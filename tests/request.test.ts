import { describe, expect, it } from 'vitest';
import type { Attachment } from '../src/core/files';
import { buildRequest, reminderFor } from '../src/core/request';
import type { Turn } from '../src/core/store';
import type { ApiMessage } from '../src/core/transcript';

const file = (fileId: string | null, name = `${fileId}.png`): Attachment =>
  ({ id: `a-${fileId ?? name}`, name, kind: 'image', bytes: 10, fileId, source: 'local' });

const imported: ApiMessage[] = [
  { role: 'user', content: '看图', attachments: [file(null, '官网.png')] },
  { role: 'assistant', content: '好的' },
];

describe('reminderFor', () => {
  it('writes the local date and weekday with an empty location', () => {
    expect(reminderFor(new Date(2026, 10, 20, 23, 59))).toBe('2026-11-20,星期五,,Web,中文');
    expect(reminderFor(new Date(2026, 0, 4))).toBe('2026-01-04,星期日,,Web,中文');
  });
});

describe('buildRequest', () => {
  it('puts file parts before text and replaces unavailable attachments with a note', () => {
    const turns: Turn[] = [{ role: 'user', content: '这两张呢', attachments: [file('f1'), file('f2')], reminder: 'R' }];
    const { messages, model, switchedFor } = buildRequest(imported, turns, { model: 'deepseek-flash', search: false });
    expect(messages).toEqual([
      { role: 'user', content: '[附件：官网.png（图片），内容不可用]\n\n看图' },
      { role: 'assistant', content: '好的' },
      { role: 'latest_reminder', content: 'R' },
      { role: 'user', content: [{ type: 'file', file_id: 'f1' }, { type: 'file', file_id: 'f2' }, { type: 'text', text: '这两张呢' }] },
    ]);
    expect(model).toBe('deepseek-flash');
    expect(switchedFor).toBeNull();
  });

  it('sends a file-only question without an empty text part', () => {
    const { messages } = buildRequest([], [{ role: 'user', content: '', attachments: [file('f1')] }], { model: 'deepseek-flash', search: false });
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'file', file_id: 'f1' }] }]);
  });

  it('replays reasoning and server tool calls of local replies and keeps old reminders in place', () => {
    const calls = [{ index: 0, calls: [{ id: 'srvtoolu_1', type: 'deepseek_web_search', signature: 'sig' }] }];
    const turns: Turn[] = [
      { role: 'user', content: 'q1', reminder: 'R1' },
      { role: 'assistant', content: 'a1', reasoning: 'think', serverToolCalls: calls },
      { role: 'user', content: 'q2', reminder: 'R2' },
    ];
    const { messages } = buildRequest(imported, turns, { model: 'deepseek-flash', search: true });
    expect(messages.slice(2)).toEqual([
      { role: 'latest_reminder', content: 'R1' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1', reasoning_content: 'think', server_tool_calls: calls },
      { role: 'latest_reminder', content: 'R2' },
      { role: 'user', content: 'q2' },
    ]);
  });

  it.each([
    { full: '查读查读', steps: ['查', '读'], expected: '查读' },
    { full: '查读', steps: ['查', '读'], expected: '' },
    { full: undefined, steps: ['', ''], expected: '' },
    { full: '已有记录', steps: ['已', '不匹配'], expected: '已有记录' },
  ])('recovers a legacy final step only from a complete matching prefix ($full, $steps)', ({ full, steps, expected }) => {
    const calls = steps.map((reasoning_content, index) => ({ index, reasoning_content, calls: [] }));
    const { messages } = buildRequest([], [{ role: 'assistant', content: 'a', reasoning: full, serverToolCalls: calls }],
      { model: 'deepseek-flash', search: false });
    expect(messages).toEqual([{ role: 'assistant', content: 'a', reasoning_content: expected, server_tool_calls: calls }]);
  });

  it('keeps a reply that only made tool calls and merges neighbouring user turns without splitting a reminder', () => {
    const turns: Turn[] = [
      { role: 'user', content: 'q1', reminder: 'R1' },
      { role: 'assistant', content: '', serverToolCalls: [{ index: 0 }] },
      { role: 'user', content: 'q2', reminder: 'R2' },
      { role: 'user', content: 'q3', reminder: 'R3', attachments: [file('f3')] },
    ];
    const { messages } = buildRequest([], turns, { model: 'deepseek-flash', search: true });
    expect(messages).toEqual([
      { role: 'latest_reminder', content: 'R1' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: '', server_tool_calls: [{ index: 0 }] },
      { role: 'latest_reminder', content: 'R2' },
      { role: 'user', content: [{ type: 'text', text: 'q2' }, { type: 'file', file_id: 'f3' }, { type: 'text', text: 'q3' }] },
    ]);
  });

  it.each([
    { name: 'files in history', imported: [{ role: 'user' as const, content: 'x', attachments: [file('f0')] }], turns: [], search: false, reason: 'files' },
    { name: 'a new file', imported: [], turns: [{ role: 'user' as const, content: 'x', attachments: [file('f1')] }], search: false, reason: 'files' },
    { name: 'search', imported: [], turns: [{ role: 'user' as const, content: 'x' }], search: true, reason: 'search' },
  ])('switches deepseek-v4-pro to flash for $name', ({ imported, turns, search, reason }) => {
    expect(buildRequest(imported, turns, { model: 'deepseek-v4-pro', search })).toMatchObject({ model: 'deepseek-flash', switchedFor: reason });
  });

  it('keeps deepseek-v4-pro for plain text without search, including unavailable attachments', () => {
    expect(buildRequest(imported, [{ role: 'user', content: 'x' }], { model: 'deepseek-v4-pro', search: false }))
      .toMatchObject({ model: 'deepseek-v4-pro', switchedFor: null });
  });
});
