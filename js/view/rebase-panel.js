// The `git rebase -i` panel. The engine hands over the commits that would move
// and changes nothing; this panel decides their order and which ones survive.
//
// Note on ARIA: `aria-grabbed` is deprecated and no longer surfaced by browsers,
// so the honest alternative is used instead - each row is a listitem whose
// keep/drop control is a real switch, every move is announced through a polite
// live region, and the row's accessible name always carries its position.

import { el, uid, prefersReducedMotion } from '../core/util.js';
import { Modal, icon } from './modal.js';

const FLIP_MS = 220;

function branchAt(engine, commitId) {
  try {
    const snapshot = engine.getSnapshot();
    const hit = Object.values(snapshot.branches || {}).find(
      (branch) => branch.target === commitId && !branch.remote
    );
    return hit ? hit.id : null;
  } catch {
    return null;
  }
}

class RebasePanel {
  constructor(request, engine) {
    this.engine = engine || null;
    this.target = request.target;
    this.source = request.source || null;
    this.order = (request.commits || []).map((id) => ({ id: String(id), keep: true }));
    this.nodes = new Map();
    this.drag = null;

    this.build();
  }

  // --- construction -------------------------------------------------------

  build() {
    const onto = branchAt(this.engine, this.target);
    const what = this.source ? `${this.source}` : 'these commits';
    this.hintId = uid('rebase-hint');

    this.listEl = el('ol', {
      class: 'rebase-list',
      role: 'list',
      'aria-label': 'Commits to replay, first one first',
      onKeydown: (event) => this.onKey(event),
    });

    this.order.forEach((entry, index) => {
      const node = this.buildRow(entry);
      // The list is the point of the panel, so that is where focus lands.
      if (index === 0) node.keepBtn.dataset.autofocus = 'true';
      this.nodes.set(entry.id, node);
      this.listEl.appendChild(node);
    });

    this.summaryEl = el('p', { class: 'rebase-summary' });
    this.liveEl = el('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });

    this.rootEl = el(
      'div',
      { class: 'rebase' },
      el(
        'p',
        { class: 'rebase-intro' },
        `Replaying ${what} onto `,
        el('code', {}, String(this.target)),
        onto ? ` (${onto})` : '',
        '. The top row lands on the new base first.'
      ),
      this.listEl,
      this.summaryEl,
      el(
        'p',
        { class: 'rebase-hint', id: this.hintId },
        icon('keyboard'),
        el(
          'span',
          {},
          'Drag a row to reorder it, or hold Alt and press the up and down arrow keys. Space switches the focused commit between pick and drop.'
        )
      ),
      this.liveEl
    );

    this.modal = new Modal({
      title: 'Interactive rebase',
      body: this.rootEl,
      size: 'md',
      className: 'modal-rebase',
      // House order: secondary first, primary last.
      buttons: [
        { label: 'Cancel', variant: 'ghost', onClick: () => null },
        {
          label: 'Start rebase',
          variant: 'primary',
          icon: 'git-merge',
          onClick: () => this.order.filter((entry) => entry.keep).map((entry) => entry.id),
        },
      ],
    });

    this.syncMeta();
  }

  buildRow(entry) {
    const keepBtn = el(
      'button',
      {
        type: 'button',
        class: 'rebase-keep',
        role: 'switch',
        'aria-checked': 'true',
        'aria-describedby': this.hintId,
        onClick: () => this.toggle(entry.id),
      },
      icon('check', { className: 'rebase-keep-on' }),
      icon('close', { className: 'rebase-keep-off' })
    );

    const row = el(
      'li',
      {
        class: 'rebase-row',
        role: 'listitem',
        dataset: { id: entry.id },
        onPointerdown: (event) => this.onPointerDown(event, row),
        onPointermove: (event) => this.onPointerMove(event),
        onPointerup: (event) => this.onPointerUp(event),
        onPointercancel: (event) => this.onPointerUp(event),
      },
      el('span', { class: 'rebase-grip', 'aria-hidden': 'true', title: 'Drag to reorder' }, icon('menu')),
      el('span', { class: 'rebase-pos', 'aria-hidden': 'true' }),
      el('code', { class: 'rebase-id' }, entry.id),
      // Real git spells these `pick` and `drop` in the todo file it opens in an
      // editor. Use its words so the todo file is recognisable later, and keep
      // the plain-English reading underneath them.
      el(
        'span',
        { class: 'rebase-op' },
        el('code', { class: 'rebase-verb' }),
        el('span', { class: 'rebase-note' })
      ),
      keepBtn
    );
    row.keepBtn = keepBtn;
    row.posEl = row.querySelector('.rebase-pos');
    row.verbEl = row.querySelector('.rebase-verb');
    row.noteEl = row.querySelector('.rebase-note');
    return row;
  }

  // --- state --------------------------------------------------------------

  at(id) {
    return this.order.find((entry) => entry.id === id) || null;
  }

  syncMeta() {
    const total = this.order.length;
    const kept = this.order.filter((entry) => entry.keep).length;

    this.order.forEach((entry, index) => {
      const row = this.nodes.get(entry.id);
      if (!row) return;
      row.classList.toggle('is-dropped', !entry.keep);
      row.posEl.textContent = String(index + 1);
      row.verbEl.textContent = entry.keep ? 'pick' : 'drop';
      // Only the odd one out is worth a gloss. "replayed onto the new base" on
      // every picked row was the same sentence four times over, and the summary
      // line under the list already says it once for the whole set.
      row.noteEl.textContent = entry.keep ? '' : 'left behind';
      row.keepBtn.setAttribute('aria-checked', String(entry.keep));
      row.keepBtn.setAttribute(
        'aria-label',
        `${entry.id}, position ${index + 1} of ${total}. ${
          entry.keep ? 'Pick: replayed onto the new base.' : 'Drop: left behind.'
        }`
      );
      row.keepBtn.title = entry.keep ? `Drop ${entry.id}` : `Pick ${entry.id}`;
    });

    this.summaryEl.textContent =
      kept === total
        ? `All ${total} commit${total === 1 ? '' : 's'} will be applied.`
        : `${kept} of ${total} commits will be applied.`;
    this.summaryEl.classList.toggle('is-partial', kept !== total);
  }

  announce(text) {
    this.liveEl.textContent = text;
  }

  toggle(id) {
    const entry = this.at(id);
    if (!entry) return;
    entry.keep = !entry.keep;
    this.syncMeta();
    this.announce(
      `${id} set to ${entry.keep ? 'pick' : 'drop'}. ${this.summaryEl.textContent}`
    );
  }

  /** Reorders the model, then replays the DOM to match, with a FLIP slide. */
  move(id, delta) {
    const from = this.order.findIndex((entry) => entry.id === id);
    const to = from + delta;
    if (from < 0) return;
    if (to < 0 || to >= this.order.length) {
      this.announce(`${id} is already at the ${delta < 0 ? 'top' : 'bottom'} of the list.`);
      return;
    }

    const before = this.snapTops();
    const [entry] = this.order.splice(from, 1);
    this.order.splice(to, 0, entry);
    this.order.forEach((item) => this.listEl.appendChild(this.nodes.get(item.id)));
    this.flip(before);
    this.syncMeta();

    // Re-inserting a node drops focus, so put it back where the reader had it.
    this.nodes.get(id)?.keepBtn.focus({ preventScroll: true });
    this.announce(`${id} moved to position ${to + 1} of ${this.order.length}.`);
  }

  snapTops() {
    const map = new Map();
    for (const [id, node] of this.nodes) map.set(id, node.getBoundingClientRect().top);
    return map;
  }

  flip(before) {
    if (prefersReducedMotion()) return;
    for (const [id, node] of this.nodes) {
      const wasTop = before.get(id);
      const nowTop = node.getBoundingClientRect().top;
      const delta = wasTop - nowTop;
      if (!delta) continue;
      node.style.transition = 'none';
      node.style.transform = `translate3d(0, ${delta}px, 0)`;
      requestAnimationFrame(() => {
        node.style.transition = `transform ${FLIP_MS}ms var(--ease-out)`;
        node.style.transform = '';
      });
      // Leave no inline transition behind: a dragged row must follow the
      // pointer with no easing at all.
      clearTimeout(node._flipTimer);
      node._flipTimer = setTimeout(() => {
        node.style.transition = '';
        node.style.transform = '';
      }, FLIP_MS + 60);
    }
  }

  // --- keyboard -----------------------------------------------------------

  rowsInOrder() {
    return this.order.map((entry) => this.nodes.get(entry.id)).filter(Boolean);
  }

  onKey(event) {
    const row = event.target.closest?.('.rebase-row');
    if (!row) return;
    const id = row.dataset.id;
    const rows = this.rowsInOrder();
    const index = rows.indexOf(row);

    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      this.move(id, event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const next = rows[index + (event.key === 'ArrowUp' ? -1 : 1)];
      next?.keepBtn.focus({ preventScroll: true });
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      (event.key === 'Home' ? rows[0] : rows[rows.length - 1])?.keepBtn.focus({
        preventScroll: true,
      });
    }
  }

  // --- pointer drag -------------------------------------------------------

  onPointerDown(event, row) {
    if (event.button !== 0 || event.target.closest('.rebase-keep')) return;
    event.preventDefault();
    try {
      row.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic or already-released pointer: the drag still works */
    }
    this.drag = { row, startY: event.clientY, id: row.dataset.id };
    row.classList.add('is-dragging');
    this.listEl.classList.add('is-reordering');
  }

  onPointerMove(event) {
    const drag = this.drag;
    if (!drag) return;
    const row = drag.row;
    row.style.transform = `translate3d(0, ${event.clientY - drag.startY}px, 0)`;

    // Find the first untouched row whose middle is below the pointer.
    let insertBefore = null;
    for (const other of this.rowsInOrder()) {
      if (other === row) continue;
      const rect = other.getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        insertBefore = other;
        break;
      }
    }
    if (insertBefore === row || insertBefore === row.nextElementSibling) return;

    const wasTop = this.untransformedTop(row);
    this.listEl.insertBefore(row, insertBefore);
    this.syncOrderFromDom();
    // Keep the row glued to the cursor now that its slot has changed.
    drag.startY += this.untransformedTop(row) - wasTop;
    row.style.transform = `translate3d(0, ${event.clientY - drag.startY}px, 0)`;
    this.syncMeta();
  }

  onPointerUp(event) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    try {
      drag.row.releasePointerCapture(event.pointerId);
    } catch {
      /* nothing to release */
    }
    drag.row.style.transform = '';
    drag.row.classList.remove('is-dragging');
    this.listEl.classList.remove('is-reordering');
    this.syncOrderFromDom();
    this.syncMeta();
    const at = this.order.findIndex((entry) => entry.id === drag.id);
    this.announce(`${drag.id} moved to position ${at + 1} of ${this.order.length}.`);
  }

  untransformedTop(node) {
    const saved = node.style.transform;
    node.style.transform = '';
    const top = node.getBoundingClientRect().top;
    node.style.transform = saved;
    return top;
  }

  syncOrderFromDom() {
    const ids = Array.from(this.listEl.children).map((node) => node.dataset.id);
    this.order.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  }

  open() {
    return this.modal.open();
  }
}

/**
 * @param {{commits:string[], target:string, source:string|null, upstream:string}} request
 * @param {{engine:object}} deps
 * @returns {Promise<string[]|null>} ids to replay in order, or null to cancel.
 */
export async function openInteractiveRebase(request, { engine } = {}) {
  const commits = Array.isArray(request?.commits) ? request.commits : [];
  if (!commits.length) return null;

  const panel = new RebasePanel(request, engine);
  const result = await panel.open();
  return Array.isArray(result) ? result : null;
}

export default openInteractiveRebase;
