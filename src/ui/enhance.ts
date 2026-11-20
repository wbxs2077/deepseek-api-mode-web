import katex from 'katex';

// 净化后的回复 HTML 上的后处理：KaTeX 排版公式、给代码块加复制按钮。
// 两者都直接操作 DOM，不经过 innerHTML，按钮文字放在 CSS 里，不改变正文的 textContent。

/** 用 MathML 输出，由 Chrome 原生排版，不需要额外字体和内联样式。 */
function renderMath(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>('.math:not(.math-done)')) {
    const tex = el.textContent ?? '';
    el.classList.add('math-done');
    try {
      katex.render(tex, el, {
        displayMode: el.classList.contains('math-display'),
        output: 'mathml',
        throwOnError: false,
        trust: false,
        strict: 'ignore',
      });
    } catch {
      el.textContent = tex;
    }
  }
}

function addCodeCopy(root: HTMLElement) {
  for (const pre of root.querySelectorAll<HTMLElement>('pre')) {
    if (pre.parentElement?.classList.contains('code-block')) continue;
    const box = document.createElement('div');
    box.className = 'code-block';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.setAttribute('aria-label', '复制代码');
    button.addEventListener('click', () => {
      const code = pre.querySelector('code') ?? pre;
      navigator.clipboard.writeText(code.textContent ?? '').then(
        () => flash(button, 'done'),
        () => flash(button, 'failed'),
      );
    });
    pre.replaceWith(box);
    box.append(pre, button);
  }
}

function flash(button: HTMLElement, state: 'done' | 'failed') {
  button.dataset.state = state;
  button.setAttribute('aria-label', state === 'done' ? '已复制' : '复制失败');
  setTimeout(() => {
    delete button.dataset.state;
    button.setAttribute('aria-label', '复制代码');
  }, 1_500);
}

export function enhanceMarkdown(root: HTMLElement | null) {
  if (!root) return;
  renderMath(root);
  addCodeCopy(root);
}
