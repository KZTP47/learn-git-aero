// Engine plumbing: tree serialisation, snapshots, frames, ref resolution,
// undo/reset and the promise that run() never throws.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GitEngine, COMMAND_NAMES, isValidTree } from '../js/git/engine.js';

const chain = async (commands, tree) => {
  const engine = new GitEngine(tree);
  await engine.run(commands);
  return engine;
};

test('a fresh engine starts with C0, main and an attached HEAD', () => {
  const engine = new GitEngine();
  const tree = engine.exportTree();
  assert.deepEqual(Object.keys(tree.commits), ['C0']);
  assert.equal(tree.commits.C0.rootCommit, true);
  assert.deepEqual(tree.commits.C0.parents, []);
  assert.equal(tree.branches.main.target, 'C0');
  assert.equal(tree.HEAD.target, 'main');
  assert.equal(engine.getSnapshot().HEAD.detached, false);
  assert.equal(engine.getSnapshot().origin, null);
});

test('loadTree(exportTree()) is a no-op', async () => {
  const engine = await chain('git commit; git checkout -b feature; git commit; git tag v1; git clone');
  const first = engine.exportTree();
  engine.loadTree(first);
  const second = engine.exportTree();
  assert.deepEqual(second, first);
  engine.loadTree(JSON.stringify(second));
  assert.deepEqual(engine.exportTree(), first);
});

test('loadTree repairs broken input instead of throwing', () => {
  const engine = new GitEngine();
  engine.loadTree({ commits: { C0: { id: 'C0', parents: ['ghost'] } }, branches: {}, HEAD: null });
  const tree = engine.exportTree();
  assert.deepEqual(tree.commits.C0.parents, []);
  assert.ok(tree.branches.main, 'a main branch is invented when none survives');
  assert.equal(tree.HEAD.target, 'main');
  engine.loadTree('not json at all');
  assert.ok(engine.exportTree().commits.C0);
});

test('isValidTree accepts real trees and rejects junk', async () => {
  const engine = await chain('git commit; git clone');
  assert.equal(isValidTree(engine.exportTree()), true);
  assert.equal(isValidTree(JSON.stringify(engine.exportTree())), true);
  assert.equal(isValidTree(null), false);
  assert.equal(isValidTree({}), false);
  assert.equal(isValidTree('nope'), false);
  assert.equal(isValidTree({ commits: {}, branches: {}, HEAD: { target: 'main' } }), false);
  assert.equal(
    isValidTree({
      commits: { C0: { id: 'C0', parents: [] } },
      branches: { main: { id: 'main', target: 'C9' } },
      HEAD: { id: 'HEAD', target: 'main' },
    }),
    false,
    'a branch pointing at a missing commit is not a valid tree'
  );
  assert.equal(
    isValidTree({
      commits: { C0: { id: 'C0', parents: [] } },
      branches: { main: { id: 'main', target: 'C0' } },
      HEAD: { id: 'HEAD', target: 'nowhere' },
    }),
    false
  );
});

test('isValidTree reads refs as own properties, not through the prototype chain', async () => {
  // A shared ?tree= link arrives through JSON.parse, so its maps have
  // Object.prototype behind them. A truthiness check let these load, and the
  // repair pass then silently rewrote HEAD or dropped a parent - the reader saw
  // a tree that was not the one in the link.
  const json = (body) => `{"commits":{"C0":{"id":"C0","parents":[]},"C1":{"id":"C1","parents":["C0"]}},${body}}`;
  const cases = [
    ['HEAD naming a prototype member', json('"branches":{"main":{"id":"main","target":"C1"}},"HEAD":{"id":"HEAD","target":"constructor"}')],
    ['a parent naming a prototype member', '{"commits":{"C0":{"id":"C0","parents":[]},"C1":{"id":"C1","parents":["toString"]}},"branches":{"main":{"id":"main","target":"C1"}},"HEAD":{"id":"HEAD","target":"main"}}'],
    ['a branch target naming a prototype member', json('"branches":{"main":{"id":"main","target":"valueOf"}},"HEAD":{"id":"HEAD","target":"main"}')],
    ['a tag target naming a prototype member', json('"branches":{"main":{"id":"main","target":"C1"}},"tags":{"v1":{"id":"v1","target":"hasOwnProperty"}},"HEAD":{"id":"HEAD","target":"main"}')],
    ['an origin HEAD naming a prototype member', json('"branches":{"main":{"id":"main","target":"C1"}},"HEAD":{"id":"HEAD","target":"main"},"originTree":{"commits":{"C0":{"id":"C0","parents":[]}},"branches":{"main":{"id":"main","target":"C0"}},"HEAD":{"id":"HEAD","target":"isPrototypeOf"}}')],
  ];
  for (const [what, text] of cases) {
    assert.equal(isValidTree(text), false, `${what} must not pass validation`);
    // Same tree, same answer, whichever door it came through.
    assert.equal(isValidTree(JSON.parse(text)), false, `${what} must not pass validation as an object`);
  }

  // A name that really is a ref stays perfectly valid - this is a lookup fix,
  // not a blacklist.
  const legal = await chain('git checkout -b constructor; git commit; git tag __proto__');
  assert.equal(isValidTree(legal.exportTree()), true);
  assert.equal(isValidTree(JSON.parse(JSON.stringify(legal.exportTree()))), true);
});

test('exportTree round-trips a repo whose branch is named __proto__, cloned origin included', async () => {
  // `origin.branches['__proto__'] = ...` on a plain object re-points the map's
  // prototype instead of adding a key, so origin came back with HEAD on
  // "__proto__" and no such branch, and loadTree(exportTree()) stopped being a
  // no-op - CONTRACT section 2.
  const engine = await chain('git checkout -b __proto__; git commit; git clone');
  const tree = engine.exportTree();
  assert.deepEqual(Object.keys(tree.originTree.branches).sort(), ['__proto__', 'main']);
  assert.equal(tree.originTree.HEAD.target, '__proto__');
  assert.equal(tree.originTree.branches.__proto__.target, 'C1');
  assert.equal(isValidTree(tree), true);

  const before = JSON.stringify(tree);
  engine.loadTree(tree);
  assert.equal(JSON.stringify(engine.exportTree()), before, 'loadTree(exportTree()) must be a no-op');
  engine.loadTree(JSON.parse(before));
  assert.equal(JSON.stringify(engine.exportTree()), before, 'the same tree via JSON must load identically');
});

test('repeated --amend walks the apostrophe ladder forwards, never back', async () => {
  // Amend prunes the commit it replaced, which frees that id again. Starting
  // the search at the bottom of the ladder handed it straight back, so the
  // terminal said "Rewrote C1'' as C1'" and the reader had every reason to
  // think they had gone backwards. CONTRACT section 1 fixes the order.
  const engine = await chain('git commit');
  const seen = [];
  for (let i = 0; i < 5; i++) {
    const result = await engine.run('git commit --amend');
    assert.equal(result.ok, true, result.error && result.error.text);
    const match = /Rewrote (\S+) as (\S+)\./.exec(result.messages.map((m) => m.text).join('\n'));
    assert.ok(match, 'amend should report what it rewrote');
    if (seen.length) assert.equal(match[1], seen[seen.length - 1], 'the report must name the commit that was there');
    seen.push(match[2]);
    assert.ok(engine.exportTree().commits[match[2]], 'the id it reported has to exist');
  }
  assert.deepEqual(seen, ["C1'", "C1''", "C1'''", "C1'^4", "C1'^5"]);
  assert.equal(engine.exportTree().branches.main.target, "C1'^5");
});

test('snapshots are deep clones - mutating one cannot reach engine state', async () => {
  const engine = await chain('git commit; git checkout -b feature; git commit; git clone');
  const result = await engine.run('git commit');
  const frame = result.frames[0];

  frame.commits.C0.parents.push('tampered');
  frame.branches.main.target = 'tampered';
  frame.HEAD.target = 'tampered';
  delete frame.commits.C1;
  if (frame.origin) frame.origin.branches.main.target = 'tampered';

  const fresh = engine.getSnapshot();
  assert.deepEqual(fresh.commits.C0.parents, []);
  assert.notEqual(fresh.branches.main.target, 'tampered');
  assert.notEqual(fresh.HEAD.target, 'tampered');
  assert.ok(fresh.commits.C1);
  assert.notEqual(fresh.origin.branches.main.target, 'tampered');
  assert.notEqual(engine.getSnapshot(), engine.getSnapshot(), 'each call builds a new object');
});

test('snapshot shape matches the contract', async () => {
  const engine = await chain('git commit; git tag v1; git clone');
  const snapshot = engine.getSnapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ['HEAD', 'branches', 'commits', 'origin', 'tags']);
  assert.equal(snapshot.branches['o/main'].remote, true);
  assert.equal(snapshot.branches.main.remote, false);
  assert.equal(snapshot.branches.main.remoteTrackingBranchID, 'o/main');
  assert.equal(snapshot.tags.v1.target, snapshot.branches.main.target);
  assert.equal(snapshot.origin.origin, null, 'origin never nests another origin');
});

test('frame counts: one per commit, at least one per replayed rebase step', async () => {
  const engine = await chain('git commit; git checkout -b feature; git commit; git commit; git commit; git checkout main; git commit');
  const single = await engine.run('git commit');
  assert.equal(single.frames.length, 1);

  const rebase = await engine.run('git rebase main feature');
  assert.ok(rebase.frames.length >= 3, `expected >= 3 frames, got ${rebase.frames.length}`);
  assert.deepEqual(rebase.frames[rebase.frames.length - 1], engine.getSnapshot());

  const readOnly = await engine.run('git status');
  assert.equal(readOnly.frames.length, 1, 'read-only git commands still report the current state');
});

test('non-git commands report but do not draw', async () => {
  const engine = new GitEngine();
  for (const name of ['help', 'levels', 'sandbox', 'hint', 'show goal', 'hide goal', 'show solution', 'clear', 'refresh', 'undo', 'reset']) {
    const result = await engine.run(name);
    assert.equal(result.ok, true, `${name} should succeed`);
    assert.equal(result.commandName, name);
    assert.deepEqual(result.frames, [], `${name} should not produce frames`);
    assert.ok(result.messages.length > 0, `${name} should explain itself`);
  }
});

test('bare undo/reset are signals only - they never change state themselves', async () => {
  const engine = await chain('git commit; git commit');
  const before = engine.exportTree();
  await engine.run('undo');
  await engine.run('reset');
  assert.deepEqual(engine.exportTree(), before);
  assert.deepEqual(engine.commandStack, ['git commit', 'git commit']);
});

test('ref resolution: names, tags, ~ and ^ chains', async () => {
  const engine = await chain('git commit; git commit; git commit; git commit; git commit; git commit; git tag v1 C2');
  assert.equal(engine.resolveRef('HEAD'), 'C6');
  assert.equal(engine.resolveRef('main'), 'C6');
  assert.equal(engine.resolveRef('C3'), 'C3');
  assert.equal(engine.resolveRef('v1'), 'C2');
  assert.equal(engine.resolveRef('HEAD~'), 'C5', '~ with no number means one step');
  assert.equal(engine.resolveRef('HEAD~0'), 'C6');
  assert.equal(engine.resolveRef('HEAD~2'), 'C4');
  assert.equal(engine.resolveRef('HEAD^'), 'C5');
  assert.equal(engine.resolveRef('HEAD^1'), 'C5');
  assert.equal(engine.resolveRef('HEAD~2^1'), 'C3');
  assert.equal(engine.resolveRef('main^^~3'), 'C1');
  assert.equal(engine.resolveRef('v1~2'), 'C0');
  assert.equal(engine.resolveRef('  main~1  '), 'C5', 'surrounding space is ignored');
});

test('ref resolution: ^2 picks the second parent of a merge', async () => {
  const engine = await chain('git commit; git checkout -b feature; git commit; git checkout main; git commit; git merge feature');
  const merge = engine.resolveRef('main');
  assert.equal(engine.repo.commits[merge].parents.length, 2);
  assert.equal(engine.resolveRef('main^1'), engine.repo.commits[merge].parents[0]);
  assert.equal(engine.resolveRef('main^2'), engine.repo.commits[merge].parents[1]);
  assert.equal(engine.resolveRef('main^2~1'), 'C1');
});

test('ref resolution failures are friendly GitErrors', async () => {
  const engine = await chain('git commit; git commit');
  const cases = ['git checkout nope', 'git checkout main~99', 'git checkout C0~1', 'git checkout main^2', 'git checkout main~1x'];
  for (const input of cases) {
    const result = await engine.run(input);
    assert.equal(result.ok, false, `${input} should fail`);
    assert.equal(result.error.type, 'GitError');
    assert.ok(result.error.text.length > 20, `${input} should explain itself: ${result.error.text}`);
    assert.ok(!/\bat \w+ \(/.test(result.error.text), 'no stack traces in user-facing text');
  }
});

test('commit ids that contain apostrophes still resolve', async () => {
  const engine = await chain('git commit; git checkout -b side; git commit; git checkout main; git cherry-pick C2');
  assert.ok(engine.hasCommit("C2'"));
  assert.equal(engine.resolveRef("C2'"), "C2'");
  assert.equal(engine.resolveRef("C2'~1"), 'C1');
  const result = await engine.run("git checkout C2'");
  assert.equal(result.ok, true);
  assert.equal(engine.getSnapshot().HEAD.target, "C2'");
});

test('multiple commands on one line merge into a single result', async () => {
  const engine = new GitEngine();
  const result = await engine.run('git commit; git commit\ngit branch feature');
  assert.equal(result.ok, true);
  assert.equal(result.frames.length, 3);
  assert.equal(result.commandName, 'branch');
  assert.deepEqual(engine.commandStack, ['git commit', 'git commit', 'git branch feature']);
});

test('a failing command stops the rest of the line and rolls itself back', async () => {
  const engine = new GitEngine();
  const result = await engine.run('git commit; git checkout nope; git commit');
  assert.equal(result.ok, false);
  assert.equal(result.error.type, 'GitError');
  assert.equal(engine.commandStack.length, 1);
  assert.ok(result.messages.some((m) => m.type === 'warning' && /not run/.test(m.text)));
  assert.equal(Object.keys(engine.exportTree().commits).length, 2);
});

test('undo walks back one command at a time and restores exact state', async () => {
  const engine = await chain('git commit; git commit');
  const checkpoint = engine.exportTree();
  // The branches have to diverge for the merge to be a real merge - see the
  // "already up to date" test below for why a merge can record nothing.
  await engine.run('git checkout -b feature; git commit; git checkout main; git commit; git checkout feature; git merge main');

  assert.equal(engine.commandStack.length, 8);
  assert.equal(engine.repo.commits[engine.resolveRef('feature')].parents.length, 2);

  for (let i = 0; i < 6; i++) assert.equal(engine.undo(), true);
  assert.deepEqual(engine.exportTree(), checkpoint);
  assert.deepEqual(engine.commandStack, ['git commit', 'git commit']);

  assert.equal(engine.undo(), true);
  assert.equal(engine.undo(), true);
  assert.equal(engine.undo(), false, 'nothing left to undo');
  assert.deepEqual(engine.commandStack, []);
});

test('commands that change nothing are not pushed onto the undo stack', async () => {
  // Real git: merging a branch that is already an ancestor of HEAD prints
  // "Already up to date." and creates no commit, so there is nothing to undo.
  const engine = await chain('git commit; git commit; git checkout -b feature; git commit');
  const before = engine.exportTree();
  const depth = engine.commandStack.length;

  const merge = await engine.run('git merge main');
  assert.equal(merge.ok, true);
  assert.match(merge.messages[0].text, /Already up to date/);
  assert.deepEqual(engine.exportTree(), before, 'nothing moved');
  assert.equal(engine.commandStack.length, depth, 'and nothing was recorded');

  // Read-only commands are the same story.
  await engine.run('git log; git status; git branch');
  assert.equal(engine.commandStack.length, depth);
  assert.deepEqual(engine.exportTree(), before);

  // A reset that lands where the ref already was is also a no-op.
  await engine.run('git reset HEAD');
  assert.equal(engine.commandStack.length, depth);
});

test('undo restores detached HEAD and remote state too', async () => {
  const engine = await chain('git commit; git clone; git checkout C1');
  const before = engine.exportTree();
  await engine.run('git commit');
  assert.notDeepEqual(engine.exportTree(), before);
  assert.equal(engine.undo(), true);
  assert.deepEqual(engine.exportTree(), before);
  assert.equal(engine.getSnapshot().HEAD.detached, true);
});

test('reset() returns to the tree given to the last loadTree()', async () => {
  const engine = new GitEngine();
  const start = engine.exportTree();
  await engine.run('git commit; git checkout -b x; git commit; git clone; git commit; git push');
  assert.notDeepEqual(engine.exportTree(), start);
  engine.reset();
  assert.deepEqual(engine.exportTree(), start);
  assert.deepEqual(engine.commandStack, []);
  assert.equal(engine.undo(), false);
});

test('commandStack is a copy, not the live array', async () => {
  const engine = await chain('git commit');
  const stack = engine.commandStack;
  stack.push('git nonsense');
  assert.deepEqual(engine.commandStack, ['git commit']);
});

test('the engine is deterministic', async () => {
  const script = 'git commit; git checkout -b a; git commit; git checkout main; git commit; git merge a; git rebase a; git tag v1';
  const one = await chain(script);
  const two = await chain(script);
  assert.deepEqual(one.exportTree(), two.exportTree());
});

test('COMMAND_NAMES covers the contract command list', () => {
  assert.ok(Array.isArray(COMMAND_NAMES));
  assert.ok(COMMAND_NAMES.length > 30);
  for (const required of [
    'git commit',
    'git branch',
    'git checkout',
    'git switch',
    'git merge',
    'git rebase',
    'git reset',
    'git revert',
    'git cherry-pick',
    'git tag',
    'git describe',
    'git log',
    'git status',
    'git fetch',
    'git pull',
    'git push',
    'git clone',
    'help',
    'levels',
    'sandbox',
    'show goal',
    'hide goal',
    'show solution',
    'hint',
    'clear',
    'refresh',
    'import tree',
    'export tree',
    'show commands',
    'theme',
    'undo',
    'reset',
  ]) {
    assert.ok(COMMAND_NAMES.includes(required), `COMMAND_NAMES is missing "${required}"`);
  }
  assert.equal(new Set(COMMAND_NAMES).size, COMMAND_NAMES.length, 'no duplicates');
});

test('levels can switch commands off', async () => {
  const engine = await chain('git commit');
  engine.setDisabledCommands(['git cherry-pick']);
  const blocked = await engine.run('git cherry-pick C1');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error.text, /switched off/);
  engine.setDisabledCommands([]);
  assert.equal((await engine.run('git status')).ok, true);
});

test('rebase -i hands the UI a request and applyInteractiveRebase finishes it', async () => {
  const engine = await chain('git commit; git checkout -b feature; git commit; git commit; git commit; git checkout main');
  const request = await engine.run('git rebase -i main feature');

  assert.equal(request.ok, true);
  assert.equal(request.commandName, 'rebase -i');
  assert.deepEqual(request.interactive.commits, ['C2', 'C3', 'C4']);
  assert.equal(request.interactive.target, 'C1');
  assert.equal(request.interactive.source, 'feature');
  assert.deepEqual(engine.exportTree().branches.feature.target, 'C4', 'the request alone changes nothing');
  assert.deepEqual(engine.pendingInteractiveRebase.commits, ['C2', 'C3', 'C4']);

  const done = engine.applyInteractiveRebase(['C4', 'C2']);
  assert.equal(done.ok, true);
  assert.equal(done.commandName, 'rebase -i');
  assert.ok(done.frames.length >= 2);
  const tree = engine.exportTree();
  assert.deepEqual(tree.commits["C4'"].parents, ['C1']);
  assert.deepEqual(tree.commits["C2'"].parents, ["C4'"]);
  assert.equal(tree.branches.feature.target, "C2'");
  assert.equal(tree.HEAD.target, 'feature');
  assert.equal(tree.commits.C3, undefined, 'the dropped commit is gone');
  assert.equal(engine.pendingInteractiveRebase, null);
  assert.equal(engine.commandStack[engine.commandStack.length - 1], 'git rebase -i main');
  assert.equal(engine.undo(), true, 'an interactive rebase can be undone');
  assert.equal(engine.exportTree().branches.feature.target, 'C4');
});

test('run() survives input that cannot even be turned into a string', async () => {
  const engine = await chain('git commit');
  const before = engine.exportTree();

  const hostile = [
    { toString() { throw new Error('boom'); } },
    { toString() { return { nope: true }; }, valueOf() { throw new Error('boom'); } },
    Object.create(null), // no toString at all
    { get length() { throw new Error('boom'); } },
    Symbol('nope'),
  ];

  for (const input of hostile) {
    let result;
    try {
      result = await engine.run(input);
    } catch (err) {
      assert.fail(`run() threw for hostile input: ${err && err.message}`);
    }
    assert.equal(result.ok, false);
    assert.equal(typeof result.input, 'string');
    assert.ok(result.error && result.error.text.length > 10);
    assert.deepEqual(result.frames, []);
  }
  assert.deepEqual(engine.exportTree(), before, 'and nothing was touched');
});

test('applyInteractiveRebase refuses a non-list instead of dropping everything', async () => {
  const engine = await chain('git commit; git checkout -b feature; git commit; git commit');
  await engine.run('git rebase -i main feature');
  const before = engine.exportTree();

  for (const bad of [null, undefined, 'C2', 42, {}, { 0: 'C2', length: 1 }, new Set(['C2'])]) {
    const result = engine.applyInteractiveRebase(bad);
    assert.equal(result.ok, false, `${JSON.stringify(String(bad))} was treated as a list`);
    assert.match(result.error.text, /array of commit ids/);
    assert.deepEqual(engine.exportTree(), before, 'a refusal must not drop commits');
    assert.deepEqual(result.frames, []);
  }

  // An empty array is the explicit way to drop them all.
  const dropped = engine.applyInteractiveRebase([]);
  assert.equal(dropped.ok, true);
  assert.equal(engine.exportTree().branches.feature.target, 'C1');
});

test('applyInteractiveRebase reads its options as own properties only', async () => {
  const engine = await chain('git commit; git commit; git checkout -b t C1; git commit');
  await engine.run('git rebase -i main t');

  Object.prototype.target = 'C1';
  Object.prototype.source = 'main';
  try {
    const done = engine.applyInteractiveRebase(['C3'], {});
    assert.equal(done.ok, true, done.error && done.error.text);
    assert.equal(engine.exportTree().branches.t.target, "C3'", 'inherited options overrode the real request');
    assert.deepEqual(engine.exportTree().commits["C3'"].parents, ['C2']);
    assert.equal(engine.exportTree().branches.main.target, 'C2', 'main must not have moved');
  } finally {
    delete Object.prototype.target;
    delete Object.prototype.source;
  }
});

test('applyInteractiveRebase reports problems instead of throwing', async () => {
  const engine = await chain('git commit; git checkout -b feature; git commit');
  const noRequest = engine.applyInteractiveRebase(['C2']);
  assert.equal(noRequest.ok, false);
  assert.match(noRequest.error.text, /interactive rebase/i);

  await engine.run('git rebase -i main feature');
  const duplicate = engine.applyInteractiveRebase(['C2', 'C2']);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error.text, /twice/);

  const unknown = engine.applyInteractiveRebase(['C99']);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error.text, /not a commit/);

  const dropAll = engine.applyInteractiveRebase([]);
  assert.equal(dropAll.ok, true);
  assert.equal(engine.exportTree().branches.feature.target, 'C1');
});

test('run() never throws, whatever you feed it', async () => {
  const engine = new GitEngine();
  await engine.run('git commit; git checkout -b feature; git commit; git clone');

  const seeds = [
    '',
    '   ',
    '\n\n',
    ';;;',
    ';',
    ' ; ; ',
    'git',
    'git ',
    'GIT',
    'git commit --nonsense',
    'git commit -m',
    'git commit -m "unbalanced',
    "git commit -m 'still open",
    'git commit -m "a" extra words',
    'git checkout',
    'git checkout -b',
    'git checkout - -',
    'git branch -d',
    'git branch -f',
    'git branch --',
    'git merge',
    'git merge a b',
    'git rebase',
    'git rebase --onto',
    'git rebase -i',
    'git reset a b',
    'git revert',
    'git cherry-pick',
    'git tag -d',
    'git describe a b',
    'git push origin :',
    'git push origin a b',
    'git pull --rebase --no-rebase',
    'git fetch nope',
    'git clone; git clone',
    'import tree',
    'import tree {',
    'import tree []',
    'import tree {"commits":{}}',
    'export tree extra',
    'theme',
    'theme    ',
    'show',
    'show nothing',
    'hide',
    'undo undo undo',
    'nonsense',
    'gti commit',
    'git comit',
    'git chekcout main',
    '--help',
    '-',
    '--',
    '~',
    '^^^',
    'HEAD~1',
    'C0',
    '"',
    "'",
    '`',
    '\\',
    '$(rm -rf /)',
    '{}',
    '[]',
    'null',
    'undefined',
    '0',
    'NaN',
    'git commit;'.repeat(50),
    'x'.repeat(10000),
    'git commit -m "' + 'y'.repeat(9000) + '"',
    'git checkout ' + 'z'.repeat(500),
    'git rebase ' + '~'.repeat(200),
    ' ',
    'git commit  ',
    'git\tcommit',
    'git   commit   -m   hi',
  ];

  const fragments = ['git', 'commit', '-m', '--amend', 'main', 'HEAD~2', "C2'", ';', '"', "'", '--onto', 'branch', '-f', 'origin', 'main:main', '^2', '~', 'rebase', 'nonsense', ''];
  let seed = 20240506;
  const nextInt = (max) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % max;
  };
  const fuzzed = [];
  for (let i = 0; i < 260; i++) {
    const length = nextInt(7);
    const parts = [];
    for (let j = 0; j <= length; j++) parts.push(fragments[nextInt(fragments.length)]);
    fuzzed.push(parts.join(' '));
  }

  const inputs = [...seeds, ...fuzzed, null, undefined, 42, {}, [], true];
  let failures = 0;
  for (const input of inputs) {
    let result;
    try {
      result = await engine.run(input);
    } catch (err) {
      assert.fail(`run(${JSON.stringify(String(input)).slice(0, 60)}) threw: ${err && err.message}`);
    }
    assert.equal(typeof result.ok, 'boolean');
    assert.equal(typeof result.input, 'string');
    assert.ok(Array.isArray(result.messages));
    assert.ok(Array.isArray(result.frames));
    if (!result.ok) {
      failures++;
      assert.ok(result.error && typeof result.error.text === 'string' && result.error.text.length > 10);
      assert.ok(['GitError', 'CommandParseError', 'Warning'].includes(result.error.type));
      assert.ok(!/\n\s+at /.test(result.error.text), 'errors must not carry stack traces');
    } else {
      assert.equal(result.error, null);
    }
  }
  assert.ok(inputs.length > 300, 'the fuzz corpus should be large');
  assert.ok(failures > 200, `most malformed input should be reported as an error (got ${failures})`);
  assert.ok(isValidTree(engine.exportTree()), 'the repository survives the whole fuzz run');
});
