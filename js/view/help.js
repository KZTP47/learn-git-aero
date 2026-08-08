// Help panel content. Plain-English reference: what the app is, how to read the
// tree, every command, how to name a commit, and the keyboard map.

import { el, uid } from '../core/util.js';
import { icon } from './modal.js';
import { TreeView } from './tree-view.js';

const GIT_COMMANDS = [
  ['git commit', 'Save a new commit on top of wherever HEAD is pointing.'],
  ['git commit --amend', 'Replace the commit HEAD is sitting on with a fresh copy of it.'],
  ['git branch <name>', 'Drop a new branch label on the current commit without moving there.'],
  ['git branch -f <name> <ref>', 'Force an existing branch label onto another commit.'],
  ['git branch -d <name>', 'Delete a branch label. The commits it pointed at stay put.'],
  ['git checkout <ref>', 'Move HEAD onto a branch, a tag or a single commit.'],
  ['git checkout -b <name>', 'Create a branch and move onto it in one step.'],
  ['git checkout -', 'Jump back to whatever you had checked out before.'],
  ['git switch <ref>', 'The modern spelling of checkout for branches.'],
  ['git switch -c <name>', 'Create a branch and switch to it.'],
  ['git merge <ref>', 'Join another branch into this one, making a commit with two parents.'],
  ['git rebase <target>', 'Copy the commits under HEAD so they sit on top of the target.'],
  ['git rebase -i <target>', 'Reorder or drop commits before they are copied.'],
  ['git rebase --onto <new> <old> <branch>', 'Move one exact stretch of commits somewhere else.'],
  ['git reset <ref>', 'Slide the current branch label back to an earlier commit.'],
  ['git revert <ref>', 'Add a new commit that cancels out an older one.'],
  ['git cherry-pick <ref>...', 'Copy named commits, in order, onto the current branch.'],
  ['git tag <name> [ref]', 'Pin a permanent name to a commit so it is easy to find later.'],
  ['git describe <ref>', 'Name a commit by the closest tag behind it.'],
  ['git log', 'List the commits you can reach from HEAD.'],
  ['git status', 'Report where HEAD sits and which branch is checked out.'],
  ['git fetch', 'Bring new commits down from origin into the o/ branches.'],
  ['git pull', 'Fetch, then merge the matching remote branch into yours.'],
  ['git pull --rebase', 'Fetch, then rebase your work on top of the remote branch.'],
  ['git push', 'Send your commits up to origin and move the remote branch.'],
  ['git push origin <refspec>', 'Push one named source onto one named remote branch.'],
  ['git push -f', 'Overwrite the remote branch with yours, even if that drops commits.'],
  ['git clone', 'Create the origin repository, plus the o/ branches that track it.'],
];

const APP_COMMANDS = [
  ['help', 'Open this panel.'],
  ['levels', 'Open the level browser.'],
  ['sandbox', 'Switch to the free repository with no goal to reach.'],
  ['hint', 'Show the hint for the level you are on.'],
  ['show goal', 'Reveal the target tree beside your own.'],
  ['hide goal', 'Put the target tree away.'],
  ['show solution', 'Reveal one working answer, and offer to run it for you.'],
  ['undo', 'Step back one command.'],
  ['reset', 'Return the repository to the state the level started in.'],
  ['clear', 'Wipe the terminal output. The repository is untouched.'],
  ['refresh', 'Redraw the tree if a resize left it looking odd.'],
  ['show commands', 'Print every command you have run on this level.'],
  ['export tree', 'Print the current repository as JSON you can keep.'],
  ['import tree <json>', 'Load a repository from JSON you exported earlier.'],
  ['theme <name>', 'Switch between the day and dusk themes.'],
];

// F6 is the way out of the terminal, and it was documented only in text meant
// for a screen reader. A sighted reader who works by keyboard could not find
// it: Tab is busy completing the half-typed line, so without F6 the terminal
// looks like somewhere you cannot leave. Tab is described here as what it does
// - finishing a command - rather than as a way to move around.
const KEYS = [
  ['?', 'Open this help panel.'],
  ['Ctrl + Z', 'Undo the last command.'],
  ['Alt + L', 'Open the level browser.'],
  ['Alt + G', 'Show or hide the goal panel.'],
  ['Esc', 'Close the panel on top, or hide the goal.'],
  ['Up / Down', 'Step through commands you have already typed.'],
  ['Tab', 'Finish the command you started typing. It completes rather than moves.'],
  ['F6', 'Move focus out of the terminal, on to the commit graph.'],
  ['Shift + F6', 'Move focus out of the terminal, backwards.'],
  ['Ctrl + L', 'Clear the terminal.'],
  ['Ctrl + C', 'Abandon the line you are typing.'],
  ['Left / Right', 'Previous or next slide in a lesson.'],
  ['Home / End', 'First or last slide, or first or last level in the browser.'],
  ['Enter', 'Run the command, or press the highlighted button.'],
];

const REFS = [
  ['HEAD', 'Where you are standing right now.'],
  ['main', 'The commit a branch label points at.'],
  ['C3', 'One exact commit, by its id.'],
  ['HEAD~2', 'Two steps back along the first parent.'],
  ['HEAD^', 'The first parent. Same as HEAD~1.'],
  ['HEAD^2', 'The second parent, which only merge commits have.'],
  ['main^^~3', 'Chains read left to right, one hop at a time.'],
];

function table(caption, rows, monoFirst = true) {
  return el(
    'table',
    { class: 'help-table' },
    el('caption', { class: 'help-caption' }, caption),
    el(
      'tbody',
      {},
      ...rows.map(([left, right]) =>
        el(
          'tr',
          {},
          el('th', { scope: 'row' }, monoFirst ? el('code', {}, left) : el('kbd', {}, left)),
          el('td', {}, right)
        )
      )
    )
  );
}

// --- tree legend ----------------------------------------------------------
// Drawn by the real TreeView on a hand-built snapshot rather than by hand here.
// A hand-drawn approximation drifts the moment TREEVIEW changes anything, and
// the last one had drifted badly: flat rings for beads, a dashed outline for
// HEAD and a plain pill for a tag the app draws as a pentagon.

/** Snapshot literal, in the shape CONTRACT.md section 1 defines. */
function snap({ commits, branches = {}, tags = {}, head = null }) {
  return {
    commits: Object.fromEntries(
      commits.map(([id, parents], i) => [
        id,
        { id, parents: parents || [], rootCommit: i === 0 && !(parents || []).length },
      ])
    ),
    branches: Object.fromEntries(
      Object.entries(branches).map(([id, target]) => [
        id,
        { id, target, remoteTrackingBranchID: null, remote: false },
      ])
    ),
    tags: Object.fromEntries(Object.entries(tags).map(([id, target]) => [id, { id, target }])),
    HEAD: head ? { id: 'HEAD', target: head.target, detached: Boolean(head.detached) } : null,
    origin: null,
  };
}

// Every snapshot carries at least one ref: a commit no ref can reach is drawn
// in the stray-commit palette, which is honest but not what a first-time reader
// should be told a commit looks like.
const LEGEND = [
  {
    key: 'commit',
    title: 'A commit',
    body: 'Each bead is one saved state. A line runs from a commit down to its parent, so the first commit sits at the bottom and the newest work at the top.',
    snapshot: snap({
      commits: [['C0', []], ['C1', ['C0']]],
      branches: { main: 'C1' },
    }),
  },
  {
    key: 'branch',
    title: 'A branch label',
    body: 'A branch is only a name stuck to a commit. Two of them can sit on the same commit, and committing moves the one you are on along with you.',
    snapshot: snap({
      commits: [['C0', []], ['C1', ['C0']]],
      branches: { main: 'C1', feature: 'C1' },
    }),
  },
  {
    key: 'tag',
    title: 'A tag',
    body: 'A tag is a name that never moves. Use one to mark a release you want to find again. It is drawn as a pointer rather than a capsule.',
    snapshot: snap({
      commits: [['C0', []], ['C1', ['C0']]],
      branches: { main: 'C1' },
      tags: { 'v1.0': 'C0' },
    }),
  },
  {
    key: 'head',
    title: 'HEAD',
    body: 'HEAD marks where you are. It usually rides on a branch; point it straight at a commit and it is detached.',
    snapshot: snap({
      commits: [['C0', []], ['C1', ['C0']]],
      branches: { main: 'C1' },
      head: { target: 'main' },
    }),
  },
  {
    key: 'merge',
    title: 'A merge',
    body: 'Every line points at a parent, so an arrow always means the same thing. A merge commit has two parents: the solid line goes back to the branch you were on, and the dashed line to the branch you merged in.',
    snapshot: snap({
      commits: [
        ['C0', []],
        ['C1', ['C0']],
        ['C2', ['C0']],
        ['C3', ['C1', 'C2']],
      ],
      branches: { main: 'C3' },
    }),
  },
];

function legendItem(entry, views) {
  const host = el('div', { class: 'legend-tree', 'aria-hidden': 'true' });

  const view = new TreeView(host, {
    readOnly: true,
    compact: true,
    idPrefix: uid(`legend-${entry.key}`),
  });
  // Decoration, not a control: modals.css turns pointer events off so a wheel
  // over the card scrolls the panel instead of zooming the drawing, and the
  // caption carries the meaning, so the drawing is hidden from assistive tech.
  //
  // The tabindex="-1" TreeView puts on a read-only svg STAYS. Chrome keeps an
  // outermost <svg> in the sequential focus order unless that attribute is
  // physically present - the IDL property still reads -1 either way, which is
  // why removing it left five silent tab stops in this panel that no computed
  // check could see. Never strip it here.
  view.svg.setAttribute('aria-hidden', 'true');
  view.svg.removeAttribute('role');
  view.render(entry.snapshot, { animate: false });
  views.push(view);

  return el(
    'figure',
    { class: 'legend-item' },
    host,
    el('figcaption', {}, el('b', {}, entry.title), el('span', {}, entry.body))
  );
}

function treeLegend(views) {
  return el('div', { class: 'legend-grid' }, ...LEGEND.map((entry) => legendItem(entry, views)));
}

// --- panel ----------------------------------------------------------------

function point(name, text) {
  return el('li', { class: 'help-point' }, icon(name), el('span', {}, text));
}

/**
 * @returns {HTMLElement} the panel body. The legend holds live TreeView
 * instances; call `node.destroyLegend()` if you tear the panel down yourself.
 * Dropping the node is also safe - nothing outside it holds a reference, and
 * each view only observes its own subtree.
 */
export function helpBody() {
  const views = [];
  const root = el(
    'div',
    { class: 'help' },

    el(
      'section',
      { class: 'help-section help-intro' },
      el('h3', {}, 'What this is'),
      // Named, not placed. This sentence used to say "the terminal on the left
      // and the commit tree on the right", which is only true on a wide window:
      // under 900px the two panes stack, so a reader on a small laptop or a
      // phone was being pointed at a side of the screen with nothing on it. The
      // lesson prose was rewritten off left/right for exactly this reason - it
      // says "the board behind this panel" - so the help says it the same way,
      // by each pane's own name and job. Those names match what the panes are
      // called everywhere else: index.html labels them "Terminal" and "Commit
      // graph", and the F6 row below sends you from one to the other.
      el(
        'p',
        {},
        'A sandbox for learning git by watching it happen. It has two panes: the terminal, where you type real git commands, and the commit graph, which redraws to match every time one runs. Nothing here touches a real repository, so there is no way to break anything.'
      ),
      el(
        'ul',
        { class: 'help-points' },
        point('levels', 'Levels are short. Each one sets a target tree and asks you to reach it.'),
        point('goal', 'Open the goal panel whenever you want to compare your tree with the target.'),
        point('hint', 'Stuck? Ask for a hint first, then the solution. Neither costs you anything.'),
        point('undo', 'Undo steps back one command; reset returns the level to its starting state.')
      )
    ),

    el(
      'section',
      { class: 'help-section help-legend' },
      el('h3', {}, 'How to read the tree'),
      el(
        'p',
        {},
        'These are drawn by the same renderer as the board, so what you see here is exactly what you will see there.'
      ),
      treeLegend(views)
    ),

    el(
      'section',
      { class: 'help-section help-refs' },
      el('h3', {}, 'Naming a commit'),
      el(
        'p',
        {},
        'Most commands take a reference. A reference is any way of pointing at one commit.'
      ),
      table('Reference syntax', REFS)
    ),

    el(
      'section',
      { class: 'help-section help-commands' },
      el('h3', {}, 'Git commands'),
      table('Every git command this sandbox understands', GIT_COMMANDS),
      el('h3', {}, 'Sandbox commands'),
      table('Commands that drive the app rather than the repository', APP_COMMANDS)
    ),

    el(
      'section',
      { class: 'help-section help-keys' },
      el('h3', {}, 'Keyboard'),
      table('Shortcuts', KEYS, false)
    )
  );

  root.destroyLegend = () => {
    views.splice(0).forEach((view) => view.destroy());
  };
  return root;
}

export default helpBody;
