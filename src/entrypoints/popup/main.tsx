import { browser } from 'wxt/browser';
import type { BalanceReply, PopupReply, PopupRequest } from '../../protocol';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { EFFORTS, MODELS, type Effort } from '../../core/client';
import { loadSettings, OUTPUT_LIMITS, saveSettings, type Settings } from '../../settings';

const num = (n: number) => n.toLocaleString('zh-CN');
const EFFORT_LABELS: Record<Effort, string> = { low: '低（low）', high: '高（high）', max: '最高（max）' };
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Popup() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [key, setKey] = useState('');
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

  if (!settings) return status ? <p class="error">{status}</p> : null;
  const saved = settings.apiKey;

  return (
    <main>
      <h1>API 续聊 for DeepSeek</h1>
      <p class="note">非官方工具，与 DeepSeek 无关联。</p>
      <p class="note">在 chat.deepseek.com 的对话页底部切换到「API」，用自己的 API Key 续聊。新回复只保存在本机。</p>

      <section>
        <h2>API Key</h2>
        <p class="note">
          {saved ? `已保存：${'•'.repeat(8)}${saved.slice(-4)}。` : '尚未设置。'}
          Key 只保存在扩展存储里，只发往 api.deepseek.com，DeepSeek 页面读不到。它在磁盘上没有加密，建议使用专用、余额有限的 Key。
        </p>
        <input type="password" autocomplete="off" placeholder="sk-…" value={key} onInput={(e) => setKey(e.currentTarget.value)} />
        <div class="row">
          <button class="primary" disabled={!key.trim()} onClick={async () => {
            await patch({ apiKey: key.trim() }, '已保存 API Key。回到页面即可发送');
            setKey('');
            void queryBalance();
          }}>保存</button>
          {saved && <button onClick={() => { setBalance(null); void patch({ apiKey: '' }, '已清除 API Key'); }}>清除</button>}
        </div>
        {saved && (
          <div class="row balance">
            <span>账户余额：{balance === '' ? '查询中…' : balance ?? '—'}</span>
            <button disabled={balance === ''} onClick={() => void queryBalance()}>刷新</button>
          </div>
        )}
      </section>

      <section>
        <h2>默认设置</h2>
        <label>
          模型
          <select value={settings.model} onChange={(e) => patch({ model: e.currentTarget.value })}>
            {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label>
          输出上限
          <select value={settings.maxTokens} onChange={(e) => patch({ maxTokens: Number(e.currentTarget.value) })}>
            {OUTPUT_LIMITS.map((n) => <option key={n} value={n}>{n ? `${num(n)} tokens` : '跟随官方（思考时最多 64K，最高强度 128K）'}</option>)}
          </select>
        </label>
        <label class="check">
          <input type="checkbox" checked={settings.thinking} onChange={(e) => patch({ thinking: e.currentTarget.checked })} />
          深度思考
        </label>
        <label>
          思考强度
          <select value={settings.effort} disabled={!settings.thinking}
            onChange={(e) => patch({ effort: e.currentTarget.value as Effort })}>
            {EFFORTS.map((e) => <option key={e} value={e}>{EFFORT_LABELS[e]}</option>)}
          </select>
        </label>
        <label class="check">
          <input type="checkbox" checked={settings.search} onChange={(e) => patch({ search: e.currentTarget.checked })} />
          智能搜索（联网搜索并阅读消息里的链接，使用 deepseek-flash）
        </label>
      </section>

      {pending > 0 && <section>
        <h2>待删除的文件</h2>
        <p class="note">{num(pending)} 个远端文件待清理。请使用上传时的 API Key。</p>
        <button disabled={!saved || retrying} onClick={() => void cleanup('retry-cleanup')}>{retrying ? '删除中…' : '重试删除'}</button>
      </section>}
      {status && <p class="note" role="status">{status}</p>}
    </main>
  );
}

render(<Popup />, document.getElementById('app')!);
