// Command semantics: every git command in the contract, exercised against the
// behaviour real git would show.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GitEngine, isValidTree } from '../js/git/engine.js';
import { GIT_OPTION_SPECS } from '../js/git/commands.js';

/** Build an engine and run a setup script on it. */
const repo = async (script = '', tree) => {
  const engine = new GitEngine(tree);
  if (script) {
    const setup = await engine.run(script);
    assert.equal(setup.ok, true, `setup failed: ${setup.error && setup.error.text}`);
  }
  return engine;
};

/** Compact view of the graph, easy to assert against. */
const graph = (engine) => {
  const tree = engine.exportTree();
  const out = {
    commits: {},
    branches: {},
    tags: {},
    HEAD: tree.HEAD.target,
  };
  for (const [id, commit] of Object.entries(tree.commits)) out.commits[id] = commit.parents;
  for (const [id, branch] of Object.entries(tree.branches)) out.branches[id] = branch.target;
  for (const [id, tag] of Object.entries(tree.tags)) out.tags[id] = tag.target;
  return out;
};

const text = (result) => result.messages.map((m) => m.text).join('\n');

/* -------------------------------------------------------------------------- */
/* commit                                                                     */
/* -------------------------------------------------------------------------- */

test('git commit adds a child of HEAD and moves the current branch', async () => {
  const engine = await repo();
  const result = await engine.run('git commit');
  assert.equal(result.ok, true);
  assert.equal(result.commandName, 'commit');
  const state = graph(engine);
  assert.deepEqual(state.commits.C1, ['C0']);
  assert.equal(state.branches.main, 'C1');
  assert.equal(state.HEAD, 'main');
});

test('git commit -m keeps the message and git log shows it', async () => {
  const engine = await repo();
  await engine.run('git commit -m "teach the parser"');
  await engine.run("git commit -m 'single quotes work too'");
  const log = await engine.run('git log');
  assert.match(text(log), /teach the parser/);
  assert.match(text(log), /single quotes work too/);
  const short = await engine.run('git log --oneline');
  assert.match(text(short), /C2 single quotes work too/);
});

test('git commit --amend replaces the tip with an apostrophe copy', async () => {
  const engine = await repo('git commit; git commit');
  const result = await engine.run('git commit --amend -m "fixed wording"');
  assert.equal(result.ok, true);
  const state = graph(engine);
  assert.deepEqual(state.commits["C2'"], ['C1'], 'the copy keeps the original parents');
  assert.equal(state.commits.C2, undefined, 'the replaced commit is no longer reachable');
  assert.equal(state.branches.main, "C2'");
  assert.match(text(await engine.run('git log')), /fixed wording/);
});

test('git commit on a detached HEAD moves HEAD and leaves branches alone', async () => {
  const engine = await repo('git commit; git commit; git checkout C1');
  assert.equal(engine.getSnapshot().HEAD.detached, true);
  await engine.run('git commit');
  const state = graph(engine);
  assert.equal(state.branches.main, 'C2', 'main did not move');
  assert.equal(state.HEAD, 'C3');
  assert.deepEqual(state.commits.C3, ['C1']);
  assert.equal(engine.getSnapshot().HEAD.detached, true);
});

test('git commit rejects a stray argument with advice about quoting', async () => {
  const engine = await repo();
  const result = await engine.run('git commit -m hello world');
  assert.equal(result.ok, false);
  assert.equal(result.error.type, 'CommandParseError');
  assert.match(result.error.text, /quote/i);
});

/* -------------------------------------------------------------------------- */
/* branch                                                                     */
/* -------------------------------------------------------------------------- */

test('git branch creates at HEAD or at a given ref', async () => {
  const engine = await repo('git commit; git commit; git commit');
  await engine.run('git branch here');
  await engine.run('git branch older HEAD~2');
  const state = graph(engine);
  assert.equal(state.branches.here, 'C3');
  assert.equal(state.branches.older, 'C1');
  assert.equal(state.HEAD, 'main', 'git branch never moves HEAD');
});

test('git branch with no arguments lists what exists', async () => {
  const engine = await repo('git commit; git branch feature; git clone');
  const result = await engine.run('git branch');
  assert.equal(result.ok, true);
  assert.match(text(result), /\* main/);
  assert.match(text(result), /feature/);
  assert.match(text(result), /o\/main/);
  assert.equal(result.frames.length, 1);
});

test('git branch refuses a duplicate but -f moves it', async () => {
  const engine = await repo('git commit; git commit; git branch feature');
  const duplicate = await engine.run('git branch feature');
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error.text, /already exists/);

  const forced = await engine.run('git branch -f feature HEAD~1');
  assert.equal(forced.ok, true);
  assert.equal(graph(engine).branches.feature, 'C1');
});

test('git branch -f on the branch you are standing on warns but still works', async () => {
  const engine = await repo('git commit; git commit');
  const result = await engine.run('git branch -f main HEAD~1');
  assert.equal(result.ok, true);
  assert.ok(result.messages.some((m) => m.type === 'warning' && /reset/.test(m.text)));
  assert.equal(graph(engine).branches.main, 'C1');
});

test('git branch -d protects the current branch and unmerged work', async () => {
  const engine = await repo('git commit; git checkout -b feature; git commit; git checkout main');

  const current = await engine.run('git branch -d main');
  assert.equal(current.ok, false);
  assert.match(current.error.text, /standing on/);

  const unmerged = await engine.run('git branch -d feature');
  assert.equal(unmerged.ok, false);
  assert.match(unmerged.error.text, /-D/);

  const forced = await engine.run('git branch -D feature');
  assert.equal(forced.ok, true);
  assert.equal(graph(engine).branches.feature, undefined);
  assert.equal(graph(engine).commits.C2, undefined, 'its unique commit goes with it');
});

test('git branch -d allows a merged branch and rejects unknown names', async () => {
  const engine = await repo('git commit; git branch feature; git commit');
  const merged = await engine.run('git branch -d feature');
  assert.equal(merged.ok, true);

  const missing = await engine.run('git branch -d ghost');
  assert.equal(missing.ok, false);
  assert.match(missing.error.text, /no branch called/);
});

test('remote-tracking branches cannot be hand-made or hand-deleted', async () => {
  const engine = await repo('git commit; git clone');
  const made = await engine.run('git branch o/feature');
  assert.equal(made.ok, false);
  assert.match(made.error.text, /remote/);

  const deleted = await engine.run('git branch -D o/main');
  assert.equal(deleted.ok, false);
  assert.match(deleted.error.text, /remote/);
});

/* -------------------------------------------------------------------------- */
/* checkout / switch                                                          */
/* -------------------------------------------------------------------------- */

test('git checkout -b, -B and git switch -c all create and move', async () => {
  const engine = await repo('git commit; git commit');

  assert.equal((await engine.run('git checkout -b alpha')).ok, true);
  assert.equal(graph(engine).HEAD, 'alpha');
  assert.equal(graph(engine).branches.alpha, 'C2');

  // We are standing on alpha, so the refusal says that rather than pointing us
  // back at the branch we are already on.
  const clashHere = await engine.run('git checkout -b alpha');
  assert.equal(clashHere.ok, false);
  assert.match(clashHere.error.text, /already standing on/);

  // From somewhere else, the same clash reports that the name is taken.
  await engine.run('git checkout main');
  const clashElsewhere = await engine.run('git checkout -b alpha');
  assert.equal(clashElsewhere.ok, false);
  assert.match(clashElsewhere.error.text, /already exists/);
  await engine.run('git checkout alpha');

  assert.equal((await engine.run('git checkout -B alpha C1')).ok, true, '-B resets an existing branch');
  assert.equal(graph(engine).branches.alpha, 'C1');

  assert.equal((await engine.run('git switch -c beta main')).ok, true);
  assert.equal(graph(engine).branches.beta, 'C2');
  assert.equal(graph(engine).HEAD, 'beta');

  assert.equal((await engine.run('git switch main')).ok, true);
  assert.equal(graph(engine).HEAD, 'main');
});

test('git checkout of a commit detaches HEAD and explains itself', async () => {
  const engine = await repo('git commit; git commit');
  const result = await engine.run('git checkout C1');
  assert.equal(result.ok, true);
  assert.equal(engine.getSnapshot().HEAD.detached, true);
  assert.equal(graph(engine).HEAD, 'C1');
  assert.match(text(result), /detached/i);
});

test('git checkout of a remote-tracking branch detaches, like real git', async () => {
  const engine = await repo('git commit; git clone');
  const result = await engine.run('git checkout o/main');
  assert.equal(result.ok, true);
  assert.equal(engine.getSnapshot().HEAD.detached, true);
  assert.equal(graph(engine).HEAD, 'C1');
});

test('git checkout - toggles between the last two places', async () => {
  const engine = await repo('git commit; git checkout -b feature; git commit; git checkout main');
  assert.equal(graph(engine).HEAD, 'main');

  assert.equal((await engine.run('git checkout -')).ok, true);
  assert.equal(graph(engine).HEAD, 'feature');

  assert.equal((await engine.run('git checkout -')).ok, true);
  assert.equal(graph(engine).HEAD, 'main');

  const fresh = await repo();
  const nowhere = await fresh.run('git checkout -');
  assert.equal(nowhere.ok, false);
  assert.match(nowhere.error.text, /nowhere to go back/);
});

test('git checkout complains usefully about missing and extra arguments', async () => {
  const engine = await repo('git commit');
  const none = await engine.run('git checkout');
  assert.equal(none.ok, false);
  assert.match(none.error.text, /-b/);

  const tooMany = await engine.run('git checkout main C1');
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error.text, /-b/);
});

/* -------------------------------------------------------------------------- */
/* tag / describe                                                             */
/* -------------------------------------------------------------------------- */

test('git tag pins a commit and never moves afterwards', async () => {
  const engine = await repo('git commit; git commit');
  assert.equal((await engine.run('git tag v1')).ok, true);
  assert.equal(graph(engine).tags.v1, 'C2');

  await engine.run('git commit');
  assert.equal(graph(engine).tags.v1, 'C2', 'the tag stayed put while main moved');
  assert.equal(graph(engine).branches.main, 'C3');

  assert.equal((await engine.run('git tag old C1')).ok, true);
  assert.equal(graph(engine).tags.old, 'C1');
  assert.equal(engine.resolveRef('old~1'), 'C0', 'tags work as refs');
});

test('git tag lists, refuses duplicates and deletes with -d', async () => {
  const engine = await repo('git commit; git tag v1');
  const listed = await engine.run('git tag');
  assert.match(text(listed), /v1 -> C1/);

  const duplicate = await engine.run('git tag v1');
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error.text, /already exists/);

  assert.equal((await engine.run('git tag -d v1')).ok, true);
  assert.equal(graph(engine).tags.v1, undefined);
  assert.match(text(await engine.run('git tag')), /No tags yet/);
});

test('git describe names the closest tag behind a commit', async () => {
  const engine = await repo('git commit; git tag v1; git commit; git commit');

  const exact = await engine.run('git describe v1');
  assert.equal(exact.describe, 'v1', 'sitting on the tag gives just the tag');

  const away = await engine.run('git describe');
  assert.equal(away.describe, 'v1-2-gC3');
  assert.match(text(away), /closest tag/);

  await engine.run('git tag v2 C2');
  assert.equal((await engine.run('git describe')).describe, 'v2-1-gC3', 'the nearer tag wins');

  const untagged = await repo('git commit');
  const none = await untagged.run('git describe');
  assert.equal(none.ok, false);
  assert.match(none.error.text, /No tag can describe/);
});

/* -------------------------------------------------------------------------- */
/* merge                                                                      */
/* -------------------------------------------------------------------------- */

test('git merge fast-forwards when the target is ahead on the same line', async () => {
  const engine = await repo('git commit; git checkout -b feature; git commit; git commit; git checkout main');
  const result = await engine.run('git merge feature');
  assert.equal(result.ok, true);
  assert.match(text(result), /Fast-forward/);
  const state = graph(engine);
  assert.equal(state.branches.main, 'C3');
  assert.equal(state.commits.C3.length, 1, 'no merge commit was created');
  assert.equal(Object.keys(state.commits).length, 4);
});

test('git merge builds a real two-parent commit when the lines diverge', async () => {
  const engine = await repo('git commit; git checkout -b feature; git commit; git checkout main; git commit');
  const result = await engine.run('git merge feature');
  assert.equal(result.ok, true);
  assert.match(text(result), /two parents/);

  const state = graph(engine);
  const tip = state.branches.main;
  assert.deepEqual(state.commits[tip], ['C3', 'C2'], 'first parent is the branch we were on');
  assert.equal(engine.resolveRef('main^1'), 'C3');
  assert.equal(engine.resolveRef('main^2'), 'C2');
  assert.equal(state.branches.feature, 'C2', 'the merged branch does not move');
  assert.equal(result.frames.length, 1);
});

test('git merge reports already-up-to-date and refuses to merge a commit into itself', async () => {
  const engine = await repo('git commit; git checkout -b feature; git commit');

  const behind = await engine.run('git merge main');
  assert.equal(behind.ok, true);
  assert.match(text(behind), /Already up to date/);
  assert.equal(graph(engine).branches.feature, 'C2', 'nothing moved');

  const itself = await engine.run('git merge HEAD');
  assert.equal(itself.ok, false);
  assert.match(itself.error.text, /into itself/);

  const alsoItself = await engine.run('git merge feature');
  assert.equal(alsoItself.ok, false);
  assert.match(alsoItself.error.text, /into itself/);
});

test('git merge works with a detached HEAD and moves HEAD only', async () => {
  const engine = await repo('git commit; git checkout -b feature; git commit; git checkout main; git commit; git checkout C3');
  const result = await engine.run('git merge feature');
  assert.equal(result.ok, true);
  const state = graph(engine);
  assert.equal(state.branches.main, 'C3', 'main stayed put');
  assert.equal(state.HEAD, 'C4');
  assert.deepEqual(state.commits.C4, ['C3', 'C2']);
});

test('git merge needs exactly one target', async () => {
  const engine = await repo('git commit');
  const none = await engine.run('git merge');
  assert.equal(none.ok, false);
  assert.equal(none.error.type, 'CommandParseError');
  const many = await engine.run('git merge main HEAD');
  assert.equal(many.ok, false);
});

/* -------------------------------------------------------------------------- */
/* rebase                                                                     */
/* -------------------------------------------------------------------------- */

test('git rebase replays the unique commits in order onto the target', async () => {
  const engine = await repo(
    'git commit; git checkout -b feature; git commit; git commit; git commit; git checkout main; git commit'
  );
  const result = await engine.run('git rebase main feature');
  assert.equal(result.ok, true);
  assert.ok(result.frames.length >= 3, `three replayed commits need >= 3 frames, got ${result.frames.length}`);

  const state = graph(engine);
  assert.deepEqual(state.commits["C2'"], ['C5'], 'first replayed commit sits on the target tip');
  assert.deepEqual(state.commits["C3'"], ["C2'"]);
  assert.deepEqual(state.commits["C4'"], ["C3'"]);
  assert.equal(state.branches.feature, "C4'");
  assert.equal(state.branches.main, 'C5', 'the target branch never moves');
  assert.equal(state.HEAD, 'feature', 'git leaves you on the rebased branch');
  for (const gone of ['C2', 'C3', 'C4']) assert.equal(state.commits[gone], undefined);
});

test('git rebase while already on the branch keeps HEAD attached', async () => {
  const engine = await repo('git commit; git checkout -b feature; git commit; git checkout main; git commit; git checkout feature');
  const result = await engine.run('git rebase main');
  assert.equal(result.ok, true);
  const state = graph(engine);
  assert.equal(state.HEAD, 'feature');
  assert.deepEqual(state.commits["C2'"], ['C3']);
  assert.equal(state.branches.feature, "C2'");
});

test('git rebase with a detached HEAD leaves HEAD detached at the new tip', async () => {
  const engine = await repo('git commit; git checkout -b feature; git commit; git checkout main; git commit; git checkout C2');
  assert.equal(engine.getSnapshot().HEAD.detached, true);
  const result = await engine.run('git rebase main');
  assert.equal(result.ok, true);
  const state = graph(engine);
  assert.equal(state.HEAD, "C2'");
  assert.equal(engine.getSnapshot().HEAD.detached, true);
  assert.equal(state.branches.feature, 'C2', 'the branch that still holds C2 did not move');
});

test('git rebase --onto moves only the slice after the upstream', async () => {
  const engine = await repo('git commit; git checkout -b feature; git commit; git commit; git commit');
  const result = await engine.run('git rebase --onto main feature~2 feature');
  assert.equal(result.ok, true);

  const state = graph(engine);
  assert.deepEqual(state.commits["C3'"], ['C1'], 'replayed straight onto main');
  assert.deepEqual(state.commits["C4'"], ["C3'"]);
  assert.equal(state.commits["C2'"], undefined, 'the upstream slice stayed behind');
  assert.equal(state.branches.feature, "C4'");
  assert.equal(state.HEAD, 'feature');

  const incomplete = await engine.run('git rebase --onto main');
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.error.type, 'CommandParseError');
});

test('git rebase skips commits the target already carries', async () => {
  // main picked C2 already, so rebasing side onto main must only move C3.
  const engine = await repo(
    'git commit; git checkout -b side; git commit; git commit; git checkout main; git cherry-pick C2'
  );
  const result = await engine.run('git rebase main side');
  assert.equal(result.ok, true);
  const state = graph(engine);
  assert.deepEqual(state.commits["C3'"], ["C2'"], 'C3 landed on top of the copy main already had');
  assert.equal(state.commits["C2''"], undefined, 'C2 was not replayed a second time');
  assert.equal(state.branches.side, "C3'");
});

test('git rebase says so when there is nothing to do, and fast-forwards when behind', async () => {
  const upToDate = await repo('git commit; git checkout -b feature; git commit');
  const same = await upToDate.run('git rebase feature');
  assert.equal(same.ok, true);
  assert.match(text(same), /up to date/i);
  assert.equal(same.frames.length, 1);

  const behind = await repo('git commit; git branch feature; git commit; git checkout feature');
  const forward = await behind.run('git rebase main');
  assert.equal(forward.ok, true);
  assert.match(text(forward), /Fast-forwarded/);
  assert.equal(graph(behind).branches.feature, 'C2');
});

test('git rebase needs a target and rejects the half-implemented flags', async () => {
  const engine = await repo('git commit');
  const bare = await engine.run('git rebase');
  assert.equal(bare.ok, false);
  assert.equal(bare.error.type, 'CommandParseError');

  const cont = await engine.run('git rebase --continue');
  assert.equal(cont.ok, false);
  assert.match(cont.error.text, /one go/);
});

test('repeated copies of one commit walk the apostrophe ladder', async () => {
  const engine = await repo('git commit; git checkout -b side; git commit; git checkout main');
  for (let i = 1; i <= 5; i++) {
    const step = await engine.run(`git checkout -b b${i} C1; git cherry-pick C2`);
    assert.equal(step.ok, true, `copy ${i} failed: ${step.error && step.error.text}`);
  }
  const ids = Object.keys(engine.exportTree().commits);
  for (const expected of ["C2'", "C2''", "C2'''", "C2'^4", "C2'^5"]) {
    assert.ok(ids.includes(expected), `expected ${expected} among ${ids.join(' ')}`);
  }
});

/* -------------------------------------------------------------------------- */
/* reset                                                                      */
/* -------------------------------------------------------------------------- */

test('git reset moves the current branch and accepts all three modes', async () => {
  for (const mode of ['', '--soft ', '--mixed ', '--hard ']) {
    const engine = await repo('git commit; git commit; git commit');
    const result = await engine.run(`git reset ${mode}HEAD~2`);
    assert.equal(result.ok, true, `${mode} should be accepted`);
    assert.equal(graph(engine).branches.main, 'C1');
    if (mode) assert.match(text(result), /working tree/, `${mode} should be explained`);
  }
});

test('git reset on a detached HEAD moves HEAD, not a branch', async () => {
  const engine = await repo('git commit; git commit; git checkout C2');
  const result = await engine.run('git reset C1');
  assert.equal(result.ok, true);
  assert.equal(graph(engine).branches.main, 'C2');
  assert.equal(graph(engine).HEAD, 'C1');
  assert.match(text(result), /detached/);
});

test('git reset can point at any resolvable ref and reports a no-op', async () => {
  const engine = await repo('git commit; git commit; git tag v1 C1');
  assert.equal((await engine.run('git reset v1')).ok, true);
  assert.equal(graph(engine).branches.main, 'C1');

  const noop = await engine.run('git reset HEAD');
  assert.equal(noop.ok, true);
  assert.match(text(noop), /Nothing moved/);

  const bad = await engine.run('git reset ghost');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.type, 'GitError');
});

/* -------------------------------------------------------------------------- */
/* revert                                                                     */
/* -------------------------------------------------------------------------- */

test('git revert appends an undoing commit without rewriting history', async () => {
  const engine = await repo('git commit; git commit');
  const result = await engine.run('git revert C2');
  assert.equal(result.ok, true);
  const state = graph(engine);
  assert.deepEqual(state.commits["C2'"], ['C2'], 'the revert sits on top of what it undoes');
  assert.ok(state.commits.C2, 'the original is still there');
  assert.equal(state.branches.main, "C2'");
  assert.match(text(result), /never rewrites history/);
});

test('git revert handles several commits in order', async () => {
  const engine = await repo('git commit; git commit; git commit');
  const result = await engine.run('git revert C3 C2');
  assert.equal(result.ok, true);
  assert.ok(result.frames.length >= 2, 'one frame per reverted commit');
  const state = graph(engine);
  assert.deepEqual(state.commits["C3'"], ['C3']);
  assert.deepEqual(state.commits["C2'"], ["C3'"]);
  assert.equal(state.branches.main, "C2'");
});

test('git revert refuses merges and needs an argument', async () => {
  const engine = await repo('git commit; git checkout -b f; git commit; git checkout main; git commit; git merge f');
  const merge = await engine.run('git revert main');
  assert.equal(merge.ok, false);
  assert.match(merge.error.text, /merge commit/);

  const none = await engine.run('git revert');
  assert.equal(none.ok, false);
  assert.equal(none.error.type, 'CommandParseError');
});

/* -------------------------------------------------------------------------- */
/* cherry-pick                                                                */
/* -------------------------------------------------------------------------- */

test('git cherry-pick copies commits onto HEAD in the order given', async () => {
  const engine = await repo('git commit; git checkout -b side; git commit; git commit; git commit; git checkout main');
  const result = await engine.run('git cherry-pick C4 C2');
  assert.equal(result.ok, true);
  assert.equal(result.frames.length, 2, 'one animation frame per copied commit');

  const state = graph(engine);
  assert.deepEqual(state.commits["C4'"], ['C1'], 'the first pick lands on HEAD');
  assert.deepEqual(state.commits["C2'"], ["C4'"], 'the second lands on the first');
  assert.equal(state.branches.main, "C2'");
  assert.equal(state.branches.side, 'C4', 'the source branch is untouched');
});

test('git cherry-pick refuses a commit HEAD can already reach', async () => {
  const engine = await repo('git commit; git commit');
  const ancestor = await engine.run('git cherry-pick C1');
  assert.equal(ancestor.ok, false);
  assert.match(ancestor.error.text, /already part of this history/);

  const self = await engine.run('git cherry-pick HEAD');
  assert.equal(self.ok, false);

  const none = await engine.run('git cherry-pick');
  assert.equal(none.ok, false);
  assert.equal(none.error.type, 'CommandParseError');
});

test('a failed cherry-pick in a list leaves the repository untouched', async () => {
  const engine = await repo('git commit; git checkout -b side; git commit; git checkout main');
  const before = engine.exportTree();
  const result = await engine.run('git cherry-pick C2 C1');
  assert.equal(result.ok, false);
  assert.deepEqual(engine.exportTree(), before, 'the whole command rolled back');
});

/* -------------------------------------------------------------------------- */
/* remotes                                                                    */
/* -------------------------------------------------------------------------- */

/** Local main is one commit ahead; origin main is one commit ahead a different way. */
const divergedTree = () => ({
  commits: {
    C0: { id: 'C0', parents: [], rootCommit: true },
    C1: { id: 'C1', parents: ['C0'] },
    C2: { id: 'C2', parents: ['C1'] },
  },
  branches: {
    main: { id: 'main', target: 'C2', remoteTrackingBranchID: 'o/main' },
    'o/main': { id: 'o/main', target: 'C1', remoteTrackingBranchID: null },
  },
  tags: {},
  HEAD: { id: 'HEAD', target: 'main' },
  originTree: {
    commits: {
      C0: { id: 'C0', parents: [], rootCommit: true },
      C1: { id: 'C1', parents: ['C0'] },
      C3: { id: 'C3', parents: ['C1'] },
    },
    branches: { main: { id: 'main', target: 'C3', remoteTrackingBranchID: null } },
    tags: {},
    HEAD: { id: 'HEAD', target: 'main' },
  },
});

test('git clone builds an origin and the o/ branches that remember it', async () => {
  const engine = await repo('git commit; git branch feature');
  const result = await engine.run('git clone');
  assert.equal(result.ok, true);

  const tree = engine.exportTree();
  assert.ok(tree.originTree, 'originTree exists');
  assert.equal(tree.originTree.branches.main.target, 'C1');
  assert.equal(tree.originTree.branches.feature.target, 'C1');
  assert.equal(tree.branches['o/main'].target, 'C1');
  assert.equal(tree.branches['o/feature'].target, 'C1');
  assert.equal(tree.branches.main.remoteTrackingBranchID, 'o/main');
  assert.equal(tree.branches['o/main'].remoteTrackingBranchID, null);

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.origin.origin, null);
  assert.equal(snapshot.branches['o/main'].remote, true);

  const twice = await engine.run('git clone');
  assert.equal(twice.ok, false);
  assert.match(twice.error.text, /already has a remote/);
});

test('git push uploads commits and moves both the remote branch and o/', async () => {
  const engine = await repo('git commit; git clone; git commit; git commit');
  const result = await engine.run('git push');
  assert.equal(result.ok, true);
  assert.ok(result.frames.length >= 2, 'a frame per uploaded commit');

  const tree = engine.exportTree();
  assert.equal(tree.originTree.branches.main.target, 'C3');
  assert.ok(tree.originTree.commits.C2 && tree.originTree.commits.C3, 'both commits arrived');
  assert.equal(tree.branches['o/main'].target, 'C3');
  assert.equal(tree.branches.main.target, 'C3');

  const again = await engine.run('git push');
  assert.equal(again.ok, true);
  assert.match(text(again), /up-to-date/i);
});

test('git push is rejected when it is not a fast-forward, and -f overrides', async () => {
  const engine = await repo('', divergedTree());
  const rejected = await engine.run('git push');
  assert.equal(rejected.ok, false);
  assert.match(rejected.error.text, /rejected/i);
  assert.match(rejected.error.text, /git pull/);
  assert.equal(engine.exportTree().originTree.branches.main.target, 'C3', 'the remote did not budge');

  const forced = await engine.run('git push -f');
  assert.equal(forced.ok, true);
  assert.ok(forced.messages.some((m) => m.type === 'warning'));
  const tree = engine.exportTree();
  assert.equal(tree.originTree.branches.main.target, 'C2');
  assert.equal(tree.branches['o/main'].target, 'C2');
});

test('the refusal never advises a force push, and a forced push says what it dropped', async () => {
  const engine = await repo('', divergedTree());

  // Levels invite the reader to try the bare push and read the refusal. Advice
  // they can follow safely: taking their work first, never dropping it.
  const rejected = await engine.run('git push');
  assert.equal(rejected.ok, false);
  assert.match(rejected.error.text, /git pull/, 'it still has to say what does work');
  assert.doesNotMatch(rejected.error.text, /-f\b|--force/, 'suggesting a force push can strand the reader');

  // Force is still available - it just has to be honest about the damage.
  const forced = await engine.run('git push -f');
  assert.equal(forced.ok, true, forced.error && forced.error.text);
  const warning = forced.messages.find((m) => m.type === 'warning');
  assert.ok(warning, 'a force push that discards a commit has to warn');
  assert.match(warning.text, /\bC3\b/, 'name the commit that just left the remote');
  assert.match(warning.text, /undo/, 'and the way back');
  assert.equal(engine.exportTree().originTree.branches.main.target, 'C2');

  // The way back has to be real, not just reassuring.
  assert.equal(engine.undo(), true);
  assert.equal(engine.exportTree().originTree.branches.main.target, 'C3', 'undo puts the remote back');

  // And it must not cry wolf: a commit another remote branch still holds is
  // not lost, so the same push cannot claim it is.
  const shared = await repo('git commit; git clone; git commit; git push; git push origin main:keep; git reset --hard C1');
  const rewound = await shared.run('git push -f');
  assert.equal(rewound.ok, true, rewound.error && rewound.error.text);
  const kept = rewound.messages.find((m) => m.type === 'warning');
  assert.ok(kept, 'moving a branch backwards is still worth a warning');
  assert.match(kept.text, /nothing is lost/, 'origin/keep still reaches C2');
  assert.equal(shared.exportTree().originTree.branches.keep.target, 'C2');
});

test('git push refuses a detached HEAD and a branch with no upstream', async () => {
  const detached = await repo('git commit; git clone; git checkout C1');
  const first = await detached.run('git push');
  assert.equal(first.ok, false);
  assert.match(first.error.text, /detached/);

  const solo = await repo('git commit; git clone; git checkout -b solo; git commit');
  const second = await solo.run('git push');
  assert.equal(second.ok, false);
  assert.match(second.error.text, /no upstream/);

  const explicit = await solo.run('git push -u origin solo');
  assert.equal(explicit.ok, true);
  const tree = solo.exportTree();
  assert.equal(tree.originTree.branches.solo.target, 'C2');
  assert.equal(tree.branches.solo.remoteTrackingBranchID, 'o/solo');
  assert.equal(tree.branches['o/solo'].target, 'C2');
});

test('git push understands a source:destination refspec', async () => {
  const engine = await repo('git commit; git clone; git checkout -b feature; git commit; git checkout main');
  const result = await engine.run('git push origin feature:release');
  assert.equal(result.ok, true);
  const tree = engine.exportTree();
  assert.equal(tree.originTree.branches.release.target, 'C2');
  assert.equal(tree.branches['o/release'].target, 'C2');
  assert.equal(tree.branches.main.target, 'C1', 'pushing another branch did not move main');
});

test('git fetch downloads what is missing and moves only the o/ branches', async () => {
  const engine = await repo('', divergedTree());
  const result = await engine.run('git fetch');
  assert.equal(result.ok, true);
  assert.ok(result.frames.length >= 2, 'a frame per downloaded commit');

  const tree = engine.exportTree();
  assert.ok(tree.commits.C3, 'the remote commit arrived locally');
  assert.equal(tree.branches['o/main'].target, 'C3');
  assert.equal(tree.branches.main.target, 'C2', 'your own branch never moves on fetch');
  assert.match(text(result), /leaves your own branches alone/);

  const again = await engine.run('git fetch');
  assert.match(text(again), /Already up to date/);
});

test('git pull is fetch plus merge', async () => {
  const engine = await repo('', divergedTree());
  const result = await engine.run('git pull');
  assert.equal(result.ok, true);

  const state = graph(engine);
  const tip = state.branches.main;
  assert.deepEqual(state.commits[tip], ['C2', 'C3'], 'a real merge of local and remote work');
  assert.equal(state.branches['o/main'], 'C3');
  assert.match(text(result), /Downloaded 1 commit/);
});

test('git pull --rebase replays your work on top of the remote', async () => {
  const engine = await repo('', divergedTree());
  const result = await engine.run('git pull --rebase');
  assert.equal(result.ok, true);

  const state = graph(engine);
  assert.deepEqual(state.commits["C2'"], ['C3'], 'the local commit was replayed onto the remote tip');
  assert.equal(state.branches.main, "C2'");
  assert.equal(state.commits.C2, undefined, 'the original is gone - rebase rewrites');
  assert.match(text(result), /replayed/);
});

test('remote commands explain themselves when there is no remote', async () => {
  const engine = await repo('git commit');
  for (const command of ['git fetch', 'git push', 'git pull']) {
    const result = await engine.run(command);
    assert.equal(result.ok, false, `${command} should fail without a remote`);
    assert.match(result.error.text, /no remote/i);
  }
});

test('git pull needs a branch and an upstream', async () => {
  const detached = await repo('git commit; git clone; git checkout C1');
  const first = await detached.run('git pull');
  assert.equal(first.ok, false);
  assert.match(first.error.text, /detached/);

  const solo = await repo('git commit; git clone; git checkout -b solo');
  const second = await solo.run('git pull');
  assert.equal(second.ok, false);
  assert.match(second.error.text, /no upstream/);

  const unknown = await solo.run('git fetch origin ghost');
  assert.equal(unknown.ok, false);
  assert.match(unknown.error.text, /no branch called/);
});

test('a full remote round trip keeps both sides consistent', async () => {
  const engine = await repo('git commit; git clone');
  const script = [
    'git commit',
    'git push',
    'git checkout -b feature',
    'git commit',
    'git push -u origin feature',
    'git checkout main',
    'git merge feature',
    'git push',
    'git fetch',
    'git status',
  ].join('; ');
  const result = await engine.run(script);
  assert.equal(result.ok, true, result.error && result.error.text);

  const tree = engine.exportTree();
  assert.equal(tree.originTree.branches.main.target, tree.branches.main.target);
  assert.equal(tree.originTree.branches.feature.target, tree.branches.feature.target);
  assert.equal(tree.branches['o/main'].target, tree.branches.main.target);
  assert.equal(tree.branches['o/feature'].target, tree.branches.feature.target);
  for (const id of Object.keys(tree.commits)) {
    assert.ok(tree.originTree.commits[id], `origin is missing ${id}`);
  }
  assert.match(text(await engine.run('git status')), /up to date/);
});

/* -------------------------------------------------------------------------- */
/* reporting commands                                                         */
/* -------------------------------------------------------------------------- */

test('git status describes attached, detached and ahead/behind states', async () => {
  const attached = await repo('git commit; git clone; git commit');
  assert.match(text(await attached.run('git status')), /On branch main/);
  assert.match(text(await attached.run('git status')), /ahead of "o\/main" by 1 commit/);

  const detached = await repo('git commit; git commit; git checkout C1');
  const result = await detached.run('git status');
  assert.match(text(result), /HEAD detached at C1/);

  const behind = await repo('', divergedTree());
  await behind.run('git reset C1; git fetch');
  assert.match(text(await behind.run('git status')), /behind "o\/main" by 1 commit/);
});

test('git show prints the commit, its parents and any refs on it', async () => {
  const engine = await repo('git commit -m "the one"; git tag v1');
  const result = await engine.run('git show');
  assert.match(text(result), /commit C1/);
  assert.match(text(result), /parents: C0/);
  assert.match(text(result), /the one/);
  assert.match(text(result), /refs here: main, v1/);

  assert.match(text(await engine.run('git show C0')), /root commit/);
});

test('git log walks newest first from any starting point', async () => {
  const engine = await repo('git commit; git commit; git commit');
  const lines = text(await engine.run('git log --oneline')).split('\n');
  assert.deepEqual(
    lines.map((line) => line.split(' ')[0]),
    ['C3', 'C2', 'C1', 'C0']
  );
  const older = text(await engine.run('git log HEAD~2 --oneline')).split('\n');
  assert.deepEqual(
    older.map((line) => line.split(' ')[0]),
    ['C1', 'C0']
  );
});

/* -------------------------------------------------------------------------- */
/* non-git commands                                                           */
/* -------------------------------------------------------------------------- */

test('help and show commands describe the whole surface', async () => {
  const engine = await repo();
  const help = await engine.run('help');
  assert.equal(help.commandName, 'help');
  assert.ok(help.messages.length > 3);

  const list = await engine.run('show commands');
  assert.equal(list.commandName, 'show commands');
  assert.ok(Array.isArray(list.commands));
  assert.ok(list.commands.includes('git cherry-pick'));
  assert.match(text(list), /git rebase --onto/);
});

test('export tree and import tree round-trip through the terminal', async () => {
  const source = await repo('git commit; git checkout -b feature; git commit; git tag v1; git clone');
  const exported = await source.run('export tree');
  assert.equal(exported.commandName, 'export tree');
  assert.ok(exported.tree && exported.tree.commits.C0);
  assert.deepEqual(exported.tree, source.exportTree());

  const target = await repo();
  const levelStart = target.exportTree();
  await target.run('git commit; git commit');

  const imported = await target.run(`import tree ${JSON.stringify(exported.tree)}`);
  assert.equal(imported.ok, true, imported.error && imported.error.text);
  assert.equal(imported.commandName, 'import tree');
  assert.deepEqual(imported.frames, [], 'non-git commands do not animate');
  assert.deepEqual(target.exportTree(), exported.tree);

  // An import must not hijack the level: Reset still goes to the level's own
  // starting tree, and Undo steps back out of the import.
  assert.equal(target.commandStack.length, 3, 'the import is recorded like any other change');
  assert.equal(target.undo(), true);
  assert.equal(Object.keys(target.exportTree().commits).length, 3, 'back to the pre-import state');

  await target.run(`import tree ${JSON.stringify(exported.tree)}`);
  target.reset();
  assert.deepEqual(target.exportTree(), levelStart, 'reset returns to the level start, not the import');
});

test('import tree rejects nonsense with a readable reason', async () => {
  const engine = await repo('git commit');
  const before = engine.exportTree();

  const empty = await engine.run('import tree');
  assert.equal(empty.ok, false);
  assert.equal(empty.error.type, 'CommandParseError');

  const broken = await engine.run('import tree {not json');
  assert.equal(broken.ok, false);
  assert.equal(broken.error.type, 'CommandParseError');
  assert.match(broken.error.text, /valid JSON/);

  const wrongShape = await engine.run('import tree {"commits":{},"branches":{},"HEAD":{"target":"main"}}');
  assert.equal(wrongShape.ok, false);
  assert.equal(wrongShape.error.type, 'GitError');

  assert.deepEqual(engine.exportTree(), before, 'a bad import changes nothing');
});

test('theme reports the requested name', async () => {
  const engine = await repo();
  const dusk = await engine.run('theme dusk');
  assert.equal(dusk.ok, true);
  assert.equal(dusk.commandName, 'theme');
  assert.equal(dusk.theme, 'dusk');

  const nameless = await engine.run('theme');
  assert.equal(nameless.ok, false);
  assert.match(nameless.error.text, /day/);
});

/* -------------------------------------------------------------------------- */
/* regressions                                                                */
/* -------------------------------------------------------------------------- */

test('regression: rebase across a merge commit loses nothing', async () => {
  // A merge used to stop the topological walk dead, so everything underneath
  // was dropped from the replay list while the branch still moved - and the
  // pruner then deleted it. The command even reported success.
  const engine = await repo(
    'git commit; git checkout -b dev C0; git commit; git commit; git merge main; git checkout -b base C0; git commit; git checkout dev'
  );
  const before = graph(engine);
  assert.equal(before.commits.C4.length, 2, 'dev tips a merge commit');
  assert.equal(before.branches.dev, 'C4');

  const result = await engine.run('git rebase base');
  assert.equal(result.ok, true);

  const state = graph(engine);
  // base..dev holds C1, C2, C3 (non-merges) and C4 (the merge). Real git
  // flattens the merge away and replays the other three.
  assert.deepEqual(state.commits["C2'"], ['C5'], 'the replay starts on the new base');
  assert.deepEqual(state.commits["C3'"], ["C2'"]);
  assert.deepEqual(state.commits["C1'"], ["C3'"]);
  assert.equal(state.branches.dev, "C1'");
  assert.equal(state.HEAD, 'dev');
  assert.ok(result.frames.length >= 3, 'a frame per replayed commit');

  // Nothing silently disappeared: every commit that was under the merge is
  // still represented, either as itself or as a copy.
  const survivors = new Set(Object.keys(state.commits).map((id) => id.replace(/'.*$/, '')));
  for (const original of ['C1', 'C2', 'C3']) {
    assert.ok(survivors.has(original), `${original} was lost by the rebase`);
  }
  assert.ok(
    result.messages.some((m) => /Flattening past C4/.test(m.text)),
    'the dropped merge is called out rather than passed over in silence'
  );
});

test('regression: a merge in the middle of the range does not truncate the replay', async () => {
  const engine = await repo(
    'git commit; git checkout -b dev C0; git commit; git merge main; git commit; git checkout -b base C0; git commit; git checkout dev'
  );
  const result = await engine.run('git rebase base');
  assert.equal(result.ok, true);
  const replayed = Object.keys(graph(engine).commits).filter((id) => id.includes("'"));
  assert.equal(replayed.length, 3, `expected C1, C2 and C4 replayed, got ${replayed.join(', ')}`);
});

test('regression: a failed command returns no frames, so the drawing cannot desync', async () => {
  const engine = await repo('git commit; git checkout -b f C0; git commit; git commit; git checkout main');
  const before = engine.exportTree();

  for (const input of ['git cherry-pick C2 C3 nosuchref', 'git revert C2 C1 nosuchref']) {
    const result = await engine.run(input);
    assert.equal(result.ok, false, `${input} should fail`);
    assert.deepEqual(result.frames, [], `${input} leaked frames from work that was rolled back`);
    assert.deepEqual(engine.exportTree(), before, `${input} did not roll back cleanly`);
  }

  // Frames from sub-commands that really did happen are still delivered.
  const partial = await engine.run('git commit; git cherry-pick nosuchref');
  assert.equal(partial.ok, false);
  assert.equal(partial.frames.length, 1, 'only the commit that survived contributes a frame');
  assert.deepEqual(partial.frames[0], engine.getSnapshot(), 'and it matches the state that was kept');
});

test('regression: merge --no-ff makes a merge commit where a fast-forward was possible', async () => {
  const engine = await repo('git checkout -b topic; git commit; git checkout main');
  assert.equal(graph(engine).branches.main, 'C0');

  const result = await engine.run('git merge --no-ff topic');
  assert.equal(result.ok, true);
  const state = graph(engine);
  const tip = state.branches.main;
  assert.equal(state.commits[tip].length, 2, '--no-ff must not fast-forward');
  assert.deepEqual(state.commits[tip], ['C0', 'C1']);
  assert.ok(!/Fast-forward/.test(text(result)), 'and must not claim it fast-forwarded');

  // Without the flag the same merge does fast-forward.
  const plain = await repo('git checkout -b topic; git commit; git checkout main');
  await plain.run('git merge topic');
  assert.equal(graph(plain).branches.main, 'C1');
  assert.equal(graph(plain).commits.C1.length, 1);
});

test('regression: merge --ff-only refuses to invent a merge commit', async () => {
  const diverged = await repo('git commit; git checkout -b f; git commit; git checkout main; git commit');
  const before = diverged.exportTree();
  const refused = await diverged.run('git merge --ff-only f');
  assert.equal(refused.ok, false);
  assert.match(refused.error.text, /fast-forward/i);
  assert.deepEqual(diverged.exportTree(), before, 'nothing was created');

  // It is happy when a fast-forward really is available.
  const ahead = await repo('git commit; git checkout -b f; git commit; git checkout main');
  const ok = await ahead.run('git merge --ff-only f');
  assert.equal(ok.ok, true);
  assert.equal(graph(ahead).branches.main, 'C2');

  const contradiction = await ahead.run('git merge --no-ff --ff-only f');
  assert.equal(contradiction.ok, false);
  assert.equal(contradiction.error.type, 'CommandParseError');
});

test('regression: git pull with nothing to pull is not an error', async () => {
  const engine = await repo('git commit; git clone');
  const result = await engine.run('git pull');
  assert.equal(result.ok, true, result.error && result.error.text);
  assert.match(text(result), /Already up to date/i);
  assert.equal(graph(engine).branches.main, 'C1');

  // Same when the remote is behind rather than level with us.
  const ahead = await repo('git commit; git clone; git commit');
  const second = await ahead.run('git pull');
  assert.equal(second.ok, true);
  assert.match(text(second), /Already up to date/i);

  const rebasing = await repo('git commit; git clone');
  const third = await rebasing.run('git pull --rebase');
  assert.equal(third.ok, true);
  assert.match(text(third), /Already up to date/i);
});

test('regression: every flag in the spec is either honoured or honestly refused', async () => {
  const engine = await repo('git commit; git clone; git tag v1');

  // Flags this model cannot honour must say so, not be swallowed.
  const refused = {
    'git commit -a -m "x"': /working directory/,
    'git log --graph': /does not simulate/,
    'git log --all': /does not simulate/,
    'git status --short': /short status/,
    'git fetch --prune': /prun/,
    'git fetch --all': /origin/,
    'git clone --bare': /bare/,
    'git describe --tags': /lightweight/,
    'git describe --all': /does not simulate/,
    'git push --all': /every branch/,
    'git checkout --force main': /working directory/,
    'git reset --keep HEAD': /working directory/,
    'git tag -a v2 -m "note"': /lightweight/,
  };
  for (const [input, pattern] of Object.entries(refused)) {
    const result = await engine.run(input);
    assert.equal(result.ok, false, `${input} was silently accepted`);
    assert.equal(result.error.type, 'CommandParseError');
    assert.match(result.error.text, pattern, `${input} gave an unhelpful reason`);
  }

  // "git push --all" used to fail with an unrelated upstream complaint.
  const pushAll = await engine.run('git push --all');
  assert.ok(!/upstream/.test(pushAll.error.text), 'the reason must be the flag, not a red herring');

  // Flags that are genuinely no-ops here stay accepted.
  for (const input of ['git branch -a', 'git branch --list', 'git tag -l', 'git revert --no-edit HEAD', 'git pull --no-rebase']) {
    const result = await engine.run(input);
    assert.equal(result.ok, true, `${input} should still work: ${result.error && result.error.text}`);
  }
});

test('audit: every accepted flag is exercised WITH an argument', async () => {
  // The old audit read the spec table and only ever ran these bare, so four
  // list flags were "accepted" while silently creating refs when given a name.
  // Behaviour, with an argument, is the only thing worth asserting.
  const cases = [
    // [setup, command, assertion]
    ['git commit; git branch feature', 'git branch --list feature', (e) => Object.keys(e.exportTree().branches).length === 2],
    ['git commit; git branch feature', 'git branch -a feature2', (e) => !e.exportTree().branches.feature2],
    ['git commit; git branch feature', 'git branch --list feat*', (e) => Object.keys(e.exportTree().branches).length === 2],
    ['git commit; git tag v1', 'git tag --list v9', (e) => Object.keys(e.exportTree().tags).length === 1],
    ['git commit; git tag v1', 'git tag -l v8', (e) => !e.exportTree().tags.v8],
    ['git commit; git tag v1', 'git tag -l v*', (e) => Object.keys(e.exportTree().tags).length === 1],
    ['git commit; git commit', 'git revert --no-edit HEAD', (e) => Object.keys(e.exportTree().commits).length === 4],
    ['git commit; git clone; git teammate-pushes main 1', 'git pull --no-rebase', (e) => e.exportTree().branches.main.target === 'C2'],
  ];

  for (const [setup, command, holds] of cases) {
    const engine = await repo(setup);
    const result = await engine.run(command);
    assert.equal(result.ok, true, `${command} failed: ${result.error && result.error.text}`);
    assert.ok(holds(engine), `${command} did something other than what the flag names`);
  }

  // The listing flags must actually list, not just decline to create.
  const listing = await repo('git commit; git branch feature; git branch other');
  assert.match(text(await listing.run('git branch --list feature')), /feature/);
  assert.doesNotMatch(text(await listing.run('git branch --list feature')), /other/);
  assert.match(text(await listing.run('git branch -a missing')), /No branch matches/);

  const tags = await repo('git commit; git tag v1; git tag beta');
  assert.match(text(await tags.run('git tag -l v*')), /v1/);
  assert.doesNotMatch(text(await tags.run('git tag -l v*')), /beta/);
  assert.match(text(await tags.run('git tag -l zzz')), /No tag matches/);

  // Creating still works when no listing flag is present.
  const creating = await repo('git commit');
  assert.equal((await creating.run('git branch feature')).ok, true);
  assert.ok(creating.exportTree().branches.feature);
  assert.equal((await creating.run('git tag v1')).ok, true);
  assert.ok(creating.exportTree().tags.v1);
});

test('audit: two mode flags on one command is a usage error, not a silent pick', async () => {
  // The audit above exercises each flag on its own with an argument, so a PAIR
  // of mode flags was never tried. Every line below used to be accepted, with
  // one flag honoured and the rest dropped on the floor - "git branch --list -d
  // feature" deleted the branch the reader had asked it to list.
  const cases = [
    ['git commit; git branch feature', 'git branch --list -d feature', ['--list', '-d']],
    ['git commit; git branch feature', 'git branch -a -D feature', ['-a', '-D']],
    ['git commit; git branch feature', 'git branch --list -f feature HEAD', ['--list', '-f']],
    ['git commit; git branch feature', 'git branch -a -f feature C0', ['-a', '-f']],
    ['git commit; git tag v1', 'git tag -l -d v1', ['-l', '-d']],
    ['git commit; git tag v1', 'git tag --list --force v1 HEAD', ['-l', '-f']],
    ['git commit; git tag v1', 'git tag -d -f v1', ['-d', '-f']],
    ['git commit', 'git checkout -b x -B y', ['-b', '-B']],
    ['git commit', 'git switch -c a -C b', ['-c', '-C']],
    ['git commit', 'git checkout -b x --detach', ['-b', '--detach']],
    ['git commit', 'git checkout -B x --detach', ['-B', '--detach']],
    ['git commit', 'git switch -c a --detach', ['-c', '--detach']],
  ];

  for (const [setup, command, named] of cases) {
    const engine = await repo(setup);
    const before = JSON.stringify(engine.exportTree());
    const stack = engine.commandStack.length;

    const result = await engine.run(command);
    assert.equal(result.ok, false, `${command} was accepted and one flag quietly ignored`);
    assert.equal(result.error.type, 'CommandParseError');
    for (const flag of named) {
      assert.ok(result.error.text.includes(`"${flag}"`), `${command} must name ${flag}: ${result.error.text}`);
    }
    assert.equal(JSON.stringify(engine.exportTree()), before, `${command} changed the repository anyway`);
    assert.equal(engine.commandStack.length, stack, `${command} landed on the undo stack`);
  }

  // Each of those flags on its own still does exactly its own job.
  const solo = await repo('git commit; git branch feature; git tag v1');
  for (const command of ['git branch --list', 'git branch -a', 'git branch --list feat*', 'git tag -l', 'git tag -l v*']) {
    assert.equal((await solo.run(command)).ok, true, `${command} should still work`);
  }
  assert.equal((await solo.run('git tag -f v1 C0')).ok, true);
  assert.equal((await solo.run('git branch -f feature C0')).ok, true);
  assert.equal((await solo.run('git branch -d feature')).ok, true);
  assert.equal((await solo.run('git tag -d v1')).ok, true);
  assert.equal((await solo.run('git checkout -b x')).ok, true);
  assert.equal((await solo.run('git checkout -B x C0')).ok, true);
  assert.equal((await solo.run('git switch -c y')).ok, true);
  assert.equal((await solo.run('git checkout --detach C0')).ok, true);
});

test('audit: no flag is declared and then ignored', () => {
  // Every flag a spec accepts has to fall into exactly one bucket. Adding a new
  // one to GIT_OPTION_SPECS without deciding which bucket it belongs in fails
  // here, which is the whole point - an inert flag is a lie to the reader.
  const HONOURED = new Set([
    'commit --amend', 'commit --message',
    'branch --force', 'branch --delete', 'branch --force-delete',
    'checkout --new-branch', 'checkout --force-new-branch',
    'switch --create', 'switch --force-create', 'switch --detach',
    'merge --no-ff', 'merge --ff-only',
    'rebase --interactive', 'rebase --continue', 'rebase --abort', 'rebase --onto',
    'reset --hard', 'reset --soft', 'reset --mixed',
    'tag --delete', 'tag --force', 'tag --list',
    'branch --list', 'branch --all',
    'checkout --detach', 'switch --detach',
    'log --oneline',
    'pull --rebase', 'pull --no-rebase', 'pull --ff-only',
    'push --force', 'push --set-upstream',
  ]);
  // Flags that name the behaviour this model already has. Accepting them is not
  // a lie: real git and this model do the same thing for them. Each one is
  // exercised with an argument in the audit test above.
  const ALREADY_THE_DEFAULT = new Set([
    'revert --no-edit', 'cherry-pick --no-edit', // there is no editor to skip
  ]);

  const stray = [];
  for (const [command, spec] of Object.entries(GIT_OPTION_SPECS)) {
    for (const flag of [...(spec.booleans || []), ...(spec.values || [])]) {
      const key = `${command} ${flag}`;
      if (HONOURED.has(key) || ALREADY_THE_DEFAULT.has(key)) continue;
      stray.push(key);
    }
    // A flag cannot be both accepted and refused.
    for (const flag of Object.keys(spec.unsupported || {})) {
      assert.ok(!(spec.booleans || []).includes(flag), `${command} ${flag} is both accepted and refused`);
      assert.ok(!(spec.values || []).includes(flag), `${command} ${flag} is both accepted and refused`);
      assert.ok(
        typeof spec.unsupported[flag] === 'string' && spec.unsupported[flag].length > 8,
        `${command} ${flag} needs a reason a reader can act on`
      );
    }
    // Every alias has to land on something the spec actually knows.
    for (const [alias, target] of Object.entries(spec.aliases || {})) {
      const known =
        (spec.booleans || []).includes(target) ||
        (spec.values || []).includes(target) ||
        Object.prototype.hasOwnProperty.call(spec.unsupported || {}, target);
      assert.ok(known, `${command}: alias ${alias} points at ${target}, which the spec does not define`);
    }
  }
  assert.deepEqual(stray, [], `these flags are parsed but nothing reads them: ${stray.join(', ')}`);
});

test('regression: advice never names the very thing that was refused', async () => {
  // "You are standing on main, so it cannot be deleted. Move away first, for
  // example git checkout main." - the suggestion was hard-coded, so it told the
  // reader to check out the branch they were already on.
  const shapes = [
    ['git commit; git branch feature', 'main'],
    ['git commit; git checkout -b feature', 'feature'],
    ['git commit; git checkout -b alpha; git checkout -b zeta; git branch -D main', 'zeta'],
    ['git commit; git branch a; git branch b; git checkout b', 'b'],
    ['git commit; git clone; git branch feature', 'main'],
  ];

  for (const [setup, current] of shapes) {
    const engine = await repo(setup);
    assert.equal(engine.currentBranch(), current, `setup put us on the wrong branch: ${setup}`);

    const result = await engine.run(`git branch -d ${current}`);
    assert.equal(result.ok, false);
    assert.match(result.error.text, /standing on/);

    const suggested = /git checkout (?:-b )?([^\s"]+)/.exec(result.error.text);
    assert.ok(suggested, `no way forward offered for: ${setup}`);
    assert.notEqual(suggested[1], current, `advice pointed back at "${current}" for: ${setup}`);

    // The advice has to be real: a named branch must exist and not be a remote.
    const branches = engine.exportTree().branches;
    assert.ok(branches[suggested[1]], `"${suggested[1]}" is not a branch that exists: ${setup}`);
    assert.ok(!suggested[1].startsWith('o/'), 'never send the reader to a remote-tracking branch');

    // And following it must actually unblock the delete.
    assert.equal((await engine.run(`git checkout ${suggested[1]}`)).ok, true);
    assert.equal((await engine.run(`git branch -D ${current}`)).ok, true);
  }
});

test('regression: the last-branch fallback still gives runnable advice', async () => {
  const engine = await repo('git commit');
  assert.deepEqual(Object.keys(engine.exportTree().branches), ['main']);

  const result = await engine.run('git branch -d main');
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error.text, /"git checkout main"/, 'must not point back at main');
  assert.match(result.error.text, /no other branch/);

  const suggested = /"(git checkout -b [^"]+)"/.exec(result.error.text);
  assert.ok(suggested, 'the fallback should still offer a way out');
  assert.equal((await engine.run(suggested[1])).ok, true, 'and it has to actually run');
  assert.equal((await engine.run('git branch -D main')).ok, true);

  // A root-only repo has no HEAD~1, so the fallback must not suggest one.
  const bare = await repo();
  const rootOnly = await bare.run('git branch -d main');
  assert.doesNotMatch(rootOnly.error.text, /HEAD~/, 'HEAD~1 does not exist on a root commit');
  const escape = /"(git checkout -b [^"]+)"/.exec(rootOnly.error.text);
  assert.equal((await bare.run(escape[1])).ok, true);
});

test('regression: detached-HEAD advice names a branch that exists', async () => {
  for (const [setup, forbidden] of [
    ['git commit; git clone; git checkout C1', null],
    ['git commit; git checkout -b work; git clone; git branch -D main; git checkout C1', 'main'],
  ]) {
    const engine = await repo(setup);
    const result = await engine.run('git push');
    assert.equal(result.ok, false);
    assert.match(result.error.text, /detached/);

    const suggested = /git checkout ([^\s"]+)/.exec(result.error.text);
    assert.ok(suggested, `no branch offered for: ${setup}`);
    if (forbidden) assert.notEqual(suggested[1], forbidden, 'named a branch that was deleted');
    assert.ok(engine.exportTree().branches[suggested[1]], `"${suggested[1]}" does not exist`);
    assert.equal((await engine.run(`git checkout ${suggested[1]}`)).ok, true);
  }

  // teammate-pushes names a branch the remote really has.
  const engine = await repo('git commit; git checkout -b work; git clone; git branch -D main; git checkout C1');
  const teammate = await engine.run('git teammate-pushes');
  assert.equal(teammate.ok, false);
  const named = /git teammate-pushes ([^\s"]+)/.exec(teammate.error.text);
  assert.ok(named);
  assert.ok(engine.exportTree().originTree.branches[named[1]], 'suggested a branch the remote does not have');
  assert.equal((await engine.run(`git teammate-pushes ${named[1]}`)).ok, true);
});

test('regression: checkout -b on the branch you are already on does not tell you to go there', async () => {
  const engine = await repo('git commit; git checkout -b feature');
  const onIt = await engine.run('git checkout -b feature');
  assert.equal(onIt.ok, false);
  assert.match(onIt.error.text, /already standing on/);
  assert.doesNotMatch(onIt.error.text, /"git checkout feature"/, 'do not send them where they already are');

  // From a different branch, pointing at it is the right advice.
  await engine.run('git checkout main');
  const elsewhere = await engine.run('git checkout -b feature');
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.error.text, /"git checkout feature"/);
  assert.equal((await engine.run('git checkout feature')).ok, true, 'and it works');
});

test('regression: suggested names in describe and pull are ones that will work', async () => {
  // "git tag v1 ..." would collide when v1 already exists somewhere unreachable.
  const tagged = await repo('git commit; git checkout -b other; git commit; git tag v1; git checkout main');
  const described = await tagged.run('git describe');
  assert.equal(described.ok, false);
  const tagCommand = /"(git tag [^"]+)"/.exec(described.error.text);
  assert.ok(tagCommand, 'describe should suggest making a tag');
  assert.doesNotMatch(tagCommand[1], /\bv1\b/, 'v1 is taken');
  assert.equal((await tagged.run(tagCommand[1])).ok, true, 'the suggested tag name has to be free');

  // "git pull origin solo" would fail when the remote has no branch "solo".
  const solo = await repo('git commit; git clone; git checkout -b solo');
  const pulled = await solo.run('git pull');
  assert.equal(pulled.ok, false);
  const pullCommand = /"(git pull [^"]+)"/.exec(pulled.error.text);
  assert.ok(pullCommand, 'pull should suggest a branch that exists on the remote');
  assert.doesNotMatch(pullCommand[1], /solo/, 'the remote has no "solo"');
  assert.equal((await solo.run(pullCommand[1])).ok, true);

  // With nothing on the remote at all, offer no command rather than a broken one.
  const empty = await repo('git commit; git clone; git checkout -b solo');
  empty.repo.origin.branches = {};
  const nothing = await empty.run('git pull');
  assert.equal(nothing.ok, false);
  assert.doesNotMatch(nothing.error.text, /"git pull origin/, 'no remote branch means no example');
  assert.match(nothing.error.text, /no branches/);
});

test('regression: the protected-push example is a destination the server accepts', async () => {
  const engine = await repo('git commit; git clone; git commit');
  engine.setProtectedRefs(['main', 'feature']);

  const result = await engine.run('git push');
  assert.equal(result.ok, false);
  const suggested = /"(git push origin [^"]+)"/.exec(result.error.text);
  assert.ok(suggested, 'the refusal should show a way to land the work');

  const destination = suggested[1].split(':').pop();
  assert.notEqual(destination, 'main', 'suggested the branch that was just refused');
  assert.equal(engine.isProtectedRef(destination), false, 'suggested another protected branch');
  assert.equal((await engine.run(suggested[1])).ok, true, 'and the suggestion has to work');
});

test('regression: push destinations are normalised and validated', async () => {
  // refs/heads/main IS main, so the long spelling must hit the same rule.
  for (const spelling of ['refs/heads/main', 'heads/main', 'main']) {
    const engine = await repo('git commit; git clone; git commit');
    engine.setProtectedRefs(['main']);
    const result = await engine.run(`git push origin main:${spelling}`);
    assert.equal(result.ok, false, `"${spelling}" walked past the protected branch`);
    assert.match(result.error.text, /refuses direct pushes to "main"/);
    assert.equal((await engine.run(`git push -f origin main:${spelling}`)).ok, false, 'and -f is no way round it');

    // The remote is exactly as it was - no literal "refs/heads/main" invented,
    // and the real main left where the clone put it.
    const origin = engine.exportTree().originTree;
    assert.deepEqual(Object.keys(origin.branches), ['main'], `"${spelling}" left something behind`);
    assert.equal(origin.branches.main.target, 'C1', `"${spelling}" moved the protected branch`);
  }

  // Names git itself would reject cannot be created on the remote either.
  const engine = await repo('git commit; git clone; git commit');
  for (const bad of ['./main', 'main/', '/main', 'a//b', 'x.lock', 'feature..bad', '@']) {
    const result = await engine.run(`git push origin main:${bad}`);
    assert.equal(result.ok, false, `"${bad}" was accepted as a remote branch name`);
    assert.equal(result.error.type, 'GitError');
    assert.deepEqual(Object.keys(engine.exportTree().originTree.branches), ['main'], `"${bad}" left something behind`);
  }

  // The long spelling still works when the destination is allowed.
  const ok = await engine.run('git push origin main:refs/heads/review');
  assert.equal(ok.ok, true, ok.error && ok.error.text);
  assert.equal(engine.exportTree().originTree.branches.review.target, 'C2', 'it should land on "review"');
  assert.ok(!engine.exportTree().originTree.branches['refs/heads/review']);
  assert.equal(engine.exportTree().branches['o/review'].target, 'C2');
});

test('regression: refspec normalisation strips every prefix, not just one', async () => {
  // One pass left "refs/heads/refs/heads/main" naming a branch literally called
  // "refs/heads/main" - a ref name no real repository would ever show.
  for (const spelling of [
    'refs/heads/refs/heads/main',
    'refs/heads/heads/main',
    'heads/heads/main',
    'heads/refs/heads/main',
    'refs/heads/refs/heads/refs/heads/main',
  ]) {
    const engine = await repo('git commit; git clone; git commit');
    const result = await engine.run(`git push origin main:${spelling}`);
    assert.equal(result.ok, true, `"${spelling}" failed: ${result.error && result.error.text}`);
    assert.deepEqual(
      Object.keys(engine.exportTree().originTree.branches),
      ['main'],
      `"${spelling}" invented a branch instead of naming main`
    );
    assert.equal(engine.exportTree().originTree.branches.main.target, 'C2');
    assert.deepEqual(Object.keys(engine.exportTree().branches).sort(), ['main', 'o/main']);

    // And the protected-ref rule sees through the same spelling.
    const guarded = await repo('git commit; git clone; git commit');
    guarded.setProtectedRefs(['main']);
    const refused = await guarded.run(`git push origin main:${spelling}`);
    assert.equal(refused.ok, false, `"${spelling}" walked past the protected branch`);
    assert.match(refused.error.text, /refuses direct pushes to "main"/);
  }
});

test('regression: branch and tag names follow git\'s own rules', async () => {
  const engine = await repo('git commit');

  for (const good of ['feature-2', 'ok_name', 'a.b', 'release/1.0', "C2'", '__proto__']) {
    const result = await engine.run(`git branch ${good}`);
    assert.equal(result.ok, true, `"${good}" should be allowed: ${result.error && result.error.text}`);
  }

  for (const bad of ['feature..bad', '.hidden', 'a@{b}', '@', 'a//b', 'trail/', '/lead', 'end.', 'x.lock']) {
    const result = await engine.run(`git branch ${bad}`);
    assert.equal(result.ok, false, `"${bad}" should be refused - git would refuse it`);
    assert.equal(result.error.type, 'GitError');
    assert.ok(!engine.exportTree().branches[bad], `"${bad}" was created anyway`);

    const tagged = await engine.run(`git tag ${bad}`);
    assert.equal(tagged.ok, false, `tag "${bad}" should be refused too`);
    assert.ok(!engine.exportTree().tags[bad]);
  }
});

test('regression: theme only reports success for a theme that exists', async () => {
  const engine = await repo();

  for (const name of ['day', 'dusk', 'DUSK']) {
    const result = await engine.run(`theme ${name}`);
    assert.equal(result.ok, true, `${name} should be accepted`);
    assert.equal(result.theme, name.toLowerCase());
  }

  for (const name of ['purple', 'midnight', '<script>']) {
    const result = await engine.run(`theme ${name}`);
    assert.equal(result.ok, false, `theme ${name} claimed success for a theme that does not exist`);
    assert.match(result.error.text, /day and dusk/);
    assert.equal(result.theme, undefined, 'a failed theme must not report a theme to apply');
  }
});

test('regression: git checkout --detach works and the error lists real spellings', async () => {
  const engine = await repo('git commit; git commit');

  const detached = await engine.run('git checkout --detach HEAD~1');
  assert.equal(detached.ok, true, detached.error && detached.error.text);
  assert.equal(engine.getSnapshot().HEAD.detached, true);
  assert.equal(engine.getSnapshot().HEAD.target, 'C1');

  // --detach from a branch name detaches rather than attaching.
  await engine.run('git checkout main');
  assert.equal((await engine.run('git checkout --detach main')).ok, true);
  assert.equal(engine.getSnapshot().HEAD.detached, true);

  const bad = await engine.run('git checkout --bogus main');
  assert.equal(bad.ok, false);
  assert.match(bad.error.text, /-b/);
  assert.doesNotMatch(bad.error.text, /--new-branch/, 'that is not a real git spelling');
  assert.doesNotMatch(bad.error.text, /--force-new-branch/);

  const badSwitch = await (await repo('git commit')).run('git switch --bogus main');
  assert.match(badSwitch.error.text, /-c/);
  assert.doesNotMatch(badSwitch.error.text, /--force-create/);
});

test('regression: teammate-pushes names itself the same way everywhere and reads counts', async () => {
  const engine = await repo('git commit; git clone');

  const negative = await engine.run('git teammate-pushes main -1');
  assert.equal(negative.ok, false);
  assert.match(negative.error.text, /between 1 and 20/, 'a negative count is a count, not an unknown option');
  assert.match(negative.error.text, /git teammate-pushes/, 'messages spell the command the way the help does');

  const zero = await engine.run('git teammate-pushes main 0');
  assert.equal(zero.ok, false);
  assert.match(zero.error.text, /between 1 and 20/);

  const typo = await engine.run('git teammate-push');
  assert.equal(typo.ok, false);
  assert.match(typo.error.text, /"git teammate-pushes"/, 'the suggestion should be typeable as printed');

  // Case does not matter here, just as it does not for any other subcommand.
  assert.equal((await engine.run('git teammate-pushes main 1')).ok, true);
  assert.equal((await engine.run('git Teammate-Pushes main 1')).ok, true);
});

test('regression: git switch --detach detaches even from a branch name', async () => {
  const engine = await repo('git commit; git commit; git branch f C1');
  const result = await engine.run('git switch --detach f');
  assert.equal(result.ok, true);
  assert.equal(engine.getSnapshot().HEAD.detached, true);
  assert.equal(graph(engine).HEAD, 'C1');
});

test('regression: a disabled rebase cannot be reached through pull --rebase', async () => {
  const engine = await repo('git commit; git clone; git teammate-pushes main 1; git commit');
  engine.setDisabledCommands(['git rebase']);
  const before = engine.exportTree();

  const direct = await engine.run('git rebase o/main');
  assert.equal(direct.ok, false);

  const sneaky = await engine.run('git pull --rebase');
  assert.equal(sneaky.ok, false, 'pull --rebase performed a rebase that the level had switched off');
  assert.match(sneaky.error.text, /git rebase/);
  assert.deepEqual(engine.exportTree(), before, 'and history was not rewritten');

  // A plain merge pull is still allowed.
  const allowed = await engine.run('git pull');
  assert.equal(allowed.ok, true, allowed.error && allowed.error.text);

  // Disabling merge closes the other half.
  const merging = await repo('git commit; git clone; git teammate-pushes main 1; git commit');
  merging.setDisabledCommands(['git merge']);
  const blocked = await merging.run('git pull');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error.text, /git merge/);
});

test('regression: push only records an upstream when asked with -u', async () => {
  const engine = await repo('git commit; git clone; git checkout -b feature; git commit; git checkout main');

  await engine.run('git push origin feature:other');
  assert.equal(
    engine.exportTree().branches.feature.remoteTrackingBranchID,
    null,
    'a plain refspec push must not adopt an upstream'
  );
  assert.equal(engine.exportTree().originTree.branches.other.target, 'C2', 'but it still pushed');

  await engine.run('git push -u origin feature:other');
  assert.equal(engine.exportTree().branches.feature.remoteTrackingBranchID, 'o/other');
});

test('regression: describe counts commits, not the shortest path', async () => {
  // v1 is one commit back down the short side of the merge and four back down
  // the long side. Real git reports the number of commits in v1..HEAD.
  const engine = await repo(
    'git commit; git tag v1; git commit; git commit; git commit; git checkout -b short v1; git commit; git checkout main; git merge short'
  );
  const tip = graph(engine).branches.main;
  assert.equal(graph(engine).commits[tip].length, 2, 'HEAD is a merge');

  const result = await engine.run('git describe');
  assert.equal(result.describe, `v1-5-g${tip}`, 'five commits sit between v1 and the merge');

  const linear = await repo('git commit; git tag v1; git commit; git commit');
  assert.equal((await linear.run('git describe')).describe, 'v1-2-gC3');
});

test('regression: git tag -f moves a tag, plain git tag still refuses', async () => {
  const engine = await repo('git commit; git commit; git tag v1');
  const refused = await engine.run('git tag v1 C1');
  assert.equal(refused.ok, false);
  assert.match(refused.error.text, /-f/);
  assert.equal(graph(engine).tags.v1, 'C2');

  const moved = await engine.run('git tag -f v1 C1');
  assert.equal(moved.ok, true);
  assert.equal(graph(engine).tags.v1, 'C1');
  assert.match(text(moved), /Moved tag/);
});

test('regression: checkout -B on an existing branch says it reset it', async () => {
  const engine = await repo('git commit; git commit; git branch f C1');
  const reset = await engine.run('git checkout -B f C2');
  assert.match(text(reset), /Reset branch/);
  assert.ok(!/new branch/.test(text(reset)));
  assert.equal(graph(engine).branches.f, 'C2');

  const made = await engine.run('git checkout -B brand C1');
  assert.match(text(made), /new branch/);
});

/* -------------------------------------------------------------------------- */
/* prototype safety                                                           */
/* -------------------------------------------------------------------------- */

/** Names that resolve to something on Object.prototype instead of a missing key. */
const DANGEROUS_NAMES = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];

/** Snapshot the prototypes we must never write through. */
function prototypeWitness() {
  const keys = ['target', 'id', 'parents', 'rootCommit', 'remoteTrackingBranchID', 'polluted'];
  const seen = {};
  for (const key of keys) {
    seen[`obj.${key}`] = ({})[key];
    seen[`arr.${key}`] = [][key];
    seen[`str.${key}`] = ''[key];
    seen[`date.${key}`] = new Date(0)[key];
  }
  // The value probes above only see a write that shadows one of those six keys
  // on one of those three objects. Listing own property names as well catches
  // the rest of the family: `Object.target` (a name that resolved to the Object
  // *function*), or a property parked on Object.prototype.toString because the
  // branch was called "toString".
  for (const [label, value] of [
    ['Object.prototype', Object.prototype],
    ['Object', Object],
    ['Array.prototype', Array.prototype],
    ['Function.prototype', Function.prototype],
    ['Object.prototype.toString', Object.prototype.toString],
    ['Object.prototype.valueOf', Object.prototype.valueOf],
    ['Object.prototype.hasOwnProperty', Object.prototype.hasOwnProperty],
    ['Object.prototype.isPrototypeOf', Object.prototype.isPrototypeOf],
  ]) {
    seen[`own:${label}`] = Object.getOwnPropertyNames(value).sort().join(',');
  }
  seen['proto:{}'] = Object.getPrototypeOf({}) === Object.prototype;
  return JSON.stringify(seen);
}

test('a branch named __proto__ is a real branch, not a write to Object.prototype', async () => {
  const clean = prototypeWitness();

  for (const name of DANGEROUS_NAMES) {
    const engine = await repo('git commit; git commit');
    const result = await engine.run(`git branch ${name}`);
    assert.equal(result.ok, true, `git branch ${name} failed: ${result.error && result.error.text}`);

    // The report has to be true: the branch must actually be there.
    const branches = engine.exportTree().branches;
    assert.ok(
      Object.prototype.hasOwnProperty.call(branches, name),
      `"${name}" was reported created but no branch exists`
    );
    assert.equal(branches[name].target, 'C2');
    assert.equal(engine.isBranch(name), true);
    assert.equal(engine.resolveRef(name), 'C2');
    assert.equal(prototypeWitness(), clean, `git branch ${name} wrote through a prototype`);

    // And it behaves like any other branch afterwards.
    assert.equal((await engine.run(`git checkout ${name}`)).ok, true);
    assert.equal(engine.getSnapshot().HEAD.detached, false, `HEAD went detached on "${name}"`);
    assert.equal(engine.currentBranch(), name);
    assert.match(text(await engine.run('git status')), new RegExp(`On branch ${name.replace(/[$^]/g, '\\$&')}`));
    assert.match(text(await engine.run('git status')), /HEAD is at C2/);

    assert.equal((await engine.run(`git checkout main`)).ok, true);
    assert.equal((await engine.run(`git branch -D ${name}`)).ok, true);
    assert.ok(!Object.prototype.hasOwnProperty.call(engine.exportTree().branches, name));
    assert.equal(prototypeWitness(), clean, `deleting "${name}" wrote through a prototype`);
  }
});

test('every name-taking command is prototype-safe', async () => {
  const clean = prototypeWitness();

  for (const name of DANGEROUS_NAMES) {
    const engine = await repo('git commit; git commit; git clone');

    for (const command of [
      `git checkout -b ${name}`,
      `git checkout -B ${name} C1`,
      `git switch -c ${name}-two`,
      `git branch -f ${name} C1`,
      `git tag ${name} C1`,
      `git tag -f ${name} C2`,
      `git push origin main:${name}`,
      `git teammate-pushes ${name}`,
      `git branch -d ${name}-two`,
      `git tag -d ${name}`,
    ]) {
      const result = await engine.run(command);
      assert.ok(
        result.ok || result.error.type === 'GitError' || result.error.type === 'CommandParseError',
        `${command} produced something other than a clean result`
      );
      assert.equal(prototypeWitness(), clean, `${command} wrote through a prototype`);
    }

    // A tag named __proto__ has to be findable and describable.
    const tags = engine.exportTree().tags;
    if (Object.prototype.hasOwnProperty.call(tags, name)) {
      assert.equal(engine.isTag(name), true);
      assert.ok(engine.resolveRef(name));
    }
    assert.equal(prototypeWitness(), clean);
  }

  // The imported-tree path takes names straight from JSON. Written as raw text
  // on purpose: `{ __proto__: ... }` in a JS literal sets the prototype instead
  // of creating the key, so a built object would not exercise this at all.
  const engine = await repo();
  const hostile =
    '{"commits":{"C0":{"id":"C0","parents":[]},"C1":{"id":"C1","parents":["C0"]}},' +
    '"branches":{"__proto__":{"id":"__proto__","target":"C1"},"main":{"id":"main","target":"C1"}},' +
    '"tags":{"constructor":{"id":"constructor","target":"C0"}},' +
    '"HEAD":{"id":"HEAD","target":"__proto__"}}';
  const imported = await engine.run(`import tree ${hostile}`);
  assert.equal(imported.ok, true, imported.error && imported.error.text);
  assert.equal(prototypeWitness(), clean, 'import tree wrote through a prototype');
  assert.equal(engine.currentBranch(), '__proto__');
  assert.equal(engine.getSnapshot().HEAD.detached, false);
});

test('regression: a cloned origin cannot make Object.prototype writable page-wide', async () => {
  // The exact repro. The cloned origin was the one repo in the app built from
  // raw object literals, and teammate-pushes checked its branches for truth
  // rather than for an own property - so this wrote Object.prototype.target and
  // every object on the page, arrays and Dates included, reported a target
  // until the page was reloaded.
  const clean = prototypeWitness();
  const engine = await repo('git clone');
  const result = await engine.run('git teammate-pushes __proto__ 1');

  assert.equal(({}).target, undefined, 'every object on the page now carries a target');
  assert.equal([].target, undefined);
  assert.equal(new Date(0).target, undefined);
  assert.equal(prototypeWitness(), clean);

  assert.equal(result.ok, false, 'the remote has no branch called "__proto__"');
  assert.equal(result.error.type, 'GitError');
  assert.match(result.error.text, /no branch called "__proto__"/);

  const other = await repo('git clone');
  const second = await other.run('git teammate-pushes constructor 2');
  assert.equal(second.ok, false, 'reported two commits on a branch origin does not have');
  assert.equal(Object.target, undefined, 'the write landed on the Object function');
  assert.equal(prototypeWitness(), clean);
  // The refusal has to match origin's own state, which is where the old message
  // and reality parted company.
  const originTree = other.exportTree().originTree;
  assert.deepEqual(Object.keys(originTree.branches), ['main']);
  assert.deepEqual(Object.keys(originTree.commits), ['C0']);
});

test('no command that takes a name writes through a prototype, cloned origin included', async () => {
  const clean = prototypeWitness();

  // Every route a name can reach a map by, run against a repo that HAS a
  // cloned origin - the provenance that used to behave differently from a
  // level-supplied one.
  const scripts = [
    (n) => [`git branch ${n}`, `git branch -f ${n} C1`, `git branch -d ${n}`],
    (n) => [`git checkout -b ${n}`, 'git checkout main', `git checkout -B ${n} C1`, `git branch -D ${n}`],
    (n) => [`git switch -c ${n}`, 'git switch main', `git branch -D ${n}`],
    (n) => [`git tag ${n}`, `git tag -f ${n} C1`, `git describe ${n}`, `git tag -d ${n}`],
    (n) => [`git teammate-pushes ${n} 2`, `git fetch origin ${n}`, `git pull ${n}`, `git pull --rebase ${n}`],
    (n) => [`git push origin main:${n}`, `git fetch origin ${n}`, `git teammate-pushes ${n} 1`, `git pull origin ${n}`],
    (n) => [`git merge ${n}`, `git rebase ${n}`, `git cherry-pick ${n}`, `git revert ${n}`, `git reset ${n}`, `git log ${n}`, `git show ${n}`, `git checkout ${n}`],
    (n) => [`git branch ${n} C1`, `git push origin ${n}:${n}`, `git teammate-pushes ${n} 1`, `git fetch origin ${n}`, `git pull origin ${n}`, `git branch -D ${n}`],
  ];

  for (const name of DANGEROUS_NAMES) {
    for (const build of scripts) {
      const engine = await repo('git commit; git commit; git clone');
      for (const command of build(name)) {
        const result = await engine.run(command);
        assert.ok(
          result.ok || result.error.type === 'GitError' || result.error.type === 'CommandParseError',
          `${command} produced something other than a clean result`
        );
        assert.equal(prototypeWitness(), clean, `${command} wrote through a prototype`);
        assert.equal(isValidTree(engine.exportTree()), true, `${command} left a tree that no longer validates`);
      }
    }
  }
});

test('git push creates a new remote branch whatever the branch is called', async () => {
  // "git push origin main:constructor" used to be refused with
  // `"constructor" on the remote is at undefined, which is not in your
  // history`, while "main:feature" in the identical repo simply worked.
  for (const name of [...DANGEROUS_NAMES, 'feature']) {
    const engine = await repo('git commit; git clone; git commit');
    const result = await engine.run(`git push origin main:${name}`);
    assert.equal(result.ok, true, `git push origin main:${name} failed: ${result.error && result.error.text}`);
    assert.match(text(result), new RegExp(`origin/${name.replace(/[$^]/g, '\\$&')}`));

    const tree = engine.exportTree();
    assert.ok(
      Object.prototype.hasOwnProperty.call(tree.originTree.branches, name),
      `"${name}" was reported pushed but the remote has no such branch`
    );
    assert.equal(tree.originTree.branches[name].target, 'C2');
    assert.ok(Object.prototype.hasOwnProperty.call(tree.branches, `o/${name}`));
    assert.equal(tree.branches[`o/${name}`].target, 'C2');
    assert.equal(isValidTree(tree), true);

    // And it is an ordinary branch afterwards: a second push moves it.
    assert.equal((await engine.run('git commit')).ok, true);
    assert.equal((await engine.run(`git push origin main:${name}`)).ok, true);
    assert.equal(engine.exportTree().originTree.branches[name].target, 'C3');
  }
});

test('git fetch refuses a remote ref that is not there, whatever it is called', async () => {
  // "git fetch origin constructor" returned ok, said "Updated o/constructor ->
  // undefined", and left a local branch pointing at nothing.
  for (const name of DANGEROUS_NAMES) {
    const engine = await repo('git commit; git clone');
    const result = await engine.run(`git fetch origin ${name}`);
    assert.equal(result.ok, false, `git fetch origin ${name} reported success`);
    assert.equal(result.error.type, 'GitError');
    assert.match(result.error.text, /no branch called/);
    assert.doesNotMatch(text(result), /undefined/);

    const tree = engine.exportTree();
    assert.equal(Object.prototype.hasOwnProperty.call(tree.branches, `o/${name}`), false);
    assert.equal(isValidTree(tree), true, 'a failed fetch must not leave a broken tree');

    // pull --rebase took the same route and rewrote main onto a base that did
    // not exist, which is worse than a wrong message.
    const pulled = await engine.run(`git pull --rebase ${name}`);
    assert.equal(pulled.ok, false);
    assert.equal(graph(engine).branches.main, 'C1', 'a failed pull must leave main where it was');
    assert.equal(isValidTree(engine.exportTree()), true);
  }
});

test('git <prototype-member> is an unknown command, not a raw TypeError', async () => {
  // gitSpecs['constructor'] resolved to Object, so new Set(spec.values) got
  // Object.values and threw "function is not iterable" at the reader.
  const engine = await repo();
  for (const name of DANGEROUS_NAMES) {
    const result = await engine.run(`git ${name}`);
    assert.equal(result.ok, false, `git ${name} was accepted`);
    assert.equal(result.error.type, 'CommandParseError');
    assert.match(result.error.text, /is not a command this app knows/);
    assert.doesNotMatch(result.error.text, /iterable|Symbol|wired up yet/);
    assert.match(result.error.text, /show commands/);
  }
  // The real commands still resolve, including through the same lookup.
  assert.equal((await engine.run('git status')).ok, true);
  assert.equal((await engine.run('git Status')).ok, true);
});

test('a polluted prototype cannot hijack the interactive rebase handshake', async () => {
  const engine = await repo('git commit; git commit; git checkout -b t C1; git commit');
  const request = await engine.run('git rebase -i main t');
  assert.equal(request.ok, true);
  assert.deepEqual(request.interactive.commits, ['C3']);

  // Simulate the exact corruption chain: a stray Object.prototype.target must
  // not stand in for the pending request's real target.
  Object.prototype.target = 'C1';
  try {
    const done = engine.applyInteractiveRebase(['C3']);
    assert.equal(done.ok, true, done.error && done.error.text);
    assert.equal(engine.exportTree().branches.t.target, "C3'", 'the replay used a prototype value as its target');
    assert.deepEqual(engine.exportTree().commits["C3'"].parents, ['C2']);
  } finally {
    delete Object.prototype.target;
  }
});

/* -------------------------------------------------------------------------- */
/* protected refs                                                             */
/* -------------------------------------------------------------------------- */

test('a protected remote branch refuses a direct push', async () => {
  const engine = await repo('git commit; git clone; git commit');
  engine.setProtectedRefs(['main']);
  assert.deepEqual(engine.protectedRefs, ['main']);

  const result = await engine.run('git push');
  assert.equal(result.ok, false);
  assert.equal(result.error.type, 'GitError');
  assert.match(result.error.text, /refuses direct pushes to "main"/);
  assert.match(result.error.text, /another branch/);

  // The destination is what is protected, whatever route you take to it.
  assert.equal((await engine.run('git push origin main:main')).ok, false);
  assert.equal((await engine.run('git push origin HEAD:main')).ok, false);
  assert.equal((await engine.run('git push -u origin main:main')).ok, false);
});

test('force is not an escape hatch from a protected branch', async () => {
  const engine = await repo('git commit; git clone; git commit');
  engine.setProtectedRefs(['main']);

  for (const input of ['git push -f', 'git push --force', 'git push -f origin main:main']) {
    const result = await engine.run(input);
    assert.equal(result.ok, false, `${input} got through`);
    assert.match(result.error.text, /refuses direct pushes/);

    // The explanation has to be true of real git: --force marks the update it
    // SENDS as forced, asking the server to accept a history that does not
    // build on what it holds. The server still decides.
    assert.match(result.error.text, /marks the update as forced/, `${input} should say what force actually does`);
    assert.match(result.error.text, /server still decides/, `${input} should say who refuses`);
    assert.doesNotMatch(
      result.error.text,
      /only tells your side|your side to stop being careful/,
      `${input} repeats the claim that force is purely local, which is wrong`
    );
  }
});

test('messages that explain git are true of real git, not just of this model', async () => {
  // The lessons quote these back at the reader, so a wrong one propagates.
  const engine = await repo('git commit; git commit');

  const reset = await engine.run('git reset --hard HEAD~1');
  assert.match(text(reset), /staged changes and your working tree/, 'reset modes are about the index and worktree');
  assert.doesNotMatch(text(reset), /only matters when there are files on disk/);

  // "recursive" has not been git's default merge strategy since 2.34 (it is
  // "ort"), so the message must not name a strategy at all.
  const merged = await repo('git commit; git checkout -b f; git commit; git checkout main; git commit');
  const mergeText = text(await merged.run('git merge f'));
  assert.match(mergeText, /two parents/);
  assert.doesNotMatch(mergeText, /recursive|ort strategy/, 'do not name a version-dependent merge strategy');

  // Rebase drops merges by default, but --rebase-merges exists, so say so.
  const flat = await repo(
    'git commit; git checkout -b dev C0; git commit; git merge main; git checkout -b base C0; git commit; git checkout dev'
  );
  const flatText = text(await flat.run('git rebase base'));
  assert.match(flatText, /by default/, 'flattening merges is the default, not the only behaviour');

  // Fetch does leave local branches alone in normal use, but a refspec can
  // update one, so avoid an absolute "never".
  const fetched = await repo('git commit; git clone; git teammate-pushes main 1');
  const fetchText = text(await fetched.run('git fetch'));
  assert.match(fetchText, /leaves your own branches alone/);
  assert.doesNotMatch(fetchText, /never touches/);

  // "o/" is this model's shorthand; real git writes "origin/".
  const remote = await repo('git commit; git clone');
  const refused = await remote.run('git branch o/thing');
  assert.match(refused.error.text, /this model/i, 'the o\/ convention belongs to this model, not to git');
  assert.match(refused.error.text, /origin\//, 'and it should point at what real git calls it');
});

test('a refused push leaves absolutely nothing behind', async () => {
  const engine = await repo('git commit; git clone; git commit');
  engine.setProtectedRefs(['main']);
  const before = engine.exportTree();
  const depth = engine.commandStack.length;

  for (const input of ['git push', 'git push -f', 'git push origin main:main']) {
    const result = await engine.run(input);
    assert.equal(result.ok, false);
    assert.deepEqual(result.frames, [], `${input} drew something it should not have`);
    assert.deepEqual(engine.exportTree(), before, `${input} changed the tree`);
    assert.equal(engine.commandStack.length, depth, `${input} landed on the undo stack`);
  }
  assert.equal(engine.undo(), true, 'the last real command is still what undo steps back to');
  assert.equal(Object.keys(engine.exportTree().commits).length, 2);
});

test('protection only covers the branch it names - the solution path still works', async () => {
  const engine = await repo('git commit; git clone; git checkout -b feature; git commit');
  engine.setProtectedRefs(['main']);

  const pushed = await engine.run('git push -u origin feature');
  assert.equal(pushed.ok, true, pushed.error && pushed.error.text);
  const tree = engine.exportTree();
  assert.equal(tree.originTree.branches.feature.target, 'C2');
  assert.equal(tree.branches['o/feature'].target, 'C2');
  assert.equal(tree.branches.feature.remoteTrackingBranchID, 'o/feature');

  // Pushing local main somewhere that is not the protected name is fine too.
  assert.equal((await engine.run('git push origin main:review')).ok, true);
  assert.equal(engine.exportTree().originTree.branches.review.target, 'C1');
});

test('protection does not touch fetch, pull or the remote itself', async () => {
  const engine = await repo('git commit; git clone');
  engine.setProtectedRefs(['main']);

  // A teammate landing on main is a server-side event, not the reader pushing.
  assert.equal((await engine.run('git teammate-pushes main 2')).ok, true);
  assert.equal(engine.exportTree().originTree.branches.main.target, 'C3');

  assert.equal((await engine.run('git fetch')).ok, true);
  assert.equal(engine.exportTree().branches['o/main'].target, 'C3');

  const pulled = await engine.run('git pull');
  assert.equal(pulled.ok, true, pulled.error && pulled.error.text);
  assert.equal(engine.exportTree().branches.main.target, 'C3');

  // But pushing to it is still refused.
  await engine.run('git commit');
  assert.equal((await engine.run('git push')).ok, false);
});

test('clearing the protected list restores an ordinary push', async () => {
  const engine = await repo('git commit; git clone; git commit');

  engine.setProtectedRefs(['main']);
  assert.equal((await engine.run('git push')).ok, false);

  engine.setProtectedRefs([]);
  assert.deepEqual(engine.protectedRefs, []);
  const result = await engine.run('git push');
  assert.equal(result.ok, true, result.error && result.error.text);
  assert.equal(engine.exportTree().originTree.branches.main.target, 'C2');
});

test('setProtectedRefs is forgiving about input and survives reset', async () => {
  // The clone has to be part of the baseline, or reset() would drop the remote
  // and later pushes would fail for a completely unrelated reason.
  const engine = await repo('git commit; git clone');
  engine.loadTree(engine.exportTree());
  await engine.run('git commit');

  engine.setProtectedRefs(['o/main']);
  assert.deepEqual(engine.protectedRefs, ['main'], 'an o/ prefix means the same branch');
  assert.equal(engine.isProtectedRef('main'), true);
  assert.equal(engine.isProtectedRef('o/main'), true);
  assert.equal(engine.isProtectedRef('feature'), false);
  assert.match((await engine.run('git push')).error.text, /refuses direct pushes/);

  // It is a level setting, so it outlives reset the way disabledCommands does.
  engine.reset();
  const afterReset = await engine.run('git commit; git push');
  assert.equal(afterReset.ok, false);
  assert.match(afterReset.error.text, /refuses direct pushes/, 'and it is still the protection refusing');

  for (const junk of [null, undefined, 'main', 42, [''], [null], [{}]]) {
    engine.setProtectedRefs(junk);
    assert.ok(Array.isArray(engine.protectedRefs), `setProtectedRefs(${JSON.stringify(junk)}) broke the list`);
    assert.deepEqual(engine.protectedRefs, [], `setProtectedRefs(${JSON.stringify(junk)}) invented an entry`);
  }
  const freed = await engine.run('git push');
  assert.equal(freed.ok, true, `junk should leave nothing protected: ${freed.error && freed.error.text}`);
});

/* -------------------------------------------------------------------------- */
/* teammate-pushes                                                            */
/* -------------------------------------------------------------------------- */

test('git teammate-pushes moves the remote and nothing else', async () => {
  const engine = await repo('git commit; git clone');
  const result = await engine.run('git teammate-pushes');
  assert.equal(result.ok, true, result.error && result.error.text);
  assert.equal(result.commandName, 'teammate-pushes');
  assert.equal(result.frames.length, 1, 'one frame per commit created');

  const tree = engine.exportTree();
  assert.equal(tree.originTree.branches.main.target, 'C2', 'the remote moved');
  assert.equal(tree.branches.main.target, 'C1', 'the local branch did not');
  assert.equal(tree.branches['o/main'].target, 'C1', 'and o/main is deliberately stale');
  assert.equal(tree.commits.C2, undefined, 'the new commit is not local yet');
  assert.match(text(result), /will not move until you run "git fetch"/);
});

test('git teammate-pushes drives the whole fetch-then-pull lesson', async () => {
  const engine = await repo('git commit; git clone');
  await engine.run('git teammate-pushes main 2');
  assert.equal(engine.exportTree().originTree.branches.main.target, 'C3');

  // Until you fetch, git has no idea anything happened - that is the lesson.
  assert.match(text(await engine.run('git status')), /up to date with "o\/main"/);

  const fetched = await engine.run('git fetch');
  assert.equal(fetched.ok, true);
  assert.equal(engine.exportTree().branches['o/main'].target, 'C3', 'only now does o/main catch up');
  assert.equal(engine.exportTree().branches.main.target, 'C1', 'fetch still leaves main alone');
  assert.match(text(await engine.run('git status')), /behind "o\/main" by 2 commits/);

  const pulled = await engine.run('git pull');
  assert.equal(pulled.ok, true);
  assert.equal(engine.exportTree().branches.main.target, 'C3');
});

test('git teammate-pushes can create a genuine divergence', async () => {
  const engine = await repo('git commit; git clone');
  await engine.run('git teammate-pushes main 1');
  await engine.run('git commit');

  const rejected = await engine.run('git push');
  assert.equal(rejected.ok, false, 'the remote has work we do not have');
  assert.match(rejected.error.text, /rejected/i);

  const pulled = await engine.run('git pull');
  assert.equal(pulled.ok, true);
  const state = graph(engine);
  assert.equal(state.commits[state.branches.main].length, 2, 'the pull produced a real merge');

  assert.equal((await engine.run('git push')).ok, true, 'and now the push lands');
});

test('git teammate-pushes argument handling', async () => {
  const engine = await repo('git commit; git clone; git checkout -b feature; git commit; git push -u origin feature');

  const named = await engine.run('git teammate-pushes origin main 2');
  assert.equal(named.ok, true, named.error && named.error.text);
  assert.equal(named.frames.length, 2);
  assert.equal(engine.exportTree().originTree.branches.main.target, 'C4');

  // With no branch given it follows the current branch's upstream.
  const implied = await engine.run('git teammate-pushes');
  assert.equal(implied.ok, true);
  assert.equal(engine.exportTree().originTree.branches.feature.target, 'C5');

  const missing = await engine.run('git teammate-pushes ghost');
  assert.equal(missing.ok, false);
  assert.match(missing.error.text, /no branch called "ghost"/);

  const tooMany = await engine.run('git teammate-pushes main 99');
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error.text, /between 1 and 20/);

  const noRemote = await repo('git commit');
  const orphan = await noRemote.run('git teammate-pushes');
  assert.equal(orphan.ok, false);
  assert.match(orphan.error.text, /no remote/i);

  const detached = await repo('git commit; git clone; git checkout C1');
  const lost = await detached.run('git teammate-pushes');
  assert.equal(lost.ok, false);
  assert.match(lost.error.text, /detached/);
});

/* -------------------------------------------------------------------------- */
/* fuzz                                                                       */
/* -------------------------------------------------------------------------- */

test('malformed command forms are reported, never thrown', async () => {
  const engine = await repo('git commit; git checkout -b feature; git commit; git clone');

  const verbs = [
    'commit',
    'branch',
    'checkout',
    'switch',
    'merge',
    'rebase',
    'reset',
    'revert',
    'cherry-pick',
    'tag',
    'describe',
    'log',
    'status',
    'show',
    'fetch',
    'pull',
    'push',
    'clone',
    'nonsense',
    'commmit',
    '',
  ];
  const tails = [
    '',
    '-x',
    '--nonsense',
    '--onto',
    '-m',
    '-m ""',
    '"',
    "'",
    '--',
    '- -',
    'main',
    'main main main',
    'ghost',
    'HEAD~99',
    'HEAD^9',
    "C2'",
    'main:feature',
    ':',
    'origin',
    'origin :',
    '--force --delete',
    '-d -D -f',
    '~^~^',
    '-1',
    '0',
  ];

  let seed = 987654321;
  const nextInt = (max) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % max;
  };

  const inputs = [];
  for (const verb of verbs) {
    for (const tail of tails) inputs.push(`git ${verb} ${tail}`.trim());
  }
  for (let i = 0; i < 120; i++) {
    const verb = verbs[nextInt(verbs.length)];
    const tail = tails[nextInt(tails.length)];
    const prefix = nextInt(3) === 0 ? '' : 'git ';
    const joiner = nextInt(4) === 0 ? '; ' : ' ';
    inputs.push(`${prefix}${verb}${joiner}${tail}`);
  }

  assert.ok(inputs.length > 200, `expected a 200+ case corpus, got ${inputs.length}`);

  const before = engine.exportTree();
  const depth = engine.commandStack.length;
  let reported = 0;
  for (const input of inputs) {
    let result;
    try {
      result = await engine.run(input);
    } catch (err) {
      assert.fail(`run(${JSON.stringify(input)}) threw: ${err && err.message}`);
    }
    assert.equal(typeof result.ok, 'boolean');
    assert.ok(Array.isArray(result.frames));
    assert.ok(Array.isArray(result.messages));
    if (!result.ok) {
      reported++;
      assert.ok(result.error.text.length > 10, `unhelpful error for ${input}`);
      assert.ok(!/\n\s+at /.test(result.error.text));
    }
  }
  assert.ok(reported > 150, `most of the corpus should be rejected cleanly (got ${reported})`);

  // Undo everything the corpus managed to do and the repo is exactly as it was.
  while (engine.commandStack.length > depth) assert.equal(engine.undo(), true);
  assert.deepEqual(engine.exportTree(), before);
});
