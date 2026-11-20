import { render } from 'preact';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { sessionIdFromPath } from '../../protocol';
import { App } from './App';
import { createHost, installPageStyle, keepMounted, type Layout } from './mount';

export default defineContentScript({
  matches: ['https://chat.deepseek.com/*'],
  main(ctx) {
    installPageStyle();
    const thread = createHost('thread');
    const composer = createHost('composer');
    const notice = createHost('notice');
    document.body.append(notice.host);

    let sessionId = sessionIdFromPath(location.pathname);
    let layout: Layout | null = null;
    const draw = () => render(
      <App key={sessionId ?? 'home'} sessionId={sessionId} layout={layout} thread={thread} composer={composer} notice={notice} />,
      thread.container,
    );
    const keeper = keepMounted(thread.host, composer.host, (next) => {
      layout = next;
      draw();
    });

    // 监听已提交的 SPA 导航，直接从当前路径读取会话。
    const syncPath = () => {
      const next = sessionIdFromPath(location.pathname);
      if (next === sessionId) return;
      sessionId = next;
      keeper.setEnabled(!!next);
      draw();
    };
    keeper.setEnabled(!!sessionId);
    draw();
    if (window.navigation) ctx.addEventListener(window.navigation, 'currententrychange', syncPath);
    ctx.addEventListener(window, 'popstate', syncPath);
    ctx.addEventListener(window, 'pageshow', syncPath);
    if (!window.navigation) ctx.setInterval(syncPath, 800);

    // 跟随官网的浅色 / 深色主题。
    const applyTheme = () => {
      const theme = document.body.classList.contains('dark') ? 'dark' : 'light';
      for (const { host } of [thread, composer, notice]) host.dataset.theme = theme;
    };
    applyTheme();
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    ctx.onInvalidated(() => {
      themeObserver.disconnect();
      render(null, thread.container);
      keeper.dispose();
      notice.host.remove();
    });
  },
});
