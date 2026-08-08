// Modal foundation: glass dialog panel, focus trap, scroll lock, stacking and
// a promise-based result. Everything else in js/view/ builds on this.

import { el, svgEl, uid, prefersReducedMotion } from '../core/util.js';

const SPRITE = 'assets/icons.svg';
const ENTER_MS = 340;
const EXIT_MS = 220;

/** Sentinel an onClick can return to keep the modal open. */
export const KEEP_OPEN = Symbol('modal:keep-open');

/** Sprite symbols are published as #icon-<name>. */
export const iconHref = (name) =>
  `${SPRITE}#${String(name).startsWith('icon-') ? name : `icon-${name}`}`;

/**
 * One <svg><use> pointing at the shared sprite. Never inlines path data so the
 * DESIGN agent stays the single owner of icon artwork.
 */
export function icon(name, { className = '', label = '', size = null } = {}) {
  const svg = svgEl('svg', {
    class: className ? `icon ${className}` : 'icon',
    focusable: 'false',
    'aria-hidden': label ? null : 'true',
    role: label ? 'img' : null,
    style: size ? { width: `${size}px`, height: `${size}px` } : null,
  });
  if (label) svg.appendChild(svgEl('title', {}, label));
  const use = svgEl('use');
  use.setAttribute('href', iconHref(name));
  svg.appendChild(use);
  return svg;
}

// --- shared state ---------------------------------------------------------

const stack = [];
let listening = false;
let lockCount = 0;
let savedRootStyle = null;

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex^="-"])',
].join(',');

function focusablesIn(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((node) => {
    if (node.closest('[inert]')) return false;
    if (node.tabIndex < 0) return false;
    if (!node.getClientRects().length) return false;
    return getComputedStyle(node).visibility !== 'hidden';
  });
}

const topModal = () => stack[stack.length - 1] || null;

/**
 * Where focus goes when a modal had no opener to hand it back to.
 *
 * Every modal the reader opens themselves restores focus to the control they
 * pressed. The lesson that opens itself at boot has no such control, and
 * "restoring" to <body> means the next Tab starts again from the skip link at
 * the very top of the page - a trap laid exclusively for keyboard users. The
 * workspace is the same place the skip link goes, so this lands the reader
 * where the app itself would have put them.
 */
function focusFallback() {
  const candidates = [
    document.getElementById('workspace'),
    document.querySelector('#terminal-host input:not([disabled])'),
    document.querySelector('main'),
  ];
  for (const node of candidates) {
    if (!node || !node.isConnected || !node.getClientRects().length) continue;
    if (node.tabIndex < 0 && !node.hasAttribute('tabindex')) node.tabIndex = -1;
    node.focus({ preventScroll: true });
    if (document.activeElement === node) return true;
  }
  return false;
}

/** <body> is where focus lands when nothing is focused, so it is not an opener. */
function openerOf(node) {
  if (!(node instanceof HTMLElement)) return null;
  if (node === document.body || node === document.documentElement) return null;
  return node;
}

function isEditable(node) {
  if (!node) return false;
  const tag = node.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    node.isContentEditable === true
  );
}

function onGlobalKey(event) {
  const modal = topModal();
  if (!modal || !modal.rootEl.isConnected) return;

  if (event.key === 'Tab') {
    const items = focusablesIn(modal.panelEl);
    if (!items.length) {
      event.preventDefault();
      modal.panelEl.focus({ preventScroll: true });
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = modal.panelEl.contains(active);
    if (!inside) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus({ preventScroll: true });
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
    return;
  }

  if (event.key === 'Escape') {
    // A modal can claim Escape first (e.g. clear a search box before closing).
    if (typeof modal.escapeGuard === 'function' && modal.escapeGuard(event) === true) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!modal.dismissible) return;
    event.preventDefault();
    event.stopPropagation();
    modal.close(null);
    return;
  }

  // Buttons may claim a key (e.g. Enter). Skip when the user is inside a
  // control that already handles that key itself.
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (isEditable(document.activeElement)) return;
  const active = document.activeElement;
  if (active && active.tagName === 'BUTTON' && (event.key === 'Enter' || event.key === ' ')) return;
  if (active && active.tagName === 'A' && event.key === 'Enter') return;

  const index = modal.buttons.findIndex((b) => b.key && b.key === event.key);
  if (index >= 0 && modal.buttonEls[index] && !modal.buttonEls[index].disabled) {
    event.preventDefault();
    modal.buttonEls[index].click();
  }
}

function onGlobalFocus(event) {
  const modal = topModal();
  if (!modal || !modal.rootEl.isConnected || modal.isClosing) return;
  if (modal.panelEl.contains(event.target)) return;
  // Focus escaped the top modal (browser chrome, stray script). Pull it back.
  const items = focusablesIn(modal.panelEl);
  (items[0] || modal.panelEl).focus({ preventScroll: true });
}

function startListening() {
  if (listening) return;
  document.addEventListener('keydown', onGlobalKey, true);
  document.addEventListener('focusin', onGlobalFocus, true);
  listening = true;
}

function stopListening() {
  if (!listening) return;
  document.removeEventListener('keydown', onGlobalKey, true);
  document.removeEventListener('focusin', onGlobalFocus, true);
  listening = false;
}

// Scroll lock. The compensating padding goes on <html> - whose border box is
// pinned to the viewport - so the <body> content box keeps its exact width and
// nothing reflows when the scrollbar disappears.
function lockScroll() {
  if (lockCount++ > 0) return;
  const root = document.documentElement;
  const gap = window.innerWidth - root.clientWidth;
  savedRootStyle = {
    overflow: root.style.overflow,
    paddingRight: root.style.paddingRight,
  };
  if (gap > 0) {
    const current = parseFloat(getComputedStyle(root).paddingRight) || 0;
    root.style.paddingRight = `${current + gap}px`;
  }
  root.style.overflow = 'hidden';
  root.classList.add('has-modal');
}

function unlockScroll() {
  if (lockCount === 0) return;
  if (--lockCount > 0) return;
  const root = document.documentElement;
  root.style.overflow = savedRootStyle ? savedRootStyle.overflow : '';
  root.style.paddingRight = savedRootStyle ? savedRootStyle.paddingRight : '';
  root.classList.remove('has-modal');
  savedRootStyle = null;
}

// position:fixed breaks inside a transformed/filtered ancestor; fall back to
// <body> in that case so a modal can never be clipped. Hosts whose children sit
// in normal flow (the toast rail) pass `fixedChildren: false`, because a
// transform on the host itself is then perfectly fine.
export function resolveMount(id, { fixedChildren = true } = {}) {
  let host = document.getElementById(id);
  if (!host) {
    host = el('div', { id });
    document.body.appendChild(host);
  }
  if (!fixedChildren) return host;
  for (let node = host; node && node !== document.documentElement; node = node.parentElement) {
    const cs = getComputedStyle(node);
    if (
      cs.transform !== 'none' ||
      cs.perspective !== 'none' ||
      cs.filter !== 'none' ||
      (cs.backdropFilter && cs.backdropFilter !== 'none') ||
      (cs.contain && /paint|layout|strict|content/.test(cs.contain)) ||
      (cs.willChange && /transform|filter|perspective/.test(cs.willChange))
    ) {
      return document.body;
    }
  }
  return host;
}

function settle(node, ms) {
  if (prefersReducedMotion()) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      node.removeEventListener('transitionend', onEnd);
      clearTimeout(timer);
      resolve();
    };
    const onEnd = (event) => {
      if (event.target === node) finish();
    };
    node.addEventListener('transitionend', onEnd);
    const timer = setTimeout(finish, ms + 60);
  });
}

// --- Modal ----------------------------------------------------------------

export class Modal {
  constructor({
    title = '',
    body = '',
    buttons = [],
    size = 'md',
    dismissible = true,
    className = '',
  } = {}) {
    this.title = title;
    this.size = ['sm', 'md', 'lg', 'xl'].includes(size) ? size : 'md';
    this.dismissible = dismissible !== false;
    this.buttons = (Array.isArray(buttons) ? buttons : []).filter(Boolean);
    this.className = className || '';
    this.buttonEls = [];
    this.isClosing = false;
    this.isOpen = false;
    /** Optional hook: return true to swallow Escape instead of closing. */
    this.escapeGuard = null;
    /** Optional hook: fired once the panel has left the DOM, for teardown. */
    this.onClosed = null;
    this._ro = null;
    this._mo = null;
    this._lateSyncs = [];
    this._syncQueued = false;

    this._resolve = null;
    this._openPromise = null;
    this._closePromise = null;
    this._prevFocus = null;
    this._titleId = uid('modal-title');

    this._build();
    if (body) this.setBody(body);
  }

  _build() {
    this.titleEl = el('h2', { class: 'modal-title', id: this._titleId }, this.title || '');

    this.closeBtn = this.dismissible
      ? el(
          'button',
          {
            type: 'button',
            class: 'modal-x',
            'aria-label': 'Close',
            onClick: () => this.close(null),
          },
          icon('close')
        )
      : null;

    this.headTextEl = el('div', { class: 'modal-head-text' }, this.titleEl);
    // Plain divs, not <header>/<footer>. `div.modal` is not sectioning content,
    // so a <header> in here does not scope to the dialog - it maps straight to a
    // page-level `banner`, and every open panel added a SECOND unnamed banner
    // beside #topbar plus a stray `contentinfo`. Landmark navigation then reads
    // "banner, banner" with nothing to tell page chrome from dialog chrome. The
    // dialog is already announced by role="dialog" + aria-labelledby; its bar
    // and its tray are layout, and they say so now.
    this.headEl = el('div', { class: 'modal-head' }, this.headTextEl, this.closeBtn);

    this.bodyEl = el('div', { class: 'modal-body' });
    // A body taller than its box has to say so. These classes drive the mask in
    // modals.css: the last line dissolves into the footer instead of being
    // guillotined by it, and the fade lifts once the reader reaches the end.
    this.bodyEl.addEventListener('scroll', () => this._syncScroll(), { passive: true });
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this._syncScroll());
      this._ro.observe(this.bodyEl);
    }
    // A ResizeObserver only fires for the boxes it watches, and watching every
    // node in a panel the size of Help is not free. Content that arrives or
    // reflows deeper down - a legend that finishes drawing, a level list that
    // re-renders under a search - changed the scroll height without changing
    // any watched box, and the panel was left believing it did not scroll: no
    // fade, no chevron, and the last line guillotined at the footer rule.
    if (typeof MutationObserver === 'function') {
      this._mo = new MutationObserver(() => this._queueSync());
      this._mo.observe(this.bodyEl, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    this.footExtraEl = el('div', { class: 'modal-foot-extra' });
    this.actionsEl = el('div', { class: 'modal-actions' });
    this.footEl = el('div', { class: 'modal-foot' }, this.footExtraEl, this.actionsEl);

    this.buttons.forEach((descriptor, index) => {
      const variant = descriptor.variant || 'ghost';
      // `iconEnd` puts the glyph after the words. A forward arrow in front of
      // "Next" points back at the label it is leading, which is the wrong way
      // round; a back arrow in front of "Back" is right. So direction is the
      // caller's to state rather than something this builder can guess.
      const button = el(
        'button',
        {
          type: 'button',
          class: `btn btn-${variant}`,
          disabled: descriptor.disabled === true,
          onClick: () => this._activate(index),
        },
        descriptor.icon ? icon(descriptor.icon) : null,
        el('span', { class: 'btn-label' }, descriptor.label || ''),
        descriptor.iconEnd ? icon(descriptor.iconEnd) : null
      );
      if (descriptor.key) button.dataset.key = descriptor.key;
      this.buttonEls.push(button);
      this.actionsEl.appendChild(button);
    });

    this.grabEl = el('div', { class: 'modal-grab', 'aria-hidden': 'true' }, el('span'));

    // "There is more below", for the reader who cannot see a scrollbar - which
    // on a touch screen is everyone. Decoration only: aria-hidden and
    // pointer-transparent, so it is not a focus stop and the trap is unchanged.
    this.moreEl = el(
      'div',
      { class: 'modal-more', 'aria-hidden': 'true' },
      icon('chevron-down')
    );

    // The two folds. A softened edge alone has to be strong enough to notice,
    // and anything strong enough to notice is strong enough to misreport the
    // words it lands on as disabled. So the fade stays gentle and these carry
    // the reading: a hairline exactly on the rule the content passes under,
    // and a short shade rising off it. They appear and disappear with the same
    // at-top / at-bottom state as the chevron. Decoration: aria-hidden,
    // pointer-transparent, not focusable, so the trap keeps exactly its stops.
    this.edgeTopEl = el('div', { class: 'modal-edge modal-edge-top', 'aria-hidden': 'true' });
    this.edgeBotEl = el('div', { class: 'modal-edge modal-edge-bottom', 'aria-hidden': 'true' });

    this.panelEl = el(
      'div',
      {
        class: `modal modal-${this.size}${this.className ? ` ${this.className}` : ''}`,
        role: 'dialog',
        'aria-modal': 'true',
        tabindex: '-1',
      },
      this.grabEl,
      this.headEl,
      this.bodyEl,
      this.footEl,
      this.edgeTopEl,
      this.edgeBotEl,
      this.moreEl
    );
    if (this.title) this.panelEl.setAttribute('aria-labelledby', this._titleId);
    else this.panelEl.setAttribute('aria-label', 'Dialog');

    this.backdropEl = el('div', { class: 'modal-backdrop' });
    this.rootEl = el(
      'div',
      { class: 'modal-layer', 'data-state': 'enter' },
      this.backdropEl,
      this.panelEl
    );

    this.backdropEl.addEventListener('click', () => {
      if (this.dismissible) this.close(null);
    });
    this.rootEl.addEventListener('mousedown', (event) => {
      // Clicking the padding around the panel counts as backdrop.
      if (event.target === this.rootEl && this.dismissible) this._backdropArmed = true;
    });
    this.rootEl.addEventListener('click', (event) => {
      if (event.target === this.rootEl && this._backdropArmed) {
        this._backdropArmed = false;
        if (this.dismissible) this.close(null);
      }
    });

    this._wireDrag();
  }

  _wireDrag() {
    let startY = 0;
    let dy = 0;
    let dragging = false;
    const sheet = () => matchMedia('(max-width: 640px)').matches;

    const down = (event) => {
      if (!this.dismissible || !sheet()) return;
      dragging = true;
      startY = event.clientY;
      dy = 0;
      this.panelEl.classList.add('is-dragging');
      this.grabEl.setPointerCapture?.(event.pointerId);
    };
    const move = (event) => {
      if (!dragging) return;
      dy = Math.max(0, event.clientY - startY);
      this.panelEl.style.transform = `translate3d(0, ${dy}px, 0)`;
      this.backdropEl.style.opacity = String(Math.max(0.25, 1 - dy / 320));
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      this.panelEl.classList.remove('is-dragging');
      this.panelEl.style.transform = '';
      this.backdropEl.style.opacity = '';
      if (dy > 110) this.close(null);
    };

    this.grabEl.addEventListener('pointerdown', down);
    this.grabEl.addEventListener('pointermove', move);
    this.grabEl.addEventListener('pointerup', up);
    this.grabEl.addEventListener('pointercancel', up);
  }

  _activate(index) {
    const descriptor = this.buttons[index];
    if (!descriptor) return;
    let value = null;
    try {
      value = descriptor.onClick ? descriptor.onClick(this) : null;
    } catch (err) {
      console.error('[modal] button handler failed', err);
    }
    if (descriptor.keepOpen === true) return;
    if (value && typeof value.then === 'function') {
      value.then(
        (resolved) => {
          if (resolved !== KEEP_OPEN) this.close(resolved === undefined ? null : resolved);
        },
        (err) => {
          console.error('[modal] button handler rejected', err);
          this.close(null);
        }
      );
      return;
    }
    if (value === KEEP_OPEN) return;
    this.close(value === undefined ? null : value);
  }

  setBody(content) {
    this.bodyEl.textContent = '';
    if (content instanceof Node) this.bodyEl.appendChild(content);
    else this.bodyEl.innerHTML = String(content ?? '');
    this._watchBody();
    this._syncScroll();
    return this;
  }

  /** Re-point the observer at the new content so a body that grows is caught. */
  _watchBody() {
    if (!this._ro) return;
    this._ro.disconnect();
    this._ro.observe(this.bodyEl);
    for (const child of this.bodyEl.children) this._ro.observe(child);
  }

  /** Coalesces a burst of mutations into one measurement on the next frame. */
  _queueSync() {
    if (this._syncQueued) return;
    this._syncQueued = true;
    requestAnimationFrame(() => {
      this._syncQueued = false;
      this._syncScroll();
    });
  }

  _syncScroll() {
    const body = this.bodyEl;
    const max = body.scrollHeight - body.clientHeight;
    const scrollable = max > 4;
    const top = body.scrollTop;
    body.classList.toggle('is-scrollable', scrollable);
    body.classList.toggle('at-top', !scrollable || top <= 2);
    body.classList.toggle('at-bottom', !scrollable || top >= max - 2);
    // The chevron and the two fold marks sit on the head and footer rules,
    // whose heights are not constants: the tray wraps, and in sheet mode a grab
    // handle appears above the title. Offsets, not scaled rects, so a panel
    // measured mid-entrance still lands on the right pixel.
    this.panelEl.style.setProperty(
      '--foot-h',
      `${this.footEl.hidden ? 0 : this.footEl.offsetHeight}px`
    );
    this.panelEl.style.setProperty(
      '--head-h',
      `${this.headEl.offsetTop + this.headEl.offsetHeight}px`
    );
  }

  /** Focus the best starting element: [autofocus], else primary button, else first. */
  _focusStart() {
    const marked = this.panelEl.querySelector('[autofocus],[data-autofocus]');
    if (marked) {
      marked.focus({ preventScroll: true });
      return;
    }
    const primary = this.buttonEls.find(
      (b, i) => !b.disabled && this.buttons[i] && this.buttons[i].variant === 'primary'
    );
    if (primary) {
      primary.focus({ preventScroll: true });
      return;
    }
    const items = focusablesIn(this.panelEl);
    (items[0] || this.panelEl).focus({ preventScroll: true });
  }

  open() {
    if (this._openPromise) return this._openPromise;

    this._prevFocus = openerOf(document.activeElement);
    const mount = resolveMount('modal-root');

    // Layer below goes inert so only the top modal is reachable.
    const below = topModal();
    if (below) below.rootEl.inert = true;

    this.rootEl.style.setProperty('--modal-depth', String(stack.length));
    // How much room the panel keeps clear at the top so its own frame does not
    // draw a line through the title in the bar behind it. Measured, because the
    // bar wraps to two rows on a narrow window.
    const bar = document.getElementById('topbar');
    const clear = bar ? Math.round(bar.getBoundingClientRect().bottom) : 0;
    this.rootEl.style.setProperty('--modal-clear-top', `${clear > 0 ? clear + 12 : 0}px`);
    this.footEl.hidden = !this.buttonEls.length && !this.footExtraEl.childElementCount;
    mount.appendChild(this.rootEl);

    stack.push(this);
    lockScroll();
    startListening();
    this.isOpen = true;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.rootEl.isConnected && !this.isClosing) this.rootEl.dataset.state = 'open';
        this._syncScroll();
        // Re-assert the starting focus. At boot the terminal mounts and calls
        // input.focus() on itself AFTER this panel opened, which left the caret
        // outside a dialog that had just told assistive tech - via aria-modal -
        // that nothing outside it exists: the lesson was never announced. The
        // focusin guard cannot catch that, because the steal happens while the
        // panel is still being laid out. Claiming it back on the frame the
        // panel actually appears is the one point that is always after every
        // sibling's mount. Anything the reader has already reached inside the
        // panel is left exactly where it is.
        if (this.isOpen && !this.isClosing && !this.panelEl.contains(document.activeElement)) {
          this._focusStart();
        }
      });
    });
    // Late arrivals: a font swapping in, an image decoding, a child view that
    // finishes drawing after its first frame. Each one changes the scroll height
    // without touching a watched box, and a stale measurement here is what turns
    // the bottom fade off and guillotines the last line.
    this._lateSyncs = [60, 320, 900].map((ms) =>
      setTimeout(() => {
        if (this.isOpen) this._syncScroll();
      }, ms)
    );
    document.fonts?.ready?.then(() => {
      if (this.isOpen) this._syncScroll();
    });
    this._watchBody();
    this._syncScroll();
    this._focusStart();

    this._openPromise = new Promise((resolve) => {
      this._resolve = resolve;
    });
    return this._openPromise;
  }

  close(value = null) {
    if (!this.isOpen) return Promise.resolve(value);
    if (this._closePromise) return this._closePromise;
    this.isClosing = true;

    this._closePromise = (async () => {
      this.rootEl.dataset.state = 'exit';
      await settle(this.panelEl, EXIT_MS);

      this.rootEl.remove();
      if (this._ro) this._ro.disconnect();
      if (this._mo) this._mo.disconnect();
      (this._lateSyncs || []).forEach(clearTimeout);
      this._lateSyncs = [];
      this.onClosed?.();
      const at = stack.indexOf(this);
      if (at >= 0) stack.splice(at, 1);
      unlockScroll();
      if (!stack.length) stopListening();

      const below = topModal();
      if (below) {
        below.rootEl.inert = false;
        if (!below.panelEl.contains(document.activeElement)) below._focusStart();
      } else if (this._prevFocus && this._prevFocus.isConnected) {
        this._prevFocus.focus({ preventScroll: true });
      } else {
        // No opener, or the opener has since left the page.
        focusFallback();
      }

      this.isOpen = false;
      this.isClosing = false;
      if (this._resolve) this._resolve(value);
      return value;
    })();

    return this._closePromise;
  }
}

Modal.KEEP_OPEN = KEEP_OPEN;
Modal.ENTER_MS = ENTER_MS;
Modal.EXIT_MS = EXIT_MS;

/**
 * Small yes/no dialog. Resolves true when confirmed.
 * Footer order is the house order everywhere: secondary first, primary last.
 */
export async function confirmModal({
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
} = {}) {
  const modal = new Modal({
    title,
    body: el('p', { class: 'modal-message' }, message),
    size: 'sm',
    className: danger ? 'modal-confirm modal-danger' : 'modal-confirm',
    buttons: [
      { label: cancelLabel, variant: 'ghost', key: 'Escape', onClick: () => false },
      {
        label: confirmLabel,
        variant: danger ? 'danger' : 'primary',
        icon: danger ? 'warning' : 'check',
        onClick: () => true,
      },
    ],
  });
  return (await modal.open()) === true;
}

// --- victory --------------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Body of the end-of-level panel. Every field is optional: rows the caller
 * cannot fill are simply left out, so an old caller still gets a sane panel.
 */
export function victoryBody({
  levelName = '',
  sequenceName = '',
  commandCount = null,
  bestCount = null,
  solvedCount = null,
  totalCount = null,
} = {}) {
  const par = Number.isFinite(bestCount) && Number.isFinite(commandCount) && commandCount <= bestCount;

  // Purely decorative: an aqua bloom with bubbles rising through it.
  const burst = el(
    'div',
    { class: 'victory-burst', 'aria-hidden': 'true' },
    ...Array.from({ length: 6 }, (_, i) => el('i', { class: `victory-bubble b${i + 1}` }))
  );

  const stats = el('div', { class: 'victory-stats' });
  if (Number.isFinite(commandCount)) {
    stats.appendChild(
      el(
        'div',
        { class: 'victory-stat' },
        el('b', {}, String(commandCount)),
        el('span', {}, commandCount === 1 ? 'command' : 'commands')
      )
    );
  }
  if (Number.isFinite(bestCount)) {
    stats.appendChild(
      el(
        'div',
        { class: `victory-stat${par ? ' is-par' : ''}` },
        el('b', {}, String(bestCount)),
        el('span', {}, par ? 'the best known' : 'best known')
      )
    );
  }

  const rows = [
    burst,
    el(
      'div',
      { class: 'victory-mark', 'aria-hidden': 'true' },
      icon(par ? 'star' : 'check'),
    ),
    sequenceName ? el('p', { class: 'victory-eyebrow' }, sequenceName) : null,
    levelName ? el('h3', { class: 'victory-level' }, levelName) : null,
    stats.childElementCount ? stats : null,
    par
      ? el(
          'p',
          { class: 'victory-note is-par' },
          icon('sparkle'),
          el('span', {}, 'That matches the shortest solution anyone knows.')
        )
      : Number.isFinite(bestCount)
        ? el(
            'p',
            { class: 'victory-note' },
            el('span', {}, `A tighter answer exists in ${plural(bestCount, 'command')}.`)
          )
        : null,
  ].filter(Boolean);

  if (Number.isFinite(solvedCount) && Number.isFinite(totalCount) && totalCount > 0) {
    const percent = Math.round((solvedCount / totalCount) * 100);
    rows.push(
      el(
        'div',
        { class: 'victory-progress' },
        el('p', { class: 'victory-progress-text' }, `${solvedCount} of ${totalCount} levels solved`),
        el(
          'div',
          {
            class: 'meter',
            role: 'progressbar',
            'aria-label': 'Levels solved',
            'aria-valuemin': '0',
            'aria-valuemax': '100',
            'aria-valuenow': String(percent),
            'aria-valuetext': `${solvedCount} of ${totalCount} levels solved`,
          },
          el('i', { class: 'meter-fill', style: { '--p': `${percent}%` } })
        )
      )
    );
  }

  return el('div', { class: 'victory' }, ...rows);
}

/**
 * The end-of-level payoff panel. Everything is optional; pass what you know.
 *
 * @param {object}  info
 * @param {string}  info.levelName        name of the level just solved
 * @param {string}  [info.sequenceName]   e.g. "First Steps"
 * @param {number}  [info.commandCount]   commands the reader actually used
 * @param {number}  [info.bestCount]      length of the best known solution
 * @param {number}  [info.solvedCount]    levels solved after this one
 * @param {number}  [info.totalCount]     levels in the whole app
 * @param {string}  [info.nextLevelName]  omit when this was the last level
 * @returns {Promise<'next'|'stay'|'levels'|null>} null when dismissed.
 */
export function victoryModal(info = {}) {
  const next = info.nextLevelName ? String(info.nextLevelName) : '';
  // House rule for a footer row: a secondary is a wordmark. Icons are for the
  // primary, for anything destructive, and for a directional pair (Back/Next),
  // so a tray never shows one button with a glyph and the one beside it without
  // for no reason the reader can see. "Level list" used to carry one and "Stay
  // here" did not.
  const buttons = [
    { label: 'Level list', variant: 'ghost', onClick: () => 'levels' },
    { label: 'Stay here', variant: 'ghost', onClick: () => 'stay' },
  ];
  if (next) {
    buttons.push({
      label: `Next: ${next}`,
      variant: 'primary',
      iconEnd: 'next',
      key: 'Enter',
      onClick: () => 'next',
    });
  }

  const modal = new Modal({
    title: 'Solved',
    body: victoryBody(info),
    size: 'md',
    className: 'modal-victory',
    buttons,
  });
  // The full name survives even when the pill has to clip it.
  if (next) {
    const primary = modal.buttonEls[modal.buttonEls.length - 1];
    primary.title = `Next level: ${next}`;
  }
  return modal.open();
}
