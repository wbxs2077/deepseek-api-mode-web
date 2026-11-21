import { browser } from 'wxt/browser';
import type { BalanceReply, PopupReply, PopupRequest } from '../../protocol';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { EFFORTS, MODELS, type Effort } from '../../core/client';
import { loadSettings, OUTPUT_LIMITS, saveSettings, type Settings } from '../../settings';

const num = (n: number) => n.toLocaleString('zh-CN');
const EFFORT_LABELS: Record<Effort, string> = { low: '低', high: '高', max: '最高' };
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Popup() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [key, setKey] = useState('');
  // 已有 Key 时，点「更换」才显示输入框。
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState('');

  const [pending, setPending] = useState(0);
  const [retrying, setRetrying] = useState(false);

  async function cleanup(type: 'cleanup-status' | 'retry-cleanup') {
    const retry = type === 'retry-cleanup';
    if (retry) setRetrying(true);
    try {
      const reply: PopupReply | undefined = await browser.runtime.sendMessage({ type });
      if (!reply?.ok) throw new Error(reply?.error || '后台未响应');
      setPending(reply.value.pending);
      if (retry) setStatus(reply.value.pending ? '还有文件待删除，请检查网络和上传时使用的 Key' : '远端文件清理完成');
    } catch (e) {
      setStatus(`查询或清理远端文件失败：${errorText(e)}`);
    } finally {
      if (retry) setRetrying(false);
    }
  }

  // 余额：null 为未查询，'' 为查询中。
  const [balance, setBalance] = useState<string | null>(null);
  async function queryBalance() {
    setBalance('');
    try {
      const reply: BalanceReply | undefined = await browser.runtime.sendMessage({ type: 'balance' } satisfies PopupRequest);
      if (!reply?.ok) throw new Error(reply?.error || '后台未响应');
      setBalance(reply.value.available ? reply.value.total : `${reply.value.total}（当前不可用于 API 调用）`);
    } catch (e) {
      setBalance(`查询失败：${errorText(e)}`);
    }
  }

  useEffect(() => {
    void cleanup('cleanup-status');
    void loadSettings().then((s) => {
      setSettings(s);
      if (s.apiKey) void queryBalance();
    }).catch((e) => setStatus(`无法读取设置：${errorText(e)}`));
  }, []);

  async function patch(next: Partial<Settings>, done = '已保存') {
    try {
      await saveSettings(next);
      setSettings((s) => (s ? { ...s, ...next } : s));
      setStatus(done);
    } catch (e) {
      setStatus(`无法保存设置：${errorText(e)}`);
    }
  }

  if (!settings) return status ? <p class="status error">{status}</p> : null;
  const saved = settings.apiKey;
  const showInput = !saved || editing;
  async function saveKey() {
    await patch({ apiKey: key.trim() }, '已保存 API Key。回到页面即可发送');
    setKey('');
    setEditing(false);
    void queryBalance();
  }

  return (
    <main>
      <header>
        <h1>API 续聊 for DeepSeek</h1>
        <p class="hint">非官方工具，与 DeepSeek 无关联。在对话页底部切换到「API」，用自己的 Key 续聊，新回复只保存在本机。</p>
      </header>

      <section>
        <h2>API Key</h2>
        <div class="card">
          {saved && (
            <div class="item">
              <span class="mono">{'•'.repeat(8)}{saved.slice(-4)}</span>
              <span class="actions">
                {!editing && <button class="small" onClick={() => setEditing(true)}>更换</button>}
                <button class="small" onClick={() => {
                  setBalance(null);
                  setEditing(false);
                  void patch({ apiKey: '' }, '已清除 API Key');
                }}>清除</button>
              </span>
            </div>
          )}
          {showInput && (
            <div class="item column">
              <input type="password" autocomplete="off" placeholder="sk-…" aria-label="API Key" value={key}
                onInput={(e) => setKey(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && key.trim()) void saveKey(); }} />
              <span class="actions">
                {editing && <button class="small" onClick={() => { setKey(''); setEditing(false); }}>取消</button>}
                <button class="small primary" disabled={!key.trim()} onClick={() => void saveKey()}>保存</button>
              </span>
            </div>
          )}
          {saved && (
            <div class="item">
              <span>账户余额：{balance === '' ? '查询中…' : balance ?? '—'}</span>
              <button class="small" disabled={balance === ''} onClick={() => void queryBalance()}>刷新</button>
            </div>
          )}
        </div>
        <p class="hint">Key 只保存在扩展存储里，只发往 api.deepseek.com，DeepSeek 页面读不到。它在磁盘上没有加密，建议使用专用、余额有限的 Key。</p>
      </section>

      <section>
        <h2>默认设置</h2>
        <div class="card">
          <label class="item">
            <span>模型</span>
            <select value={settings.model} onChange={(e) => patch({ model: e.currentTarget.value })}>
              {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label class="item">
            <span>深度思考</span>
            <input type="checkbox" role="switch" class="switch" checked={settings.thinking}
              onChange={(e) => patch({ thinking: e.currentTarget.checked })} />
          </label>
          <div class="item">
            <span id="effort-label" class={settings.thinking ? '' : 'off'}>思考强度</span>
            <div class="segmented" role="radiogroup" aria-labelledby="effort-label">
              {EFFORTS.map((e) => (
                <button key={e} role="radio" aria-checked={settings.effort === e} disabled={!settings.thinking}
                  onClick={() => patch({ effort: e })}>{EFFORT_LABELS[e]}</button>
              ))}
            </div>
          </div>
          <label class="item">
            <span>智能搜索<small>联网搜索并阅读链接，使用 deepseek-flash</small></span>
            <input type="checkbox" role="switch" class="switch" checked={settings.search}
              onChange={(e) => patch({ search: e.currentTarget.checked })} />
          </label>
          <label class="item">
            <span>输出上限<small>跟随官方：思考时最多 64K，最高强度 128K</small></span>
            <select value={settings.maxTokens} onChange={(e) => patch({ maxTokens: Number(e.currentTarget.value) })}>
              {OUTPUT_LIMITS.map((n) => <option key={n} value={n}>{n ? `${num(n)} tokens` : '跟随官方'}</option>)}
            </select>
          </label>
        </div>
      </section>

      {pending > 0 && (
        <section>
          <h2>待删除的文件</h2>
          <div class="card">
            <div class="item">
              <span>{num(pending)} 个远端文件待清理<small>请使用上传时的 API Key</small></span>
              <button class="small" disabled={!saved || retrying} onClick={() => void cleanup('retry-cleanup')}>
                {retrying ? '删除中…' : '重试删除'}
              </button>
            </div>
          </div>
        </section>
      )}
      {status && <p class={`status${/失败|无法/.test(status) ? ' error' : ''}`} role="status">{status}</p>}
    </main>
  );
}

render(<Popup />, document.getElementById('app')!);
