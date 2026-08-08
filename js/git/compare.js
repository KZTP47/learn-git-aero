// Level goal checking.
//
// Both trees are reduced to a *canonical form* and then compared field by
// field. The canonical form is built like this:
//
//   1. Keep only the commits reachable from the refs the mode cares about.
//   2. Give every commit a structural key: its label plus the (sorted) keys of
//      its parents, recursively. Keys are interned into integers in a table
//      shared by both trees, so equal keys really do mean equal structure and
//      the whole pass stays linear.
//   3. The canonical form is the sorted multiset of `key<parentKeys` wiring
//      entries plus the map of ref name -> key.
//
// Comparing the node multiset as well as the refs matters: a signature alone
// describes a commit's ancestry as an unfolded tree, which cannot see whether
// two identical-looking parents are one shared commit or two separate ones.
// The multiset pins the node count and the wiring, so that cannot slip through.
//
// The label is where the modes differ. Exact modes use the commit id as-is.
// Hash-agnostic modes strip the apostrophe suffix (`C2'''` -> `C2`) so a
// rewritten commit still matches its original. Normalising the *label* is not
// the same as merging the *nodes*: `C2` and its revert `C2'` both label as
// `C2`, but they sit in different structural positions, so they get different
// keys and can never collide.
//
// Nothing here mutates its inputs and nothing depends on key order.

const MODES = new Set([
  'main',
  'allBranches',
  'allBranchesHashAgnostic',
  'allBranchesAndTags',
  'allBranchesAndTagsHashAgnostic',
  'tagsOnly',
  'withOrigin',
]);

const HASH_AGNOSTIC_MODES = new Set([
  'allBranchesHashAgnostic',
  'allBranchesAndTagsHashAgnostic',
  'withOrigin',
]);

/**
 * @param {object} current  Snapshot or TreeJSON
 * @param {object} goal     Snapshot or TreeJSON
 * @param {string} mode     see MODES
 * @returns {boolean}
 */
export function compareTrees(current, goal, mode = 'allBranchesHashAgnostic') {
  try {
    const name = MODES.has(mode) ? mode : 'allBranchesHashAgnostic';
    const a = read(current);
    const b = read(goal);
    if (!a || !b) return false;

    const table = new Map(); // structural key -> integer, shared by both trees
    if (!sameShape(a, b, name, table)) return false;
    if (name !== 'withOrigin') return true;

    if (!a.origin !== !b.origin) return false;
    if (!a.origin) return true;
    // The remote's own HEAD is not something the reader can move or see, so
    // requiring it to match would fail levels for an invisible reason.
    return sameShape(a.origin, b.origin, 'allBranchesHashAgnostic', table, { includeHead: false });
  } catch {
    return false;
  }
}

/**
 * The canonical form a mode reduces a tree to. Exposed for tests and for
 * debugging a level that will not register as solved.
 * @returns {{nodes:string[], refs:Record<string,number>}|null}
 */
export function canonicalise(tree, mode = 'allBranchesHashAgnostic', table = new Map()) {
  const parsed = read(tree);
  if (!parsed) return null;
  const name = MODES.has(mode) ? mode : 'allBranchesHashAgnostic';
  return canonicalForm(parsed, name, table);
}

/** `C2'''` and `C2'^4` both reduce to `C2`. */
export function normaliseId(id) {
  const text = String(id);
  const at = text.indexOf("'");
  return at === -1 ? text : text.slice(0, at);
}

/* -------------------------------------------------------------------------- */

function sameShape(a, b, mode, table, options) {
  const left = canonicalForm(a, mode, table, options);
  const right = canonicalForm(b, mode, table, options);
  if (left === null || right === null) return false;

  if (left.nodes.length !== right.nodes.length) return false;
  for (let i = 0; i < left.nodes.length; i++) {
    if (left.nodes[i] !== right.nodes[i]) return false;
  }

  const leftRefs = Object.keys(left.refs).sort();
  const rightRefs = Object.keys(right.refs).sort();
  if (leftRefs.length !== rightRefs.length) return false;
  for (let i = 0; i < leftRefs.length; i++) {
    if (leftRefs[i] !== rightRefs[i]) return false;
    if (left.refs[leftRefs[i]] !== right.refs[rightRefs[i]]) return false;
  }
  return true;
}

function canonicalForm(tree, mode, table, { includeHead = true } = {}) {
  const refPairs = refsForMode(tree, mode);
  for (const [, target] of refPairs) {
    // A ref pointing at a commit that is not in the tree is a broken tree.
    if (!tree.commits[target]) return null;
  }

  // HEAD is a ref like any other. Leaving it out let a solved level accept a
  // tree with HEAD parked anywhere, and left a detached commit dangling on
  // screen with nothing noticing.
  const head = includeHead ? readHead(tree) : null;
  const roots = refPairs.map((pair) => pair[1]);
  if (head && head.commit) roots.push(head.commit);

  const reachable = reachableFrom(tree, roots);
  const keys = keyAll(tree, reachable, HASH_AGNOSTIC_MODES.has(mode), table);

  const nodes = [];
  for (const id of reachable) {
    const parents = tree.commits[id].parents
      .map((parent) => keys.get(parent))
      .sort((x, y) => x - y);
    nodes.push(`${keys.get(id)}<${parents.join(',')}`);
  }
  nodes.sort();

  const refs = Object.create(null);
  for (const [name, target] of refPairs) refs[name] = keys.get(target);
  if (head) {
    // Attached HEAD compares by branch name; detached HEAD compares by the
    // structural position of the commit it is sitting on.
    refs.HEAD = intern(
      table,
      head.branch !== null
        ? `HEAD@branch:${head.branch}`
        : head.commit
          ? `HEAD@detached:${keys.get(head.commit)}`
          : 'HEAD@nowhere'
    );
  }
  return { nodes, refs };
}

/** Resolve HEAD into `{ branch, commit }`; branch is null when detached. */
function readHead(tree) {
  const target = tree.HEAD;
  if (typeof target !== 'string' || !target) return null;
  if (tree.branches[target] !== undefined) {
    return { branch: target, commit: tree.branches[target] };
  }
  if (tree.commits[target]) return { branch: null, commit: target };
  return { branch: null, commit: null };
}

function refsForMode(tree, mode) {
  const pairs = [];
  if (mode === 'main') {
    if (tree.branches.main !== undefined) pairs.push(['branch:main', tree.branches.main]);
    return pairs;
  }
  if (mode === 'tagsOnly') {
    for (const name of Object.keys(tree.tags)) pairs.push([`tag:${name}`, tree.tags[name]]);
    return pairs;
  }
  for (const name of Object.keys(tree.branches)) pairs.push([`branch:${name}`, tree.branches[name]]);
  if (mode === 'allBranchesAndTags' || mode === 'allBranchesAndTagsHashAgnostic') {
    for (const name of Object.keys(tree.tags)) pairs.push([`tag:${name}`, tree.tags[name]]);
  }
  return pairs;
}

function reachableFrom(tree, starts) {
  const seen = new Set();
  const stack = [...starts];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id) || !tree.commits[id]) continue;
    seen.add(id);
    for (const parent of tree.commits[id].parents) stack.push(parent);
  }
  return seen;
}

/**
 * Structural key for every reachable commit. Iterative so a 10k-commit chain
 * cannot blow the stack; parents are always keyed before their children.
 */
function keyAll(tree, reachable, hashAgnostic, table) {
  const keys = new Map();
  const inProgress = new Set();
  const label = hashAgnostic ? normaliseId : String;

  for (const start of reachable) {
    if (keys.has(start)) continue;
    const stack = [[start, false]];
    while (stack.length) {
      const [id, expanded] = stack.pop();
      if (keys.has(id)) continue;
      const commit = tree.commits[id];
      if (!expanded) {
        if (inProgress.has(id)) continue; // parent cycle - handled below
        inProgress.add(id);
        stack.push([id, true]);
        for (const parent of commit.parents) {
          if (!keys.has(parent) && !inProgress.has(parent)) stack.push([parent, false]);
        }
        continue;
      }
      // A parent cycle (only possible in a hand-written tree) leaves a parent
      // unkeyed; fall back to its raw id so the walk still terminates.
      const parts = commit.parents
        .map((parent) => (keys.has(parent) ? keys.get(parent) : `?${parent}`))
        .sort();
      keys.set(id, intern(table, `${label(id)}(${parts.join(',')})`));
      inProgress.delete(id);
    }
  }
  return keys;
}

function intern(table, key) {
  let value = table.get(key);
  if (value === undefined) {
    value = table.size + 1;
    table.set(key, value);
  }
  return value;
}

/** Accept a Snapshot, a TreeJSON, or a JSON string of either. Never mutates. */
function read(input) {
  let source = input;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      return null;
    }
  }
  if (!source || typeof source !== 'object') return null;

  const commits = Object.create(null);
  const rawCommits = source.commits && typeof source.commits === 'object' ? source.commits : {};
  for (const key of Object.keys(rawCommits)) {
    const commit = rawCommits[key];
    if (!commit || typeof commit !== 'object') continue;
    const id = typeof commit.id === 'string' && commit.id ? commit.id : key;
    const parents = Array.isArray(commit.parents)
      ? commit.parents.filter((p) => typeof p === 'string')
      : [];
    commits[id] = { id, parents: [...parents] };
  }
  // Parents that name a commit which is not in the tree cannot take part in a
  // structural comparison; drop them so both sides see the same graph.
  for (const id of Object.keys(commits)) {
    commits[id].parents = commits[id].parents.filter((parent) => commits[parent]);
  }

  const branches = Object.create(null);
  const rawBranches = source.branches && typeof source.branches === 'object' ? source.branches : {};
  for (const key of Object.keys(rawBranches)) {
    const branch = rawBranches[key];
    if (!branch || typeof branch !== 'object') continue;
    const id = typeof branch.id === 'string' && branch.id ? branch.id : key;
    if (typeof branch.target !== 'string') continue;
    branches[id] = branch.target;
  }

  const tags = Object.create(null);
  const rawTags = source.tags && typeof source.tags === 'object' ? source.tags : {};
  for (const key of Object.keys(rawTags)) {
    const tag = rawTags[key];
    if (!tag || typeof tag !== 'object') continue;
    const id = typeof tag.id === 'string' && tag.id ? tag.id : key;
    if (typeof tag.target !== 'string') continue;
    tags[id] = tag.target;
  }

  const rawHead = source.HEAD;
  const HEAD =
    rawHead && typeof rawHead === 'object' && typeof rawHead.target === 'string' ? rawHead.target : null;

  const originSource = source.origin ?? source.originTree ?? null;
  const origin = originSource ? read(originSource) : null;

  return { commits, branches, tags, HEAD, origin };
}
