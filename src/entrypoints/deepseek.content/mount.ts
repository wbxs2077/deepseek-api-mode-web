import css from './style.css?inline';

// 对话页结构（2026-11-20 核对）：
//   .ds-virtual-list                 滚动容器
//     .ds-virtual-list-items         虚拟列表
//     ★ ds-api-thread                续聊区，放在虚拟列表外、同一滚动容器内
//     …
//     div（sticky，贴底）            输入区
//       ★ ds-api-composer            分段控件和 API 输入框
//       div（含 textarea）           官方输入框，API 模式下由页面级样式隐藏
// 切换对话时整个滚动容器会被替换，宿主节点随时补挂，Preact 状态保留在宿主上。

export interface Host {
  host: HTMLElement;
  container: HTMLElement;
}

export interface Layout {
  scroller: HTMLElement;
  items: Element;
  sticky: Element;
  official: HTMLElement | null;
}

const RECHECK_MS = 2_000;
const OFFICIAL_ATTR = 'data-ds-api-official';
// 官网可能把同一容器就地换成冻结提示。textarea 一移除就放行，无需等下一帧。
const PAGE_STYLE = `ds-api-composer[data-mode="api"] + [${OFFICIAL_ATTR}]:has(textarea) { display: none !important; }`;
// 宿主上拦截的事件，避免页面的全局快捷键和复制处理接管扩展里的输入。
const ISOLATED_EVENTS = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'copy', 'cut'];

export function createHost(kind: 'thread' | 'composer' | 'notice'): Host {
  const host = document.createElement(`ds-api-${kind}`);
  // 结构不匹配的提示只展示文字，点击应能穿过它落到官网的导出等控件。
  if (kind === 'notice') host.style.pointerEvents = 'none';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = css;
  const container = document.createElement('div');
  container.className = 'root';
  root.append(style, container);
  for (const type of ISOLATED_EVENTS) host.addEventListener(type, (e) => e.stopPropagation());
  return { host, container };
}

export function installPageStyle() {
  const style = document.createElement('style');
  style.dataset.dsApi = '';
  style.textContent = PAGE_STYLE;
  (document.head ?? document.documentElement).append(style);
}

const isOurs = (el: Element) => el.localName.startsWith('ds-api-');

const isSticky = (el: Element) =>
  !isOurs(el) && !el.classList.contains('ds-scroll-area__gutters') && getComputedStyle(el).position === 'sticky';

export function findLayout(): Layout | null {
  for (const scroller of document.querySelectorAll<HTMLElement>('.ds-virtual-list')) {
    const items = scroller.querySelector(':scope > .ds-virtual-list-items');
    if (!items) continue;
    const sticky = [...scroller.children].findLast(isSticky);
    if (!sticky) continue;
    const official = [...sticky.children].find((el): el is HTMLElement =>
      !isOurs(el) && el instanceof HTMLElement && !!el.querySelector('textarea')) ?? null;
    return { scroller, items, sticky, official };
  }
  return null;
}

const stillValid = (l: Layout) =>
  l.scroller.isConnected && l.scroller.classList.contains('ds-virtual-list') &&
  l.items.parentElement === l.scroller && l.items.classList.contains('ds-virtual-list-items') &&
  l.sticky.parentElement === l.scroller && isSticky(l.sticky) &&
  (l.official ? l.official.parentElement === l.sticky && !!l.official.querySelector('textarea') : !l.sticky.querySelector('textarea'));

function place(l: Layout, thread: HTMLElement, composer: HTMLElement) {
  if (thread.previousElementSibling !== l.items) l.items.after(thread);
  if (l.official) {
    if (composer.nextElementSibling !== l.official) l.official.before(composer);
  } else if (composer.parentElement !== l.sticky) {
    // 没有官方输入框（例如对话不可续聊）时放在输入区内容首位，不隐藏官方节点。
    const first = [...l.sticky.children].find((el) => getComputedStyle(el).position !== 'absolute');
    l.sticky.insertBefore(composer, first ?? null);
  }
}

/** 在对话页保持宿主挂载。enabled 为 false 时卸下宿主。 */
export function keepMounted(thread: HTMLElement, composer: HTMLElement, onChange: (layout: Layout | null) => void) {
  let layout: Layout | null = null;
  let enabled = false;
  let frame = 0;

  function update(next: Layout | null) {
    if (next === layout) return;
    layout?.official?.removeAttribute(OFFICIAL_ATTR);
    next?.official?.setAttribute(OFFICIAL_ATTR, '');
    layout = next;
    onChange(next);
  }

  function check() {
    if (!enabled) {
      thread.remove();
      composer.remove();
      update(null);
      return;
    }
    const next = layout && stillValid(layout) ? layout : findLayout();
    if (next) place(next, thread, composer);
    else {
      thread.remove();
      composer.remove();
    }
    update(next);
  }

  const schedule = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      check();
    });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  // 只改类名或样式的重绘不会触发 childList，低频补查一次。
  const timer = setInterval(schedule, RECHECK_MS);

  return {
    setEnabled(value: boolean) {
      enabled = value;
      schedule();
    },
    dispose() {
      observer.disconnect();
      clearInterval(timer);
      cancelAnimationFrame(frame);
      layout?.official?.removeAttribute(OFFICIAL_ATTR);
      layout = null;
      thread.remove();
      composer.remove();
    },
  };
}
