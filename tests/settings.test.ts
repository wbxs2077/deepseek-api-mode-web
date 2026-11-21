import { beforeEach, describe, expect, it, vi } from 'vitest';

const stored: Record<string, unknown> = {};
vi.mock('wxt/browser', () => ({ browser: { storage: { local: {
  get: async (defaults: Record<string, unknown>) => ({ ...defaults, ...stored }),
  set: async (patch: Record<string, unknown>) => { Object.assign(stored, patch); },
} } } }));

const { loadSettings, saveSettings } = await import('../src/settings');

describe('settings', () => {
  beforeEach(() => { for (const key of Object.keys(stored)) delete stored[key]; });

  it('defaults to thinking on with high effort', async () => {
    expect(await loadSettings()).toMatchObject({ thinking: true, effort: 'high' });
  });

  it('keeps an upgraded user\'s thinking switch and fills in high effort', async () => {
    Object.assign(stored, { apiKey: 'sk-old', thinking: false, maxTokens: 8192 });
    expect(await loadSettings()).toMatchObject({ apiKey: 'sk-old', thinking: false, effort: 'high', maxTokens: 8192 });
  });

  it('restores the saved effort and replaces invalid values with high', async () => {
    await saveSettings({ effort: 'max' });
    expect((await loadSettings()).effort).toBe('max');
    stored.effort = 'medium';
    expect((await loadSettings()).effort).toBe('high');
  });
});
