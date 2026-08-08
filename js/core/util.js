// Shared helpers. Read-only for feature agents.

const SVG_NS = 'http://www.w3.org/2000/svg';

function applyProps(node, props, ns) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') {
      node.setAttribute('class', String(value));
    } else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith('--')) node.style.setProperty(prop, String(v));
        else node.style[prop] = v;
      }
    } else if (key === 'dataset' && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) node.dataset[k] = v;
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (!ns && key in node && key !== 'list' && key !== 'form') {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  applyProps(node, props, false);
  appendChildren(node, children);
  return node;
}

export function svgEl(tag, props, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  applyProps(node, props, true);
  appendChildren(node, children);
  return node;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fall through for exotic values */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

let uidCounter = 0;
export const uid = (prefix = 'id') => `${prefix}-${(++uidCounter).toString(36)}`;

export const raf = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const reducedMotionQuery =
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
export const prefersReducedMotion = () => Boolean(reducedMotionQuery && reducedMotionQuery.matches);

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- Markdown -------------------------------------------------------------
// Deliberately small: headings, lists, blockquotes, fenced + inline code,
// bold/italic, links, images, rules, paragraphs. Everything is escaped first so
// lesson content can never inject markup.

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}">`)
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_, label, href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}

export function renderMarkdown(md) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let list = null; // 'ul' | 'ol'
  let quote = [];
  let fence = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      quote = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');

    const fenceMatch = line.match(/^\s*```(\w*)\s*$/);
    if (fenceMatch) {
      if (fence === null) {
        flushAll();
        fence = { lang: fenceMatch[1] || '', body: [] };
      } else {
        const cls = fence.lang ? ` class="lang-${fence.lang}"` : '';
        out.push(`<pre><code${cls}>${escapeHtml(fence.body.join('\n'))}</code></pre>`);
        fence = null;
      }
      continue;
    }
    if (fence) {
      fence.body.push(rawLine);
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[-*_\s]*$/.test(line)) {
      flushAll();
      out.push('<hr>');
      continue;
    }

    const quoted = line.match(/^\s*>\s?(.*)$/);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    flushQuote();

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const want = bullet ? 'ul' : 'ol';
      if (list !== want) {
        flushList();
        list = want;
        out.push(`<${want}>`);
      }
      out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      continue;
    }
    flushList();

    paragraph.push(line.trim());
  }

  if (fence) out.push(`<pre><code>${escapeHtml(fence.body.join('\n'))}</code></pre>`);
  flushAll();
  return out.join('\n');
}
