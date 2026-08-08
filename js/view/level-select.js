// Level browser: grouped tabs, one glass card per sequence, numbered chips with
// solved state, live filtering and full keyboard navigation.

import { el } from '../core/util.js';
import { store } from '../core/store.js';
import { Modal, icon, confirmModal } from './modal.js';
import { toast } from './toast.js';

const GROUP_ORDER = ['Main', 'Remote'];
const GROUP_ICON = { Main: 'git-branch', Remote: 'cloud' };

function groupOf(sequence) {
  if (sequence.group) return sequence.group;
  return String(sequence.key || '').startsWith('remote') ? 'Remote' : 'Main';
}

function bestKnown(level) {
  if (!level || !level.solutionCommand) return null;
  return level.solutionCommand.split(';').filter((part) => part.trim()).length || null;
}

/**
 * A level with no goal tree - the two sandboxes - has nothing to compare
 * against and can never be marked solved. Counting them made the browser say
 * "0 of 39 solved" while the end-of-level panel said "1 of 37", two totals for
 * the same course in the same product. 37 is the honest number: it is how many
 * levels can actually be finished.
 */
function gradeable(level) {
  return Boolean(level) && level.goalTree !== null && level.solutionCommand !== '';
}

/** Nearest chip one row up or down, using real geometry so wrapping works. */
function neighbourRow(items, current, direction) {
  const from = current.getBoundingClientRect();
  let best = null;
  let bestScore = Infinity;
  for (const node of items) {
    if (node === current) continue;
    const rect = node.getBoundingClientRect();
    const dy = rect.top - from.top;
    if (direction > 0 ? dy <= 2 : dy >= -2) continue;
    const score = Math.abs(dy) * 2 + Math.abs(rect.left - from.left);
    if (score < bestScore) {
      bestScore = score;
      best = node;
    }
  }
  return best;
}

export class LevelSelect {
  constructor(sequences, progress, { onPick = null, currentId = null } = {}) {
    this.sequences = (Array.isArray(sequences) ? sequences : []).filter(
      (sequence) => sequence && Array.isArray(sequence.levels) && sequence.levels.length
    );
    this.progress = progress || {};
    this.onPick = onPick;
    this.currentId =
      currentId || decodeURIComponent(String(location.hash || '').replace('#', '')).trim() || null;
    this.query = '';

    this.groups = [];
    for (const sequence of this.sequences) {
      const group = groupOf(sequence);
      if (!this.groups.includes(group)) this.groups.push(group);
    }
    this.groups.sort((a, b) => {
      const ai = GROUP_ORDER.indexOf(a);
      const bi = GROUP_ORDER.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });

    const owning = this.sequences.find((sequence) =>
      sequence.levels.some((level) => level.id === this.currentId)
    );
    this.activeGroup = owning ? groupOf(owning) : this.groups[0] || 'Main';

    this.build();
  }

  // --- data helpers -------------------------------------------------------

  allLevels() {
    return this.sequences.flatMap((sequence) => sequence.levels);
  }

  /** Every level the meter is allowed to count. */
  gradedLevels() {
    return this.allLevels().filter(gradeable);
  }

  matches(sequence, level) {
    if (!this.query) return true;
    const needle = this.query.toLowerCase();
    return (
      String(level.name || '').toLowerCase().includes(needle) ||
      String(level.id || '').toLowerCase().includes(needle) ||
      String(sequence.name || '').toLowerCase().includes(needle) ||
      String(sequence.about || '').toLowerCase().includes(needle)
    );
  }

  matchesInGroup(group) {
    let count = 0;
    for (const sequence of this.sequences) {
      if (groupOf(sequence) !== group) continue;
      for (const level of sequence.levels) if (this.matches(sequence, level)) count += 1;
    }
    return count;
  }

  // --- construction -------------------------------------------------------

  build() {
    this.searchEl = el('input', {
      type: 'search',
      class: 'levels-search-input',
      placeholder: 'Search levels and sequences',
      'aria-label': 'Search levels',
      autocomplete: 'off',
      'data-autofocus': 'true',
      onInput: () => {
        this.query = this.searchEl.value.trim();
        this.renderList();
        this.renderTabs();
      },
      onKeydown: (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          const first = this.listEl.querySelector('.level-chip');
          if (first) this.focusChip(first);
        }
      },
    });

    this.meterFillEl = el('i', { class: 'meter-fill' });
    this.meterTextEl = el('span', { class: 'meter-text' });
    this.meterEl = el(
      'div',
      { class: 'levels-meter' },
      this.meterTextEl,
      el(
        'div',
        {
          class: 'meter',
          role: 'progressbar',
          'aria-label': 'Levels solved',
          'aria-valuemin': '0',
          'aria-valuemax': '100',
        },
        this.meterFillEl
      )
    );

    this.tabsEl = el('div', { class: 'levels-tabs', role: 'tablist', 'aria-label': 'Level groups' });
    this.listEl = el('div', {
      class: 'levels-list',
      role: 'tabpanel',
      tabindex: '-1',
      onKeydown: (event) => this.onListKey(event),
    });

    this.rootEl = el(
      'div',
      { class: 'levels' },
      el(
        'div',
        { class: 'levels-top' },
        el(
          'div',
          { class: 'levels-search' },
          icon('search', { className: 'levels-search-icon' }),
          this.searchEl
        ),
        this.meterEl
      ),
      this.tabsEl,
      this.listEl
    );

    this.modal = new Modal({
      title: 'Levels',
      body: this.rootEl,
      size: 'xl',
      className: 'modal-levels',
      // One close affordance: the header X. The footer carries the ordinary way
      // out, with no second X glyph on it.
      buttons: [{ label: 'Done', variant: 'primary', onClick: () => null }],
    });

    // Destructive and rare, so it lives at the far left of the footer, as far
    // from the primary as the tray allows.
    this.resetBtn = el(
      'button',
      {
        type: 'button',
        class: 'btn btn-ghost levels-reset',
        onClick: () => this.confirmReset(),
      },
      icon('reset'),
      el('span', { class: 'btn-label' }, 'Reset all progress')
    );
    this.modal.footExtraEl.appendChild(this.resetBtn);

    this.modal.escapeGuard = () => {
      if (!this.query) return false;
      this.searchEl.value = '';
      this.query = '';
      this.renderTabs();
      this.renderList();
      this.searchEl.focus({ preventScroll: true });
      return true;
    };

    this.renderTabs();
    this.renderList();
    this.renderMeter();
  }

  /** @returns {Promise<string|null>} the chosen level id. */
  open() {
    return this.modal.open();
  }

  // --- rendering ----------------------------------------------------------

  renderMeter() {
    const levels = this.gradedLevels();
    const solved = levels.filter((level) => this.progress[level.id]?.solved).length;
    const percent = levels.length ? Math.round((solved / levels.length) * 100) : 0;
    this.meterFillEl.style.setProperty('--p', `${percent}%`);
    this.meterTextEl.textContent = `${solved} of ${levels.length} solved`;
    const bar = this.meterEl.querySelector('.meter');
    bar.setAttribute('aria-valuenow', String(percent));
    bar.setAttribute('aria-valuetext', `${solved} of ${levels.length} levels solved`);
  }

  renderTabs() {
    this.tabsEl.textContent = '';
    this.groups.forEach((group) => {
      const active = group === this.activeGroup;
      const hits = this.query ? this.matchesInGroup(group) : 0;
      const tab = el(
        'button',
        {
          type: 'button',
          class: `levels-tab${active ? ' is-active' : ''}`,
          role: 'tab',
          'aria-selected': String(active),
          tabindex: active ? '0' : '-1',
          onClick: () => this.setGroup(group),
          onKeydown: (event) => {
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
            event.preventDefault();
            const at = this.groups.indexOf(group);
            const next =
              (at + (event.key === 'ArrowRight' ? 1 : this.groups.length - 1)) % this.groups.length;
            this.setGroup(this.groups[next]);
            this.tabsEl.children[next]?.focus({ preventScroll: true });
          },
        },
        icon(GROUP_ICON[group] || 'levels'),
        el('span', {}, group),
        this.query ? el('span', { class: 'levels-tab-count' }, String(hits)) : null
      );
      this.tabsEl.appendChild(tab);
    });
    this.listEl.setAttribute('aria-label', `${this.activeGroup} levels`);
  }

  setGroup(group) {
    if (group === this.activeGroup) return;
    this.activeGroup = group;
    this.renderTabs();
    this.renderList();
  }

  renderList() {
    this.listEl.textContent = '';
    const inGroup = this.sequences.filter((sequence) => groupOf(sequence) === this.activeGroup);
    let shown = 0;

    for (const sequence of inGroup) {
      const levels = sequence.levels.filter((level) => this.matches(sequence, level));
      if (!levels.length) continue;
      shown += levels.length;
      this.listEl.appendChild(this.buildCard(sequence, levels));
    }

    if (!shown) {
      const elsewhere = this.groups
        .filter((group) => group !== this.activeGroup)
        .map((group) => ({ group, hits: this.matchesInGroup(group) }))
        .filter((entry) => entry.hits > 0);

      this.listEl.appendChild(
        el(
          'div',
          { class: 'levels-empty' },
          icon('search', { className: 'levels-empty-icon' }),
          el('p', {}, this.query ? `Nothing matches "${this.query}" here.` : 'No levels loaded.'),
          ...elsewhere.map((entry) =>
            el(
              'button',
              {
                type: 'button',
                class: 'btn btn-ghost',
                onClick: () => this.setGroup(entry.group),
              },
              el(
                'span',
                { class: 'btn-label' },
                `Show ${entry.hits} match${entry.hits === 1 ? '' : 'es'} in ${entry.group}`
              )
            )
          )
        )
      );
    }

    this.syncRoving();
  }

  buildCard(sequence, levels) {
    const graded = sequence.levels.filter(gradeable);
    const solved = graded.filter((level) => this.progress[level.id]?.solved).length;
    // No per-group column count. Choosing the widest grid that divided each
    // group's own length gave every card a different cell width - and the count
    // was a promise the layout could not keep anyway, because auto-fill opened
    // whatever number of tracks actually fitted and stranded the odd chip
    // regardless. modals.css now fixes the count per breakpoint for the whole
    // list and centres any short tail row.
    const chips = el('div', { class: 'seq-chips' });

    levels.forEach((level) => {
      const record = this.progress[level.id] || null;
      const isCurrent = level.id === this.currentId;
      const par = bestKnown(level);
      const perfect =
        record?.solved && par && typeof record.bestCommands === 'number' && record.bestCommands <= par;

      const chip = el(
        'button',
        {
          type: 'button',
          class: `level-chip${record?.solved ? ' is-solved' : ''}${isCurrent ? ' is-current' : ''}`,
          tabindex: '-1',
          'aria-current': isCurrent ? 'true' : null,
          dataset: { id: level.id },
          title: level.name,
          onClick: () => this.pick(level.id),
        },
        el('span', { class: 'chip-num' }, String((level.index ?? levels.indexOf(level)) + 1)),
        el(
          'span',
          { class: 'chip-body' },
          el('span', { class: 'chip-name' }, level.name || level.id),
          record?.solved && typeof record.bestCommands === 'number'
            ? el(
                'span',
                { class: 'chip-meta' },
                `Solved in ${record.bestCommands} command${record.bestCommands === 1 ? '' : 's'}`
              )
            : null
        ),
        el(
          'span',
          { class: 'chip-state' },
          record?.solved
            ? icon(perfect ? 'star' : 'check', {
                className: perfect ? 'is-par' : '',
                label: perfect ? 'Solved in the fewest commands' : 'Solved',
              })
            : null
        )
      );
      chips.appendChild(chip);
    });

    return el(
      'section',
      { class: 'seq-card' },
      el(
        'header',
        { class: 'seq-head' },
        // Title and counter share one baseline row: the pill has something to
        // sit on instead of floating above the heading's cap line.
        el(
          'div',
          { class: 'seq-head-top' },
          el('h3', { class: 'seq-name' }, sequence.name || sequence.key),
          // A sequence with nothing to solve - the sandboxes - gets no counter
          // at all rather than a "0/2" that can never move.
          graded.length
            ? el(
                'span',
                {
                  class: `seq-count${solved === graded.length ? ' is-complete' : ''}`,
                  title: `${solved} of ${graded.length} solved`,
                },
                solved === graded.length ? icon('check') : null,
                el('span', {}, `${solved}/${graded.length}`)
              )
            : null
        ),
        sequence.about ? el('p', { class: 'seq-about' }, sequence.about) : null
      ),
      chips
    );
  }

  // --- interaction --------------------------------------------------------

  chips() {
    return Array.from(this.listEl.querySelectorAll('.level-chip'));
  }

  syncRoving() {
    const chips = this.chips();
    if (!chips.length) return;
    const preferred = chips.find((chip) => chip.dataset.id === this.currentId) || chips[0];
    chips.forEach((chip) => {
      chip.tabIndex = chip === preferred ? 0 : -1;
    });
  }

  focusChip(chip) {
    if (!chip) return;
    this.chips().forEach((node) => {
      node.tabIndex = node === chip ? 0 : -1;
    });
    chip.focus({ preventScroll: true });
    chip.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }

  onListKey(event) {
    const chips = this.chips();
    if (!chips.length) return;
    const current = event.target.closest?.('.level-chip');
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    if (!current) {
      if (event.key === 'ArrowDown' || event.key === 'Home') {
        event.preventDefault();
        this.focusChip(chips[0]);
      }
      return;
    }

    event.preventDefault();
    const at = chips.indexOf(current);
    if (event.key === 'ArrowRight') this.focusChip(chips[Math.min(chips.length - 1, at + 1)]);
    else if (event.key === 'ArrowLeft') this.focusChip(chips[Math.max(0, at - 1)]);
    else if (event.key === 'Home') this.focusChip(chips[0]);
    else if (event.key === 'End') this.focusChip(chips[chips.length - 1]);
    else if (event.key === 'ArrowDown')
      this.focusChip(neighbourRow(chips, current, 1) || chips[chips.length - 1]);
    else if (event.key === 'ArrowUp') {
      const up = neighbourRow(chips, current, -1);
      if (up) this.focusChip(up);
      else this.searchEl.focus({ preventScroll: true });
    }
  }

  pick(levelId) {
    // The chosen id comes back through open()'s promise. `onPick` is kept as an
    // opt-in side channel: firing both here would make a caller that already
    // acts on the resolved value load the level twice.
    this.modal.close(levelId);
  }

  async confirmReset() {
    const ok = await confirmModal({
      title: 'Reset all progress',
      message:
        'This clears every solved mark and best command count on this device. Levels themselves are not affected.',
      confirmLabel: 'Reset everything',
      cancelLabel: 'Keep my progress',
      danger: true,
    });
    if (!ok) return;
    store.resetProgress();
    this.progress = {};
    this.renderMeter();
    this.renderList();
    toast('Progress cleared.', 'success');
  }
}
