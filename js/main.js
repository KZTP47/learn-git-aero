// Application shell: owns the engine instance, the level lifecycle and all
// wiring between the view modules. Feature modules never talk to each other
// directly - everything routes through here or through the event bus.

import { bus } from './core/events.js';
import { store } from './core/store.js';
import { el, deepClone, prefersReducedMotion, raf, sleep } from './core/util.js';
import { loadSequences, allLevels, findLevel, nextLevel, FALLBACK_TREE } from './levels/index.js';

// --- module loading -------------------------------------------------------
// Modules are imported dynamically so that one broken/missing file degrades to a
// stub instead of blanking the page. In a finished build no stub is ever used.

async function tryImport(path, describe) {
  try {
    return await import(path);
  } catch (err) {
    console.error(`[boot] failed to load ${describe} (${path})`, err);
    return null;
  }
}

function stubTreeView(host) {
  return {
    async render(snapshot) {
      host.textContent = `tree-view module missing. ${
        Object.keys(snapshot?.commits || {}).length
      } commits.`;
    },
    async playFrames(frames) {
      await this.render(frames[frames.length - 1]);
    },
    setHighlight() {},
    resize() {},
    destroy() {},
  };
}

function stubTerminal(host, opts) {
  const log = el('div', { class: 'stub-log' });
  const input = el('input', { class: 'stub-input', placeholder: 'terminal module missing' });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      opts.onCommand(input.value.trim());
      input.value = '';
    }
  });
  host.append(log, input);
  return {
    print(text) {
      log.append(el('div', {}, text));
    },
    printResult(result) {
      (result.messages || []).forEach((m) => this.print(m.text));
    },
    printMarkdown(md) {
      this.print(md);
    },
    setBusy() {},
    focus() {
      input.focus();
    },
    clear() {
      log.textContent = '';
    },
    getHistory: () => [],
    setHistory() {},
  };
}

// --- app state ------------------------------------------------------------

const state = {
  engine: null,
  level: null,
  sequences: [],
  tree: null,
  goal: null,
  terminal: null,
  modules: {},
  solvedThisLevel: false,
  busy: false,
  generation: 0,
  pendingWin: null,
  pendingAction: null,
  celebrating: false,
  headNearMiss: false,
  soundOn: store.get('sound', true),
};

const $ = (id) => document.getElementById(id);

// --- level lifecycle ------------------------------------------------------

// Engine-level rules are configuration, not tree state: they survive loadTree()
// and never clear themselves, so every path that (re)loads a level must set
// both of them. Keeping it in one function stops the load and reset paths
// drifting apart.
function applyLevelRules(level) {
  state.engine.setDisabledCommands?.(level?.disabledCommands || []);
  state.engine.setProtectedRefs?.(level?.protectedRefs || []);
}

function levelIsSandbox(level) {
  return !level || level.id === 'sandbox' || !level.goalTree;
}

async function loadLevel(levelId, { silent = false } = {}) {
  const level = (await findLevel(levelId)) || (await allLevels())[0];
  if (!level) return;

  // Loading a level while a multi-frame animation is still playing used to let
  // the old playFrames() keep painting after the new tree was rendered, leaving
  // the graph showing a repository that no longer exists. Bumping the
  // generation tells any in-flight command to stop touching the view.
  state.generation += 1;
  state.pendingWin = null;

  state.level = level;
  state.solvedThisLevel = false;
  state.engine.loadTree(deepClone(level.startTree || FALLBACK_TREE));
  applyLevelRules(level);

  const generation = state.generation;
  await state.tree.render(state.engine.getSnapshot(), { animate: false });
  // A late frame from a cancelled animation can still land between those two
  // awaits, so assert the truth once more on the next frame.
  await raf();
  if (state.generation === generation) {
    await state.tree.render(state.engine.getSnapshot(), { animate: false });
  }
  renderGoal();
  updateChrome();

  if (location.hash !== `#${level.id}`) {
    history.replaceState(null, '', `#${level.id}`);
  }

  if (!silent) {
    state.terminal.clear();
    printLevelHeader(level);
    if (level.dialog && level.dialog.length) {
      // Deliberately not awaited: the lesson dialog stays open until the reader
      // dismisses it, and nothing downstream may block on that.
      openDialog(level);
    }
  }
  state.terminal.focus();
}

// The terminal should never start a level blank, even while the lesson dialog is
// open on top of it. This is orientation only - it must not leak the answer.
function printLevelHeader(level) {
  const seq = state.sequences.find((s) => s.key === level.sequenceKey);
  const position = seq ? `level ${level.index + 1} of ${seq.levels.length}` : '';
  const where = [level.sequenceName, position].filter(Boolean).join(', ');

  // The top bar already shows the sequence and the level name, so this adds
  // only what it does not: where you are in the sequence, and what to type.
  const lines = [];
  if (where) lines.push(`*${where}*`);
  lines.push(
    levelIsSandbox(level)
      ? 'Free play: no goal to hit. Type `help` to see every command.'
      : 'Type `objective` to reopen the lesson, `show goal` to compare against the target, ' +
          '`hint` if you get stuck, or `undo` and `reset` to step back.'
  );
  state.terminal.printMarkdown(lines.join('\n\n'));
}

// Saying what counts is part of the puzzle being fair. Without this a learner
// can build a tree that satisfies the words but not the grader, and never learn
// why it was rejected.
// Every mode also grades HEAD, so where you finish standing counts. Saying so
// is the difference between a fair puzzle and a silent rejection.
const GRADING_NOTES = {
  main: 'Graded: the commits reachable from main, and where you are standing.',
  allBranches:
    'Graded: every branch and where you are standing. Commit ids must match exactly.',
  allBranchesHashAgnostic:
    'Graded: every branch and where you are standing. A copied commit such as C2’ counts as its original.',
  allBranchesAndTags: 'Graded: every branch, every tag, and where you are standing.',
  tagsOnly: 'Graded: tags, and where you are standing.',
  withOrigin:
    'Graded: every branch on both your repository and the origin, and where you are standing.',
};

function renderGoal() {
  const panel = $('goal-panel');
  if (!state.goal || !panel) return;
  if (levelIsSandbox(state.level)) {
    panel.hidden = true;
    return;
  }
  // `ghost` draws the reader's current tree as dimmed outlines behind the
  // target, so the goal panel shows the distance to travel rather than just the
  // destination. Omitting the key would keep the previous ghost, so it is always
  // passed explicitly.
  state.goal.render(treeToSnapshot(state.level.goalTree), {
    animate: false,
    ghost: state.engine.getSnapshot(),
  });

  let note = panel.querySelector('.goal-grading');
  if (!note) {
    note = el('p', { class: 'goal-grading' });
    panel.appendChild(note);
  }
  note.textContent =
    GRADING_NOTES[state.level.compareMode] || GRADING_NOTES.allBranchesHashAgnostic;
}

// TreeJSON -> Snapshot for the read-only goal view. The engine does the same
// job for live state; this keeps the goal view independent of engine internals.
function treeToSnapshot(tree) {
  if (!tree) return { commits: {}, branches: {}, tags: {}, HEAD: { id: 'HEAD', target: 'main' }, origin: null };
  const t = deepClone(tree);
  const snap = {
    commits: t.commits || {},
    branches: t.branches || {},
    tags: t.tags || {},
    HEAD: { id: 'HEAD', ...(t.HEAD || { target: 'main' }) },
    origin: null,
  };
  snap.HEAD.detached = !snap.branches[snap.HEAD.target];
  for (const b of Object.values(snap.branches)) b.remote = b.id.startsWith('o/');
  if (t.originTree) snap.origin = treeToSnapshot(t.originTree);
  return snap;
}

function updateChrome() {
  const level = state.level;
  const title = $('level-title');
  const progress = $('level-progress');
  if (title) {
    title.textContent = level ? level.name : '';
    title.dataset.sequence = level ? level.sequenceName || '' : '';
  }
  if (progress && level) {
    const done = Object.keys(store.getProgress()).length;
    progress.textContent = `${done} solved`;
    progress.dataset.count = String(done);
  }
  const objectiveBtn = $('btn-objective');
  if (objectiveBtn) objectiveBtn.disabled = levelIsSandbox(level);
  const solutionBtn = $('btn-solution');
  if (solutionBtn) solutionBtn.disabled = levelIsSandbox(level);
  bus.emit('level:changed', level);
}

// --- command routing ------------------------------------------------------

// Also the source of tab-completions for shell-level commands, so anything the
// app tells a reader to type has to be listed here or Tab cannot complete it.
const UI_COMMANDS = new Set([
  'objective',
  'share',
  'levels',
  'help',
  'undo',
  'reset',
  'show goal',
  'hide goal',
  'show solution',
  'hint',
  'clear',
  'sandbox',
  'refresh',
  'theme',
]);

// --- sharing --------------------------------------------------------------
// A repository you built by hand is worth passing to someone else. The whole
// tree travels in the URL, so there is no server and nothing to expire.

const b64 = {
  encode(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(encoded) {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  },
};

async function shareLink() {
  let url;
  try {
    const tree = b64.encode(JSON.stringify(state.engine.exportTree()));
    url = `${location.origin}${location.pathname}?tree=${tree}#${state.level?.id || 'sandbox'}`;
  } catch (err) {
    state.terminal.print(`Could not build a link: ${err.message}`, 'error');
    return;
  }

  let copied = false;
  try {
    await navigator.clipboard.writeText(url);
    copied = true;
  } catch {
    // Clipboard needs a user gesture or permission; the link is still printed.
  }

  state.terminal.printMarkdown(
    `${copied ? 'Link copied to your clipboard.' : 'Copy this link:'}\n\n\`\`\`\n${url}\n\`\`\``
  );
  state.modules.toast?.toast(
    copied ? 'Share link copied' : 'Share link ready in the terminal',
    'success'
  );
}

// Returns true when the URL supplied a tree, so boot skips the level's start tree.
function applySharedTree(isValidTree) {
  const params = new URLSearchParams(location.search);
  const encoded = params.get('tree');
  if (!encoded) return false;

  const refuse = () => {
    // No console noise: a bad link is a user-facing situation, not a bug.
    state.modules.toast?.toast(
      'That shared link did not carry a repository I could read. Showing the level as it starts.',
      'warning',
      7000
    );
    return false;
  };

  let tree;
  try {
    tree = JSON.parse(b64.decode(encoded));
  } catch {
    return refuse();
  }
  // Anything can arrive in a URL. Without this a truncated link silently wiped
  // the level's start tree and then reported success.
  if (!isValidTree || !isValidTree(tree)) return refuse();

  state.engine.loadTree(tree);
  return true;
}

// Single owner of the busy flag, so nothing can mutate the engine while an
// animation is still walking a frame list.
async function withBusy(fn) {
  state.busy = true;
  state.terminal.setBusy(true);
  try {
    return await fn();
  } catch (err) {
    console.error('[app] action failed', err);
    state.terminal.print(String(err && err.message ? err.message : err), 'error');
  } finally {
    state.busy = false;
    state.terminal.setBusy(false);
    state.terminal.focus();
  }
  // Deliberately not awaited. The victory modal closes only when a human clicks
  // it, so awaiting here would leave the caller's promise pending indefinitely -
  // any scripted chain ending on a solve would stall.
  flushWin();
}

async function runCommand(raw) {
  const input = String(raw || '').trim();
  if (!input || state.busy) return;
  // The victory modal traps focus, so a person cannot reach the terminal while
  // it is open - but a scripted call still could, and mutating the repository
  // behind the celebration would leave the two disagreeing.
  if (state.celebrating) return;

  if (/^share$/i.test(input)) {
    state.terminal.print(input, 'command');
    await shareLink();
    state.terminal.focus();
    return;
  }

  // `objective` is a shell-level alias the engine has no reason to know about:
  // it reopens the lesson the reader just dismissed.
  if (/^(objective|lesson)$/i.test(input)) {
    state.terminal.print(input, 'command');
    if (state.level?.dialog?.length) openDialog(state.level);
    else {
      toggleGoal(true);
      state.terminal.print('This level has no lesson text. Showing the goal instead.', 'info');
    }
    state.terminal.focus();
    return;
  }

  const generation = state.generation;
  state.busy = true;
  state.terminal.setBusy(true);
  try {
    const result = await state.engine.run(input);
    state.terminal.printResult(result);

    // A failed command is rolled back by the engine, but it may still carry the
    // frames its handler produced before it threw. Playing those would draw a
    // repository that does not exist, so a failure always re-renders truth.
    if (result.ok && result.frames && result.frames.length) {
      await state.tree.playFrames(result.frames, {
        animate: !prefersReducedMotion(),
      });
    } else {
      await state.tree.render(state.engine.getSnapshot(), { animate: !prefersReducedMotion() });
    }

    // A level load during the animation replaced the repository underneath us.
    // Everything below belongs to a repository that no longer exists - but a
    // cancelled animation can still paint a stale frame after this point, so
    // assert the truth again rather than simply walking away.
    if (state.generation !== generation) {
      const settled = state.generation;
      await sleep(80);
      if (state.generation === settled) {
        await state.tree.render(state.engine.getSnapshot(), { animate: false });
      }
      return;
    }

    if (result.interactive) await runInteractiveRebase(result.interactive);
    await handleUiCommand(result, input);
    if (result.ok) playSound(result.commandName === null ? 'type' : 'ok');
    else playSound('error');

    // The ghost overlay tracks the live tree, so it has to refresh whenever the
    // repository changes and the panel is on screen.
    if (!$('goal-panel')?.hidden) renderGoal();

    // Pasting a tree in is not solving a level. Without this, importing the
    // level's own goal registers as a win and writes progress.
    if (!/^\s*import\s+tree\b/i.test(input)) await checkSolved();
  } catch (err) {
    console.error('[command] unexpected failure', err);
    state.terminal.print(String(err && err.message ? err.message : err), 'error');
  } finally {
    state.busy = false;
    state.terminal.setBusy(false);
    state.terminal.focus();
  }
  // Deliberately not awaited. The victory modal closes only when a human clicks
  // it, so awaiting here would leave the caller's promise pending indefinitely -
  // any scripted chain ending on a solve would stall.
  flushWin();
}

// `git rebase -i` does not change state on its own: the engine hands back the
// commits that would move, the reader reorders or drops them, and we apply the
// result as a single undoable step.
async function runInteractiveRebase(request) {
  const open = state.modules.rebasePanel?.openInteractiveRebase;
  let order = request.commits;

  if (open) {
    const choice = await open(request, { engine: state.engine });
    if (choice === null) {
      state.terminal.print('Interactive rebase cancelled. Nothing moved.', 'info');
      return;
    }
    order = choice;
  } else {
    state.terminal.print(
      'Interactive panel unavailable, applying the commits in their original order.',
      'warning'
    );
  }

  const applied = state.engine.applyInteractiveRebase(order);
  state.terminal.printResult(applied);
  if (applied.frames?.length) {
    await state.tree.playFrames(applied.frames, { animate: !prefersReducedMotion() });
  } else {
    await state.tree.render(state.engine.getSnapshot(), { animate: !prefersReducedMotion() });
  }
}

async function handleUiCommand(result, input) {
  // `reset` and `undo` exist both as app actions and as git subcommands, so the
  // raw input decides: anything starting with "git " belongs to the engine.
  if (/^\s*git\b/i.test(input || '')) return;
  const name = result.commandName;
  if (!name || !UI_COMMANDS.has(name)) return;

  switch (name) {
    case 'levels':
      await openLevelSelect();
      break;
    case 'help':
      await openHelp();
      break;
    case 'undo':
      await doUndo({ guard: false });
      break;
    case 'reset':
      await doReset({ guard: false });
      break;
    case 'theme':
      applyTheme(result.theme);
      break;
    case 'show goal':
      toggleGoal(true);
      break;
    case 'hide goal':
      toggleGoal(false);
      break;
    case 'show solution':
      // Deferred, not awaited: this opens a modal and then replays commands
      // through runCommand(), which would be refused by the busy guard we are
      // still holding. Queue it to run once the guard clears.
      state.pendingAction = showSolution;
      break;
    case 'hint':
      showHint();
      break;
    case 'clear':
      state.terminal.clear();
      break;
    case 'sandbox':
      await loadLevel('sandbox');
      break;
    case 'refresh':
      await state.tree.render(state.engine.getSnapshot(), { animate: false });
      break;
    default:
      break;
  }
}

// --- level completion -----------------------------------------------------

async function checkSolved() {
  const level = state.level;
  if (!level || levelIsSandbox(level) || state.solvedThisLevel) return;
  const compare = state.modules.compare;
  if (!compare) return;

  const current = state.engine.getSnapshot();
  const goal = treeToSnapshot(level.goalTree);
  const mode = level.compareMode || 'allBranchesHashAgnostic';
  const solved = compare.compareTrees(current, goal, mode);

  if (!solved) {
    reportHeadNearMiss(current, goal, mode);
    return;
  }
  state.headNearMiss = false;

  state.solvedThisLevel = true;
  const commandCount = state.engine.commandStack.length;
  store.setSolved(level.id, commandCount);
  updateChrome();
  playSound('win');
  // Queued, never awaited here: the victory modal only closes when a human
  // clicks it, and we are still holding the busy flag. Awaiting it inside the
  // busy window wedges every later command at the guard in runCommand().
  state.pendingWin = { level, commandCount };
  return state.pendingWin;
}

// HEAD counts towards a solution, so it is possible to build exactly the right
// shape and still not finish - you are simply standing in the wrong place. That
// silence is where a learner gives up, so say it once, plainly.
function reportHeadNearMiss(current, goal, mode) {
  const compare = state.modules.compare;
  const patched = deepClone(current);
  patched.HEAD = deepClone(goal.HEAD);

  if (!compare.compareTrees(patched, goal, mode)) {
    state.headNearMiss = false;
    return;
  }
  if (state.headNearMiss) return; // already said; do not nag on every command
  state.headNearMiss = true;

  const want = goal.HEAD.detached
    ? `commit \`${goal.HEAD.target}\`, with no branch checked out`
    : `\`${goal.HEAD.target}\``;
  state.terminal.printMarkdown(
    `That is the right shape. The only difference left is where you are standing: ` +
      `the goal wants you on ${want}.`
  );
  state.modules.toast?.toast('Right shape - wrong place to be standing.', 'info', 6000);
}

// Called only after the busy flag has been released.
async function flushWin() {
  // Anything that opens a modal and then drives further commands has to run
  // outside the busy window, or its own commands are refused by the guard.
  const action = state.pendingAction;
  if (action) {
    state.pendingAction = null;
    try {
      await action();
    } catch (err) {
      console.error('[app] deferred action failed', err);
    }
  }

  const win = state.pendingWin;
  if (!win || state.celebrating) return;
  state.pendingWin = null;
  state.celebrating = true;
  try {
    await celebrate(win.level, win.commandCount);
  } catch (err) {
    console.error('[app] celebration failed', err);
  } finally {
    state.celebrating = false;
  }
}

async function celebrate(level, commandCount) {
  const best = level.solutionCommand
    ? level.solutionCommand.split(';').filter((s) => s.trim()).length
    : commandCount;
  const upcoming = await nextLevel(level.id);
  const victoryModal = state.modules.modal?.victoryModal;

  if (!victoryModal) {
    state.terminal.print(`Level solved in ${commandCount} commands.`, 'success');
    return;
  }

  const gradedLevels = (await allLevels()).filter((l) => !levelIsSandbox(l));
  const solved = store.getProgress();
  const choice = await victoryModal({
    levelName: level.name,
    sequenceName: level.sequenceName,
    commandCount,
    bestCount: best || null,
    solvedCount: gradedLevels.filter((l) => solved[l.id]?.solved).length,
    totalCount: gradedLevels.length,
    nextLevelName: upcoming?.name || null,
  });
  if (choice === 'next' && upcoming) await loadLevel(upcoming.id);
  else if (choice === 'levels') await openLevelSelect();
}

// --- toolbar actions ------------------------------------------------------

// `guard` is on for toolbar and keyboard entry points, which can fire while a
// multi-frame animation is still playing; leaving it on there would let the
// engine change under a running playFrames() and desync the drawing. It is off
// when we are already inside runCommand(), which holds the busy flag itself.
async function doUndo({ guard = true } = {}) {
  if (guard && state.busy) return;
  const run = async () => {
    if (state.engine.undo()) {
      state.solvedThisLevel = false;
      await state.tree.render(state.engine.getSnapshot(), { animate: true });
      state.terminal.print('Undid the last command.', 'info');
    } else {
      state.terminal.print('Nothing left to undo.', 'warning');
    }
    await checkSolved();
  };
  return guard ? withBusy(run) : run();
}

async function doReset({ guard = true } = {}) {
  if (guard && state.busy) return;
  const run = async () => {
    // Reload the level's own start tree rather than the engine's baseline: an
    // `import tree` earlier in the session would otherwise have redefined what
    // "the starting state" means for this level.
    if (state.level?.startTree) {
      state.engine.loadTree(deepClone(state.level.startTree));
      applyLevelRules(state.level);
    } else {
      state.engine.reset();
    }
    state.solvedThisLevel = false;
    await state.tree.render(state.engine.getSnapshot(), { animate: true });
    state.terminal.print('Repository reset to the starting state.', 'info');
  };
  return guard ? withBusy(run) : run();
}

function toggleGoal(force) {
  const panel = $('goal-panel');
  if (!panel || levelIsSandbox(state.level)) return;
  const show = force === undefined ? panel.hidden : force;
  panel.hidden = !show;
  // The canvas pane reflows when the goal docks beside the graph, so the live
  // tree has to re-fit into its new box - otherwise the goal covers its labels.
  document.getElementById('canvas-pane')?.classList.toggle('has-goal', show);
  if (show) renderGoal();
  requestAnimationFrame(() => {
    state.tree?.resize();
    if (show) state.goal?.resize();
  });
  store.set('goalVisible', show);
}

async function showSolution() {
  const level = state.level;
  if (!level || !level.solutionCommand) {
    state.terminal.print('No stored solution for this level.', 'warning');
    return;
  }
  const Modal = state.modules.modal?.Modal;
  const commands = level.solutionCommand
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const body = `<p>One way to solve this level:</p><pre><code>${commands.join('\n')}</code></pre>`;
  if (!Modal) {
    state.terminal.print(commands.join('\n'), 'info');
    return;
  }
  const modal = new Modal({
    title: 'Solution',
    body,
    size: 'sm',
    buttons: [
      { label: 'Run it for me', variant: 'primary', onClick: () => 'run' },
      { label: 'Close', variant: 'ghost', onClick: () => null },
    ],
  });
  if ((await modal.open()) === 'run') {
    await doReset();
    for (const cmd of commands) {
      await runCommand(cmd);
      await sleep(120);
    }
  }
}

function showHint() {
  const hint = state.level?.hint;
  if (!hint) {
    state.terminal.print('No hint for this level.', 'warning');
    return;
  }
  // Markdown, not plain text: hints contain backticked commands, and printing
  // them raw leaks the backticks into the UI. Terminal only - a toast carrying
  // the identical sentence one line above is just noise.
  state.terminal.printMarkdown(`**Hint.** ${hint}`);
}

async function openLevelSelect() {
  const LevelSelect = state.modules.levelSelect?.LevelSelect;
  if (!LevelSelect) {
    const names = (await allLevels()).map((l) => `${l.id} - ${l.name}`).join('\n');
    state.terminal.print(names, 'info');
    return;
  }
  // LevelSelect resolves the chosen id from open(); it deliberately does not
  // also invoke a callback, so loading here is the single load path.
  const picker = new LevelSelect(state.sequences, store.getProgress(), {
    currentId: state.level?.id || null,
  });
  const picked = await picker.open();
  if (picked) await loadLevel(picked);
}

async function openDialog(level) {
  const LevelDialog = state.modules.dialog?.LevelDialog;
  if (!LevelDialog) {
    state.terminal.printMarkdown(
      (level.dialog || []).map((slide) => slide.markdown || '').join('\n\n')
    );
    return;
  }
  const dialog = new LevelDialog(level, {
    onFinish: () => state.terminal.focus(),
    onCommand: (cmd) => runCommand(cmd),
  });
  await dialog.open();
}

async function openHelp() {
  const Modal = state.modules.modal?.Modal;
  const help = state.modules.helpContent?.helpBody?.() || null;
  if (!Modal || !help) {
    state.terminal.print('Type "show commands" for the full list.', 'info');
    return;
  }
  const modal = new Modal({
    title: 'Help',
    body: help,
    size: 'lg',
    buttons: [{ label: 'Done', variant: 'primary', onClick: () => null }],
  });
  // The legend is built from live TreeView instances, so it has to be torn down
  // or each Help visit leaks four of them.
  modal.onClosed = () => help.destroyLegend?.();
  await modal.open();
}

// --- sound ----------------------------------------------------------------
// Generated with WebAudio so the app stays dependency-free and offline.

let audioCtx = null;
const SOUNDS = {
  ok: [660, 0.05, 'sine', 0.05],
  type: [420, 0.02, 'sine', 0.02],
  error: [180, 0.14, 'triangle', 0.07],
  win: [880, 0.5, 'sine', 0.09],
};

function playSound(kind) {
  if (!state.soundOn || !SOUNDS[kind]) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const [freq, dur, type, gainPeak] = SOUNDS[kind];
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (kind === 'win') osc.frequency.exponentialRampToValueAtTime(freq * 1.5, now + dur);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(gainPeak, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  } catch {
    /* audio is a nicety, never a failure */
  }
}

// --- chrome wiring --------------------------------------------------------

function wireToolbar() {
  const on = (id, fn) => $(id)?.addEventListener('click', fn);
  on('btn-levels', openLevelSelect);
  on('btn-objective', () => (state.level?.dialog?.length ? openDialog(state.level) : toggleGoal()));
  on('btn-hint', showHint);
  on('btn-solution', showSolution);
  on('btn-undo', doUndo);
  on('btn-reset', doReset);
  on('btn-help', openHelp);
  on('btn-theme', toggleTheme);
  on('btn-sound', toggleSound);
  on('btn-fullscreen', toggleFullscreen);
  $('goal-close')?.addEventListener('click', () => toggleGoal(false));
}

const THEMES = ['day', 'dusk'];

function applyTheme(name) {
  if (!THEMES.includes(name)) {
    state.terminal.print(`Unknown theme "${name}". Try: ${THEMES.join(', ')}.`, 'warning');
    return false;
  }
  document.documentElement.dataset.theme = name;
  store.set('theme', name);
  bus.emit('theme:changed', name);
  $('btn-theme')?.setAttribute('aria-label', `Theme: ${name}`);
  return true;
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dusk' ? 'day' : 'dusk');
}

function toggleSound() {
  state.soundOn = !state.soundOn;
  store.set('sound', state.soundOn);
  $('btn-sound')?.setAttribute('aria-pressed', String(state.soundOn));
  bus.emit('sound:changed', state.soundOn);
  if (state.soundOn) playSound('ok');
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const field = /^(input|textarea)$/i.test(e.target?.tagName || '') ? e.target : null;
    const emptyField = field && !field.value;
    const modal = document.querySelector('#modal-root .modal');

    // The app auto-focuses the terminal after every command, so a shortcut that
    // refuses to fire from a field is a shortcut that never fires. Allow it only
    // on an empty line, where "?" cannot be part of something being typed.
    if (e.key === '?' && !modal && (!field || emptyField)) {
      e.preventDefault();
      openHelp();
    }
    // Never steal Ctrl+Z from a text field: someone fixing a typo expects their
    // text back, not their repository rolled back.
    if (e.ctrlKey && e.key.toLowerCase() === 'z' && !modal && !field) {
      e.preventDefault();
      doUndo();
    }
    if (e.key === 'Escape' && !modal) toggleGoal(false);
    if (e.altKey && e.key.toLowerCase() === 'l' && !modal) {
      e.preventDefault();
      openLevelSelect();
    }
    if (e.altKey && e.key.toLowerCase() === 'g' && !modal) {
      e.preventDefault();
      toggleGoal();
    }
  });
}

function wirePaneDivider() {
  const divider = $('pane-divider');
  const pane = $('terminal-pane');
  if (!divider || !pane) return;

  const MIN = 280;
  const maxWidth = () => Math.max(MIN, window.innerWidth - 360);

  // A focusable role="separator" must expose its value, or arrow-key resizing is
  // silent to assistive tech - and it must be exposed from the first paint, not
  // only after someone has already dragged it.
  const describe = (width) => {
    divider.setAttribute('aria-valuemin', String(MIN));
    divider.setAttribute('aria-valuemax', String(maxWidth()));
    divider.setAttribute('aria-valuenow', String(Math.round(width)));
    divider.setAttribute('aria-valuetext', `Terminal pane ${Math.round(width)} pixels wide`);
  };

  const apply = (px) => {
    const width = Math.min(Math.max(px, MIN), maxWidth());
    pane.style.flexBasis = `${width}px`;
    describe(width);
    store.set('paneWidth', width);
    state.tree?.resize();
  };

  const saved = store.get('paneWidth', null);
  if (saved) apply(saved);
  else describe(pane.getBoundingClientRect().width || MIN);

  let dragging = false;
  const move = (e) => {
    if (!dragging) return;
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    apply(x - pane.getBoundingClientRect().left);
  };
  const stop = () => {
    dragging = false;
    document.body.classList.remove('is-resizing');
  };
  const start = (e) => {
    dragging = true;
    document.body.classList.add('is-resizing');
    e.preventDefault();
  };

  divider.addEventListener('mousedown', start);
  divider.addEventListener('touchstart', start, { passive: false });
  window.addEventListener('mousemove', move);
  window.addEventListener('touchmove', move, { passive: true });
  window.addEventListener('mouseup', stop);
  window.addEventListener('touchend', stop);
  divider.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') apply(pane.getBoundingClientRect().width - step);
    if (e.key === 'ArrowRight') apply(pane.getBoundingClientRect().width + step);
  });
}

function wireResize() {
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.tree?.resize();
      state.goal?.resize();
    }, 80);
  });
}

// --- boot -----------------------------------------------------------------

async function boot() {
  document.documentElement.dataset.theme = store.get('theme', 'day');

  const [engineMod, compareMod, treeMod, terminalMod, modalMod, dialogMod, selectMod, toastMod, helpMod] =
    await Promise.all([
      tryImport('./git/engine.js', 'git engine'),
      tryImport('./git/compare.js', 'tree comparison'),
      tryImport('./view/tree-view.js', 'tree view'),
      tryImport('./view/terminal-view.js', 'terminal'),
      tryImport('./view/modal.js', 'modal'),
      tryImport('./view/dialog.js', 'level dialog'),
      tryImport('./view/level-select.js', 'level select'),
      tryImport('./view/toast.js', 'toast'),
      tryImport('./view/help.js', 'help content'),
    ]);
  const rebaseMod = await tryImport('./view/rebase-panel.js', 'interactive rebase panel');

  state.modules = {
    compare: compareMod,
    modal: modalMod,
    dialog: dialogMod,
    levelSelect: selectMod,
    toast: toastMod,
    helpContent: helpMod,
    rebasePanel: rebaseMod,
  };

  if (!engineMod?.GitEngine) {
    document.body.append(
      el('div', { class: 'boot-error' }, 'The git engine module failed to load. See the console.')
    );
    return;
  }

  state.engine = new engineMod.GitEngine();
  state.sequences = await loadSequences();

  const treeHost = $('tree-host');
  const goalHost = $('goal-host');
  const terminalHost = $('terminal-host');

  state.tree = treeMod?.TreeView ? new treeMod.TreeView(treeHost) : stubTreeView(treeHost);
  state.goal = treeMod?.TreeView
    ? new treeMod.TreeView(goalHost, { readOnly: true, compact: true, idPrefix: 'goal' })
    : stubTreeView(goalHost);

  const completions = () =>
    (engineMod.COMMAND_NAMES || []).concat([...UI_COMMANDS]).filter(Boolean);
  state.terminal = terminalMod?.Terminal
    ? new terminalMod.Terminal(terminalHost, { onCommand: runCommand, completions })
    : stubTerminal(terminalHost, { onCommand: runCommand });

  state.terminal.setHistory(store.get('history', []));
  bus.on('terminal:history', (history) => store.set('history', history.slice(-200)));

  wireToolbar();
  wireKeyboard();
  wirePaneDivider();
  wireResize();

  $('btn-sound')?.setAttribute('aria-pressed', String(state.soundOn));

  // Exposed for the automated visual checks and for debugging. Set before the
  // first level loads so tooling never has to wait on a lesson dialog.
  window.__lga = { state, runCommand, loadLevel, treeToSnapshot, openLevelSelect, checkSolved };
  document.documentElement.classList.add('is-ready');

  const fromHash = location.hash.replace('#', '').trim();
  const known = await allLevels();
  // The skip link writes #workspace, so a hash that names a real element on the
  // page is an in-page anchor, not a level - warning about it would mean the app
  // scolding the user for a link the app itself wrote.
  const isPageAnchor = fromHash && Boolean(document.getElementById(fromHash));
  if (fromHash && !isPageAnchor && !known.some((l) => l.id === fromHash)) {
    // A shared link with a stale or mistyped id must not silently pretend to work.
    state.modules.toast?.toast(`No level called "${fromHash}". Opening the first one.`, 'warning', 6000);
  }
  const params = new URLSearchParams(location.search);
  const askedLevel = params.get('level');
  if (askedLevel && !known.some((l) => l.id === askedLevel)) {
    state.modules.toast?.toast(`No level called "${askedLevel}". Opening the first one.`, 'warning', 6000);
  }
  const startId = fromHash || askedLevel || store.get('lastLevel', null) || known[0]?.id;
  await loadLevel(startId);

  // A shared repository replaces the level's start tree, so it must be applied
  // after the level has loaded rather than before.
  if (applySharedTree(engineMod.isValidTree)) {
    await state.tree.render(state.engine.getSnapshot(), { animate: false });
    state.terminal.print('Loaded the repository from the shared link.', 'info');
  }
  if (params.get('command')) await runCommand(params.get('command'));
  if (store.get('goalVisible', false)) toggleGoal(true);

  window.addEventListener('hashchange', async () => {
    const id = location.hash.replace('#', '').trim();
    if (!id || id === state.level?.id) return;
    // Not every hash is a level. The skip link points at #workspace, and
    // treating that as a level id used to wipe the reader's repository and
    // bounce them to level one - a trap laid exclusively for keyboard users.
    if (!(await findLevel(id))) return;
    loadLevel(id);
  });
  bus.on('level:changed', (level) => level && store.set('lastLevel', level.id));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
