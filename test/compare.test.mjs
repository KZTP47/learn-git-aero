// Goal checking: every mode says yes to a correct solution and no to the
// near-misses that look right at a glance.

import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalise, compareTrees, normaliseId } from '../js/git/compare.js';
import { GitEngine } from '../js/git/engine.js';

const MODES = [
  'main',
  'allBranches',
  'allBranchesHashAgnostic',
  'allBranchesAndTags',
  'allBranchesAndTagsHashAgnostic',
  'tagsOnly',
  'withOrigin',
];

/**
 * Tiny tree builder. `commits` is `{ id: [parents] }`, `branches` and `tags`
 * are `{ name: commitId }`.
 */
function tree({ commits, branches = {}, tags = {}, HEAD = 'main', originTree }) {
  const out = { commits: {}, branches: {}, tags: {}, HEAD: { id: 'HEAD', target: HEAD } };
  for (const [id, parents] of Object.entries(commits)) {
    out.commits[id] = parents.length ? { id, parents } : { id, parents: [], rootCommit: true };
  }
  for (const [name, target] of Object.entries(branches)) {
    out.branches[name] = { id: name, target, remoteTrackingBranchID: null };
  }
  for (const [name, target] of Object.entries(tags)) out.tags[name] = { id: name, target };
  if (originTree) out.originTree = originTree;
  return out;
}

const LINEAR = () =>
  tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'] },
    branches: { main: 'C3' },
  });

const run = async (script, start) => {
  const engine = new GitEngine(start);
  const result = await engine.run(script);
  assert.equal(result.ok, true, `script failed: ${result.error && result.error.text}`);
  return engine;
};

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/* -------------------------------------------------------------------------- */

test('normaliseId strips every apostrophe form', () => {
  assert.equal(normaliseId('C2'), 'C2');
  assert.equal(normaliseId("C2'"), 'C2');
  assert.equal(normaliseId("C2'''"), 'C2');
  assert.equal(normaliseId("C2'^4"), 'C2');
  assert.equal(normaliseId("C12'^17"), 'C12');
});

test('a tree matches itself in every mode', () => {
  const value = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'] },
    branches: { main: 'C2', feature: 'C1' },
    tags: { v1: 'C1' },
    originTree: tree({ commits: { C0: [], C1: ['C0'] }, branches: { main: 'C1' } }),
  });
  for (const mode of MODES) {
    assert.equal(compareTrees(value, structuredClone(value), mode), true, `${mode} should match`);
  }
});

test('an unknown mode falls back to the hash-agnostic branch comparison', () => {
  const a = tree({ commits: { C0: [], C1: ['C0'] }, branches: { main: 'C1' } });
  const b = tree({ commits: { C0: [], "C1'": ['C0'] }, branches: { main: "C1'" } });
  assert.equal(compareTrees(a, b, 'nonsense-mode'), true);
  assert.equal(compareTrees(a, b), true, 'and the default is the same');
  assert.equal(compareTrees(a, b, 'allBranches'), false);
});

/* --- mode: main ----------------------------------------------------------- */

test('mode "main" ignores every other branch', () => {
  const goal = tree({ commits: { C0: [], C1: ['C0'], C2: ['C1'] }, branches: { main: 'C2' } });
  const extra = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'], C9: ['C1'] },
    branches: { main: 'C2', sideshow: 'C9' },
    tags: { v1: 'C0' },
  });
  assert.equal(compareTrees(extra, goal, 'main'), true);
  assert.equal(compareTrees(extra, goal, 'allBranches'), false, 'but allBranches notices');
});

test('mode "main" fails when main sits somewhere else or has different history', () => {
  const goal = tree({ commits: { C0: [], C1: ['C0'], C2: ['C1'] }, branches: { main: 'C2' } });
  const short = tree({ commits: { C0: [], C1: ['C0'] }, branches: { main: 'C1' } });
  const reparented = tree({ commits: { C0: [], C1: ['C0'], C2: ['C0'] }, branches: { main: 'C2' } });

  assert.equal(compareTrees(short, goal, 'main'), false);
  assert.equal(compareTrees(reparented, goal, 'main'), false, 'same ids, different shape');
  assert.equal(compareTrees(tree({ commits: { C0: [] }, branches: { other: 'C0' }, HEAD: 'other' }), goal, 'main'), false);
});

/* --- mode: allBranches ---------------------------------------------------- */

test('mode "allBranches" compares ids exactly', () => {
  const goal = tree({ commits: { C0: [], C1: ['C0'], C2: ['C1'] }, branches: { main: 'C2' } });
  const rewritten = tree({ commits: { C0: [], C1: ['C0'], "C2'": ['C1'] }, branches: { main: "C2'" } });

  assert.equal(compareTrees(rewritten, goal, 'allBranches'), false);
  assert.equal(compareTrees(rewritten, goal, 'allBranchesHashAgnostic'), true);
});

test('mode "allBranches" notices a missing, extra or misplaced branch', () => {
  const goal = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'] },
    branches: { main: 'C2', feature: 'C1' },
  });
  const missing = tree({ commits: { C0: [], C1: ['C0'], C2: ['C1'] }, branches: { main: 'C2' } });
  const extra = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'] },
    branches: { main: 'C2', feature: 'C1', spare: 'C0' },
  });
  const moved = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'] },
    branches: { main: 'C2', feature: 'C0' },
  });
  const renamed = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'] },
    branches: { main: 'C2', bugfix: 'C1' },
  });

  for (const [label, candidate] of [['missing', missing], ['extra', extra], ['moved', moved], ['renamed', renamed]]) {
    assert.equal(compareTrees(candidate, goal, 'allBranches'), false, `${label} should not match`);
    assert.equal(compareTrees(candidate, goal, 'allBranchesHashAgnostic'), false, `${label} is not a hash problem`);
  }
});

/* --- mode: allBranchesHashAgnostic --------------------------------------- */

test('hash-agnostic mode accepts any apostrophe depth', () => {
  const goal = tree({ commits: { C0: [], C1: ['C0'], C2: ['C1'] }, branches: { main: 'C2' } });
  for (const id of ["C2'", "C2''", "C2'''", "C2'^4"]) {
    const candidate = tree({ commits: { C0: [], C1: ['C0'], [id]: ['C1'] }, branches: { main: id } });
    assert.equal(compareTrees(candidate, goal, 'allBranchesHashAgnostic'), true, `${id} should normalise to C2`);
  }
});

test('hash-agnostic mode still tells topologies apart', () => {
  const goal = tree({ commits: { C0: [], C1: ['C0'], C2: ['C1'] }, branches: { main: 'C2' } });

  const shortcut = tree({ commits: { C0: [], C1: ['C0'], "C2'": ['C0'] }, branches: { main: "C2'" } });
  assert.equal(compareTrees(shortcut, goal, 'allBranchesHashAgnostic'), false, 'C2 hanging off C0 is a different tree');

  const merged = tree({
    commits: { C0: [], C1: ['C0'], C9: ['C0'], "C2'": ['C1', 'C9'] },
    branches: { main: "C2'" },
  });
  assert.equal(compareTrees(merged, goal, 'allBranchesHashAgnostic'), false, 'an extra parent is a different tree');

  const deeper = tree({
    commits: { C0: [], C1: ['C0'], C8: ['C1'], "C2'": ['C8'] },
    branches: { main: "C2'" },
  });
  assert.equal(compareTrees(deeper, goal, 'allBranchesHashAgnostic'), false, 'an extra commit in between counts');
});

test('hash-agnostic mode copes with a commit and its copy living side by side', () => {
  // side keeps the original C2; main carries a cherry-picked copy of it.
  const goal = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'], "C2'": ['C1'] },
    branches: { main: "C2'", side: 'C2' },
  });
  const same = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'], "C2''": ['C1'] },
    branches: { main: "C2''", side: 'C2' },
  });
  assert.equal(compareTrees(same, goal, 'allBranchesHashAgnostic'), true);

  const stacked = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'], "C2'": ['C2'] },
    branches: { main: "C2'", side: 'C2' },
  });
  assert.equal(
    compareTrees(stacked, goal, 'allBranchesHashAgnostic'),
    false,
    'the copy sitting on top of the original is a different shape'
  );
});

test('hash-agnostic mode is not fooled by a merge parent order swap alone', () => {
  const a = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C0'], C3: ['C1', 'C2'] },
    branches: { main: 'C3' },
  });
  const b = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C0'], C3: ['C2', 'C1'] },
    branches: { main: 'C3' },
  });
  // Parents are compared as a set: the shape is the same, only the order git
  // would report for ^1 / ^2 differs, which a level goal should not hinge on.
  assert.equal(compareTrees(a, b, 'allBranchesHashAgnostic'), true);

  const different = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C1', 'C2'] },
    branches: { main: 'C3' },
  });
  assert.equal(compareTrees(a, different, 'allBranchesHashAgnostic'), false);
});

/* --- modes: tags ---------------------------------------------------------- */

test('mode "allBranchesAndTags" adds tags to the branch comparison', () => {
  const goal = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'] },
    branches: { main: 'C2' },
    tags: { v1: 'C1' },
  });
  const same = structuredClone(goal);
  const noTag = tree({ commits: { C0: [], C1: ['C0'], C2: ['C1'] }, branches: { main: 'C2' } });
  const movedTag = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'] },
    branches: { main: 'C2' },
    tags: { v1: 'C2' },
  });
  const renamedTag = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'] },
    branches: { main: 'C2' },
    tags: { v2: 'C1' },
  });

  assert.equal(compareTrees(same, goal, 'allBranchesAndTags'), true);
  assert.equal(compareTrees(noTag, goal, 'allBranchesAndTags'), false);
  assert.equal(compareTrees(movedTag, goal, 'allBranchesAndTags'), false);
  assert.equal(compareTrees(renamedTag, goal, 'allBranchesAndTags'), false);
  assert.equal(compareTrees(noTag, goal, 'allBranches'), true, 'allBranches ignores tags');
});

test('mode "tagsOnly" looks at tags and nothing else', () => {
  const goal = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'] },
    branches: { main: 'C2' },
    tags: { v1: 'C1' },
  });
  const otherBranches = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'], C7: ['C1'] },
    branches: { main: 'C2', wildcard: 'C7' },
    tags: { v1: 'C1' },
  });
  const otherTag = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'] },
    branches: { main: 'C2' },
    tags: { v1: 'C2' },
  });

  assert.equal(compareTrees(otherBranches, goal, 'tagsOnly'), true);
  assert.equal(compareTrees(otherTag, goal, 'tagsOnly'), false);
  assert.equal(compareTrees(otherBranches, goal, 'allBranches'), false);
});

test('the hash-agnostic tag mode normalises ids too', () => {
  const goal = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'] },
    branches: { main: 'C2' },
    tags: { v1: 'C2' },
  });
  const rewritten = tree({
    commits: { C0: [], C1: ['C0'], "C2''": ['C1'] },
    branches: { main: "C2''" },
    tags: { v1: "C2''" },
  });
  assert.equal(compareTrees(rewritten, goal, 'allBranchesAndTagsHashAgnostic'), true);
  assert.equal(compareTrees(rewritten, goal, 'allBranchesAndTags'), false);
});

/* --- mode: withOrigin ----------------------------------------------------- */

test('mode "withOrigin" compares both repositories', async () => {
  const solved = await run('git commit; git clone; git commit; git push');
  const goal = solved.exportTree();

  const same = await run('git commit; git clone; git commit; git push');
  assert.equal(compareTrees(same.getSnapshot(), goal, 'withOrigin'), true);

  const notPushed = await run('git commit; git clone; git commit');
  assert.equal(compareTrees(notPushed.getSnapshot(), goal, 'withOrigin'), false, 'origin is behind');
  assert.equal(
    compareTrees(notPushed.getSnapshot(), goal, 'allBranchesHashAgnostic'),
    false,
    'and o/main gives it away locally too'
  );

  const noRemote = await run('git commit; git commit');
  assert.equal(compareTrees(noRemote.getSnapshot(), goal, 'withOrigin'), false);
  assert.equal(compareTrees(goal, noRemote.getSnapshot(), 'withOrigin'), false, 'and the other way round');
});

test('mode "withOrigin" catches a remote that differs only on the far side', () => {
  const local = { commits: { C0: [], C1: ['C0'] }, branches: { main: 'C1', 'o/main': 'C1' } };
  const goal = tree({
    ...local,
    originTree: tree({ commits: { C0: [], C1: ['C0'] }, branches: { main: 'C1' } }),
  });
  const aheadRemote = tree({
    ...local,
    originTree: tree({ commits: { C0: [], C1: ['C0'], C2: ['C1'] }, branches: { main: 'C2' } }),
  });
  const extraRemoteBranch = tree({
    ...local,
    originTree: tree({ commits: { C0: [], C1: ['C0'] }, branches: { main: 'C1', spare: 'C0' } }),
  });

  assert.equal(compareTrees(aheadRemote, goal, 'withOrigin'), false);
  assert.equal(compareTrees(extraRemoteBranch, goal, 'withOrigin'), false);
  assert.equal(compareTrees(aheadRemote, goal, 'allBranchesHashAgnostic'), true, 'the local side alone looks fine');
});

/* --- robustness ----------------------------------------------------------- */

test('comparison is order-independent', () => {
  const forward = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C1'] },
    branches: { main: 'C2', feature: 'C3' },
    tags: { v1: 'C1', v2: 'C2' },
  });
  const reversed = { commits: {}, branches: {}, tags: {}, HEAD: { id: 'HEAD', target: 'main' } };
  for (const key of Object.keys(forward.commits).reverse()) reversed.commits[key] = forward.commits[key];
  for (const key of Object.keys(forward.branches).reverse()) reversed.branches[key] = forward.branches[key];
  for (const key of Object.keys(forward.tags).reverse()) reversed.tags[key] = forward.tags[key];
  // parent order inside a commit is a set too
  reversed.commits.C1 = { id: 'C1', parents: ['C0'] };

  assert.notDeepEqual(Object.keys(forward.commits), Object.keys(reversed.commits));
  for (const mode of MODES) {
    assert.equal(compareTrees(forward, reversed, mode), true, `${mode} should be order-independent`);
  }
});

test('comparison never mutates its inputs', () => {
  const a = deepFreeze(
    tree({
      commits: { C0: [], C1: ['C0'], C2: ['C1'] },
      branches: { main: 'C2', feature: 'C1' },
      tags: { v1: 'C1' },
      originTree: tree({ commits: { C0: [], C1: ['C0'] }, branches: { main: 'C1' } }),
    })
  );
  const b = deepFreeze(structuredClone(tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'] },
    branches: { main: 'C2', feature: 'C1' },
    tags: { v1: 'C1' },
    originTree: tree({ commits: { C0: [], C1: ['C0'] }, branches: { main: 'C1' } }),
  })));

  const beforeA = JSON.stringify(a);
  const beforeB = JSON.stringify(b);
  for (const mode of MODES) {
    // A frozen input would make any write throw, and compareTrees swallows
    // throws as `false` - so a true here proves nothing was written.
    assert.equal(compareTrees(a, b, mode), true, `${mode} tried to write to its input`);
  }
  assert.equal(JSON.stringify(a), beforeA);
  assert.equal(JSON.stringify(b), beforeB);
});

test('Snapshots and TreeJSON compare against each other', async () => {
  const engine = await run('git commit; git checkout -b feature; git commit; git tag v1; git clone');
  const snapshot = engine.getSnapshot();
  const json = engine.exportTree();

  for (const mode of MODES) {
    assert.equal(compareTrees(snapshot, json, mode), true, `${mode} snapshot vs TreeJSON`);
    assert.equal(compareTrees(json, snapshot, mode), true, `${mode} TreeJSON vs snapshot`);
  }
  assert.equal(compareTrees(JSON.stringify(json), snapshot, 'allBranches'), true, 'JSON strings work too');
});

test('rubbish input is false, not an exception', () => {
  const good = LINEAR();
  const rubbish = [null, undefined, 0, 'nope', '{oops', [], true, {}, { commits: null }, { commits: {}, branches: {} }];
  for (const value of rubbish) {
    assert.equal(compareTrees(value, good, 'allBranches'), false, `${String(value)} vs a tree`);
    assert.equal(compareTrees(good, value, 'allBranches'), false, `a tree vs ${String(value)}`);
  }
  assert.equal(compareTrees(null, null, 'allBranches'), false);
  assert.equal(
    compareTrees({ commits: { C0: { id: 'C0', parents: [] } }, branches: { main: { id: 'main', target: 'gone' } } }, good, 'main'),
    false,
    'a branch pointing nowhere cannot match'
  );
});

test('a parent cycle in a hand-written tree terminates instead of hanging', () => {
  const cyclic = {
    commits: { C0: { id: 'C0', parents: ['C1'] }, C1: { id: 'C1', parents: ['C0'] } },
    branches: { main: { id: 'main', target: 'C1' } },
    tags: {},
    HEAD: { id: 'HEAD', target: 'main' },
  };
  assert.equal(compareTrees(cyclic, structuredClone(cyclic), 'allBranches'), true);
  assert.equal(compareTrees(cyclic, LINEAR(), 'allBranches'), false);
});

/* --- canonical form ------------------------------------------------------- */

test('a revert chain is a different shape from the chain it reverts', async () => {
  // git revert C2 names the new commit C2', so the chain holds two commits
  // that normalise to the same label. They are still separate nodes.
  const reverted = await run('git commit; git commit; git revert C2');
  assert.deepEqual(Object.keys(reverted.exportTree().commits), ['C0', 'C1', 'C2', "C2'"]);

  const alsoReverted = await run('git commit; git commit; git revert C2');
  const plain = await run('git commit; git commit');

  assert.equal(
    compareTrees(reverted.getSnapshot(), alsoReverted.getSnapshot(), 'allBranchesHashAgnostic'),
    true,
    'two identical revert chains match'
  );
  assert.equal(
    compareTrees(reverted.getSnapshot(), plain.getSnapshot(), 'allBranchesHashAgnostic'),
    false,
    'C0-C1-C2-C2\' must not collapse onto C0-C1-C2'
  );
  assert.equal(compareTrees(plain.getSnapshot(), reverted.getSnapshot(), 'allBranchesHashAgnostic'), false);

  // And it is the same story with the copy stacked one level deeper.
  const twice = await run('git commit; git commit; git revert C2; git revert C2');
  assert.equal(compareTrees(twice.getSnapshot(), reverted.getSnapshot(), 'allBranchesHashAgnostic'), false);
  assert.equal(compareTrees(twice.getSnapshot(), plain.getSnapshot(), 'allBranchesHashAgnostic'), false);

  // The hand-built equivalent of the revert chain matches it.
  const handBuilt = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'], "C2'": ['C2'] },
    branches: { main: "C2'" },
  });
  assert.equal(compareTrees(reverted.getSnapshot(), handBuilt, 'allBranchesHashAgnostic'), true);
});

test('a rebase copy matches the hand-built tree at the same structural position', async () => {
  const start = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C1'], C4: ['C3'] },
    branches: { main: 'C2', feature: 'C4' },
    HEAD: 'feature',
  });
  const rebased = await run('git rebase main', structuredClone(start));
  assert.deepEqual(Object.keys(rebased.exportTree().commits).sort(), ['C0', 'C1', 'C2', "C3'", "C4'"]);

  const handBuilt = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'], C4: ['C3'] },
    branches: { main: 'C2', feature: 'C4' },
    HEAD: 'feature',
  });
  assert.equal(
    compareTrees(rebased.getSnapshot(), handBuilt, 'allBranchesHashAgnostic'),
    true,
    "C3' occupies the position C3 does, so the two trees are the same shape"
  );
  assert.equal(compareTrees(rebased.getSnapshot(), handBuilt, 'allBranches'), false, 'exact ids still differ');
  assert.equal(compareTrees(rebased.getSnapshot(), start, 'allBranchesHashAgnostic'), false);
});

test('same node count, different parent wiring, different result', () => {
  const diamond = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C0'], C3: ['C1', 'C2'] },
    branches: { main: 'C3' },
  });
  const chain = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'] },
    branches: { main: 'C3' },
  });
  const forked = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C1'] },
    branches: { main: 'C3', side: 'C2' },
  });

  assert.equal(Object.keys(diamond.commits).length, Object.keys(chain.commits).length);
  assert.equal(compareTrees(diamond, chain, 'allBranchesHashAgnostic'), false);
  assert.equal(compareTrees(diamond, chain, 'allBranches'), false);
  assert.equal(compareTrees(chain, forked, 'allBranchesHashAgnostic'), false);
  assert.equal(compareTrees(diamond, structuredClone(diamond), 'allBranchesHashAgnostic'), true);
});

test('shared parents are not confused with duplicated ones', () => {
  // Both trees unfold to exactly the same ancestry description; only the number
  // of real nodes differs. Comparing the node multiset is what catches it.
  const shared = tree({
    commits: { Z: [], Y: ['Z'], "Y'": ['Z'], X: ['Y', "Y'"] },
    branches: { main: 'X' },
  });
  const split = tree({
    commits: { Z: [], "Z'": [], Y: ['Z'], "Y'": ["Z'"], X: ['Y', "Y'"] },
    branches: { main: 'X' },
  });

  assert.equal(Object.keys(shared.commits).length, 4);
  assert.equal(Object.keys(split.commits).length, 5);
  assert.equal(compareTrees(shared, split, 'allBranchesHashAgnostic'), false, 'four nodes are not five');
  assert.equal(compareTrees(shared, structuredClone(shared), 'allBranchesHashAgnostic'), true);
  assert.equal(compareTrees(split, structuredClone(split), 'allBranchesHashAgnostic'), true);
});

test('the canonical form itself is stable under key reordering', () => {
  const forward = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'], "C2'": ['C2'], C3: ['C1'] },
    branches: { main: "C2'", feature: 'C3' },
    tags: { v1: 'C1' },
  });
  const shuffled = { commits: {}, branches: {}, tags: {}, HEAD: { id: 'HEAD', target: 'main' } };
  for (const key of Object.keys(forward.commits).reverse()) shuffled.commits[key] = forward.commits[key];
  for (const key of Object.keys(forward.branches).reverse()) shuffled.branches[key] = forward.branches[key];
  for (const key of Object.keys(forward.tags).reverse()) shuffled.tags[key] = forward.tags[key];

  assert.notDeepEqual(Object.keys(forward.commits), Object.keys(shuffled.commits));
  for (const mode of MODES) {
    const table = new Map();
    assert.deepEqual(
      canonicalise(forward, mode, table),
      canonicalise(shuffled, mode, table),
      `${mode} canonical form drifted with key order`
    );
    assert.equal(compareTrees(forward, shuffled, mode), true, `${mode} should still match`);
  }

  // Reversing a merge commit's parent list is the same graph too.
  const merge = tree({ commits: { C0: [], C1: ['C0'], C2: ['C0'], C3: ['C1', 'C2'] }, branches: { main: 'C3' } });
  const swapped = tree({ commits: { C0: [], C1: ['C0'], C2: ['C0'], C3: ['C2', 'C1'] }, branches: { main: 'C3' } });
  const table = new Map();
  assert.deepEqual(canonicalise(merge, 'allBranches', table), canonicalise(swapped, 'allBranches', table));
});

test('canonicalise reports the shape it compared', () => {
  const value = tree({ commits: { C0: [], C1: ['C0'] }, branches: { main: 'C1' } });
  const form = canonicalise(value, 'allBranches');
  assert.ok(Array.isArray(form.nodes));
  assert.equal(form.nodes.length, 2, 'one entry per reachable commit');
  assert.deepEqual(Object.keys(form.refs).sort(), ['HEAD', 'branch:main']);

  const withJunk = tree({
    commits: { C0: [], C1: ['C0'], C9: ['C0'] },
    branches: { main: 'C1' },
  });
  assert.equal(canonicalise(withJunk, 'main').nodes.length, 2, 'unreachable commits are ignored');
  assert.equal(compareTrees(withJunk, value, 'main'), true);
  assert.equal(canonicalise(null, 'main'), null);
});

/* --- HEAD is a ref too ---------------------------------------------------- */

test('HEAD is compared, so parking it somewhere else is not a solution', async () => {
  const goal = await run('git commit; git commit');

  const same = await run('git commit; git commit');
  assert.equal(compareTrees(same.getSnapshot(), goal.exportTree(), 'allBranchesHashAgnostic'), true);

  // Identical branches, but HEAD left detached somewhere behind.
  const parked = await run('git commit; git commit; git checkout C1');
  assert.equal(
    compareTrees(parked.getSnapshot(), goal.exportTree(), 'allBranchesHashAgnostic'),
    false,
    'a detached HEAD is a visible difference and must fail'
  );

  // Identical commits, but standing on a different branch.
  const goalOnMain = await run('git commit; git branch feature');
  const onFeature = await run('git commit; git branch feature; git checkout feature');
  assert.equal(
    compareTrees(onFeature.getSnapshot(), goalOnMain.exportTree(), 'allBranchesHashAgnostic'),
    false,
    'which branch you are standing on is part of the answer'
  );
  assert.equal(
    compareTrees(onFeature.getSnapshot(), onFeature.exportTree(), 'allBranchesHashAgnostic'),
    true
  );
});

test('a detached commit left dangling is no longer invisible to the comparison', async () => {
  const goal = await run('git commit; git commit');

  // Detach, commit (making a commit no branch can reach), and the branches
  // still look exactly like the goal.
  const dangling = await run('git commit; git commit; git checkout C1; git commit');
  const state = dangling.exportTree();
  assert.equal(state.branches.main.target, 'C2', 'main is where the goal wants it');
  assert.equal(state.HEAD.target, 'C3');
  assert.equal(
    compareTrees(dangling.getSnapshot(), goal.exportTree(), 'allBranchesHashAgnostic'),
    false,
    'the extra commit on screen has to count'
  );
});

test('a detached HEAD goal is verifiable, and compares by position', async () => {
  const goal = await run('git commit; git commit; git commit; git checkout HEAD~1');
  assert.equal(goal.getSnapshot().HEAD.detached, true);

  const solved = await run('git commit; git commit; git commit; git checkout C2');
  assert.equal(
    compareTrees(solved.getSnapshot(), goal.exportTree(), 'allBranchesHashAgnostic'),
    true,
    'two routes to the same detached spot both count'
  );

  const wrongSpot = await run('git commit; git commit; git commit; git checkout C1');
  assert.equal(compareTrees(wrongSpot.getSnapshot(), goal.exportTree(), 'allBranchesHashAgnostic'), false);

  const notDetached = await run('git commit; git commit; git commit');
  assert.equal(
    compareTrees(notDetached.getSnapshot(), goal.exportTree(), 'allBranchesHashAgnostic'),
    false,
    'attached and detached are different states even at the same commit'
  );

  // Attached HEAD at the same commit as a detached goal is still different.
  const attachedThere = await run('git commit; git commit; git commit; git branch parked C2; git checkout parked');
  assert.equal(compareTrees(attachedThere.getSnapshot(), goal.exportTree(), 'allBranchesHashAgnostic'), false);
});

test('HEAD takes part in every mode', async () => {
  const goal = await run('git commit; git commit; git tag v1; git clone');
  const parked = await run('git commit; git commit; git tag v1; git clone; git checkout C1');

  for (const mode of MODES) {
    assert.equal(
      compareTrees(parked.getSnapshot(), goal.exportTree(), mode),
      false,
      `${mode} ignored a HEAD that moved`
    );
    assert.equal(compareTrees(goal.getSnapshot(), goal.exportTree(), mode), true, `${mode} rejected an exact match`);
  }
});

test('the remote repository has no HEAD of its own to compare', () => {
  // origin's HEAD is not something the reader can move or even see, so a
  // difference there must not fail a level.
  const local = { commits: { C0: [], C1: ['C0'] }, branches: { main: 'C1', 'o/main': 'C1' } };
  const goal = tree({
    ...local,
    originTree: tree({ commits: { C0: [], C1: ['C0'] }, branches: { main: 'C1', spare: 'C0' }, HEAD: 'main' }),
  });
  const otherHead = tree({
    ...local,
    originTree: tree({ commits: { C0: [], C1: ['C0'] }, branches: { main: 'C1', spare: 'C0' }, HEAD: 'spare' }),
  });
  assert.equal(compareTrees(otherHead, goal, 'withOrigin'), true);
});

/* --- against real command output ------------------------------------------ */

test('level-shaped check: the solution passes and near-misses fail', async () => {
  const start = tree({
    commits: { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C1'] },
    branches: { main: 'C2', feature: 'C3' },
    HEAD: 'feature',
  });

  const goal = (await run('git rebase main', structuredClone(start))).exportTree();

  const solved = await run('git rebase main', structuredClone(start));
  assert.equal(compareTrees(solved.getSnapshot(), goal, 'allBranchesHashAgnostic'), true);

  const nearMisses = {
    'merged instead of rebased': 'git merge main',
    'reset instead of rebased': 'git reset main',
    'rebased the wrong way round': 'git checkout main; git rebase feature',
    'cherry-picked onto main': 'git checkout main; git cherry-pick C3',
    'did nothing': 'git status',
  };
  for (const [label, script] of Object.entries(nearMisses)) {
    const attempt = await run(script, structuredClone(start));
    assert.equal(
      compareTrees(attempt.getSnapshot(), goal, 'allBranchesHashAgnostic'),
      false,
      `"${label}" should not count as solved`
    );
  }
});

test('level-shaped check: a remote level with withOrigin', async () => {
  const start = tree({
    commits: { C0: [], C1: ['C0'] },
    branches: { main: 'C1', 'o/main': 'C1' },
    originTree: tree({ commits: { C0: [], C1: ['C0'] }, branches: { main: 'C1' } }),
  });
  start.branches.main.remoteTrackingBranchID = 'o/main';

  const goal = (await run('git commit; git push', structuredClone(start))).exportTree();

  const solved = await run('git commit; git push', structuredClone(start));
  assert.equal(compareTrees(solved.getSnapshot(), goal, 'withOrigin'), true);

  const committedOnly = await run('git commit', structuredClone(start));
  assert.equal(compareTrees(committedOnly.getSnapshot(), goal, 'withOrigin'), false);

  const fetchedOnly = await run('git fetch', structuredClone(start));
  assert.equal(compareTrees(fetchedOnly.getSnapshot(), goal, 'withOrigin'), false);

  const twoCommits = await run('git commit; git commit; git push', structuredClone(start));
  assert.equal(compareTrees(twoCommits.getSnapshot(), goal, 'withOrigin'), false);
});
