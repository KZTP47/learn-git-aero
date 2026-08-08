// Terminal - the command console. Owns this file and css/terminal.css only.
//
// Five things here are less obvious than they look:
//
// 1. The caret is ours, not the browser's. A real <input> keeps mobile
//    keyboards, IME composition and native selection working; `caret-color:
//    transparent` hides the system caret and we draw our own on top. Its x
//    position is measured with a mirror <span> that inherits the input's exact
//    font, so it stays correct when the mono stack falls back to a
//    proportional face - a character count would drift immediately.
// 2. Keystrokes that land while `setBusy(true)` is in effect are buffered and
//    replayed, so typing during a tree animation never silently disappears.
// 3. The log only autoscrolls while the user is parked at the bottom. Scroll
//    up to read and the "jump to latest" pill takes over.
// 4. Tab is only ever swallowed when a completion is genuinely on offer, and
//    Shift+Tab is never swallowed at all - not mid-cycle, not mid-search. The
//    terminal sits before the commit graph in DOM order, so a greedy Tab would
//    strand every control after it: the divider, the zoom buttons, the goal
//    panel. A key that silently does nothing is worse than one that navigates,
//    so Tab with nothing left to complete stays the browser's own way out of
//    the field. F6 steps out from anywhere, mid-line included.
// 5. The pane is far taller than a few lines of output, so something has to be
//    said about the room left over. Output fills from the top under a capped
//    lead-in, which puts the unwritten part of the screen after the last line
//    where a terminal keeps it, and two pieces of furniture explain the rest -
//    different rules for different reasons:
//      - The hero (mark, headline, lede, starter card) is a description of an
//        empty screen: "what you type and what git says back both land here".
//        The moment one line exists that sentence is false and the card is
//        competing with real output, so the hero is keyed on the scrollback
//        being *empty*, not on there being room for it. Height only picks which
//        tier of the hero fits.
//      - The key strip says what the keyboard does, which is true in every
//        state, so it lives in the terminal's chrome above the field it
//        describes and is never dropped. Bundled with the hero it measured 0px
//        at every width at or below 900 - the one binding that gets a keyboard
//        user out of the field, invisible exactly when the pane is tightest.
//    Nothing here stretches: every pad is capped, so extra viewport height is
//    left as unwritten screen after the last line rather than being spread
//    through the furniture as growing holes.

import { bus } from '../core/events.js';
import { el, svgEl, renderMarkdown, prefersReducedMotion, clamp } from '../core/util.js';

const MESSAGE_TYPES = new Set(['info', 'error', 'warning', 'log', 'success', 'command']);
// Plain output gets a neutral dash so every row starts in the same column;
// an indent with nothing in it reads as a mistake.
const ICON_FOR = { error: 'error', warning: 'warning', success: 'success', info: 'info', log: 'dash' };

// The strip above the prompt. These are the bindings people do not expect a
// browser terminal to have. F6 earns its place because it is the one way out of
// the field that works mid-line, and a sighted keyboard-only user had no way to
// discover it: the sr-only description is the only other place it is written
// down. It rides in the terminal's own chrome rather than inside the empty-state
// pad, because it is the way out of a keyboard trap and must not disappear with
// the decoration when the scrollback fills or the pane gets short.
const KEY_HINTS = [
  ['Tab', 'complete'],
  ['Up', 'history'],
  ['Ctrl+R', 'search'],
  ['Ctrl+L', 'clear'],
  ['F6', 'exit'],
];

// Offered on the empty pane. Filtered against completions() before rendering,
// so a build that cannot run one of these never advertises it.
// The first three survive into the cramped tier, so they are the three a
// beginner needs first.
const STARTERS = [
  ['git commit', 'record a snapshot'],
  ['git branch', 'start a new line of work'],
  ['git checkout', 'move HEAD somewhere else'],
  ['git merge', 'join two lines back together'],
  ['git log', 'list the history you can reach'],
  ['help', 'every command, with examples'],
];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const MAX_HISTORY = 400;
const MAX_LINES = 1200; // scrollback cap; older lines are dropped
const REVEAL_MAX = 24; // above this many lines at once we skip the reveal
const BOTTOM_SLACK = 26; // px from the bottom that still counts as "at the bottom"
// Free px each tier of the empty-state hero needs. Below the last of them the
// hero goes entirely; the key strip is not part of this budget because it no
// longer lives inside the pad.
const FIT_FULL = 356; // mark, headline, all six starter rows
const FIT_MID = 214; // headline plus the first three rows
const FIT_LITE = 116; // headline only

// --- icons ----------------------------------------------------------------
// Everything comes from the shared sprite. Its symbols carry their own
// presentation attributes, so a cross-document <use> renders correctly and
// still picks up `color` from this document. Resolved against import.meta.url
// so the path works from any page depth (the fixtures page lives in test/).

const SPRITE_URL = new URL('../../assets/icons.svg', import.meta.url).href;
const ICON_ID = {
  terminal: 'icon-terminal',
  chevron: 'icon-chevron-right',
  error: 'icon-error',
  warning: 'icon-warning',
  success: 'icon-success',
  info: 'icon-info',
  copy: 'icon-copy',
  check: 'icon-check',
  down: 'icon-chevron-down',
  search: 'icon-search',
  dash: 'icon-minus',
};

function resolveIcon(name) {
  const id = ICON_ID[name] || name;
  // If the sprite is inlined in the host document, use it and skip the request.
  return document.getElementById(id) ? `#${id}` : `${SPRITE_URL}#${id}`;
}

function icon(name, cls) {
  return svgEl(
    'svg',
    {
      class: cls ? `term__icon ${cls}` : 'term__icon',
      viewBox: '0 0 24 24',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    svgEl('use', { href: resolveIcon(name) })
  );
}

// --- helpers --------------------------------------------------------------

function commonPrefix(list) {
  if (!list.length) return '';
  let prefix = list[0];
  for (const item of list.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < item.length && prefix[i].toLowerCase() === item[i].toLowerCase()) i += 1;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

// A percentage height inside an auto-height parent resolves to auto, so an
// empty probe stays 0px tall. That tells us whether we can safely fill the host.
function hostHasDefiniteHeight(host) {
  if (!host.getClientRects().length) return true; // hidden: assume the layout is fine
  const probe = document.createElement('div');
  probe.style.cssText = 'height:100%;width:0;padding:0;border:0;flex:0 0 auto;';
  host.appendChild(probe);
  const definite = probe.offsetHeight > 0;
  probe.remove();
  return definite;
}

let instanceCount = 0;

export class Terminal {
  constructor(host, options = {}) {
    if (!host) throw new Error('[terminal] a host element is required');

    this.host = host;
    this.onCommand = typeof options.onCommand === 'function' ? options.onCommand : async () => {};
    this.completions = typeof options.completions === 'function' ? options.completions : () => [];

    this.uid = `term-${++instanceCount}`;
    this.history = [];
    this.historyIndex = null; // null = editing a fresh line
    this.draft = ''; // in-progress line parked while walking history
    this.busy = false;
    this.pending = []; // keystrokes captured while busy
    this.flushing = false;
    this.stick = true; // autoscroll while parked at the bottom
    this.unread = 0;
    this.composing = false;
    this.pendingEcho = null; // command already echoed by _submit()
    this.burst = []; // append timestamps, used to skip animation on floods
    this.syncToken = 0;
    this.comp ={ list: [], index: -1, stem: '', cycling: false, token: '' };
    this.ghost = '';
    this.search = { active: false, query: '', index: -1, restore: '' };
    this.disposers = [];

    this._build();
    this._wire();
  }

  // --- construction -------------------------------------------------------

  _build() {
    const inputId = `${this.uid}-input`;
    const hintId = `${this.uid}-hint`;

    this.logEl = el('div', {
      class: 'term__log',
      id: `${this.uid}-log`,
      role: 'log',
      'aria-live': 'polite',
      'aria-relevant': 'additions text',
      'aria-atomic': 'false',
      'aria-label': 'Terminal output',
      tabindex: '0',
    });

    this.jumpEl = el(
      'button',
      { class: 'term__jump', type: 'button', hidden: true },
      icon('down'),
      el('span', { class: 'term__jump-text' }, 'Jump to latest')
    );

    this.keysEl = el(
      'div',
      { class: 'term__keys' },
      KEY_HINTS.map(([key, label]) =>
        el('span', { class: 'term__keyhint' }, el('kbd', { class: 'term__kbd' }, key), label)
      )
    );

    this.startEl = el('ul', { class: 'term__starters' });
    this.cardEl = el(
      'div',
      { class: 'term__card' },
      el('p', { class: 'term__card-label' }, 'Try one of these'),
      this.startEl
    );

    // Sits in the room an empty scrollback leaves, out of the log's own flow, so
    // showing it can never move a line. aria-hidden and click-through: it says
    // nothing the field's description does not already say, and nothing in it is
    // a control. The pad is a fixed-size block pinned under the title bar - it
    // never stretches to swallow the pane, so a taller viewport grows the empty
    // scrollback below it instead of pulling this block apart.
    this.introEl = el(
      'div',
      { class: 'term__intro', 'aria-hidden': 'true', hidden: true },
      el('span', { class: 'term__intro-pad' }),
      el(
        'div',
        { class: 'term__intro-body' },
        icon('terminal', 'term__intro-mark'),
        el('p', { class: 'term__intro-title' }, 'Ready for a command'),
        el(
          'p',
          { class: 'term__intro-lede' },
          'What you type and what git says back both land here.'
        ),
        this.cardEl
      )
    );

    this.searchEl = el(
      'div',
      { class: 'term__search', hidden: true },
      icon('search', 'term__search-icon'),
      el('span', { class: 'term__search-label' }, 'reverse-i-search'),
      el('span', { class: 'term__search-q' }),
      el('span', { class: 'term__search-match' })
    );

    this.mirror = el('span', { class: 'term__mirror', 'aria-hidden': 'true' });
    this.caretEl = el('span', { class: 'term__caret', 'aria-hidden': 'true' });
    this.ghostEl = el('span', { class: 'term__ghost', 'aria-hidden': 'true' });

    this.input = el('input', {
      class: 'term__input',
      id: inputId,
      type: 'text',
      autocomplete: 'off',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: false,
      enterkeyhint: 'go',
      'aria-describedby': hintId,
      'aria-autocomplete': 'list',
    });

    this.busyEl = el(
      'span',
      { class: 'term__busy', role: 'status' },
      el('span', { class: 'term__busy-dots', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')),
      el('span', { class: 'term__sr' })
    );

    this.promptEl = el(
      'div',
      { class: 'term__prompt' },
      el(
        'label',
        { class: 'term__label', for: inputId },
        icon('chevron', 'term__chev'),
        el('span', { class: 'term__sr' }, 'Command')
      ),
      el(
        'div',
        { class: 'term__field' },
        this.input,
        el('span', { class: 'term__overlay', 'aria-hidden': 'true' }, this.mirror, this.ghostEl, this.caretEl)
      ),
      this.busyEl
    );

    this.root = el(
      'div',
      { class: 'term', 'data-term': this.uid },
      el(
        'div',
        { class: 'term__bar' },
        icon('terminal', 'term__bar-icon'),
        el('span', { class: 'term__bar-title' }, 'Terminal'),
        el('span', { class: 'term__bar-dots', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'))
      ),
      el('div', { class: 'term__body' }, this.logEl, this.introEl, this.jumpEl),
      this.keysEl,
      this.searchEl,
      this.promptEl,
      el(
        'p',
        { class: 'term__sr', id: hintId },
        'Type a git command and press Enter. Up and Down arrows walk your history, ' +
          'Control L clears the screen, Control C abandons the line, ' +
          'Control R searches your history. ' +
          'Tab completes the command you have started, and steps through the choices ' +
          'when more than one matches; when there is nothing left to complete, Tab ' +
          'moves focus to the next control instead. ' +
          'Shift Tab always moves focus to the previous control. ' +
          'Escape closes an open list of choices. ' +
          'Press F6 to move focus out of the terminal to the commit graph, or Shift F6 ' +
          'to move back the other way.'
      )
    );

    this.host.appendChild(this.root);
    if (!hostHasDefiniteHeight(this.host)) this.root.classList.add('term--auto');
    this._buildStarters();
    this._syncCaret();
    this._syncFill();
  }

  // Cosmetic, and it runs during construction: a host that never got this far
  // must not take the whole app down with it. The empty state degrades to its
  // headline, which is the tier a short pane shows anyway.
  _buildStarters() {
    if (!this.startEl || !this.cardEl) return;

    let offered;
    try {
      offered = new Set(this.completions() || []);
    } catch (err) {
      console.error('[terminal] completions() threw', err);
      offered = new Set();
    }
    const rows = STARTERS.filter(([cmd]) => offered.has(cmd));
    this.startEl.replaceChildren(
      ...rows.map(([cmd, why]) =>
        el(
          'li',
          { class: 'term__starter' },
          el('code', { class: 'term__starter-cmd' }, cmd),
          el('span', { class: 'term__starter-why' }, why)
        )
      )
    );
    this.cardEl.hidden = rows.length === 0;
  }

  _wire() {
    const add = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this.disposers.push(() => target.removeEventListener(type, fn, opts));
    };

    add(this.input, 'keydown', (e) => this._onKeyDown(e));
    add(this.input, 'input', () => this._onInput());
    add(this.input, 'scroll', () => this._syncCaret());
    add(this.input, 'click', () => this._onCaretMove());
    add(this.input, 'select', () => this._onCaretMove());
    add(this.input, 'keyup', () => this._onCaretMove());
    add(this.input, 'compositionstart', () => {
      this.composing = true;
      this._setGhost('');
    });
    add(this.input, 'compositionend', () => {
      this.composing = false;
      this._onInput();
    });
    add(this.input, 'focus', () => {
      this._syncFocus();
      this._syncCaret();
    });
    add(this.input, 'blur', () => this._syncFocus());

    add(this.logEl, 'scroll', () => this._onScroll(), { passive: true });
    add(this.jumpEl, 'click', () => this.scrollToBottom(true));

    // Click anywhere to focus - unless the user just selected text (they are
    // copying output) or clicked something interactive.
    add(this.root, 'pointerup', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target.closest('button, a, input, textarea, select, [contenteditable]')) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && String(selection).trim()) return;
      this.focus();
    });

    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => {
        this._syncCaret();
        this._syncFill();
      });
      this.ro.observe(this.promptEl);
      this.ro.observe(this.logEl);
      this.disposers.push(() => this.ro.disconnect());
    }

    this.disposers.push(bus.on('theme:changed', () => this._syncCaret()));
  }

  // --- public API ---------------------------------------------------------

  print(text, type = 'log') {
    const line = this._createLine(String(text ?? ''), MESSAGE_TYPES.has(type) ? type : 'log');
    this._append(line);
    return line;
  }

  printResult(result) {
    if (!result) return;

    const input = typeof result.input === 'string' ? result.input : '';
    if (input) {
      // _submit() already echoed what the user typed; only echo commands that
      // arrived some other way (a lesson demo, "run the solution for me").
      if (this.pendingEcho !== null && this.pendingEcho === input.trim()) this.pendingEcho = null;
      else this.print(input, 'command');
    }
    this.pendingEcho = null;

    const messages = Array.isArray(result.messages) ? result.messages : [];
    for (const message of messages) {
      if (!message) continue;
      this.print(message.text ?? '', message.type);
    }

    const error = result.error;
    if (error && error.text && !messages.some((m) => m && m.text === error.text)) {
      this.print(error.text, error.type === 'Warning' ? 'warning' : 'error');
    }
  }

  printMarkdown(md) {
    const block = el('div', { class: 'term__line term__line--md', dataset: { type: 'log' } });
    const body = el('div', { class: 'term__md' });
    body.innerHTML = renderMarkdown(md); // renderMarkdown escapes its input
    this._decorateCode(body);
    block.appendChild(body);
    this._append(block);
    return block;
  }

  setBusy(flag) {
    const next = Boolean(flag);
    if (next === this.busy) return;
    this.busy = next;

    this.root.classList.toggle('is-busy', next);
    this.root.setAttribute('aria-busy', String(next));
    this.input.readOnly = next;
    this.input.setAttribute('aria-disabled', String(next));
    this.busyEl.querySelector('.term__sr').textContent = next ? 'Running command' : '';

    if (next) this._setGhost('');
    else this._flushPending();
    this._syncCaret();
  }

  focus() {
    try {
      this.input.focus({ preventScroll: true });
    } catch {
      this.input.focus();
    }
    this._syncFocus();
    this._syncCaret();
  }

  // Drives the focus ring. Read from activeElement rather than trusting the
  // focus event alone: a window that does not have OS focus never fires one,
  // and the app still routes every keystroke here.
  _syncFocus() {
    this.root.classList.toggle('is-focused', document.activeElement === this.input);
  }

  clear() {
    this.logEl.replaceChildren();
    this.unread = 0;
    this.stick = true;
    this.jumpEl.hidden = true;
    this.logEl.scrollTop = 0;
    this._syncFill();
  }

  getHistory() {
    return this.history.slice();
  }

  setHistory(list) {
    const clean = [];
    for (const item of Array.isArray(list) ? list : []) {
      const value = typeof item === 'string' ? item.trim() : '';
      if (!value || value === clean[clean.length - 1]) continue;
      clean.push(value);
    }
    this.history = clean.slice(-MAX_HISTORY);
    this.historyIndex = null;
    this.draft = '';
  }

  scrollToBottom(smooth = false) {
    this.stick = true;
    this.unread = 0;
    this.jumpEl.hidden = true;
    const top = this.logEl.scrollHeight;
    if (smooth && !prefersReducedMotion()) this.logEl.scrollTo({ top, behavior: 'smooth' });
    else this.logEl.scrollTop = top;
    this._syncFill();
  }

  destroy() {
    for (const off of this.disposers) {
      try {
        off();
      } catch {
        /* listener already gone */
      }
    }
    this.disposers = [];
    this.root.remove();
  }

  // --- output -------------------------------------------------------------

  _createLine(text, type) {
    const line = el('div', { class: 'term__line', dataset: { type } });

    if (type === 'command') {
      line.append(icon('chevron', 'term__line-chev'), el('span', { class: 'term__cmd' }, text));
      return line;
    }

    const iconName = ICON_FOR[type];
    if (iconName) line.append(icon(iconName, 'term__line-icon'));

    const body = el('div', { class: 'term__msg' });
    const rows = text.split('\n');
    const reveal = rows.length > 1 && rows.length <= REVEAL_MAX && !prefersReducedMotion();

    rows.forEach((row, i) => {
      const node = el('span', { class: 'term__ln' }, row === '' ? ' ' : row);
      if (reveal) {
        node.classList.add('is-typing');
        node.style.setProperty('--d', `${i * 26}ms`);
        node.addEventListener('animationend', () => node.classList.remove('is-typing'), { once: true });
      }
      body.appendChild(node);
    });

    line.appendChild(body);
    return line;
  }

  _append(node) {
    const now = performance.now();
    this.burst = this.burst.filter((t) => now - t < 260);
    this.burst.push(now);
    if (this.burst.length > REVEAL_MAX || prefersReducedMotion()) node.classList.add('term__line--flat');

    this.logEl.appendChild(node);
    while (this.logEl.childElementCount > MAX_LINES) this.logEl.firstElementChild.remove();

    this._scheduleSync();
    if (!this.stick) {
      this.unread += 1;
      this.jumpEl.hidden = false;
      this.jumpEl.querySelector('.term__jump-text').textContent =
        this.unread > 1 ? `${this.unread} new lines` : 'Jump to latest';
    }
  }

  // Coalesced so a 200-line burst costs one layout, not two hundred.
  // Background tabs get a timer because rAF is parked there.
  _scheduleSync() {
    if (this.syncToken) return;
    const run = () => {
      this.syncToken = 0;
      if (this.stick) this.logEl.scrollTop = this.logEl.scrollHeight;
      this._syncFill();
    };
    this.syncToken = document.hidden ? setTimeout(run, 0) : requestAnimationFrame(run);
  }

  // Two independent questions decide what the empty-state hero does:
  //
  //   Is the scrollback empty? The hero's words - "Ready for a command", "what
  //   you type and what git says back both land here" - describe a screen with
  //   nothing on it. One line and they are a lie printed above the truth, and
  //   the starter card is then competing with real output for the eye. So the
  //   hero is gated on the line count, never on there merely being room for it.
  //   That is also why the free height is simply the log's height: the only
  //   state that shows a hero is the one with nothing else in the box.
  //
  //   Does it fit? Only then does height pick a tier, so a squeezed pane sheds
  //   the heavy parts rather than clipping them.
  //
  // The pad lives outside the log's flow, so this measurement cannot feed back
  // into itself: showing or hiding it never moves a line.
  _syncFill() {
    const log = this.logEl;
    if (!log || !this.introEl) return;
    const box = log.getBoundingClientRect();
    if (!box.height) return; // not laid out yet; the ResizeObserver will call back

    const empty = !log.firstElementChild;
    const free = empty ? box.height : 0;

    const fit = !empty
      ? 'none'
      : free >= FIT_FULL
        ? 'full'
        : free >= FIT_MID
          ? 'mid'
          : free >= FIT_LITE
            ? 'lite'
            : 'none';

    this.introEl.style.setProperty('--term-free', `${Math.max(0, Math.round(free))}px`);
    this.introEl.dataset.fit = fit;
    this.introEl.hidden = fit === 'none';
    this._syncEdges();
  }

  // The scrollback is a hard-edged window cut into a rounded glass card, so a
  // row sliced through the middle at either end reads as a rendering fault
  // rather than as "there is more this way". Fade whichever end is actually
  // hiding something; never both-by-default, or the first line of a short log
  // would sit behind a gradient for no reason.
  _syncEdges() {
    const log = this.logEl;
    const room = log.scrollHeight - log.clientHeight;
    log.classList.toggle('is-cut-top', log.scrollTop > 1);
    log.classList.toggle('is-cut-bottom', room - log.scrollTop > 1);
  }

  _onScroll() {
    const log = this.logEl;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight <= BOTTOM_SLACK;
    this.stick = atBottom;
    if (atBottom) {
      this.unread = 0;
      this.jumpEl.hidden = true;
    } else if (log.scrollHeight > log.clientHeight + BOTTOM_SLACK) {
      this.jumpEl.hidden = false;
    }
    this._syncEdges();
  }

  _decorateCode(container) {
    for (const pre of container.querySelectorAll('pre')) {
      const wrap = el('div', { class: 'term__code' });
      pre.replaceWith(wrap);
      wrap.appendChild(pre);

      const label = el('span', { class: 'term__copy-text' }, 'Copy');
      const button = el(
        'button',
        { class: 'term__copy', type: 'button', 'aria-label': 'Copy code to the clipboard' },
        icon('copy', 'term__copy-icon'),
        label
      );
      button.addEventListener('click', async () => {
        const ok = await copyText(pre.textContent || '');
        button.classList.toggle('is-done', ok);
        button.classList.toggle('is-failed', !ok);
        label.textContent = ok ? 'Copied' : 'Press Ctrl+C';
        setTimeout(() => {
          button.classList.remove('is-done', 'is-failed');
          label.textContent = 'Copy';
        }, 1600);
      });
      wrap.appendChild(button);
    }
  }

  // --- input --------------------------------------------------------------

  // Cycling survives events that leave the line untouched - notably the keyup
  // of the very Tab press that armed it.
  _compToken() {
    return `${this.input.selectionStart}|${this.input.value}`;
  }

  _dropStaleCycle() {
    if (this.comp.cycling && this.comp.token !== this._compToken()) this.comp.cycling = false;
  }

  _onInput() {
    if (this.composing) return;
    this._dropStaleCycle();
    this.historyIndex = null;
    if (this.search.active) this._searchUpdate(this.input.value);
    else this._refreshGhost();
    this._syncCaret();
  }

  _onCaretMove() {
    this._dropStaleCycle();
    if (!this.search.active) this._refreshGhost();
    this._syncCaret();
  }

  _onKeyDown(e) {
    if (e.isComposing) return;

    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    const key = e.key;

    if (ctrl && key.toLowerCase() === 'l') {
      e.preventDefault();
      this.clear();
      return;
    }
    if (ctrl && key.toLowerCase() === 'c') {
      e.preventDefault();
      this._cancelLine();
      return;
    }

    if (this.busy) {
      this._captureWhileBusy(e);
      return;
    }

    if (this.search.active && this._searchKey(e)) return;

    if (ctrl) {
      const lower = key.toLowerCase();
      if (lower === 'r') {
        e.preventDefault();
        this._searchStep();
        return;
      }
      if (lower === 'u') {
        e.preventDefault();
        this._setValue('');
        return;
      }
      if (lower === 'a') {
        e.preventDefault();
        this._setCaret(0);
        return;
      }
      if (lower === 'e') {
        e.preventDefault();
        this._setCaret(this.input.value.length);
        return;
      }
      if (lower === 'k') {
        e.preventDefault();
        const at = this.input.selectionStart ?? this.input.value.length;
        this._setValue(this.input.value.slice(0, at), at);
        return;
      }
      if (lower === 'w') {
        e.preventDefault();
        this._killWord();
        return;
      }
    }

    switch (key) {
      case 'Enter':
        e.preventDefault();
        this._submit();
        return;
      // Tab is the browser's own way out of a control, and everything after the
      // terminal in DOM order - the divider, the graph, its zoom buttons -
      // depends on it. Two rules, and the field's description states both:
      //   Shift+Tab is never taken. Not mid-cycle, not mid-search, never.
      //   Tab is taken only when _completionPlan() has real work; a line with
      //   nothing left to complete lets it through, because a key that
      //   silently does nothing is worse than one that navigates.
      case 'Tab': {
        if (e.shiftKey) return;
        const plan = this._completionPlan();
        if (plan.kind === 'none') return;
        e.preventDefault();
        this._applyCompletion(plan);
        return;
      }
      case 'ArrowUp':
        e.preventDefault();
        this._walkHistory(-1);
        return;
      case 'ArrowDown':
        e.preventDefault();
        this._walkHistory(1);
        return;
      case 'ArrowRight':
      case 'End':
        if (this.ghost && this._caretAtEnd()) {
          e.preventDefault();
          this._acceptGhost();
        }
        return;
      case 'Escape':
        // Only claimed when there is a suggestion to dismiss; otherwise it
        // belongs to the app (it closes the goal panel).
        if (this.ghost || this.comp.cycling) {
          e.preventDefault();
          this.comp.cycling = false;
          this._setGhost('');
        }
        return;
      // The conventional "move to the next region" key, and the one exit that
      // works even mid-line, where Tab is still busy completing.
      case 'F6':
        e.preventDefault();
        this._leave(e.shiftKey ? -1 : 1);
        return;
      case 'PageUp':
      case 'PageDown': {
        e.preventDefault();
        const step = this.logEl.clientHeight * 0.85 * (key === 'PageUp' ? -1 : 1);
        this.logEl.scrollTop += step;
        return;
      }
      default:
    }
  }

  // F6: hand focus to the first control outside the terminal. Tab alone cannot
  // always do it, because a half-typed line keeps Tab for completion, and this
  // is the app's only path from the console to the graph.
  _leave(dir = 1) {
    const all = [...document.querySelectorAll(FOCUSABLE)].filter(
      (node) => node === document.activeElement || node.getClientRects().length
    );
    const mine = all.filter((node) => this.root.contains(node));
    const anchor = dir > 0 ? mine[mine.length - 1] : mine[0];
    const at = anchor ? all.indexOf(anchor) : -1;
    const next = at < 0 ? null : all[at + dir];
    if (next) next.focus();
    else this.input.blur();
    this._syncFocus();
  }

  _captureWhileBusy(e) {
    if (e.metaKey || e.altKey || e.ctrlKey) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      this.pending.push({ type: 'enter' });
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      this.pending.push({ type: 'backspace' });
    } else if (e.key.length === 1) {
      e.preventDefault();
      this.pending.push({ type: 'char', ch: e.key });
    }
    if (this.pending.length) this.root.classList.add('has-queue');
  }

  _flushPending() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.pending.length && !this.busy) {
        const item = this.pending.shift();
        if (item.type === 'char') this._insert(item.ch);
        else if (item.type === 'backspace') this._backspace();
        else if (item.type === 'enter') this._submit();
      }
    } finally {
      this.flushing = false;
      this.root.classList.toggle('has-queue', this.pending.length > 0);
    }
  }

  _insert(ch) {
    const value = this.input.value;
    const start = this.input.selectionStart ?? value.length;
    const end = this.input.selectionEnd ?? start;
    this._setValue(value.slice(0, start) + ch + value.slice(end), start + ch.length);
  }

  _backspace() {
    const value = this.input.value;
    const start = this.input.selectionStart ?? value.length;
    const end = this.input.selectionEnd ?? start;
    if (start === end) {
      if (!start) return;
      this._setValue(value.slice(0, start - 1) + value.slice(start), start - 1);
    } else {
      this._setValue(value.slice(0, start) + value.slice(end), start);
    }
  }

  _killWord() {
    const value = this.input.value;
    const at = this.input.selectionStart ?? value.length;
    const head = value.slice(0, at).replace(/\S+\s*$/, '');
    this._setValue(head + value.slice(at), head.length);
  }

  _setValue(value, caret = value.length) {
    this.input.value = value;
    const pos = clamp(caret, 0, value.length);
    this.input.setSelectionRange(pos, pos);
    this.historyIndex = null;
    this.comp.cycling = false;
    if (this.search.active) this._searchUpdate(value);
    else this._refreshGhost();
    this._syncCaret();
  }

  _setCaret(pos) {
    const at = clamp(pos, 0, this.input.value.length);
    this.input.setSelectionRange(at, at);
    this._onCaretMove();
  }

  _caretAtEnd() {
    const len = this.input.value.length;
    return this.input.selectionStart === len && this.input.selectionEnd === len;
  }

  // --- submit + history ---------------------------------------------------

  _submit() {
    if (this.search.active) {
      const match = this.search.index >= 0 ? this.history[this.search.index] : '';
      this._searchEnd(match || this.input.value);
    }

    const raw = this.input.value;
    const command = raw.trim();

    this._setGhost('');
    this.comp.cycling = false;
    this.historyIndex = null;
    this.draft = '';
    this.input.value = '';
    this._syncCaret();

    if (!command) {
      this._append(this._createLine('', 'command'));
      return;
    }

    this._pushHistory(command);
    this.pendingEcho = command;
    this.print(command, 'command');
    bus.emit('terminal:history', this.getHistory());

    let running;
    try {
      running = this.onCommand(command);
    } catch (err) {
      this.pendingEcho = null;
      this._reportFailure(err);
      return;
    }
    if (running && typeof running.catch === 'function') {
      running.catch((err) => {
        this.pendingEcho = null;
        this._reportFailure(err);
      });
    }
  }

  _reportFailure(err) {
    console.error('[terminal] command handler failed', err);
    this.print(String(err && err.message ? err.message : err), 'error');
    this.setBusy(false);
  }

  _cancelLine() {
    const value = this.input.value;
    this.pending.length = 0;
    this.root.classList.remove('has-queue');
    if (this.search.active) this._searchEnd(this.search.restore);
    this.input.value = '';
    this.historyIndex = null;
    this.draft = '';
    this.comp.cycling = false;
    this._setGhost('');
    this._syncCaret();
    this._append(this._createLine(`${value}^C`, 'command'));
  }

  _pushHistory(command) {
    if (this.history[this.history.length - 1] !== command) this.history.push(command);
    if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);
  }

  _walkHistory(dir) {
    if (!this.history.length) return;

    if (this.historyIndex === null) {
      if (dir > 0) return; // already on the fresh line
      this.draft = this.input.value;
      this.historyIndex = this.history.length - 1;
    } else {
      const next = this.historyIndex + dir;
      if (next < 0) return;
      if (next >= this.history.length) {
        this.historyIndex = null;
        this.input.value = this.draft;
        this._setCaret(this.draft.length);
        return;
      }
      this.historyIndex = next;
    }

    const value = this.history[this.historyIndex];
    this.input.value = value;
    this.input.setSelectionRange(value.length, value.length);
    this.comp.cycling = false;
    this._setGhost('');
    this._syncCaret();
  }

  // --- completion ---------------------------------------------------------

  _candidates(prefix) {
    let list;
    try {
      list = this.completions() || [];
    } catch (err) {
      console.error('[terminal] completions() threw', err);
      return [];
    }
    const lower = prefix.toLowerCase();
    const seen = new Set();
    const out = [];
    for (const item of list) {
      if (typeof item !== 'string' || !item) continue;
      if (!item.toLowerCase().startsWith(lower) || seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
    return out.sort((a, b) => a.length - b.length || a.localeCompare(b));
  }

  _refreshGhost() {
    if (this.busy || this.search.active || this.composing) return this._setGhost('');
    const value = this.input.value;
    if (!value.trim() || !this._caretAtEnd()) return this._setGhost('');

    const list = this._candidates(value);
    const best = list.find((c) => c.startsWith(value) && c.length > value.length);
    return this._setGhost(best ? best.slice(value.length) : '');
  }

  _setGhost(text) {
    if (this.ghost === text) return;
    this.ghost = text;
    this.ghostEl.textContent = text;
    this.root.classList.toggle('has-ghost', Boolean(text));
    this._syncCaret();
  }

  _acceptGhost() {
    if (!this.ghost) return;
    this._setValue(this.input.value + this.ghost);
  }

  // What Tab would do with the line as it stands. Deciding this before the key
  // is swallowed is the whole point: 'none' means Tab is not ours, so a line
  // like `git commit -m "fix"` - or one already complete - moves focus on
  // rather than dead-ending. Kind 'cycle' wraps, which is the only way round
  // the list now that Shift+Tab is off limits.
  _completionPlan() {
    if (this.comp.cycling && this.comp.list.length > 1) return { kind: 'cycle' };

    const value = this.input.value;
    if (!value.trim()) return { kind: 'none' };

    const list = this._candidates(value);
    if (!list.length) return { kind: 'none' };
    if (list.length === 1) {
      return list[0] === value ? { kind: 'none' } : { kind: 'fill', text: list[0] };
    }

    const prefix = commonPrefix(list);
    if (prefix.length > value.length) return { kind: 'fill', text: prefix };
    return { kind: 'list', list };
  }

  _applyCompletion(plan) {
    if (plan.kind === 'cycle') {
      const count = this.comp.list.length;
      this.comp.index = (this.comp.index + 1) % count;
      const pick = this.comp.list[this.comp.index];
      this.input.value = pick;
      this.input.setSelectionRange(pick.length, pick.length);
      this._setGhost('');
      this.comp.token = this._compToken();
      this._syncCaret();
      return;
    }

    if (plan.kind === 'fill') {
      this._setValue(plan.text);
      return;
    }

    // No more shared characters. Print what is on offer and leave the line
    // alone, the way a shell does; the next Tab starts cycling candidates.
    this._printCandidates(plan.list);
    this.comp.list = plan.list;
    this.comp.stem = this.input.value;
    this.comp.index = -1;
    this.comp.cycling = true;
    this.comp.token = this._compToken();
  }

  _printCandidates(list) {
    const line = el('div', { class: 'term__line', dataset: { type: 'log' } });
    const grid = el('div', { class: 'term__cands' });
    for (const item of list) grid.appendChild(el('span', { class: 'term__cand' }, item));
    line.append(icon(ICON_FOR.log, 'term__line-icon'), el('div', { class: 'term__msg' }, grid));
    this._append(line);
  }

  // --- reverse history search ---------------------------------------------

  _searchStep(dir = -1) {
    if (!this.search.active) {
      this.search = { active: true, query: '', index: -1, restore: this.input.value };
      this.input.value = '';
      this.root.classList.add('is-searching');
      this.searchEl.hidden = false;
      this._setGhost('');
      this._searchApply(this._searchFind('', this.history.length - 1, -1));
      this._syncCaret();
      return;
    }
    const found = this._searchFind(this.search.query, this.search.index + dir, dir);
    if (found < 0) {
      this.searchEl.classList.add('is-failing');
      return;
    }
    this._searchApply(found);
  }

  _searchFind(query, from, dir) {
    const needle = query.toLowerCase();
    for (let i = from; i >= 0 && i < this.history.length; i += dir) {
      if (!needle || this.history[i].toLowerCase().includes(needle)) return i;
    }
    return -1;
  }

  // Typing in search mode always restarts from the most recent entry.
  _searchUpdate(query) {
    this.search.query = query;
    this._searchApply(this._searchFind(query, this.history.length - 1, -1));
  }

  _searchApply(index) {
    this.search.index = index;
    const query = this.search.query;
    const qEl = this.searchEl.querySelector('.term__search-q');
    const matchEl = this.searchEl.querySelector('.term__search-match');

    qEl.textContent = `'${query}'`;
    this.searchEl.classList.toggle('is-failing', query !== '' && index < 0);

    matchEl.replaceChildren();
    if (index >= 0) {
      const entry = this.history[index];
      const at = query ? entry.toLowerCase().indexOf(query.toLowerCase()) : -1;
      if (at < 0) matchEl.append(entry);
      else {
        matchEl.append(
          entry.slice(0, at),
          el('mark', {}, entry.slice(at, at + query.length)),
          entry.slice(at + query.length)
        );
      }
    } else {
      matchEl.append(query ? 'no match' : 'type to search your history');
    }
  }

  // Returns true when the key was handled by search mode.
  _searchKey(e) {
    const key = e.key;
    if (key === 'Escape') {
      e.preventDefault();
      this._searchEnd(this.search.restore);
      return true;
    }
    if (key === 'Enter') return false; // _submit() picks the match up
    if (key === 'ArrowUp') {
      e.preventDefault();
      this._searchStep(-1);
      return true;
    }
    if (key === 'ArrowDown') {
      e.preventDefault();
      this._searchStep(1);
      return true;
    }
    if (key === 'Tab' || key === 'ArrowRight' || key === 'ArrowLeft' || key === 'Home' || key === 'End') {
      // Shift+Tab is never taken, here least of all: search mode is exactly
      // where a reader is most likely to want back out. Accept the match either
      // way, so the bar cannot linger with focus somewhere else, but let the
      // key itself through so focus moves.
      if (!(key === 'Tab' && e.shiftKey)) e.preventDefault();
      const match = this.search.index >= 0 ? this.history[this.search.index] : this.search.query;
      this._searchEnd(match);
      return true;
    }
    return false;
  }

  _searchEnd(value) {
    this.search.active = false;
    this.search.query = '';
    this.searchEl.hidden = true;
    this.searchEl.classList.remove('is-failing');
    this.root.classList.remove('is-searching');
    const text = typeof value === 'string' ? value : '';
    this.input.value = text;
    this.input.setSelectionRange(text.length, text.length);
    this._refreshGhost();
    this._syncCaret();
  }

  // --- caret --------------------------------------------------------------

  // Called from several events that often fire together (input + keyup +
  // select), so it bails out early when nothing that matters has changed.
  _syncCaret() {
    const value = this.input.value;
    const start = this.input.selectionStart ?? value.length;
    const end = this.input.selectionEnd ?? start;
    const scroll = this.input.scrollLeft || 0;

    const signature = `[${start}|${end}|${scroll}|${this.ghost.length}] ${value}`;
    if (signature === this.caretSignature) return;
    const textChanged = this.caretValue !== value;
    this.caretSignature = signature;
    this.caretValue = value;

    // A live selection gets the browser's own highlight; two carets would lie.
    const ranged = start !== end;
    this.root.classList.toggle('has-range', ranged);

    const before = this._measure(value.slice(0, ranged ? end : start));
    const total = (ranged ? end : start) === value.length ? before : this._measure(value);

    const atEnd = !ranged && start === value.length;
    this.caretEl.classList.toggle('term__caret--block', atEnd && !this.ghost);
    this.caretEl.style.transform = `translate(${(before - scroll).toFixed(2)}px, -50%)`;
    this.ghostEl.style.transform = `translate(${(total - scroll).toFixed(2)}px, -50%)`;

    // Restart the blink so the caret stays solid while the user types.
    if (textChanged || ranged) {
      this.caretEl.style.animation = 'none';
      void this.caretEl.offsetWidth;
      this.caretEl.style.animation = '';
    }
  }

  _measure(text) {
    this.mirror.textContent = text;
    // Trailing spaces still occupy a rect because the mirror is `white-space: pre`.
    return this.mirror.getBoundingClientRect().width;
  }
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const scratch = el('textarea', {
      value: text,
      style: 'position:fixed;top:0;left:-9999px;opacity:0',
      readonly: true,
      'aria-hidden': 'true',
    });
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand('copy');
    scratch.remove();
    return ok;
  } catch {
    return false;
  }
}

export default Terminal;
