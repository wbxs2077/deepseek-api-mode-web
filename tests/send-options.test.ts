import { describe, expect, expectTypeOf, it } from 'vitest';
import { parseSendOptions, type SendOptions } from '../src/core/send-options';
import type { ChatPortIn, PageReply, PageRequest, PopupReply, PopupRequest } from '../src/protocol';

const displayed = { model: 'deepseek-v4-pro', thinking: false, effort: 'low', search: false, maxTokens: 8192 };

describe('send options', () => {
  it('captures the visible settings and only includes public request fields', () => {
    const settings = { ...displayed, hasKey: true, apiKey: 'fixture-only' };
    const options = parseSendOptions(settings);
    Object.assign(settings, { model: 'deepseek-flash', thinking: true, effort: 'max', search: true, maxTokens: 4096 });
    expect(options).toStrictEqual(displayed);
    expect(parseSendOptions(settings)).toStrictEqual({ model: 'deepseek-flash', thinking: true, effort: 'max', search: true, maxTokens: 4096 });
  });

  it.each([undefined, null, [], {}, { ...displayed, model: 'unknown' },
    { ...displayed, thinking: undefined }, { ...displayed, thinking: 'true' }, { ...displayed, search: 'false' },
    { ...displayed, search: 0 }, { ...displayed, effort: undefined }, { ...displayed, effort: 'medium' }, { ...displayed, maxTokens: undefined }, { ...displayed, maxTokens: '8192' },
    { ...displayed, maxTokens: 8193 }])('rejects incomplete or invalid options (%#)', value => {
      expect(() => parseSendOptions(value)).toThrow();
    });

  it('requires options on run and keeps popup cleanup separate from page requests', () => {
    expectTypeOf<Extract<ChatPortIn, { type: 'run' }>>().toMatchTypeOf<{ options: SendOptions }>();
    expectTypeOf<PopupRequest['type']>().toEqualTypeOf<'cleanup-status' | 'retry-cleanup' | 'balance'>();
    expectTypeOf<Extract<PageRequest['type'], PopupRequest['type']>>().toBeNever();
    expectTypeOf<PopupReply>().toEqualTypeOf<PageReply<{ pending: number }>>();
  });
});
