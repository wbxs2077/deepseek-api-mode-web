import DOMPurify, { type Config } from 'dompurify';
import { Marked } from 'marked';
import { mathExtension } from './math';

const markdown = new Marked(
  {
    renderer: {
      checkbox({ checked }) {
        return checked ? '☑ ' : '☐ ';
      },
    },
  },
  mathExtension,
);

// Allow formatting and navigation only. Resource elements and attributes
// such as src, srcset, style, and ping are excluded.
const sanitizeOptions: Config = {
  ALLOWED_TAGS: [
    'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2',
    'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'li', 'ol', 'p', 'pre', 's', 'span',
    'strong', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
  ],
  ALLOWED_ATTR: ['align', 'class', 'href', 'start', 'title'],
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
};

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export const renderMarkdown = (text: string) => {
  // Parse in an inert template so resources cannot load before sanitization.
  const template = document.createElement('template');
  template.innerHTML = markdown.parse(text, { async: false, breaks: true });
  return DOMPurify.sanitize(template.content, sanitizeOptions);
};
