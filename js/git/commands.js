// Every command the terminal understands. Each handler receives the context
// built by engine.js and mutates the repository through the engine's helpers,
// pushing a frame whenever something visible happened.
//
// Handlers throw GitError / CommandParseError for anything the user got wrong;
// engine.run() turns those into a CommandResult and rolls the state back.

import { CommandParseError, GitError, emptyMap, own, parseRefspec } from './parse.js';

/* -------------------------------------------------------------------------- */
/* Option specs                                                               */
/* -------------------------------------------------------------------------- */

const NO_WORKING_DIRECTORY = 'a working directory, so there is nothing to stage or discard';

// Null-prototype: this table is indexed by whatever word follows "git", so on
// an ordinary object `git constructor` would resolve to the Object function and
// `new Set(spec.values)` would throw a raw TypeError at the reader.
export const GIT_OPTION_SPECS = Object.assign(emptyMap(), {
  commit: {
    booleans: ['--amend'],
    values: ['--message'],
    aliases: { '-m': '--message', '-a': '--all' },
    unsupported: { '--all': NO_WORKING_DIRECTORY },
    example: 'git commit -m "add the footer"',
  },
  branch: {
    // -a and --list are the default behaviour here: the listing always shows
    // remote-tracking branches, so accepting them changes nothing.
    booleans: ['--force', '--delete', '--force-delete', '--all', '--list'],
    aliases: { '-f': '--force', '-d': '--delete', '-D': '--force-delete', '-a': '--all' },
  },
  checkout: {
    booleans: ['--detach'],
    values: ['--new-branch', '--force-new-branch'],
    aliases: { '-b': '--new-branch', '-B': '--force-new-branch', '-f': '--force' },
    unsupported: { '--force': NO_WORKING_DIRECTORY },
    display: ['-b', '-B', '--detach'],
    example: 'git checkout -b feature',
  },
  switch: {
    booleans: ['--detach'],
    values: ['--create', '--force-create'],
    aliases: { '-c': '--create', '-C': '--force-create', '-f': '--force', '-d': '--detach' },
    unsupported: { '--force': NO_WORKING_DIRECTORY },
    display: ['-c', '-C', '--detach'],
    example: 'git switch -c feature',
  },
  merge: { booleans: ['--no-ff', '--ff-only'] },
  rebase: {
    booleans: ['--interactive', '--continue', '--abort'],
    values: ['--onto'],
    aliases: { '-i': '--interactive' },
    example: 'git rebase --onto main feature~2 feature',
  },
  reset: {
    booleans: ['--hard', '--soft', '--mixed'],
    unsupported: { '--keep': NO_WORKING_DIRECTORY },
  },
  // --no-edit is an honest no-op: there is no editor to skip.
  revert: { booleans: ['--no-edit'] },
  'cherry-pick': { booleans: ['--no-edit'] },
  tag: {
    booleans: ['--delete', '--list', '--force'],
    aliases: { '-d': '--delete', '-l': '--list', '-a': '--annotate', '-m': '--message', '-f': '--force' },
    unsupported: {
      '--annotate': 'annotated tags - every tag here is a lightweight pointer',
      '--message': 'annotated tags - every tag here is a lightweight pointer',
    },
  },
  describe: {
    unsupported: {
      // Real git needs --tags because describe otherwise looks only at
      // annotated tags. Here every tag is lightweight and always counted.
      '--tags': 'annotated tags - every tag here is lightweight, and describe already counts them all',
      '--all': 'describing from branches as well as tags',
    },
  },
  log: {
    booleans: ['--oneline'],
    unsupported: {
      '--graph': 'drawing a graph in text - the diagram this app keeps beside the terminal is the graph',
      '--all': 'walking every branch at once',
    },
  },
  status: { unsupported: { '--short': 'the short status format' } },
  show: {},
  fetch: {
    unsupported: {
      '--all': 'several remotes - there is only ever "origin" here',
      '--prune': 'pruning remote-tracking branches whose remote branch is gone',
    },
  },
  // --no-rebase is the default, so accepting it is honest.
  pull: {
    booleans: ['--rebase', '--ff-only', '--no-rebase'],
    aliases: { '-r': '--rebase' },
  },
  push: {
    booleans: ['--force', '--set-upstream'],
    aliases: { '-f': '--force', '-u': '--set-upstream' },
    unsupported: { '--all': 'pushing every branch in one go' },
  },
  clone: { unsupported: { '--bare': 'bare repositories' } },
  // Not a real git command - this app's own way to make the remote move while
  // you are standing still. Named plainly so nobody mistakes it for one.
  'teammate-pushes': {},
});

export const UI_COMMAND_NAMES = [
  'show commands',
  'show solution',
  'show goal',
  'hide goal',
  'import tree',
  'export tree',
  'theme',
  'sandbox',
  'levels',
  'refresh',
  'reset',
  'undo',
  'hint',
  'clear',
  'help',
];

export const COMMAND_NAMES = [
  'git commit',
  'git commit -m',
  'git commit --amend',
  'git branch',
  'git branch -f',
  'git branch -d',
  'git branch -D',
  'git checkout',
  'git checkout -b',
  'git checkout -B',
  'git checkout -',
  'git switch',
  'git switch -c',
  'git merge',
  'git rebase',
  'git rebase -i',
  'git rebase --onto',
  'git reset',
  'git reset --hard',
  'git reset --soft',
  'git revert',
  'git cherry-pick',
  'git tag',
  'git describe',
  'git log',
  'git status',
  'git show',
  'git clone',
  'git fetch',
  'git pull',
  'git pull --rebase',
  'git push',
  'git push -f',
  'git teammate-pushes',
  'help',
  'show commands',
  'levels',
  'sandbox',
  'hint',
  'show goal',
  'hide goal',
  'show solution',
  'undo',
  'reset',
  'clear',
  'refresh',
  'import tree',
  'export tree',
  'theme',
];

/* -------------------------------------------------------------------------- */
/* Small shared helpers                                                       */
/* -------------------------------------------------------------------------- */

const RESERVED_BRANCH_NAMES = new Set(['HEAD', 'head', '-']);

function baseId(id) {
  const text = String(id);
  const at = text.indexOf("'");
  return at === -1 ? text : text.slice(0, at);
}

function checkBranchName(name, what = 'branch') {
  if (typeof name !== 'string' || !name.trim()) {
    throw new CommandParseError(`That ${what} needs a name, for example "feature".`);
  }
  if (name.startsWith('-')) {
    throw new CommandParseError(`"${name}" starts with a dash, so git reads it as an option. Pick a plain name like "feature".`);
  }
  if (RESERVED_BRANCH_NAMES.has(name)) {
    throw new GitError(`"${name}" is reserved by git and cannot be used as a ${what} name.`);
  }
  if (name.startsWith('o/')) {
    throw new GitError(
      `In this model "o/" is the shorthand for a remote-tracking branch, the way real git writes "origin/". Those move when you fetch or push, so they are not created by hand.`
    );
  }
  // The rules git itself applies in check-ref-format. Worth enforcing even
  // though nothing downstream depends on them: a name git would reject should
  // not look like it worked here.
  if (/[\s~^:?*[\\]/.test(name) || /[\x00-\x1f\x7f]/.test(name)) {
    throw new GitError(`"${name}" contains a character git does not allow in a ${what} name.`);
  }
  if (name.includes('..')) {
    throw new GitError(`"${name}" contains "..", which git reads as a range, so it cannot be a ${what} name.`);
  }
  if (name.includes('@{') || name === '@') {
    throw new GitError(`"${name}" uses git's "@" syntax, so it cannot be a ${what} name.`);
  }
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    throw new GitError(`"${name}" has a misplaced slash. A ${what} name cannot start or end with "/" or contain "//".`);
  }
  if (name.endsWith('.') || name.endsWith('.lock')) {
    throw new GitError(`A ${what} name cannot end with "${name.endsWith('.lock') ? '.lock' : '.'}".`);
  }
  if (name.split('/').some((part) => part.startsWith('.'))) {
    throw new GitError(`"${name}" has a part beginning with ".", which git does not allow in a ${what} name.`);
  }
}

/**
 * Two flags that ask for different jobs. Real git answers these with a usage
 * error; this model used to accept both, honour whichever the handler tested
 * first and drop the rest on the floor - so "git branch --list -d feature"
 * deleted the branch the reader had asked it to list.
 */
function conflictingFlags(command, a, b, explain) {
  return new CommandParseError(
    `"${a}" and "${b}" ask ${command} to do two different things${explain ? `: ${explain}` : ''}. Git refuses rather than guessing which one you meant - run them one at a time.`
  );
}

/**
 * Shell-style ref patterns for the listing flags: `feat*`, `v?`, or a plain
 * name. Returns a predicate; a null pattern list matches everything.
 */
function refMatcher(patterns) {
  if (!patterns || !patterns.length) return () => true;
  const tests = patterns.map((pattern) => {
    const source = String(pattern)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${source}$`);
  });
  return (name) => tests.some((test) => test.test(name));
}

/**
 * `refs/heads/main` and `heads/main` both mean the branch `main`.
 *
 * Stripping runs to a fixed point. One pass left
 * `refs/heads/refs/heads/main` naming a branch literally called
 * `refs/heads/main`, which no real repository would ever show.
 */
function normaliseRefName(name) {
  let value = String(name ?? '');
  for (;;) {
    const next = value.replace(/^refs\/heads\//, '').replace(/^heads\//, '');
    if (next === value) return value;
    value = next;
  }
}

function requireOrigin(ctx) {
  if (!ctx.engine.repo.origin) {
    throw new GitError('This repository has no remote yet. Run "git clone" first to create one.');
  }
  return ctx.engine.repo.origin;
}

/**
 * A branch worth naming in a "go somewhere else" message.
 *
 * Never returns `exclude`: telling someone to check out the branch they are
 * already standing on - or the one they just tried to act on - reads as a
 * contradiction and stalls the reader. Returns null when there is genuinely
 * nothing else to suggest, so the caller can fall back to generic advice.
 */
function otherBranchName(engine, exclude, repo = engine.repo) {
  const names = Object.keys(repo.branches)
    .filter((name) => name !== exclude && !name.startsWith('o/'))
    .sort();
  if (!names.length) return null;
  return names.includes('main') ? 'main' : names[0];
}

function requireCurrentBranch(ctx, action) {
  const branch = ctx.engine.currentBranch();
  if (!branch) {
    const elsewhere = otherBranchName(ctx.engine, null);
    throw new GitError(
      `HEAD is detached, so git does not know which branch to ${action}. Check out a branch first${
        elsewhere ? `, for example "git checkout ${elsewhere}"` : ''
      }.`
    );
  }
  return branch;
}

function copyCommitInto(engine, commit, repo) {
  repo.commits[commit.id] = {
    id: commit.id,
    parents: [...commit.parents],
    rootCommit: commit.parents.length === 0,
  };
}

function missingCommits(engine, fromRepo, toRepo, startId) {
  const reachable = engine.ancestors(startId, fromRepo);
  const missing = new Set();
  for (const id of reachable) {
    if (!Object.prototype.hasOwnProperty.call(toRepo.commits, id)) missing.add(id);
  }
  return engine.topoOrder(startId, new Set([...missing, startId]), fromRepo).filter((id) => missing.has(id));
}

/* -------------------------------------------------------------------------- */
/* git commit                                                                 */
/* -------------------------------------------------------------------------- */

function commit(ctx) {
  const { engine, flags, args } = ctx;
  if (args.length) {
    throw new CommandParseError(
      `git commit does not take "${args[0]}" as an argument here. If that was part of a message, quote it: git commit -m "${[...args].join(' ')}".`
    );
  }
  const head = engine.headCommit();

  if (flags.amend) {
    const original = engine.repo.commits[head];
    const newId = engine.copyId(head);
    engine.createCommit([...original.parents], {
      id: newId,
      message: flags.message || engine.messages[head] || `Commit ${head}`,
    });
    engine.moveCurrent(newId);
    ctx.good(`Rewrote ${head} as ${newId}. Same parents, new commit.`);
    ctx.finish();
    return;
  }

  const created = engine.createCommit([head], { message: flags.message });
  engine.moveCurrent(created.id);
  const where = engine.currentBranch();
  ctx.good(
    where
      ? `[${where} ${created.id}] ${engine.messages[created.id]}`
      : `[detached HEAD ${created.id}] ${engine.messages[created.id]}`
  );
  ctx.finish();
}

/* -------------------------------------------------------------------------- */
/* git branch                                                                 */
/* -------------------------------------------------------------------------- */

function branch(ctx) {
  const { engine, flags, args } = ctx;

  const listing = flags.list ? '--list' : flags.all ? '-a' : null;
  const deleting = flags.delete ? '-d' : flags.forceDelete ? '-D' : null;
  if (listing && deleting) {
    throw conflictingFlags('git branch', listing, deleting, 'one lists branches, the other removes one');
  }
  if (listing && flags.force) {
    throw conflictingFlags('git branch', listing, '-f', 'one lists branches, the other moves one');
  }

  if (flags.delete || flags.forceDelete) {
    const names = args.length ? args : [];
    if (!names.length) throw new CommandParseError('Which branch should I delete? Try "git branch -d feature".');
    for (const name of names) {
      deleteOneBranch(ctx, name, Boolean(flags.forceDelete));
    }
    ctx.finish();
    return;
  }

  // --list / -a list matching refs. With a pattern they still list; real git
  // never creates a branch when you ask it to list one.
  if (flags.list || flags.all || !args.length) {
    listBranches(ctx, args.length ? args : null);
    return;
  }

  const [name, at] = args;
  checkBranchName(name);
  const target = engine.resolveRef(at ?? 'HEAD');

  if (engine.isBranch(name)) {
    if (!flags.force) {
      throw new GitError(
        `A branch called "${name}" already exists. Use "git branch -f ${name} ${at ?? 'HEAD'}" to move it, or pick another name.`
      );
    }
    if (engine.currentBranch() === name) {
      ctx.warn(
        `Real git refuses to force-move the branch you are standing on; you would use "git reset" for that instead. Moving "${name}" anyway so you can see what happens.`
      );
    }
    engine.setBranch(name, target);
    ctx.good(`Moved "${name}" to ${target}.`);
  } else {
    engine.setBranch(name, target);
    ctx.good(`Created branch "${name}" at ${target}.`);
  }
  ctx.finish();
}

function deleteOneBranch(ctx, name, force) {
  const { engine } = ctx;
  if (!engine.isBranch(name)) {
    throw new GitError(`There is no branch called "${name}". "git branch" lists the ones you have.`);
  }
  if (name.startsWith('o/')) {
    throw new GitError(
      `"${name}" is a remote-tracking branch: your record of where the remote was. This model keeps it in step with fetch and push rather than letting you delete it.`
    );
  }
  if (engine.currentBranch() === name) {
    const elsewhere = otherBranchName(engine, name);
    throw new GitError(
      `You are standing on "${name}", so it cannot be deleted. Move away first${
        elsewhere
          ? `, for example "git checkout ${elsewhere}"`
          : ' - there is no other branch to move to, so make one with "git checkout -b somewhere-else"'
      }.`
    );
  }
  const tip = engine.repo.branches[name].target;
  if (!force && !engine.isAncestor(tip, engine.headCommit())) {
    throw new GitError(
      `"${name}" has commits that are not in your current history, so deleting it would lose them. Use "git branch -D ${name}" if you really mean it.`
    );
  }
  // Any local branch that used this one as its upstream loses that link.
  for (const other of Object.values(engine.repo.branches)) {
    if (other.remoteTrackingBranchID === name) other.remoteTrackingBranchID = null;
  }
  engine.deleteBranch(name);
  ctx.good(`Deleted branch "${name}" (was ${tip}).`);
}

function listBranches(ctx, patterns) {
  const { engine } = ctx;
  const current = engine.currentBranch();
  const matches = refMatcher(patterns);
  const local = [];
  const remote = [];
  for (const name of Object.keys(engine.repo.branches).sort()) {
    if (!matches(name)) continue;
    const info = engine.repo.branches[name];
    const line = `${name === current ? '* ' : '  '}${name} -> ${info.target}${
      info.remoteTrackingBranchID ? ` (tracking ${info.remoteTrackingBranchID})` : ''
    }`;
    (name.startsWith('o/') ? remote : local).push(line);
  }
  if (patterns && !local.length && !remote.length) {
    ctx.info(`No branch matches ${patterns.map((p) => `"${p}"`).join(' or ')}.`);
    ctx.frame();
    return;
  }
  if (!current && !patterns) ctx.log(`* (HEAD detached at ${engine.headCommit()})`);
  local.forEach((line) => ctx.log(line));
  if (remote.length) {
    ctx.log('remote-tracking:');
    remote.forEach((line) => ctx.log(line));
  }
  ctx.frame();
}

/* -------------------------------------------------------------------------- */
/* git checkout / git switch                                                  */
/* -------------------------------------------------------------------------- */

function checkout(ctx) {
  const { engine, flags, args } = ctx;
  const create = flags.newBranch ?? flags.create;
  const forceCreate = flags.forceNewBranch ?? flags.forceCreate;

  // `git checkout -b x -B y` used to create x and drop y without a word.
  const command = `git ${ctx.name}`;
  const createFlag = ctx.name === 'switch' ? '-c' : '-b';
  const forceFlag = ctx.name === 'switch' ? '-C' : '-B';
  if (create !== undefined && forceCreate !== undefined) {
    throw conflictingFlags(command, createFlag, forceFlag, 'each names the branch to create, and only one branch is created');
  }
  if ((create !== undefined || forceCreate !== undefined) && flags.detach) {
    throw conflictingFlags(
      command,
      create !== undefined ? createFlag : forceFlag,
      '--detach',
      'one puts HEAD on a new branch, the other takes HEAD off every branch'
    );
  }

  if (create !== undefined || forceCreate !== undefined) {
    const name = create ?? forceCreate;
    checkBranchName(name);
    const start = engine.resolveRef(args[0] ?? 'HEAD');
    const existed = engine.isBranch(name);
    if (existed && create !== undefined) {
      if (engine.currentBranch() === name) {
        throw new GitError(
          `You are already standing on "${name}". Choose another name for the new branch, or drop the -b to stay put.`
        );
      }
      throw new GitError(
        `A branch called "${name}" already exists. Use "git checkout ${name}" to go to it, or "-B" to reset it to a new place.`
      );
    }
    engine.setBranch(name, start);
    engine.moveHead(name);
    ctx.good(existed ? `Reset branch "${name}" to ${start}.` : `Switched to a new branch "${name}" at ${start}.`);
    ctx.finish();
    return;
  }

  if (flags.detach) {
    const commitId = engine.resolveRef(args[0] ?? 'HEAD');
    if (args.length > 1) throw new CommandParseError(`git ${ctx.name} --detach takes one place to go.`);
    engine.moveHead(commitId);
    ctx.good(`HEAD is now detached at ${commitId}.`);
    ctx.finish();
    return;
  }

  const wanted = args[0];
  if (wanted === undefined) {
    throw new CommandParseError(
      'git checkout needs somewhere to go, for example "git checkout main" or "git checkout -b feature".'
    );
  }
  if (args.length > 1) {
    throw new CommandParseError(
      `git checkout takes one place to go, but got ${args.length}. Did you mean "git checkout -b ${args[0]} ${args[1]}"?`
    );
  }

  if (wanted === '-') {
    const previous = engine._prevHead;
    if (!previous) throw new GitError('There is nowhere to go back to yet - this is the first place you have been.');
    if (!engine.isBranch(previous) && !engine.hasCommit(previous)) {
      throw new GitError(`The previous spot (${previous}) no longer exists.`);
    }
    engine.moveHead(previous);
    ctx.good(
      engine.isBranch(previous) ? `Switched back to branch "${previous}".` : `Back to ${previous} with HEAD detached.`
    );
    ctx.finish();
    return;
  }

  if (engine.isBranch(wanted) && !wanted.startsWith('o/')) {
    engine.moveHead(wanted);
    ctx.good(`Switched to branch "${wanted}".`);
    ctx.finish();
    return;
  }

  const commitId = engine.resolveRef(wanted);
  engine.moveHead(commitId);
  ctx.good(`HEAD is now detached at ${commitId}.`);
  ctx.info('Detached means HEAD points straight at a commit instead of a branch. New commits will not move any branch.');
  ctx.finish();
}

/* -------------------------------------------------------------------------- */
/* git merge                                                                  */
/* -------------------------------------------------------------------------- */

function merge(ctx) {
  const { args, flags } = ctx;
  if (!args.length) {
    throw new CommandParseError('git merge needs something to merge, for example "git merge feature".');
  }
  if (args.length > 1) {
    throw new CommandParseError('This model merges one branch at a time. Run "git merge <ref>" once per branch.');
  }
  doMerge(ctx, args[0], { noFf: Boolean(flags.noFf), ffOnly: Boolean(flags.ffOnly) });
  ctx.finish();
}

function doMerge(ctx, refText, { noFf = false, ffOnly = false } = {}) {
  const { engine } = ctx;
  if (noFf && ffOnly) {
    throw new CommandParseError(
      '--no-ff and --ff-only ask for opposite things: one insists on a merge commit, the other refuses to make one.'
    );
  }
  engine.requireEnabled('git merge', 'merge');

  const target = engine.resolveRef(refText);
  const head = engine.headCommit();

  if (target === head) {
    throw new GitError(`${refText} is exactly where you already are - a commit cannot be merged into itself.`);
  }
  if (engine.isAncestor(target, head)) {
    ctx.info(`Already up to date. Everything in ${refText} is part of this history already.`);
    return { changed: false };
  }

  const canFastForward = engine.isAncestor(head, target);
  if (canFastForward && !noFf) {
    engine.moveCurrent(target);
    ctx.good(`Fast-forward. ${engine.currentBranch() || 'HEAD'} slid straight to ${target}.`);
    return { changed: true, fastForward: true };
  }
  if (!canFastForward && ffOnly) {
    throw new GitError(
      `Not possible to fast-forward: ${refText} and ${engine.currentBranch() || 'HEAD'} have both moved on since they parted. Drop --ff-only to make a merge commit, or rebase first.`
    );
  }

  const label = engine.isBranch(refText) ? refText : target;
  const created = engine.createCommit([head, target], { message: `Merge ${label} into ${engine.currentBranch() || head}` });
  engine.moveCurrent(created.id);
  if (canFastForward) {
    ctx.good(
      `Merge made: ${created.id} has two parents (${head} and ${target}). --no-ff kept the merge visible instead of sliding the branch forward.`
    );
  } else {
    ctx.good(`Merge made: ${created.id} has two parents (${head} and ${target}).`);
  }
  return { changed: true, mergeCommit: created.id };
}

/* -------------------------------------------------------------------------- */
/* git rebase                                                                 */
/* -------------------------------------------------------------------------- */

function rebase(ctx) {
  const { engine, flags, args } = ctx;

  if (flags.abort || flags.continue) {
    throw new GitError(
      'There is nothing to continue or abort - this model replays a rebase in one go, so it never stops halfway.'
    );
  }

  let newBaseRef;
  let upstreamRef;
  let sourceRef;

  if (flags.onto !== undefined) {
    newBaseRef = flags.onto;
    upstreamRef = args[0];
    sourceRef = args[1];
    if (!upstreamRef) {
      throw new CommandParseError(
        'git rebase --onto needs a new base and an upstream: git rebase --onto <newbase> <upstream> [branch].'
      );
    }
  } else {
    newBaseRef = args[0];
    sourceRef = args[1];
    upstreamRef = newBaseRef;
    if (!newBaseRef) {
      throw new CommandParseError('git rebase needs a target, for example "git rebase main".');
    }
    if (args.length > 2) {
      throw new CommandParseError('git rebase takes at most a target and a source: "git rebase main feature".');
    }
  }

  const newBase = engine.resolveRef(newBaseRef);
  const upstream = engine.resolveRef(upstreamRef);
  const sourceCommit = sourceRef ? engine.resolveRef(sourceRef) : engine.headCommit();
  const sourceName = sourceRef ?? engine.currentBranch();

  const { order, merges, present } = rebaseCandidates(engine, { newBase, upstream, sourceCommit });

  if (flags.interactive) {
    engine._pendingInteractive = {
      commits: [...order],
      target: newBase,
      targetRef: newBaseRef,
      upstream,
      source: sourceName ?? null,
    };
    ctx.setName('rebase -i');
    ctx.extra('interactive', {
      commits: [...order],
      target: newBase,
      source: sourceName ?? null,
      upstream,
    });
    if (!order.length) {
      ctx.info(`Nothing to replay onto ${newBase} - the interactive list would be empty.`);
    } else {
      ctx.info(
        `Interactive rebase: ${order.length} commit${order.length === 1 ? '' : 's'} (${order.join(', ')}) ready to move onto ${newBase}. Reorder or drop them in the panel, then confirm.`
      );
    }
    ctx.frame();
    return;
  }

  if (!order.length && newBase === sourceCommit) {
    ctx.info(`Current branch ${sourceName ?? 'HEAD'} is up to date - there is nothing to replay.`);
    ctx.frame();
    return;
  }

  // Say out loud what is being left behind, so a dropped commit can never be a
  // surprise the reader only notices later.
  if (present.length) {
    ctx.info(
      `Skipping ${present.join(', ')} - ${present.length === 1 ? 'that change is' : 'those changes are'} already on ${newBaseRef}.`
    );
  }
  if (merges.length) {
    ctx.info(
      `Flattening past ${merges.join(', ')}: rebase replays single-parent commits by default, so the merge ${merges.length === 1 ? 'commit itself is' : 'commits themselves are'} not recreated.`
    );
  }

  replayOnto(ctx, { targetCommit: newBase, order, source: sourceName ?? null });
}

/**
 * Commits reachable from source but not from upstream, oldest first.
 *
 * The whole range - merge commits included - has to stay in the set the walk
 * traverses. Filtering merges out beforehand made the topological walk stop at
 * the first merge it met, so every commit underneath vanished from the result
 * and, because the branch still moved, was pruned away for good.
 * Merges are dropped from the *replay list* instead, which is what real git
 * does when it flattens a rebase.
 */
function rebaseCandidates(engine, { newBase, upstream, sourceCommit }) {
  const fromUpstream = engine.ancestors(upstream);
  const alreadyThere = new Set([...engine.ancestors(newBase)].map(baseId));

  const range = new Set();
  for (const id of engine.ancestors(sourceCommit)) {
    if (!fromUpstream.has(id)) range.add(id);
  }

  const order = [];
  const merges = [];
  const present = [];
  for (const id of engine.topoOrder(sourceCommit, range)) {
    if (engine.repo.commits[id].parents.length > 1) merges.push(id);
    else if (alreadyThere.has(baseId(id))) present.push(id);
    else order.push(id);
  }
  return { order, merges, present, range };
}

/**
 * Shared by `git rebase`, `git rebase -i` (via applyInteractiveRebase) and
 * `git pull --rebase`. Copies `order` onto `targetCommit`, then moves the
 * source branch and HEAD the way real git leaves them.
 */
export function replayOnto(ctx, { targetCommit, order, source, interactive = false }) {
  const { engine } = ctx;
  // The gate has to sit on the operation, not on the command name, or
  // "git pull --rebase" would quietly rewrite history a level had ruled out.
  engine.requireEnabled('git rebase', 'replay commits');
  let base = targetCommit;
  const created = [];

  for (const id of order) {
    const newId = engine.copyId(id);
    engine.createCommit([base], { id: newId, message: engine.messages[id] || `Commit ${id}` });
    created.push(newId);
    base = newId;
    ctx.frame();
  }

  const isBranch = typeof source === 'string' && engine.isBranch(source);
  if (isBranch) {
    engine.setBranch(source, base);
    engine.moveHead(source, { remember: false });
  } else if (source === null && engine.currentBranch()) {
    engine.setBranch(engine.currentBranch(), base);
  } else {
    engine.repo.HEAD.target = base;
  }

  if (created.length) {
    ctx.good(
      `${interactive ? 'Interactive rebase' : 'Rebase'} replayed ${created.length} commit${
        created.length === 1 ? '' : 's'
      }: ${created.join(', ')}.`
    );
  } else if (base === targetCommit) {
    ctx.good(`Fast-forwarded ${isBranch ? source : 'HEAD'} to ${targetCommit} - there was nothing to replay.`);
  }
  ctx.finish();
}

/* -------------------------------------------------------------------------- */
/* git reset                                                                  */
/* -------------------------------------------------------------------------- */

function reset(ctx) {
  const { engine, flags, args } = ctx;
  if (args.length > 1) {
    throw new CommandParseError('git reset moves one ref: "git reset HEAD~1".');
  }
  const refText = args[0] ?? 'HEAD';
  const target = engine.resolveRef(refText);
  const branch = engine.currentBranch();
  const before = engine.headCommit();

  if (branch) engine.setBranch(branch, target);
  else engine.repo.HEAD.target = target;

  const mode = flags.hard ? '--hard' : flags.soft ? '--soft' : flags.mixed ? '--mixed' : null;
  if (before === target) {
    ctx.info(`${branch || 'HEAD'} was already at ${target}. Nothing moved.`);
  } else {
    ctx.good(`${branch || 'HEAD'} moved from ${before} to ${target}.`);
  }
  if (mode) {
    ctx.info(
      `${mode} decides what happens to your staged changes and your working tree. This model has neither, so --soft, --mixed and --hard all do the same thing here: move the ref.`
    );
  }
  if (!branch) {
    ctx.info('HEAD is detached, so the reset moved HEAD itself and left every branch where it was.');
  }
  ctx.finish();
}

/* -------------------------------------------------------------------------- */
/* git revert                                                                 */
/* -------------------------------------------------------------------------- */

function revert(ctx) {
  const { engine, args } = ctx;
  if (!args.length) {
    throw new CommandParseError('git revert needs at least one commit, for example "git revert HEAD".');
  }
  for (const refText of args) {
    const target = engine.resolveRef(refText);
    const commit = engine.repo.commits[target];
    if (commit.parents.length > 1) {
      throw new GitError(
        `${target} is a merge commit. Reverting a merge needs a side to keep, which this model does not track.`
      );
    }
    const head = engine.headCommit();
    const newId = engine.copyId(target);
    engine.createCommit([head], { id: newId, message: `Revert "${engine.messages[target] || target}"` });
    engine.moveCurrent(newId);
    ctx.good(`Reverted ${target} with a new commit ${newId}.`);
    ctx.frame();
  }
  ctx.info('Revert never rewrites history: it adds a commit that undoes an older one.');
  ctx.finish();
}

/* -------------------------------------------------------------------------- */
/* git cherry-pick                                                            */
/* -------------------------------------------------------------------------- */

function cherryPick(ctx) {
  const { engine, args } = ctx;
  if (!args.length) {
    throw new CommandParseError('git cherry-pick needs at least one commit, for example "git cherry-pick C3".');
  }
  for (const refText of args) {
    const target = engine.resolveRef(refText);
    const head = engine.headCommit();
    if (engine.isAncestor(target, head)) {
      throw new GitError(
        `${target} is already part of this history, so there is nothing to copy. Pick a commit that HEAD cannot reach.`
      );
    }
    const newId = engine.copyId(target);
    engine.createCommit([head], { id: newId, message: engine.messages[target] || `Commit ${target}` });
    engine.moveCurrent(newId);
    ctx.good(`Copied ${target} onto ${head} as ${newId}.`);
    ctx.frame();
  }
  ctx.finish();
}

/* -------------------------------------------------------------------------- */
/* git tag / git describe                                                     */
/* -------------------------------------------------------------------------- */

function tag(ctx) {
  const { engine, flags, args } = ctx;

  if (flags.list && flags.delete) {
    throw conflictingFlags('git tag', '-l', '-d', 'one lists tags, the other removes one');
  }
  if (flags.list && flags.force) {
    throw conflictingFlags('git tag', '-l', '-f', 'one lists tags, the other repoints one');
  }
  if (flags.delete && flags.force) {
    throw conflictingFlags('git tag', '-d', '-f', 'one removes a tag, the other repoints it');
  }

  if (flags.delete) {
    if (!args.length) throw new CommandParseError('Which tag should I delete? Try "git tag -d v1".');
    for (const name of args) {
      if (!engine.isTag(name)) throw new GitError(`There is no tag called "${name}".`);
      delete engine.repo.tags[name];
      ctx.good(`Deleted tag "${name}".`);
    }
    ctx.finish();
    return;
  }

  // -l / --list lists matching tags. With a pattern real git still lists, so
  // it must never fall through to creating one.
  if (flags.list || !args.length) {
    const matches = refMatcher(flags.list && args.length ? args : null);
    const names = Object.keys(engine.repo.tags).sort().filter(matches);
    if (args.length && flags.list && !names.length) {
      ctx.info(`No tag matches ${args.map((a) => `"${a}"`).join(' or ')}.`);
      ctx.frame();
      return;
    }
    if (!names.length) ctx.info('No tags yet. "git tag v1" pins a name to wherever HEAD is.');
    else names.forEach((name) => ctx.log(`${name} -> ${engine.repo.tags[name].target}`));
    ctx.frame();
    return;
  }

  const [name, at] = args;
  checkBranchName(name, 'tag');
  const existing = engine.isTag(name) ? engine.repo.tags[name].target : null;
  if (existing && !flags.force) {
    throw new GitError(
      `A tag called "${name}" already exists at ${existing}. Tags do not move on their own - use "git tag -f ${name} ${at ?? 'HEAD'}" if you really want to repoint it.`
    );
  }
  const target = engine.resolveRef(at ?? 'HEAD');
  engine.setTag(name, target);
  if (existing) ctx.good(`Moved tag "${name}" from ${existing} to ${target}.`);
  else ctx.good(`Tagged ${target} as "${name}". Unlike a branch, this tag will never move on its own.`);
  ctx.finish();
}

function describe(ctx) {
  const { engine, args } = ctx;
  if (args.length > 1) throw new CommandParseError('git describe looks at one ref at a time.');
  const refText = args[0] ?? 'HEAD';
  const start = engine.resolveRef(refText);

  const found = nearestTag(engine, start);
  if (!found) {
    // Suggest a tag name that is actually free, or the advice fails too.
    let suggestion = 'v1';
    for (let n = 2; engine.isTag(suggestion); n++) suggestion = `v${n}`;
    throw new GitError(
      `No tag can describe ${start} - nothing in its history is tagged. Create one with "git tag ${suggestion} ${start}".`
    );
  }
  const text = found.distance === 0 ? found.tag : `${found.tag}-${found.distance}-g${start}`;
  ctx.extra('describe', text);
  ctx.log(text);
  if (found.distance > 0) {
    ctx.info(
      `That reads as: the closest tag behind ${start} is "${found.tag}", ${found.distance} commit${
        found.distance === 1 ? '' : 's'
      } back, and the commit itself is ${start}.`
    );
  }
  ctx.frame();
}

/**
 * Real git counts the commits between the tag and the target - the same number
 * `git rev-list --count <tag>..<commit>` gives - not the length of the shortest
 * path. Across a merge those differ: a tag four commits back on the long side
 * is four away, even though the short side reaches it in two.
 */
function nearestTag(engine, startId) {
  const reachable = engine.ancestors(startId);
  let best = null;
  for (const name of Object.keys(engine.repo.tags).sort()) {
    const target = engine.repo.tags[name].target;
    if (!reachable.has(target)) continue;
    const behind = engine.ancestors(target);
    let distance = 0;
    for (const id of reachable) if (!behind.has(id)) distance++;
    if (!best || distance < best.distance) best = { tag: name, distance };
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* git log / status / show                                                    */
/* -------------------------------------------------------------------------- */

function log(ctx) {
  const { engine, args } = ctx;
  if (args.length > 1) throw new CommandParseError('git log reads one starting point at a time.');
  const start = engine.resolveRef(args[0] ?? 'HEAD');
  const reachable = engine.ancestors(start);
  const order = engine.topoOrder(start, reachable).reverse();

  const limit = 60;
  for (const id of order.slice(0, limit)) {
    const commit = engine.repo.commits[id];
    if (ctx.flags.oneline) {
      ctx.log(`${id} ${engine.messages[id] || `Commit ${id}`}`);
      continue;
    }
    ctx.log(`commit ${id}${commit.parents.length > 1 ? ` (merge of ${commit.parents.join(' and ')})` : ''}`);
    ctx.log(`    ${engine.messages[id] || `Commit ${id}`}`);
  }
  if (order.length > limit) ctx.info(`... and ${order.length - limit} older commits.`);
  ctx.frame();
}

function status(ctx) {
  const { engine } = ctx;
  const branchName = engine.currentBranch();
  const head = engine.headCommit();

  if (!branchName) {
    ctx.log(`HEAD detached at ${head}`);
    ctx.info('New commits will move HEAD only. Make a branch here with "git branch <name>" before you leave.');
    ctx.frame();
    return;
  }

  ctx.log(`On branch ${branchName}`);
  const upstream = engine.repo.branches[branchName].remoteTrackingBranchID;
  if (upstream && engine.isBranch(upstream)) {
    const remoteTip = engine.repo.branches[upstream].target;
    const ahead = countUnique(engine, head, remoteTip);
    const behind = countUnique(engine, remoteTip, head);
    if (!ahead && !behind) ctx.log(`Your branch is up to date with "${upstream}".`);
    else if (ahead && !behind) ctx.log(`Your branch is ahead of "${upstream}" by ${ahead} commit${ahead === 1 ? '' : 's'}.`);
    else if (!ahead && behind) ctx.log(`Your branch is behind "${upstream}" by ${behind} commit${behind === 1 ? '' : 's'}.`);
    else ctx.log(`Your branch and "${upstream}" have diverged: ${ahead} local and ${behind} remote commit(s).`);
  } else if (engine.repo.origin) {
    ctx.log(`"${branchName}" has no upstream branch yet.`);
  }
  ctx.log(`HEAD is at ${head}.`);
  ctx.frame();
}

function countUnique(engine, fromId, otherId) {
  const other = engine.ancestors(otherId);
  let count = 0;
  for (const id of engine.ancestors(fromId)) if (!other.has(id)) count++;
  return count;
}

function show(ctx) {
  const { engine, args } = ctx;
  const id = engine.resolveRef(args[0] ?? 'HEAD');
  const commit = engine.repo.commits[id];
  ctx.log(`commit ${id}`);
  ctx.log(commit.parents.length ? `parents: ${commit.parents.join(', ')}` : 'parents: none (root commit)');
  ctx.log(`    ${engine.messages[id] || `Commit ${id}`}`);
  const pointers = [
    ...Object.keys(engine.repo.branches).filter((name) => engine.repo.branches[name].target === id),
    ...Object.keys(engine.repo.tags).filter((name) => engine.repo.tags[name].target === id),
  ].sort();
  if (pointers.length) ctx.log(`refs here: ${pointers.join(', ')}`);
  ctx.frame();
}

/* -------------------------------------------------------------------------- */
/* Remotes: clone / fetch / push / pull                                       */
/* -------------------------------------------------------------------------- */

function clone(ctx) {
  const { engine } = ctx;
  if (engine.repo.origin) {
    throw new GitError('This repository already has a remote called "origin". There is nothing left to clone.');
  }

  // Built with emptyMap(), exactly like a repo that came through normaliseRepo.
  // A raw `{}` here made the cloned origin the one repo in the app whose maps
  // had Object.prototype behind them, so the same command behaved differently
  // depending on where the remote came from.
  const origin = {
    commits: emptyMap(),
    branches: emptyMap(),
    tags: emptyMap(),
    HEAD: { id: 'HEAD', target: 'main' },
    origin: null,
  };
  for (const commit of Object.values(engine.repo.commits)) copyCommitInto(engine, commit, origin);
  for (const local of Object.values(engine.repo.branches)) {
    if (local.id.startsWith('o/')) continue;
    origin.branches[local.id] = { id: local.id, target: local.target, remoteTrackingBranchID: null };
  }
  for (const t of Object.values(engine.repo.tags)) origin.tags[t.id] = { id: t.id, target: t.target };
  const originHead = engine.currentBranch() || (own(origin.branches, 'main') ? 'main' : Object.keys(origin.branches)[0]);
  origin.HEAD.target = originHead;
  engine.repo.origin = origin;

  const created = [];
  for (const remoteBranch of Object.values(origin.branches)) {
    const trackingName = `o/${remoteBranch.id}`;
    engine.repo.branches[trackingName] = {
      id: trackingName,
      target: remoteBranch.target,
      remoteTrackingBranchID: null,
    };
    engine.repo.branches[remoteBranch.id].remoteTrackingBranchID = trackingName;
    created.push(trackingName);
  }

  ctx.good(`Cloned into a remote called "origin".`);
  ctx.info(
    `You now have ${created.length} remote-tracking branch${created.length === 1 ? '' : 'es'} (${created.join(', ')}). They are your local memory of where the remote was the last time you talked to it.`
  );
  ctx.finish();
}

function fetch(ctx) {
  const { args } = ctx;
  requireOrigin(ctx);
  const spec = readRemoteArgs(args);
  const outcome = doFetch(ctx, spec);
  if (!outcome.downloaded.length && !outcome.moved.length) {
    ctx.info('Already up to date - the remote has nothing you do not already have.');
  }
  ctx.finish();
}

/** Shared by fetch and pull. `spec` is `{src, dst}` or null for "everything". */
function doFetch(ctx, spec) {
  const { engine } = ctx;
  const origin = engine.repo.origin;
  const downloaded = [];
  const moved = [];

  const names = spec ? [spec.src] : Object.keys(origin.branches).sort();
  for (const name of names) {
    // Own-property check: "git fetch origin constructor" used to sail past a
    // truthiness test, report "Updated o/constructor -> undefined" and leave a
    // ref pointing at nothing behind.
    const remoteBranch = own(origin.branches, name) ? origin.branches[name] : null;
    if (!remoteBranch) {
      throw new GitError(`The remote has no branch called "${name}". "git branch" on the remote side would list ${Object.keys(origin.branches).sort().join(', ') || 'nothing'}.`);
    }
    const trackingName = `o/${spec ? spec.dst : name}`;
    for (const id of missingCommits(engine, origin, engine.repo, remoteBranch.target)) {
      copyCommitInto(engine, origin.commits[id], engine.repo);
      downloaded.push(id);
      ctx.frame();
    }
    const existing = own(engine.repo.branches, trackingName) ? engine.repo.branches[trackingName] : null;
    if (!existing || existing.target !== remoteBranch.target) {
      engine.setBranch(trackingName, remoteBranch.target);
      moved.push(`${trackingName} -> ${remoteBranch.target}`);
    }
    // A local branch of the same name with no upstream now has an obvious one.
    const local = own(engine.repo.branches, name) ? engine.repo.branches[name] : null;
    if (local && !local.remoteTrackingBranchID) local.remoteTrackingBranchID = trackingName;
  }

  if (downloaded.length) {
    ctx.good(`Downloaded ${downloaded.length} commit${downloaded.length === 1 ? '' : 's'}: ${downloaded.join(', ')}.`);
  }
  if (moved.length) ctx.info(`Updated ${moved.join(', ')}.`);
  if (downloaded.length || moved.length) {
    ctx.info('Fetch leaves your own branches alone - it moves the "o/" copies that remember where the remote was.');
  }
  return { downloaded, moved };
}

function push(ctx) {
  const { engine, flags, args } = ctx;
  const origin = requireOrigin(ctx);
  const spec = readRemoteArgs(args);

  let srcRef;
  let dstName;
  if (spec) {
    srcRef = spec.src;
    dstName = spec.dst;
    if (!srcRef) throw new CommandParseError('Deleting a remote branch is not supported here. Use "git push origin <source>:<destination>".');
  } else {
    srcRef = requireCurrentBranch(ctx, 'push');
    const upstream = engine.repo.branches[srcRef].remoteTrackingBranchID;
    if (!upstream) {
      if (!flags.setUpstream) {
        throw new GitError(
          `"${srcRef}" has no upstream branch, so git does not know where to send it. Try "git push -u origin ${srcRef}" or "git push origin ${srcRef}:${srcRef}".`
        );
      }
      dstName = srcRef;
    } else {
      dstName = upstream.replace(/^o\//, '');
    }
  }

  // `refs/heads/main` IS `main` to git, so it has to normalise before anything
  // decides whether the destination is allowed - otherwise the long spelling
  // walks straight past a protected branch and invents a branch literally
  // called "refs/heads/main".
  dstName = normaliseRefName(dstName);
  checkBranchName(dstName, 'push destination');

  const srcCommit = engine.resolveRef(srcRef);

  // A server-side rule, so it is checked before anything moves and -f is no
  // way around it: the refusal happens on origin, not in your copy.
  if (engine.isProtectedRef(dstName)) {
    // The example destination has to be one the server would actually accept.
    let example = 'feature';
    for (let n = 2; engine.isProtectedRef(example) || example === dstName; n++) example = `feature-${n}`;
    throw new GitError(
      `origin refuses direct pushes to "${dstName}" - land your work on another branch and get it merged there.` +
        (flags.force
          ? ' Force marks the update as forced, which asks the server to accept a history that does not build on what it already has. The server still decides, and this one has decided not to.'
          : ` Give the work a branch of its own and send that instead, for example "git push origin ${srcRef}:${example}".`)
    );
  }

  // Own-property check: without it "git push origin main:constructor" found the
  // Object function, read `undefined` off it, and refused a brand new branch
  // with "constructor on the remote is at undefined, which is not in your
  // history" - while "main:feature" in the same repo simply worked.
  const remoteBranch = own(origin.branches, dstName) ? origin.branches[dstName] : null;

  if (remoteBranch && remoteBranch.target === srcCommit) {
    ctx.info('Everything up-to-date.');
    applyPushRefs(ctx, { dstName, srcCommit, srcRef, setUpstream: flags.setUpstream });
    ctx.finish();
    return;
  }

  if (remoteBranch && !engine.isAncestor(remoteBranch.target, srcCommit, mergedView(engine, origin))) {
    if (!flags.force) {
      // No -f in this advice on purpose. It is the one suggestion here that can
      // destroy work, and a reader taking the app at its word would drop the
      // very commit some levels need to reach their goal.
      throw new GitError(
        `Updates were rejected: "${dstName}" on the remote is at ${remoteBranch.target}, which is not in your history. Run "git pull" (or "git pull --rebase") to take their work first, then push again.`
      );
    }
    // A forced push is the only push that removes commits from the remote, so
    // name them: work that disappears silently is work nobody knows to look for.
    const dropped = discardedByForce(engine, origin, dstName, remoteBranch.target, srcCommit);
    if (dropped.length) {
      const one = dropped.length === 1;
      ctx.warn(
        `Force pushing dropped ${dropped.join(', ')} from origin/${dstName}. Nothing on the remote points at ${
          one ? 'it' : 'them'
        } any more, so if you still needed ${one ? 'that commit' : 'those commits'}, "undo" puts the remote back and "reset" returns to the start of this level.`
      );
    } else {
      ctx.warn(
        `Force pushing: origin/${dstName} is leaving ${remoteBranch.target}, which is not in your history. Another ref on the remote still reaches it, so nothing is lost.`
      );
    }
  }

  const uploaded = missingCommits(engine, engine.repo, origin, srcCommit);
  for (const id of uploaded) {
    copyCommitInto(engine, engine.repo.commits[id], origin);
    ctx.frame();
  }

  origin.branches[dstName] = {
    id: dstName,
    target: srcCommit,
    remoteTrackingBranchID: null,
  };
  applyPushRefs(ctx, { dstName, srcCommit, srcRef, setUpstream: flags.setUpstream });

  ctx.good(
    uploaded.length
      ? `Pushed ${uploaded.length} commit${uploaded.length === 1 ? '' : 's'} (${uploaded.join(', ')}) to origin/${dstName}.`
      : `origin/${dstName} now points at ${srcCommit}.`
  );
  ctx.finish();
}

function applyPushRefs(ctx, { dstName, srcCommit, srcRef, setUpstream }) {
  const { engine } = ctx;
  const trackingName = `o/${dstName}`;
  engine.setBranch(trackingName, srcCommit);
  // Real git only records an upstream when you ask for one with -u.
  if (setUpstream && engine.isBranch(srcRef)) {
    engine.repo.branches[srcRef].remoteTrackingBranchID = trackingName;
  }
}

/**
 * Ancestry questions during a push span both repositories: the remote tip may
 * be a commit we have never downloaded. This merges the two commit maps for a
 * read-only reachability check.
 */
function mergedView(engine, origin) {
  const commits = Object.assign(emptyMap(), origin.commits, engine.repo.commits);
  return {
    commits,
    branches: emptyMap(),
    tags: emptyMap(),
    HEAD: { id: 'HEAD', target: '' },
    origin: null,
  };
}

/**
 * What a forced push really takes away: commits reachable from the old remote
 * tip that neither the incoming history nor any other ref on the remote can
 * still reach. Oldest first, and empty when the remote keeps them anyway - the
 * warning has to be true, or the next one gets ignored.
 */
function discardedByForce(engine, origin, dstName, remoteTip, srcCommit) {
  const view = mergedView(engine, origin);
  const kept = new Set(engine.ancestors(srcCommit, view));
  const survivors = [
    ...Object.values(origin.branches).filter((branch) => branch.id !== dstName).map((branch) => branch.target),
    ...Object.values(origin.tags).map((t) => t.target),
  ];
  for (const start of survivors) {
    for (const id of engine.ancestors(start, view)) kept.add(id);
  }
  const gone = new Set();
  for (const id of engine.ancestors(remoteTip, view)) if (!kept.has(id)) gone.add(id);
  return engine.topoOrder(remoteTip, gone, view);
}

/**
 * `git teammate-pushes [remote] [branch] [n]` - commit on the remote as if a
 * teammate had pushed while you were working.
 *
 * Only the origin tree changes. `o/<branch>` deliberately stays put: noticing
 * that your remote-tracking branch is stale until you fetch is the entire point
 * of the fetch and pull lessons, and there is no other way to set that up.
 */
function teammatePushes(ctx) {
  const { engine, args } = ctx;
  ctx.setName('teammate-pushes');
  const origin = requireOrigin(ctx);

  const rest = args.filter((arg) => arg !== 'origin');
  let branchName = null;
  let count = 1;

  if (rest.length > 2) {
    throw new CommandParseError('git teammate-pushes takes at most a branch and a number: "git teammate-pushes main 2".');
  }
  for (const arg of rest) {
    if (/^-?\d+$/.test(arg)) count = Number(arg);
    else if (branchName === null) branchName = arg;
    else throw new CommandParseError(`I cannot tell what "${arg}" means here. Try "git teammate-pushes main 2".`);
  }

  if (branchName === null) {
    const current = engine.currentBranch();
    const upstream = current ? engine.repo.branches[current].remoteTrackingBranchID : null;
    branchName = upstream ? upstream.replace(/^o\//, '') : current;
    if (!branchName) {
      // Name a branch the remote actually has, not a guess that may not exist.
      const example = otherBranchName(engine, null, origin);
      throw new GitError(
        `HEAD is detached, so there is no branch to work on.${
          example ? ` Name one: "git teammate-pushes ${example}".` : ' The remote has no branches to commit on.'
        }`
      );
    }
  }

  // Own-property check, so a prototype name cannot be "found" on the remote and
  // then reported as work a teammate did on a branch that does not exist.
  if (!own(origin.branches, branchName)) {
    const known = Object.keys(origin.branches).sort().join(', ');
    throw new GitError(
      `The remote has no branch called "${branchName}". It has ${known || 'no branches at all'}.`
    );
  }
  if (count < 1 || count > 20) {
    throw new CommandParseError('Ask for between 1 and 20 commits, for example "git teammate-pushes main 3".');
  }

  const created = [];
  for (let i = 0; i < count; i++) {
    const id = engine.newCommitId();
    const parent = origin.branches[branchName].target;
    origin.commits[id] = { id, parents: [parent], rootCommit: false };
    origin.branches[branchName].target = id;
    created.push(id);
    ctx.frame();
  }

  const tracking = `o/${branchName}`;
  ctx.good(
    `A teammate pushed ${created.length} commit${created.length === 1 ? '' : 's'} (${created.join(', ')}) to origin/${branchName}.`
  );
  ctx.info(
    engine.isBranch(tracking)
      ? `Your ${tracking} still points at ${engine.repo.branches[tracking].target} - it will not move until you run "git fetch" or "git pull".`
      : `You have no ${tracking} yet. "git fetch" will create one.`
  );
  ctx.finish();
}

function pull(ctx) {
  const { engine, flags, args } = ctx;
  requireOrigin(ctx);
  if (flags.rebase && flags.noRebase) {
    throw new CommandParseError('Pick one: "git pull" merges, "git pull --rebase" replays. They cannot both apply.');
  }
  const branchName = requireCurrentBranch(ctx, 'pull into');
  const spec = readRemoteArgs(args);

  let trackingName;
  if (spec) {
    trackingName = `o/${spec.dst}`;
  } else {
    const upstream = engine.repo.branches[branchName].remoteTrackingBranchID;
    if (!upstream) {
      // Only name a remote branch that is really there to be pulled.
      const origin = engine.repo.origin;
      const available = own(origin.branches, branchName)
        ? branchName
        : otherBranchName(engine, null, origin);
      throw new GitError(
        `"${branchName}" has no upstream branch, so there is nothing to pull.` +
          (available ? ` Try "git pull origin ${available}".` : ' The remote has no branches to pull from yet.')
      );
    }
    trackingName = upstream;
  }

  doFetch(ctx, spec || { src: trackingName.replace(/^o\//, ''), dst: trackingName.replace(/^o\//, '') });

  if (!engine.isBranch(trackingName)) {
    throw new GitError(`After fetching there is still no "${trackingName}" to merge from.`);
  }

  // Nothing new on the remote is the ordinary case, not an error: a plain
  // "git clone; git pull" has to say "Already up to date." like real git.
  const newBase = engine.repo.branches[trackingName].target;
  const sourceCommit = engine.headCommit();
  if (engine.isAncestor(newBase, sourceCommit)) {
    ctx.info(`Already up to date - ${branchName} already contains everything on ${trackingName}.`);
    ctx.finish();
    return;
  }

  if (flags.rebase) {
    const { order, merges, present } = rebaseCandidates(engine, { newBase, upstream: newBase, sourceCommit });
    if (present.length) ctx.info(`Skipping ${present.join(', ')} - already on ${trackingName}.`);
    if (merges.length) ctx.info(`Flattening past ${merges.join(', ')}: rebase replays single-parent commits by default.`);
    replayOnto(ctx, { targetCommit: newBase, order, source: branchName });
    ctx.info(`Pull with --rebase: your commits were replayed on top of ${trackingName} instead of being merged.`);
    return;
  }

  doMerge(ctx, trackingName, { ffOnly: Boolean(flags.ffOnly) });
  ctx.finish();
}

/** `origin`, `origin main`, `origin main:main`, or nothing at all. */
function readRemoteArgs(args) {
  const list = args.filter((arg) => arg !== 'origin');
  if (!list.length) return null;
  if (list.length > 1) {
    throw new CommandParseError(
      `One refspec at a time please: "git push origin ${list[0]}:${list[1]}" if you meant a source and a destination.`
    );
  }
  const spec = parseRefspec(list[0]);
  if (!spec.dst) throw new CommandParseError('A refspec looks like "source:destination", for example "main:main".');
  return spec;
}

/* -------------------------------------------------------------------------- */
/* Non-git commands - these only report; main.js drives the UI                */
/* -------------------------------------------------------------------------- */

const HELP_TEXT = [
  'This is a git sandbox. Everything lives in memory, so nothing you type can break a real project.',
  'Making history: git commit, git branch <name>, git checkout <ref>, git merge <ref>, git rebase <target>.',
  'Moving refs: git reset <ref>, git branch -f <name> <ref>, git tag <name> [ref].',
  'Copying work: git cherry-pick <ref>..., git revert <ref>...',
  'Remotes: git clone, git fetch, git pull [--rebase], git push [-f].',
  'git teammate-pushes [branch] [n] commits on the remote for you, as if a teammate had pushed. Your o/ branches stay put until you fetch.',
  'Refs accept ~ and ^: HEAD~2 is two first-parent steps back, C4^2 is a merge commit\'s second parent, and they chain (main^^~3).',
  'App commands: levels, hint, show goal, show solution, undo, reset, clear, sandbox, theme day|dusk.',
  'Type "show commands" for every command name.',
];

const uiHelp = (ctx) => {
  HELP_TEXT.forEach((line) => ctx.log(line));
  ctx.info('Opening the help panel.');
};

const uiSignal = (text, type = 'info') => (ctx) => ctx.say(type, text);

function uiShowCommands(ctx) {
  ctx.log('Git commands:');
  COMMAND_NAMES.filter((name) => name.startsWith('git ')).forEach((name) => ctx.log(`  ${name}`));
  ctx.log('App commands:');
  COMMAND_NAMES.filter((name) => !name.startsWith('git ')).forEach((name) => ctx.log(`  ${name}`));
  ctx.extra('commands', [...COMMAND_NAMES]);
}

function uiExportTree(ctx) {
  const tree = ctx.engine.exportTree();
  ctx.extra('tree', tree);
  ctx.log(JSON.stringify(tree));
  ctx.info('Copy that line to save this repository, then bring it back with "import tree <json>".');
}

function uiImportTree(ctx) {
  const raw = ctx.rest;
  if (!raw) {
    throw new CommandParseError('import tree needs the JSON to load, for example: import tree {"commits":{...},...}');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CommandParseError(
      `That is not valid JSON (${err.message}). Paste the whole object exactly as "export tree" printed it.`
    );
  }
  if (!isTreeShaped(parsed)) {
    throw new GitError(
      'That JSON parsed, but it is not a repository tree. It needs "commits", "branches" and "HEAD", and every target must point at a commit that exists.'
    );
  }
  // baseline:false - the level's own start tree stays what "reset" returns to.
  ctx.engine.loadTree(parsed, { baseline: false });
  const count = Object.keys(ctx.engine.repo.commits).length;
  ctx.good(
    `Loaded a repository with ${count} commit${count === 1 ? '' : 's'}. "reset" still returns to this level's starting tree, and "undo" steps back out of the import.`
  );
}

// Kept local so commands.js stays free of engine imports (no import cycle).
let treeValidator = null;
export function setTreeValidator(fn) {
  treeValidator = fn;
}
function isTreeShaped(value) {
  return typeof treeValidator === 'function' ? treeValidator(value) : false;
}

const THEMES = ['day', 'dusk'];

function uiTheme(ctx) {
  const name = ctx.rest.trim().toLowerCase();
  if (!name) {
    throw new CommandParseError(`theme needs a name: ${THEMES.map((t) => `"theme ${t}"`).join(' or ')}.`);
  }
  // Report success only for a theme that exists, or the terminal says "set" and
  // the UI immediately contradicts it.
  if (!THEMES.includes(name)) {
    throw new GitError(`There is no theme called "${name}". The choices are ${THEMES.join(' and ')}.`);
  }
  ctx.extra('theme', name);
  ctx.good(`Theme set to "${name}".`);
}

/* -------------------------------------------------------------------------- */
/* Registries                                                                 */
/* -------------------------------------------------------------------------- */

// Null-prototype for the same reason as GIT_OPTION_SPECS: both registries are
// looked up with a name the reader typed.
export const COMMANDS = Object.assign(emptyMap(), {
  commit,
  branch,
  checkout,
  switch: checkout,
  merge,
  rebase,
  reset,
  revert,
  'cherry-pick': cherryPick,
  tag,
  describe,
  log,
  status,
  show,
  clone,
  fetch,
  push,
  pull,
  'teammate-pushes': teammatePushes,
});

export const UI_COMMANDS = Object.assign(emptyMap(), {
  help: uiHelp,
  'show commands': uiShowCommands,
  levels: uiSignal('Opening the level list.'),
  sandbox: uiSignal('Switching to the sandbox - no goal, nothing to break.'),
  hint: uiSignal('Here is a nudge.'),
  'show goal': uiSignal('Showing the goal tree.'),
  'hide goal': uiSignal('Hiding the goal tree.'),
  'show solution': uiSignal('Showing one way to solve this level.'),
  undo: uiSignal('Undoing the last command.'),
  reset: uiSignal('Resetting the repository to the start of this level.'),
  clear: uiSignal('Cleared.'),
  refresh: uiSignal('Redrawing the tree.'),
  'export tree': uiExportTree,
  'import tree': uiImportTree,
  theme: uiTheme,
});
