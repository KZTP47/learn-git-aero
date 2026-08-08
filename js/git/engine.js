// The in-memory git model: repository state, ref resolution, the DAG helpers
// every command leans on, snapshot/frame production and the undo stack.
//
// Determinism is a hard rule here - no clocks, no randomness. Commit ids come
// from a counter over the ids that already exist, so the same command sequence
// always produces the same tree.

import { deepClone } from '../core/util.js';
import {
  CommandParseError,
  GitError,
  emptyMap,
  own,
  parseCommandLine,
  splitCommands,
  splitRefExpression,
} from './parse.js';
import {
  COMMANDS,
  COMMAND_NAMES,
  GIT_OPTION_SPECS,
  UI_COMMANDS,
  UI_COMMAND_NAMES,
  replayOnto,
  setTreeValidator,
} from './commands.js';

export { CommandParseError, GitError } from './parse.js';
export { COMMAND_NAMES };

const DEFAULT_MESSAGE = (id) => `Commit ${id}`;

/* -------------------------------------------------------------------------- */
/* Tree helpers                                                               */
/* -------------------------------------------------------------------------- */

// `emptyMap` / `own` come from parse.js so engine.js, commands.js and the
// parser all share one definition. Every map keyed by a name the reader
// controls - commits, branches, tags, messages, the command registries - is
// built with `emptyMap()`, and every existence check on one is `own()`.

export function freshTree() {
  const commits = emptyMap();
  commits.C0 = { id: 'C0', parents: [], rootCommit: true };
  const branches = emptyMap();
  branches.main = { id: 'main', target: 'C0', remoteTrackingBranchID: null };
  return { commits, branches, tags: emptyMap(), HEAD: { id: 'HEAD', target: 'main' } };
}

function commitOrder(id) {
  const match = /^C(\d+)/.exec(String(id));
  const base = match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  return [base, String(id).length, String(id)];
}

function newestCommitId(commits) {
  const ids = Object.keys(commits);
  if (!ids.length) return null;
  return ids.sort((a, b) => {
    const [an, al, as] = commitOrder(a);
    const [bn, bl, bs] = commitOrder(b);
    if (an !== bn) return an - bn;
    if (al !== bl) return al - bl;
    return as < bs ? -1 : as > bs ? 1 : 0;
  })[ids.length - 1];
}

/**
 * Coerce anything into a usable repo. Broken input is repaired rather than
 * rejected: a level with a typo should still show something instead of
 * blanking the page, and nothing here is allowed to log to the console.
 */
function normaliseRepo(input, { allowOrigin = true } = {}) {
  const raw = input && typeof input === 'object' ? input : {};

  const commits = emptyMap();
  const rawCommits = raw.commits && typeof raw.commits === 'object' ? raw.commits : {};
  for (const [key, value] of Object.entries(rawCommits)) {
    if (!value || typeof value !== 'object') continue;
    const id = typeof value.id === 'string' && value.id ? value.id : key;
    const parents = Array.isArray(value.parents)
      ? value.parents.filter((p) => typeof p === 'string' && p)
      : [];
    commits[id] = { id, parents, rootCommit: false };
  }
  for (const commit of Object.values(commits)) {
    commit.parents = commit.parents.filter((p) => own(commits, p) && p !== commit.id);
    commit.rootCommit = commit.parents.length === 0;
  }
  if (!Object.keys(commits).length) {
    commits.C0 = { id: 'C0', parents: [], rootCommit: true };
  }

  const branches = emptyMap();
  const rawBranches = raw.branches && typeof raw.branches === 'object' ? raw.branches : {};
  for (const [key, value] of Object.entries(rawBranches)) {
    if (!value || typeof value !== 'object') continue;
    const id = typeof value.id === 'string' && value.id ? value.id : key;
    const target = typeof value.target === 'string' ? value.target : null;
    if (!target || !own(commits, target)) continue;
    const tracking =
      typeof value.remoteTrackingBranchID === 'string' && value.remoteTrackingBranchID
        ? value.remoteTrackingBranchID
        : null;
    branches[id] = { id, target, remoteTrackingBranchID: tracking };
  }
  if (!Object.keys(branches).length) {
    branches.main = { id: 'main', target: newestCommitId(commits), remoteTrackingBranchID: null };
  }

  const tags = emptyMap();
  const rawTags = raw.tags && typeof raw.tags === 'object' ? raw.tags : {};
  for (const [key, value] of Object.entries(rawTags)) {
    if (!value || typeof value !== 'object') continue;
    const id = typeof value.id === 'string' && value.id ? value.id : key;
    const target = typeof value.target === 'string' ? value.target : null;
    if (!target || !own(commits, target)) continue;
    tags[id] = { id, target };
  }

  let headTarget = raw.HEAD && typeof raw.HEAD === 'object' ? raw.HEAD.target : null;
  if (typeof headTarget !== 'string' || (!own(branches, headTarget) && !own(commits, headTarget))) {
    headTarget = own(branches, 'main') ? 'main' : Object.keys(branches)[0];
  }

  const repo = { commits, branches, tags, HEAD: { id: 'HEAD', target: headTarget } };
  if (allowOrigin && raw.originTree && typeof raw.originTree === 'object') {
    repo.origin = normaliseRepo(raw.originTree, { allowOrigin: false });
    for (const branch of Object.values(repo.origin.branches)) branch.remoteTrackingBranchID = null;
  } else {
    repo.origin = null;
  }
  return repo;
}

function repoToTree(repo) {
  const commits = emptyMap();
  for (const id of Object.keys(repo.commits)) {
    const commit = repo.commits[id];
    commits[id] = commit.rootCommit
      ? { id, parents: [...commit.parents], rootCommit: true }
      : { id, parents: [...commit.parents] };
  }
  const branches = emptyMap();
  for (const id of Object.keys(repo.branches)) {
    const branch = repo.branches[id];
    branches[id] = {
      id,
      target: branch.target,
      remoteTrackingBranchID: branch.remoteTrackingBranchID ?? null,
    };
  }
  const tags = emptyMap();
  for (const id of Object.keys(repo.tags)) tags[id] = { id, target: repo.tags[id].target };

  const tree = { commits, branches, tags, HEAD: { id: 'HEAD', target: repo.HEAD.target } };
  if (repo.origin) tree.originTree = repoToTree(repo.origin);
  return tree;
}

function repoToSnapshot(repo) {
  const commits = emptyMap();
  for (const id of Object.keys(repo.commits)) {
    const commit = repo.commits[id];
    commits[id] = { id, parents: [...commit.parents], rootCommit: !!commit.rootCommit };
  }
  const branches = emptyMap();
  for (const id of Object.keys(repo.branches)) {
    const branch = repo.branches[id];
    branches[id] = {
      id,
      target: branch.target,
      remoteTrackingBranchID: branch.remoteTrackingBranchID ?? null,
      remote: id.startsWith('o/'),
    };
  }
  const tags = emptyMap();
  for (const id of Object.keys(repo.tags)) tags[id] = { id, target: repo.tags[id].target };

  return {
    commits,
    branches,
    tags,
    HEAD: {
      id: 'HEAD',
      target: repo.HEAD.target,
      detached: !Object.prototype.hasOwnProperty.call(repo.branches, repo.HEAD.target),
    },
    origin: repo.origin ? repoToSnapshot(repo.origin) : null,
  };
}

/** Strict validation - used by `import tree`, never repairs. */
export function isValidTree(obj) {
  try {
    let tree = obj;
    if (typeof tree === 'string') tree = JSON.parse(tree);
    return validateTree(tree, true);
  } catch {
    return false;
  }
}

function validateTree(tree, allowOrigin) {
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) return false;
  if (!tree.commits || typeof tree.commits !== 'object' || Array.isArray(tree.commits)) return false;

  // Every "does this ref exist?" question below is an own-property check.
  // A tree straight out of JSON.parse has Object.prototype behind its maps, so
  // a truthiness test would accept `HEAD -> "constructor"` or a parent named
  // "toString" - refs that do not exist - and the loader would then silently
  // rewrite them. The same tree from exportTree() (null-prototype maps) was
  // refused, so the answer depended on how the tree arrived.
  const ids = Object.keys(tree.commits);
  if (!ids.length) return false;
  for (const key of ids) {
    const commit = tree.commits[key];
    if (!commit || typeof commit !== 'object') return false;
    if (typeof commit.id !== 'string' || commit.id !== key) return false;
    if (!Array.isArray(commit.parents)) return false;
    for (const parent of commit.parents) {
      if (typeof parent !== 'string' || !own(tree.commits, parent)) return false;
    }
  }

  if (!tree.branches || typeof tree.branches !== 'object' || Array.isArray(tree.branches)) return false;
  for (const key of Object.keys(tree.branches)) {
    const branch = tree.branches[key];
    if (!branch || typeof branch !== 'object') return false;
    if (typeof branch.id !== 'string' || branch.id !== key) return false;
    if (typeof branch.target !== 'string' || !own(tree.commits, branch.target)) return false;
  }

  if (tree.tags !== undefined) {
    if (!tree.tags || typeof tree.tags !== 'object' || Array.isArray(tree.tags)) return false;
    for (const key of Object.keys(tree.tags)) {
      const tag = tree.tags[key];
      if (!tag || typeof tag !== 'object') return false;
      if (typeof tag.id !== 'string' || tag.id !== key) return false;
      if (typeof tag.target !== 'string' || !own(tree.commits, tag.target)) return false;
    }
  }

  if (!tree.HEAD || typeof tree.HEAD !== 'object') return false;
  if (typeof tree.HEAD.target !== 'string') return false;
  if (!own(tree.branches, tree.HEAD.target) && !own(tree.commits, tree.HEAD.target)) return false;

  if (tree.originTree !== undefined) {
    if (!allowOrigin) return false;
    if (!validateTree(tree.originTree, false)) return false;
  }
  return true;
}

// `import tree` validates through this without commands.js importing engine.js.
setTreeValidator(isValidTree);

/* -------------------------------------------------------------------------- */
/* GitEngine                                                                  */
/* -------------------------------------------------------------------------- */

export class GitEngine {
  constructor(treeJSON) {
    this._disabled = new Set();
    this._protected = new Set();
    this._pendingInteractive = null;
    this.loadTree(treeJSON === undefined ? freshTree() : treeJSON);
  }

  /* --- lifecycle -------------------------------------------------------- */

  /**
   * Replace all state.
   *
   * `baseline: true` (the default) also makes this tree the one `reset()`
   * returns to and clears the undo stack - that is what starting a level means.
   * `baseline: false` swaps the state in but leaves the level's start tree
   * authoritative, so `import tree` cannot hijack the Reset button.
   */
  loadTree(treeJSONOrString, { baseline = true } = {}) {
    let source = treeJSONOrString;
    if (typeof source === 'string') {
      try {
        source = JSON.parse(source);
      } catch {
        source = null;
      }
    }
    this.repo = normaliseRepo(source ?? freshTree());
    this.messages = emptyMap();
    this._prevHead = null;
    this._pendingInteractive = null;
    if (baseline) {
      this._history = [];
      this._stack = [];
      this._baseTree = repoToTree(this.repo);
    }
    return this;
  }

  exportTree() {
    return repoToTree(this.repo);
  }

  getSnapshot() {
    return repoToSnapshot(this.repo);
  }

  reset() {
    this.repo = normaliseRepo(deepClone(this._baseTree));
    this.messages = emptyMap();
    this._prevHead = null;
    this._history = [];
    this._stack = [];
    this._pendingInteractive = null;
  }

  undo() {
    if (!this._history.length) return false;
    const entry = this._history.pop();
    this._restore(entry.before);
    this._stack.pop();
    return true;
  }

  get commandStack() {
    return [...this._stack];
  }

  /** Levels can switch commands off; `run()` then explains instead of acting. */
  setDisabledCommands(list) {
    this._disabled = new Set(
      (Array.isArray(list) ? list : [])
        .filter((entry) => typeof entry === 'string')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    );
  }

  isDisabled(label) {
    const name = String(label ?? '').trim().toLowerCase();
    if (!name) return false;
    return this._disabled.has(name) || this._disabled.has(name.replace(/^git\s+/, ''));
  }

  /**
   * Remote branches the server refuses a direct push to, named the way they
   * appear on origin (`main`, not `o/main` - though either is accepted).
   * A level setting like disabledCommands: it survives loadTree and reset.
   */
  setProtectedRefs(list) {
    this._protected = new Set(
      (Array.isArray(list) ? list : [])
        .filter((entry) => typeof entry === 'string')
        .map((entry) => entry.trim().replace(/^o\//, ''))
        .filter(Boolean)
    );
  }

  get protectedRefs() {
    return [...this._protected];
  }

  isProtectedRef(name) {
    return this._protected.has(String(name ?? '').trim().replace(/^o\//, ''));
  }

  /**
   * Gate an *operation* rather than a command name, so a command that performs
   * a disabled operation by another route cannot slip past.
   */
  requireEnabled(label, what) {
    if (!this.isDisabled(label)) return;
    throw new GitError(
      `That would ${what}, and "${label}" is switched off for this level. Try another route - "hint" nudges you in the right direction.`
    );
  }

  get origin() {
    return this.repo.origin;
  }

  /* --- state capture ---------------------------------------------------- */

  _capture() {
    return {
      tree: repoToTree(this.repo),
      messages: Object.assign(emptyMap(), this.messages),
      prevHead: this._prevHead,
    };
  }

  _restore(state) {
    this.repo = normaliseRepo(deepClone(state.tree));
    this.messages = Object.assign(emptyMap(), state.messages);
    this._prevHead = state.prevHead;
  }

  /* --- graph helpers ---------------------------------------------------- */

  hasCommit(id, repo = this.repo) {
    return Object.prototype.hasOwnProperty.call(repo.commits, id);
  }

  isBranch(name, repo = this.repo) {
    return Object.prototype.hasOwnProperty.call(repo.branches, name);
  }

  isTag(name, repo = this.repo) {
    return Object.prototype.hasOwnProperty.call(repo.tags, name);
  }

  isKnownRefName(name, repo = this.repo) {
    return name === 'HEAD' || this.isBranch(name, repo) || this.isTag(name, repo) || this.hasCommit(name, repo);
  }

  currentBranch(repo = this.repo) {
    return this.isBranch(repo.HEAD.target, repo) ? repo.HEAD.target : null;
  }

  headCommit(repo = this.repo) {
    const target = repo.HEAD.target;
    if (this.isBranch(target, repo)) return repo.branches[target].target;
    if (this.hasCommit(target, repo)) return target;
    return newestCommitId(repo.commits);
  }

  ancestors(commitId, repo = this.repo) {
    const seen = new Set();
    const stack = [commitId];
    while (stack.length) {
      const id = stack.pop();
      if (!id || seen.has(id) || !this.hasCommit(id, repo)) continue;
      seen.add(id);
      for (const parent of repo.commits[id].parents) stack.push(parent);
    }
    return seen;
  }

  isAncestor(maybeAncestor, descendant, repo = this.repo) {
    if (maybeAncestor === descendant) return true;
    return this.ancestors(descendant, repo).has(maybeAncestor);
  }

  /** Post-order walk from `startId`, restricted to `set`; oldest commit first. */
  topoOrder(startId, set, repo = this.repo) {
    const out = [];
    const seen = new Set();
    const stack = [[startId, false]];
    while (stack.length) {
      const [id, done] = stack.pop();
      if (!set.has(id)) continue;
      if (done) {
        out.push(id);
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push([id, true]);
      const parents = own(repo.commits, id) ? repo.commits[id].parents : [];
      for (let i = parents.length - 1; i >= 0; i--) stack.push([parents[i], false]);
    }
    return out;
  }

  /* --- ids -------------------------------------------------------------- */

  newCommitId() {
    let highest = -1;
    const scan = (repo) => {
      if (!repo) return;
      for (const id of Object.keys(repo.commits)) {
        const match = /^C(\d+)/.exec(id);
        if (match) highest = Math.max(highest, Number(match[1]));
      }
      scan(repo.origin);
    };
    scan(this.repo);
    return `C${highest + 1}`;
  }

  /**
   * `C3` -> `C3'` -> `C3''` -> `C3'''` -> `C3'^4` -> `C3'^5` ...
   *
   * The search starts one rung *above the source*, never at the bottom of the
   * ladder. Repeated `git commit --amend` prunes the commit it replaced, which
   * frees that id again; starting from the bottom then handed it straight back,
   * so a reader amending three times was told "Rewrote C1'' as C1'" and
   * reasonably concluded the history had gone backwards.
   */
  copyId(sourceId) {
    const base = baseCommitId(sourceId);
    const taken = (id) => this.hasCommit(id, this.repo) || (this.repo.origin && this.hasCommit(id, this.repo.origin));
    const rung = (n) => (n <= 3 ? `${base}${"'".repeat(n)}` : `${base}'^${n}`);
    for (let n = copyGeneration(sourceId) + 1; ; n++) {
      const candidate = rung(n);
      if (!taken(candidate)) return candidate;
    }
  }

  /* --- mutation --------------------------------------------------------- */

  createCommit(parents, { id, message } = {}, repo = this.repo) {
    const commitId = id || this.newCommitId();
    const list = (parents || []).filter((p) => this.hasCommit(p, repo));
    repo.commits[commitId] = { id: commitId, parents: list, rootCommit: list.length === 0 };
    if (repo === this.repo) this.messages[commitId] = message || DEFAULT_MESSAGE(commitId);
    return repo.commits[commitId];
  }

  setBranch(name, target, repo = this.repo) {
    if (own(repo.branches, name)) repo.branches[name].target = target;
    else repo.branches[name] = { id: name, target, remoteTrackingBranchID: null };
    return repo.branches[name];
  }

  deleteBranch(name, repo = this.repo) {
    delete repo.branches[name];
  }

  setTag(name, target, repo = this.repo) {
    repo.tags[name] = { id: name, target };
    return repo.tags[name];
  }

  /** Move HEAD, remembering where it was so `git checkout -` can go back. */
  moveHead(target, { remember = true } = {}) {
    if (remember && this.repo.HEAD.target !== target) this._prevHead = this.repo.HEAD.target;
    this.repo.HEAD.target = target;
  }

  /** Where a ref update should land: the current branch, or HEAD when detached. */
  moveCurrent(commitId) {
    const branch = this.currentBranch();
    if (branch) this.setBranch(branch, commitId);
    else this.repo.HEAD.target = commitId;
  }

  /** Drop commits no ref can reach, in both the local repo and origin. */
  prune() {
    pruneRepo(this, this.repo);
    if (this.repo.origin) pruneRepo(this, this.repo.origin);
    for (const id of Object.keys(this.messages)) {
      if (!this.hasCommit(id)) delete this.messages[id];
    }
  }

  /* --- ref resolution --------------------------------------------------- */

  /**
   * `HEAD`, branch, tag, commit id, and chains of `~n` / `^n`.
   * Throws GitError with a friendly message when it cannot get there.
   */
  resolveRef(refText, repo = this.repo) {
    const text = String(refText ?? '').trim();
    if (!text) throw new GitError('That command needs a ref, for example "main", "HEAD~1" or "C2".');

    const parsed = splitRefExpression(text, (candidate) => this.isKnownRefName(candidate, repo));
    if (!parsed) {
      throw new GitError(
        `I cannot find "${text}". Check the spelling - "git branch" lists your branches and "git log" lists the commits.`
      );
    }

    let commitId;
    if (parsed.base === 'HEAD') commitId = this.headCommit(repo);
    else if (this.isBranch(parsed.base, repo)) commitId = repo.branches[parsed.base].target;
    else if (this.isTag(parsed.base, repo)) commitId = repo.tags[parsed.base].target;
    else commitId = parsed.base;

    if (!this.hasCommit(commitId, repo)) {
      throw new GitError(`"${parsed.base}" does not point at a commit that exists any more.`);
    }

    for (const step of parsed.steps) {
      commitId = this._applyRefStep(commitId, step, parsed.base, repo);
    }
    return commitId;
  }

  _applyRefStep(startId, step, label, repo) {
    let commitId = startId;
    if (step.kind === '~') {
      for (let i = 0; i < step.n; i++) {
        const parents = repo.commits[commitId].parents;
        if (!parents.length) {
          throw new GitError(
            `Cannot walk back ${step.n} from ${label}: ${commitId} is the root commit, so there is nothing before it.`
          );
        }
        commitId = parents[0];
      }
      return commitId;
    }
    if (step.n === 0) return commitId;
    const parents = repo.commits[commitId].parents;
    if (step.n > parents.length) {
      throw new GitError(
        `${commitId} has ${parents.length} parent${parents.length === 1 ? '' : 's'}, so "^${step.n}" does not point anywhere. "^2" only works on a merge commit.`
      );
    }
    return parents[step.n - 1];
  }

  /** Resolve a ref only if it names a branch, otherwise null. */
  branchAt(name, repo = this.repo) {
    return this.isBranch(name, repo) ? repo.branches[name] : null;
  }

  /* --- running commands ------------------------------------------------- */

  async run(commandString) {
    const merged = {
      ok: true,
      input: '',
      commandName: null,
      messages: [],
      frames: [],
      error: null,
    };

    // Coercing has to happen inside the guard: a value with a throwing
    // toString() would otherwise escape run() entirely, and the contract says
    // it never throws for *any* input.
    let input;
    let pieces;
    try {
      input = String(commandString ?? '');
      merged.input = input;
      // `import tree` carries raw JSON, which may contain `;` and newlines.
      pieces = /^\s*import\s+tree\b/i.test(input) ? [input.trim()] : splitCommands(input);
    } catch {
      return failed(
        merged,
        new CommandParseError('I could not read that as text. Type the command as plain text and try again.')
      );
    }

    if (!pieces.length) {
      return failed(
        merged,
        new CommandParseError(
          input.trim()
            ? 'There is no command in there - just separators. Type "help" to see what you can run.'
            : 'Type a command to begin. "help" explains the basics and "levels" lists the lessons.'
        )
      );
    }

    for (let i = 0; i < pieces.length; i++) {
      const result = this._runOne(pieces[i]);
      merged.messages.push(...result.messages);
      merged.frames.push(...result.frames);
      if (result.commandName) merged.commandName = result.commandName;
      for (const key of Object.keys(result)) {
        if (!['ok', 'input', 'commandName', 'messages', 'frames', 'error'].includes(key)) {
          merged[key] = result[key];
        }
      }
      if (!result.ok) {
        merged.ok = false;
        merged.error = result.error;
        const left = pieces.length - i - 1;
        if (left > 0) {
          merged.messages.push({
            type: 'warning',
            text: `Stopped here - ${left} more command${left === 1 ? '' : 's'} on this line ${left === 1 ? 'was' : 'were'} not run.`,
          });
        }
        break;
      }
    }
    return merged;
  }

  _runOne(piece) {
    const result = {
      ok: true,
      input: piece,
      commandName: null,
      messages: [],
      frames: [],
      error: null,
    };
    const before = this._capture();

    try {
      const parsed = parseCommandLine(piece, {
        uiNames: UI_COMMAND_NAMES,
        gitSpecs: GIT_OPTION_SPECS,
        allNames: COMMAND_NAMES,
      });

      const label = parsed.kind === 'git' ? parsed.label || `git ${parsed.name}` : parsed.name;
      if (this._disabled.has(label.toLowerCase()) || this._disabled.has(parsed.name.toLowerCase())) {
        throw new GitError(
          `"${label}" is switched off for this level. Solve it with the other commands - "hint" nudges you in the right direction.`
        );
      }

      const ctx = makeContext(this, parsed, result);
      // Own-property lookup as well: the registries are null-prototype, but a
      // command name must never be able to reach an inherited member either.
      const registry = parsed.kind === 'git' ? COMMANDS : UI_COMMANDS;
      const handler = own(registry, parsed.name) ? registry[parsed.name] : undefined;
      if (typeof handler !== 'function') {
        throw new CommandParseError(`"${label}" is recognised but not wired up yet.`);
      }
      result.commandName = result.commandName || parsed.name;
      handler(ctx);

      if (parsed.kind === 'git') {
        if (!result.frames.length) ctx.frame();
        this._recordIfChanged(piece, before);
      } else if (parsed.name === 'import tree') {
        // The one non-git command that changes state, so it has to be undoable.
        this._recordIfChanged(piece, before);
      }
      return result;
    } catch (err) {
      this._restore(before);
      // The handler may have pushed frames before it hit the error. Those
      // frames show work that has just been rolled back, so replaying them
      // would leave the drawing permanently out of step with the state.
      result.frames.length = 0;
      return failed(result, err);
    }
  }

  _recordIfChanged(command, before) {
    const after = this._capture();
    if (JSON.stringify(after.tree) === JSON.stringify(before.tree)) return;
    this._history.push({ command, before });
    this._stack.push(command);
  }

  /* --- interactive rebase handshake ------------------------------------- */

  get pendingInteractiveRebase() {
    return this._pendingInteractive ? { ...this._pendingInteractive, commits: [...this._pendingInteractive.commits] } : null;
  }

  /**
   * Completion half of `git rebase -i`. `orderedIds` is the list the user kept,
   * in the order they want them replayed (drop a commit by leaving it out).
   * Returns a CommandResult exactly like `run()` does, and never throws.
   */
  applyInteractiveRebase(orderedIds, options) {
    // Read the caller's options as own properties only. Inherited keys must
    // never stand in for a real pending request.
    const given = options && typeof options === 'object' ? options : {};
    const request = this._pendingInteractive || {};
    const pick = (key) => (own(given, key) ? given[key] : request[key]);
    const target = pick('target');
    const source = pick('source');
    const label = `git rebase -i ${pick('targetRef') ?? target ?? ''}`.trim();

    const result = {
      ok: true,
      input: label,
      commandName: 'rebase -i',
      messages: [],
      frames: [],
      error: null,
    };
    const before = this._capture();

    try {
      if (target === undefined || target === null) {
        throw new GitError('There is no interactive rebase waiting. Run "git rebase -i <target>" first.');
      }
      // "Not a list" must never quietly mean "drop every commit" - that is a
      // destructive default for a public method.
      if (!Array.isArray(orderedIds)) {
        throw new GitError(
          'applyInteractiveRebase needs an array of commit ids in the order to replay them. Pass [] to drop them all.'
        );
      }
      const list = orderedIds.map((id) => String(id));
      const seen = new Set();
      for (const id of list) {
        if (seen.has(id)) throw new GitError(`${id} appears twice in the list - each commit can only be replayed once.`);
        seen.add(id);
        if (!this.hasCommit(id)) throw new GitError(`${id} is not a commit in this repository.`);
      }

      const targetCommit = this.resolveRef(String(target));
      const ctx = makeContext(this, { kind: 'git', name: 'rebase', args: [], flags: {} }, result);
      replayOnto(ctx, {
        targetCommit,
        order: list,
        source: source ?? null,
        interactive: true,
      });

      if (!result.frames.length) ctx.frame();
      this._pendingInteractive = null;
      this._recordIfChanged(label, before);
      return result;
    } catch (err) {
      this._restore(before);
      return failed(result, err);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

export function baseCommitId(id) {
  const text = String(id);
  const at = text.indexOf("'");
  return at === -1 ? text : text.slice(0, at);
}

/** Which rung of the apostrophe ladder an id sits on: `C1` 0, `C1''` 2, `C1'^5` 5. */
export function copyGeneration(id) {
  const text = String(id);
  const at = text.indexOf("'");
  if (at === -1) return 0;
  const tail = text.slice(at);
  if (/^'+$/.test(tail)) return tail.length;
  const caret = /^'\^(\d+)$/.exec(tail);
  if (caret) {
    const n = Number(caret[1]);
    return Number.isFinite(n) && n > 0 && n < 1e6 ? n : 0;
  }
  return 0; // A shape this app never mints; treat it as an original.
}

function pruneRepo(engine, repo) {
  const keep = new Set();
  const roots = [];
  for (const branch of Object.values(repo.branches)) roots.push(branch.target);
  for (const tag of Object.values(repo.tags)) roots.push(tag.target);
  if (!Object.prototype.hasOwnProperty.call(repo.branches, repo.HEAD.target)) {
    roots.push(repo.HEAD.target);
  }
  for (const root of roots) {
    if (!Object.prototype.hasOwnProperty.call(repo.commits, root)) continue;
    for (const id of engine.ancestors(root, repo)) keep.add(id);
  }
  for (const id of Object.keys(repo.commits)) {
    if (!keep.has(id)) delete repo.commits[id];
  }
}

function failed(result, err) {
  const type = err && err.type === 'CommandParseError' ? 'CommandParseError' : 'GitError';
  const text =
    err && typeof err.message === 'string' && err.message
      ? err.message
      : 'Something went wrong running that command.';
  result.ok = false;
  result.error = { type, text };
  result.messages.push({ type: 'error', text });
  return result;
}

function makeContext(engine, parsed, result) {
  return {
    engine,
    result,
    name: parsed.name,
    kind: parsed.kind,
    args: parsed.args || [],
    flags: parsed.flags || {},
    rest: parsed.rest || '',
    get repo() {
      return engine.repo;
    },
    get origin() {
      return engine.repo.origin;
    },
    frame() {
      result.frames.push(engine.getSnapshot());
    },
    // Final keyframe: tidy unreachable commits, then record the state unless
    // the previous frame already showed exactly this.
    finish() {
      engine.prune();
      const snapshot = engine.getSnapshot();
      const last = result.frames[result.frames.length - 1];
      if (!last || JSON.stringify(last) !== JSON.stringify(snapshot)) result.frames.push(snapshot);
    },
    say(type, text) {
      result.messages.push({ type, text });
    },
    info(text) {
      result.messages.push({ type: 'info', text });
    },
    log(text) {
      result.messages.push({ type: 'log', text });
    },
    good(text) {
      result.messages.push({ type: 'success', text });
    },
    warn(text) {
      result.messages.push({ type: 'warning', text });
    },
    extra(key, value) {
      result[key] = value;
    },
    setName(name) {
      result.commandName = name;
    },
  };
}
