// Sequence: Deep Water. Long rebases, reading merge commits, and repair work.
// Trees are written out in full so the level data stays readable at a glance.

/** commits({ C0: [], C1: ['C0'] }) -> TreeJSON.commits */
function commits(spec) {
  const out = {};
  for (const [id, parents] of Object.entries(spec)) {
    out[id] = { id, parents: [...parents] };
    if (!parents.length) out[id].rootCommit = true;
  }
  return out;
}

/** branches({ main: 'C1' }) -> TreeJSON.branches */
function branches(spec) {
  const out = {};
  for (const [id, target] of Object.entries(spec)) {
    out[id] = { id, target, remoteTrackingBranchID: null };
  }
  return out;
}

function tree(commitSpec, branchSpec, head) {
  return {
    commits: commits(commitSpec),
    branches: branches(branchSpec),
    tags: {},
    HEAD: { id: 'HEAD', target: head },
  };
}

// --- 1. Moving part of a stack ----------------------------------------------
//
// Deliberately not "rebase every branch onto the one below it" - that exercise
// already exists as mixed-restack, and repeating it here would make the harder
// sequence the easier one. This level is the three-argument rebase instead,
// which nothing else in the curriculum teaches.

const rebaseOnto = {
  id: 'advanced-rebase-onto',
  name: 'Only the top of the stack',
  hint: 'A plain rebase replays everything a branch has that its new base has not, which here is more than you want. The three-argument form lets you name the landing place and the cut-off point separately.',
  compareMode: 'allBranchesHashAgnostic',
  startTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C1'], C4: ['C3'], C5: ['C4'], C6: ['C5'] },
    { main: 'C2', feature: 'C4', bugfix: 'C6' },
    'main'
  ),
  goalTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C1'], C4: ['C3'], "C5'": ['C2'], "C6'": ["C5'"] },
    { main: "C6'", feature: 'C4', bugfix: "C6'" },
    'main'
  ),
  solutionCommand: 'git rebase --onto main feature bugfix; git checkout main; git merge bugfix',
  dialog: [
    {
      type: 'markdown',
      title: 'A branch built on a branch',
      markdown: [
        '`bugfix` was never started from `main`. It was started from `feature`, which was itself started from an older `main`, and `main` has moved on since.',
        '',
        'So the two commits that actually fix the bug are sitting on top of two commits from `feature` that have nothing to do with it and are nowhere near ready to ship.',
        '',
        'What you want is the fix on `main` today, `feature` left exactly where it is, and none of its work dragged along for the ride. That means lifting the top of the stack off the bottom of it.',
      ].join('\n'),
    },
    {
      type: 'demo',
      title: 'What the obvious command does',
      command: 'git rebase main bugfix',
      markdown: [
        'This looks right and is not. A plain rebase replays every commit the branch has that the new base has not, and by that measure `bugfix` has four: its own two, plus the two it inherited from `feature` on the way past.',
        '',
        'Run it and count the copies that land on `main`. Two of them are somebody else\'s unfinished work, now published on the branch everybody builds from.',
        '',
        'Then type `reset` to put the level back, because that is not the answer.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Naming the cut-off separately',
      markdown: [
        'A plain rebase runs two decisions together: where the commits should land, and where the range worth replaying starts. The three-argument form pulls them apart.',
        '',
        '```',
        'git rebase --onto <new base> <upstream> <branch>',
        '```',
        '',
        'Read it as: take the commits in `<branch>` that are not already in `<upstream>`, and replay those onto `<new base>`.',
        '',
        'The middle argument is a cut-off, not a destination. Nothing goes anywhere near it. Pick the branch your range should stop at and you get the top of the stack without the bottom of it.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'The task',
      markdown: [
        '**Goal:** `bugfix` rebuilt directly on `main` carrying only its own two commits, `feature` untouched, and `main` brought up to the rebuilt tip with you standing on it.',
        '',
        'Three commands. The first is the three-argument rebase, and its cut-off is the branch `bugfix` grew out of.',
        '',
        'That rebase leaves you on `bugfix` rather than on `main`, so the second command is where you fix that.',
        '',
        'For the third: `main` has nothing of its own that `bugfix` lacks, so an ordinary merge finds nothing to combine and slides the label forward instead of building a commit.',
      ].join('\n'),
    },
  ],
};

// --- 2. Merge parents --------------------------------------------------------

const mergeParents = {
  id: 'advanced-merge-parents',
  name: 'Two ways up',
  hint: 'Every label here is one sideways step off the trunk. Walk back to the merge you want, then choose which parent you mean.',
  compareMode: 'allBranchesHashAgnostic',
  startTree: tree(
    {
      C0: [],
      C1: ['C0'],
      C2: ['C1'],
      C3: ['C1'],
      C4: ['C3', 'C2'],
      C5: ['C4'],
      C6: ['C2'],
      C7: ['C5', 'C6'],
    },
    { main: 'C7' },
    'main'
  ),
  goalTree: tree(
    {
      C0: [],
      C1: ['C0'],
      C2: ['C1'],
      C3: ['C1'],
      C4: ['C3', 'C2'],
      C5: ['C4'],
      C6: ['C2'],
      C7: ['C5', 'C6'],
    },
    { main: 'C7', alpha: 'C6', beta: 'C2', gamma: 'C3' },
    'main'
  ),
  solutionCommand: 'git branch alpha main^2; git branch beta main~2^2; git branch gamma main~2^',
  dialog: [
    {
      type: 'markdown',
      title: 'A commit with two parents',
      markdown: [
        'Most commits have one parent, so "go back one step" is never ambiguous. A merge commit has two, and git needs you to say which one you mean.',
        '',
        '`main^` and `main^1` both mean the **first** parent: the branch you were standing on when you ran the merge. `main^2` means the **second** parent: the branch you merged in.',
        '',
        '`~` is a different tool. `main~3` means three steps back, and at every merge it silently takes the first parent. So `~` walks the trunk, and `^2` is how you step sideways onto a line that was merged in.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Chaining them',
      markdown: [
        'These pieces glue together, and you read the result left to right.',
        '',
        '```',
        'main~2^2',
        '```',
        '',
        'Start at `main`. Take two first-parent steps back, which lands on a merge commit. Then take that merge commit\'s second parent.',
        '',
        'Each piece moves the pointer once. What comes out is just a commit, and anywhere a commit id is allowed, an expression like this is allowed too. `git branch <name> <ref>` drops a label there without moving you.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Read the picture, then label it',
      markdown: [
        'This history contains two merges. Place three new branch labels using relative refs only, with no commit ids.',
        '',
        '- `alpha` on the commit that was merged in last',
        '- `beta` on the second parent of the earlier merge',
        '- `gamma` on the first parent of that same merge',
        '',
        'If a label lands in the wrong place, `git branch -f <name> <ref>` moves it. Three commands, and `main` stays exactly where it is.',
      ].join('\n'),
    },
  ],
};

// --- 3. Untangling -----------------------------------------------------------

const untangle = {
  id: 'advanced-untangle',
  name: 'Untangling the knot',
  hint: 'Cherry-pick accepts a list, so a single command can rebuild the line from oldest keeper to newest. What is left after that is making sure no label still points at the old mess.',
  compareMode: 'allBranchesHashAgnostic',
  startTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C1'], C4: ['C2', 'C3'], C5: ['C4'], C6: ['C5'] },
    { main: 'C1', tangle: 'C6' },
    'main'
  ),
  goalTree: tree(
    { C0: [], C1: ['C0'], "C2'": ['C1'], "C3'": ["C2'"], "C6'": ["C3'"] },
    { main: "C6'", tangle: "C6'" },
    'main'
  ),
  solutionCommand: 'git cherry-pick C2 C3 C6; git branch -f tangle main',
  dialog: [
    {
      type: 'markdown',
      title: 'A branch that grew sideways',
      markdown: [
        'Somebody merged two lines of work together halfway through a feature. `tangle` now carries a merge commit nobody wanted, and above it sits `C5`, a debugging commit that must not survive. `main` never moved at all.',
        '',
        'A plain `git rebase` is the wrong shape of tool here. It flattens the merge away, which you want, but it replays the whole range it is handed, so the debugging commit arrives with everything else. Plain rebase never asks what is in the range.',
        '',
        '`git rebase -i` does ask, and unticking `C5` gets you the right shape - but not in two commands. `git rebase -i main tangle` leaves you standing on `tangle`, so you would still have to move `main` onto the rebuilt tip and check `main` out again afterwards.',
        '',
        '`git cherry-pick` is the tool that says out loud which commits it wants: you name them, and nothing you did not name can turn up.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Cherry-pick takes a list',
      markdown: [
        'You can name several commits in one go.',
        '',
        '```',
        'git cherry-pick <first> <second> <third>',
        '```',
        '',
        'Each one is copied on top of the previous one, so the order you type is the order they land in.',
        '',
        'The copies are new commits with new ids. The originals stay exactly where they were - nothing is moved, only duplicated. That is why cherry-pick is a comfortable tool on a history you do not fully trust yet.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Rebuild it clean',
      markdown: [
        '`main` is checked out, sitting on the commit from just before the mess started.',
        '',
        'Four commits sit above it and three of them are worth keeping. Copy those onto `main` in their original order, leaving out both the merge and the debugging commit. Then move `tangle` onto the new tip with `git branch -f`, so no label refers to the tangled line any more.',
        '',
        'When that last label moves, the whole tangled line has nothing pointing at it and disappears from the drawing. Only this app forgets that fast: real git keeps the originals, so a rebuild like this stays reversible for weeks.',
        '',
        'Two commands are enough by the cherry-pick route. Rebase is not switched off: run a plain one if you like and watch `C5` arrive with everything else, or take the interactive route and budget the third command it needs to leave you back on `main`.',
      ].join('\n'),
    },
  ],
};

// --- 4. Capstone -------------------------------------------------------------

const capstone = {
  id: 'advanced-capstone',
  name: 'Capstone: rebuild, then rejoin',
  hint: 'Modernise `ui` before anything gets merged, and check where a rebase leaves you standing. Of the two merges, the branch you did not rebase goes in first.',
  compareMode: 'allBranchesHashAgnostic',
  startTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C0'], C4: ['C3'], C5: ['C1'], C6: ['C5'] },
    { main: 'C2', ui: 'C4', api: 'C6' },
    'main'
  ),
  goalTree: tree(
    {
      C0: [],
      C1: ['C0'],
      C2: ['C1'],
      C5: ['C1'],
      C6: ['C5'],
      "C3'": ['C2'],
      "C4'": ["C3'"],
      C7: ['C2', 'C6'],
      C8: ['C7', "C4'"],
    },
    { main: 'C8', ui: "C4'", api: 'C6' },
    'main'
  ),
  solutionCommand: 'git rebase main ui; git checkout main; git merge api; git merge ui',
  dialog: [
    {
      type: 'markdown',
      title: 'Everything at once',
      markdown: [
        'Last one in this sequence, and nothing new is introduced. This is the whole set of tools in a single puzzle.',
        '',
        '`main` has a commit of its own. `api` grew from the commit just before it, so the base it started from is behind - though `api` itself carries two commits `main` has never seen. `ui` is worse: it grew straight out of the root and knows nothing about anything.',
        '',
        'You want `ui` rebuilt on top of today\'s `main`, and then both branches folded into `main` with real merges - `api` first, `ui` second.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Two things to keep in mind',
      markdown: [
        'A rebase leaves you standing on the branch it rebased. Check where you are before you start merging, or the merge will happen in the wrong place.',
        '',
        'And `git merge` only builds a merge commit when neither side already contains the other. When one side is simply ahead, git slides the label forward instead and no commit is created.',
        '',
        'Here `main` has a commit `api` lacks, and `api` has commits `main` lacks. Neither contains the other, so both merges will produce genuine two-parent commits.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'The task',
      markdown: [
        '**Goal:** `ui` replayed on top of `main`, then `main` merged with `api`, then `main` merged with `ui`.',
        '',
        'Four commands are enough:',
        '',
        '1. rebase `ui`',
        '2. get back onto `main`',
        '3. merge one branch',
        '4. merge the other',
        '',
        'Look closely at the final commit. Its first parent is the merge you made a moment earlier, and its second parent is the tip of `ui`. That is what `main^2` will find when you come back to this repository next week.',
      ].join('\n'),
    },
  ],
};

export default {
  key: 'advanced',
  name: 'Deep Water',
  group: 'Main',
  about:
    'Lifting part of a stack off the rest of it, reading merge commits with relative refs, and repairing a history that went wrong.',
  levels: [rebaseOnto, mergeParents, untangle, capstone],
};
