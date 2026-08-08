// Stacked glass toasts. Auto-dismiss with a draining sliver, pause on hover or
// focus, click to dismiss, four visible at most.

import { el } from '../core/util.js';
import { icon, resolveMount } from './modal.js';

const MAX_VISIBLE = 4;
const DEFAULT_MS = 4200;
const ICONS = {
  info: 'info',
  success: 'success',
  error: 'error',
  warning: 'warning',
};

const live = [];

/**
 * The rail hangs just under the top bar. Its height is not a constant - the bar
 * wraps to two rows on a phone - so it is measured rather than guessed, and
 * modals.css reads the answer back out of --rail-top.
 */
function anchor(host) {
  const bar = document.getElementById('topbar');
  const below = bar ? Math.round(bar.getBoundingClientRect().bottom) : 0;
  host.style.setProperty('--rail-top', `${below + 12}px`);
}

const stack = () => {
  const host = resolveMount('toast-root', { fixedChildren: false });
  anchor(host);
  return host;
};

// The bar can change height on resize (its actions wrap), so anything on screen
// follows it. Registered once, and it costs nothing while the rail is empty.
window.addEventListener(
  'resize',
  () => {
    if (!live.length) return;
    const host = document.getElementById('toast-root');
    if (host) anchor(host);
  },
  { passive: true }
);

function remove(entry) {
  if (entry.removed) return;
  entry.removed = true;
  clearTimeout(entry.timer);
  const at = live.indexOf(entry);
  if (at >= 0) live.splice(at, 1);

  entry.el.classList.add('is-leaving');
  // Collapse the row so the ones below slide up instead of jumping.
  entry.el.style.height = `${entry.el.offsetHeight}px`;
  requestAnimationFrame(() => {
    entry.el.style.height = '0px';
    entry.el.style.marginBottom = '0px';
  });
  const drop = () => {
    entry.el.removeEventListener('transitionend', drop);
    entry.el.remove();
  };
  entry.el.addEventListener('transitionend', drop);
  setTimeout(drop, 420);
}

function schedule(entry) {
  if (!entry.ms) return;
  clearTimeout(entry.timer);
  entry.startedAt = performance.now();
  entry.timer = setTimeout(() => remove(entry), entry.remaining);
}

function pause(entry) {
  if (!entry.ms || entry.paused || entry.removed) return;
  entry.paused = true;
  clearTimeout(entry.timer);
  entry.remaining = Math.max(300, entry.remaining - (performance.now() - entry.startedAt));
  entry.el.classList.add('is-paused');
}

function resume(entry) {
  if (!entry.ms || !entry.paused || entry.removed) return;
  entry.paused = false;
  entry.el.classList.remove('is-paused');
  schedule(entry);
}

/**
 * @param {string} text
 * @param {"info"|"success"|"error"|"warning"} [type]
 * @param {number} [ms] 0 keeps the toast until it is clicked.
 * @returns {{el:HTMLElement, dismiss:()=>void}}
 */
export function toast(text, type = 'info', ms = DEFAULT_MS) {
  const kind = ICONS[type] ? type : 'info';
  const host = stack();

  const bar = el('i', { class: 'toast-bar', style: { animationDuration: `${ms}ms` } });
  // The container announces; the dismiss control is a real, labelled button.
  // A status region that is itself focusable and clickable claims to be a
  // control it never exposes, so the two jobs are kept apart.
  const closeBtn = el(
    'button',
    { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss' },
    icon('close')
  );
  const node = el(
    'div',
    {
      class: `toast toast-${kind}`,
      role: 'status',
      'aria-live': kind === 'error' ? 'assertive' : 'polite',
    },
    el('span', { class: 'toast-icon' }, icon(ICONS[kind])),
    el('span', { class: 'toast-text' }, String(text ?? '')),
    closeBtn,
    ms > 0 ? bar : null
  );

  const entry = { el: node, ms: ms > 0 ? ms : 0, remaining: ms > 0 ? ms : 0, removed: false };

  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    remove(entry);
  });
  node.addEventListener('click', () => remove(entry));
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      remove(entry);
    }
  });
  node.addEventListener('mouseenter', () => pause(entry));
  node.addEventListener('mouseleave', () => resume(entry));
  node.addEventListener('focusin', () => pause(entry));
  node.addEventListener('focusout', () => resume(entry));

  host.appendChild(node);
  live.push(entry);
  requestAnimationFrame(() => node.classList.add('is-in'));
  schedule(entry);

  while (live.length > MAX_VISIBLE) remove(live[0]);

  return { el: node, dismiss: () => remove(entry) };
}

/** Clears every visible toast (used when a level or view is torn down). */
export function clearToasts() {
  [...live].forEach(remove);
}
