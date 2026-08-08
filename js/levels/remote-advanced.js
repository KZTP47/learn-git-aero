// Sequence: Remote Mastery. Arguments to push, fetch and pull, refspecs, what
// tracking actually attaches to, and one level that uses the lot.

/** commits({ C0: [], C1: ['C0'] }) -> TreeJSON.commits */
function commits(spec) {
  const out = {};
  for (const [id, parents] of Object.entries(spec)) {
    out[id] = { id, parents: [...parents] };
    if (!parents.length) out[id].rootCommit = true;
  }
  return out;
}

/** branches({ main: ['C1', 'o/main'], 'o/main': 'C1' }) -> TreeJSON.branches */
function branches(spec) {
  const out = {};
  for (const [id, value] of Object.entries(spec)) {
    const [target, remoteTrackingBranchID = null] = Array.isArray(value) ? value : [value];
    out[id] = { id, target, remoteTrackingBranchID };
  }
  return out;
}

function tree(commitSpec, branchSpec, head, originTree) {
  const out = {
    commits: commits(commitSpec),
    branches: branches(branchSpec),
    tags: {},
    HEAD: { id: 'HEAD', target: head },
  };
  if (originTree) out.originTree = originTree;
  return out;
}

function origin(commitSpec, branchSpec, head = 'main') {
  return tree(commitSpec, branchSpec, head);
}

// --- 1. Push arguments -------------------------------------------------------

const pushArgs = {
  id: 'remote-advanced-push-args',
  name: 'Push, by name',
  hint: 'Name the remote and the branch, and push stops caring what you have checked out. Two pushes, no checkouts.',
  compareMode: 'withOrigin',
  startTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C1'] },
    {
      main: ['C1', 'o/main'],
      'o/main': 'C1',
      search: ['C2', 'o/search'],
      'o/search': 'C1',
      login: ['C3', 'o/login'],
      'o/login': 'C1',
    },
    'main',
    origin({ C0: [], C1: ['C0'] }, { main: 'C1', search: 'C1', login: 'C1' })
  ),
  goalTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C1'] },
    {
      main: ['C1', 'o/main'],
      'o/main': 'C1',
      search: ['C2', 'o/search'],
      'o/search': 'C2',
      login: ['C3', 'o/login'],
      'o/login': 'C3',
    },
    'main',
    origin(
      { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C1'] },
      { main: 'C1', search: 'C2', login: 'C3' }
    )
  ),
  solutionCommand: 'git push origin search; git push origin login',
  dialog: [
    {
      type: 'markdown',
      title: 'Saying it out loud',
      markdown: [
        'So far `git push` has meant "push whatever I am standing on". That works because your branch has a remote-tracking branch attached to it, and git uses that to decide where things go.',
        '',
        'You can say it explicitly instead:',
        '',
        '```',
        'git push <remote> <branch>',
        '```',
        '',
        'which reads "send my `<branch>` to `<remote>`". The branch does not have to be checked out. That is the useful part: you can publish finished work from one branch while you are busy on another.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Two branches, no checkouts',
      markdown: [
        'You are on `main`, and `main` has nothing new. Two other branches do.',
        '',
        'Push `search` and then `login` to `origin` by name, without checking either of them out. Two commands, and `main` should still be the branch you are standing on at the end.',
        '',
        'Watch the `o/` labels as you go. Each successful push updates the matching remote-tracking branch, because that is the moment your record of the server stops being stale.',
      ].join('\n'),
    },
  ],
};

// --- 2. Refspecs -------------------------------------------------------------

const refspecs = {
  id: 'remote-advanced-refspec',
  name: 'Source and destination',
  hint: 'One push, with a colon in the argument. The left half is a ref in your repository, and it does not have to be a branch tip.',
  compareMode: 'withOrigin',
  startTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'] },
    { main: ['C3', 'o/main'], 'o/main': 'C1' },
    'main',
    origin({ C0: [], C1: ['C0'] }, { main: 'C1' })
  ),
  goalTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'] },
    { main: ['C3', 'o/main'], 'o/main': 'C2' },
    'main',
    origin({ C0: [], C1: ['C0'], C2: ['C1'] }, { main: 'C2' })
  ),
  solutionCommand: 'git push origin main^:main',
  dialog: [
    {
      type: 'markdown',
      title: 'One argument, two halves',
      markdown: [
        'The branch argument to push is really two arguments with a colon between them.',
        '',
        '```',
        'git push origin <source>:<destination>',
        '```',
        '',
        '`<source>` is any ref **in your repository** - a branch, a commit id, or an expression like `main^`. `<destination>` is the branch **on the remote** that you want moved.',
        '',
        'Written as one word, `git push origin main`, both halves happen to be the same name. Once they are allowed to differ, you can push something other than a branch tip.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Publish only the first commit',
      markdown: [
        'You have two new commits on `main`. Only the older one is ready to be seen; the newer one is still rough.',
        '',
        'Send just that older commit to the server\'s `main`. The source is the commit one step back from your `main`, and you can name it with a relative ref instead of an id.',
        '',
        'Your local `main` will not move - you did not ask it to. `o/main` lands on the commit you actually pushed, which is the honest record of what the server now holds.',
      ].join('\n'),
    },
  ],
};

// --- 3. Fetch arguments ------------------------------------------------------

const fetchArgs = {
  id: 'remote-advanced-fetch-args',
  name: 'Fetch, by name',
  hint: 'Fetch takes the same shape of argument as push. Name the one branch you care about and git leaves every other record alone.',
  compareMode: 'withOrigin',
  startTree: tree(
    { C0: [], C1: ['C0'] },
    {
      main: ['C1', 'o/main'],
      'o/main': 'C1',
      search: ['C1', 'o/search'],
      'o/search': 'C1',
    },
    'main',
    origin({ C0: [], C1: ['C0'], C2: ['C1'], C3: ['C1'] }, { main: 'C2', search: 'C3' })
  ),
  goalTree: tree(
    { C0: [], C1: ['C0'], C3: ['C1'] },
    {
      main: ['C1', 'o/main'],
      'o/main': 'C1',
      search: ['C1', 'o/search'],
      'o/search': 'C3',
    },
    'main',
    origin({ C0: [], C1: ['C0'], C2: ['C1'], C3: ['C1'] }, { main: 'C2', search: 'C3' })
  ),
  solutionCommand: 'git fetch origin search',
  dialog: [
    {
      type: 'markdown',
      title: 'The mirror argument',
      markdown: [
        'Fetch takes the same kind of argument as push, and it means the opposite direction.',
        '',
        '```',
        'git fetch <remote> <branch>',
        '```',
        '',
        '"Go to `<remote>`, look at `<branch>` over there, download whatever I am missing, and move my `o/<branch>` to match."',
        '',
        'Bare `git fetch` does this for every branch at once. Naming one leaves everything else exactly as it was, which is what you want when a colleague\'s branch is the only thing you care about right now.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Ask about one branch only',
      markdown: [
        'The server has moved in two places: its `main` has a new commit, and its `search` branch has one too.',
        '',
        'Fetch only `search`. Afterwards `o/search` should be sitting on the new commit, and `o/main` should be untouched, still showing the older state.',
        '',
        'That is correct behaviour, not a bug. You did not ask about `main`, and git does not guess.',
        '',
        'None of your own branches move either, and in this app they never will: a fetch here only ever writes `o/` records. Real git keeps one exception in reserve. The `<source>:<destination>` form from the last level works on fetch as well, and `git fetch origin main:main` really does write your local `main` - which is why real git refuses that spelling when `main` is the branch you are standing on. This model reads the source half and ignores the destination.',
      ].join('\n'),
    },
  ],
};

// --- 4. Fetching into a branch that does not exist ---------------------------

const fetchNewPlace = {
  id: 'remote-advanced-fetch-new-place',
  name: 'Fetching into thin air',
  hint: 'Ask the remote about a branch by name and its `o/` record appears out of nothing. A record is still not a place you can work.',
  compareMode: 'withOrigin',
  startTree: tree(
    { C0: [], C1: ['C0'] },
    { main: ['C1', 'o/main'], 'o/main': 'C1' },
    'main',
    origin({ C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'] }, { main: 'C1', hotfix: 'C3' })
  ),
  goalTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'] },
    { main: ['C1', 'o/main'], 'o/main': 'C1', 'o/hotfix': 'C3', hotfix: 'C3' },
    'hotfix',
    origin({ C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'] }, { main: 'C1', hotfix: 'C3' })
  ),
  solutionCommand: 'git fetch origin hotfix; git checkout -b hotfix o/hotfix',
  dialog: [
    {
      type: 'markdown',
      title: 'A branch you have never heard of',
      markdown: [
        'Your repository only knows about the remote branches somebody has told it about. Right now that is `main` and nothing else - there is no `o/hotfix` label anywhere on your side, because the subject has never come up.',
        '',
        'Naming a branch in a fetch fixes that. Git goes to the remote, finds the branch, downloads every commit you are missing, and creates the remote-tracking label from nothing. A whole line of history appears where a second ago there was empty space.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Then make it yours',
      markdown: [
        'A remote-tracking branch is a record, not a workspace. Check `o/hotfix` out - here or in real git, the answer is the same - and you land on a detached `HEAD`, because a record of where the server\'s branch was is not a place your next commit can attach itself to.',
        '',
        'So the second half of the job is to start an ordinary local branch from where the fetched one landed:',
        '',
        '```',
        'git checkout -b <name> o/<name>',
        '```',
        '',
        'The `-b` form takes a starting point as its second argument. Any ref will do, and a remote-tracking branch is a perfectly good ref.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Bring it down and stand on it',
      markdown: [
        'The server has a branch called `hotfix` carrying two commits. You have never seen either of them.',
        '',
        'Fetch it by name, which creates `o/hotfix` and pulls both commits down. Then create a local `hotfix` branch starting from `o/hotfix`, and switch to it.',
        '',
        'Two commands. `main` and `o/main` should be exactly where they started - naming a branch in a fetch means git touches that one and nothing else.',
      ].join('\n'),
    },
  ],
};

// --- 5. Pull arguments -------------------------------------------------------

const pullArgs = {
  id: 'remote-advanced-pull-args',
  name: 'Pull, by name',
  hint: 'One command. Give pull the branch name you would have given fetch, and it merges whatever that fetch just updated into the branch you are standing on.',
  compareMode: 'withOrigin',
  startTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'] },
    { main: ['C2', 'o/main'], 'o/main': 'C1' },
    'main',
    origin({ C0: [], C1: ['C0'], C3: ['C1'] }, { main: 'C1', release: 'C3' })
  ),
  goalTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C1'], C4: ['C2', 'C3'] },
    { main: ['C4', 'o/main'], 'o/main': 'C1', 'o/release': 'C3' },
    'main',
    origin({ C0: [], C1: ['C0'], C3: ['C1'] }, { main: 'C1', release: 'C3' })
  ),
  solutionCommand: 'git pull origin release',
  dialog: [
    {
      type: 'markdown',
      title: 'Pull inherits fetch arguments',
      markdown: [
        '`git pull` is fetch plus merge, so its argument is the fetch\'s argument. Name a branch and git fetches that branch, updates the matching `o/` label, then merges that label into whatever you are standing on.',
        '',
        '```',
        'git pull origin <branch>',
        '```',
        '',
        'The branch you name lives **on the remote**. It has nothing to do with the name of the branch you are on. A bare `git pull` only saves you from typing it, by reading your branch\'s upstream instead.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Take somebody else\'s branch into yours',
      markdown: [
        'The server has a `release` branch with a commit you do not have, and you have never fetched it, so there is no `o/release` on your side yet. Meanwhile you are on `main` with a commit of your own.',
        '',
        'One `git pull origin release` does the lot: it downloads the commit, creates `o/release`, and merges that into `main`. Neither side contains the other, so you get a real two-parent merge commit.',
        '',
        'Keep an eye on `o/main`. It does not move - you never asked about `main`.',
      ].join('\n'),
    },
  ],
};

// --- 6. Tracking -------------------------------------------------------------

const tracking = {
  id: 'remote-advanced-tracking',
  name: 'Setting an upstream',
  hint: 'Only the opening push has to spell out both halves of the refspec and record the upstream in the same breath. Once that is done, the bare form knows where to go.',
  compareMode: 'withOrigin',
  startTree: tree(
    { C0: [], C1: ['C0'] },
    { main: ['C1', 'o/main'], 'o/main': 'C1', side: 'C1' },
    'side',
    origin({ C0: [], C1: ['C0'] }, { main: 'C1' })
  ),
  goalTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'] },
    { main: ['C1', 'o/main'], 'o/main': 'C3', side: ['C3', 'o/main'] },
    'side',
    origin({ C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'] }, { main: 'C3' })
  ),
  solutionCommand: 'git commit; git push -u origin side:main; git commit; git push',
  dialog: [
    {
      type: 'markdown',
      title: 'The upstream',
      markdown: [
        'When a branch has a remote-tracking branch attached to it, git knows two things without being told: where a bare `git push` should send it, and what a bare `git pull` should merge in. That attachment is called the **upstream**.',
        '',
        '`git clone` sets one up for `main` automatically. A branch you create yourself has none, so a bare `git push` from it fails and complains that git does not know where to send anything. That is not git being difficult - it genuinely has no idea.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Recording it while you push',
      markdown: [
        'You attach the upstream on the first push:',
        '',
        '```',
        'git push -u origin <source>:<destination>',
        '```',
        '',
        '`-u` is short for `--set-upstream`. It performs the push and then remembers where the commits went, so every later push and pull from that branch can be typed bare.',
        '',
        'Here is the part that surprises people: the upstream belongs to your branch, not to its name. A local branch called `side` can be set to follow the server\'s `main`, and git will not argue with you about it.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Publish it under another name',
      markdown: [
        'You are on `side`, and `side` has no upstream. Four commands:',
        '',
        '1. commit',
        '2. `git push -u origin side:main` - publish to the server\'s `main` and record that as the upstream',
        '3. commit again',
        '4. a bare `git push`, which now knows exactly where to go',
        '',
        'A bare push right now will refuse, and its advice will be to publish a branch called `side`. Ignore that: it is guessing from the name, and it cannot know this work belongs on the server\'s `main`. Spell out both halves yourself.',
        '',
        'Afterwards, look at your local `main`. It never moved, so it now trails a server it is meant to mirror.',
      ].join('\n'),
    },
  ],
};

// --- 7. Capstone -------------------------------------------------------------

const capstone = {
  id: 'remote-advanced-capstone',
  name: 'The whole loop',
  hint: 'Every command here is one you have used before. The order is the whole lesson: nothing you send can be refused if your work already sits on top of what the server holds.',
  compareMode: 'withOrigin',
  startTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'] },
    {
      main: ['C1', 'o/main'],
      'o/main': 'C1',
      feature: ['C2', 'o/feature'],
      'o/feature': 'C1',
    },
    'feature',
    origin({ C0: [], C1: ['C0'], C3: ['C1'] }, { main: 'C3', feature: 'C1' })
  ),
  goalTree: tree(
    { C0: [], C1: ['C0'], C3: ['C1'], "C2'": ['C3'] },
    {
      main: ['C3', 'o/main'],
      'o/main': 'C3',
      feature: ["C2'", 'o/feature'],
      'o/feature': "C2'",
    },
    'feature',
    origin({ C0: [], C1: ['C0'], C3: ['C1'], "C2'": ['C3'] }, { main: 'C3', feature: "C2'" })
  ),
  solutionCommand: 'git fetch; git rebase o/main; git push; git branch -f main o/main',
  dialog: [
    {
      type: 'markdown',
      title: 'An ordinary afternoon',
      markdown: [
        'Everything at once, in the shape a normal day actually takes.',
        '',
        'You are on `feature` with one commit of your own. While you were writing it, the server\'s `main` picked up a commit from somebody else. Your `o/main` has not heard about it, and your local `main` is behind as well.',
        '',
        'The job: get the server\'s commit, rebuild your work on top of it, publish `feature`, and leave your local `main` matching the server.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Order matters more than the commands do',
      markdown: [
        'Fetch first. It is the only step that asks the server anything, and it moves `o/main` without touching a single branch of yours.',
        '',
        'Then rebase onto `o/main`, because after that fetch the label sits exactly where the server\'s `main` sits.',
        '',
        'Push once your work is on top of theirs, so the push only adds and cannot be refused.',
        '',
        'Finally move `main` onto `o/main`. It has no commits of its own to protect, so `git branch -f` is enough.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'The task',
      markdown: [
        '**Goal:** `feature` and `o/feature` on your replayed commit, `main` and `o/main` on the commit the server added, and the server\'s `feature` holding your work.',
        '',
        'Four commands, and you never check `main` out - `git branch -f main o/main` moves it from where you are standing.',
        '',
        'If a push is refused, you rebased onto the wrong thing. Check that the parent of your replayed commit really is the server\'s newest `main` commit, then try again.',
        '',
        'The commit you started with leaves the drawing once `feature` moves onto its copy. Real git would keep it, which is what makes replaying work nobody has pulled yet a safe habit.',
      ].join('\n'),
    },
  ],
};

export default {
  key: 'remote-advanced',
  name: 'Remote Mastery',
  group: 'Remote',
  about:
    'Arguments and refspecs for push, fetch and pull, what an upstream is really attached to, and a full round trip through a shared repository.',
  levels: [pushArgs, refspecs, fetchArgs, fetchNewPlace, pullArgs, tracking, capstone],
};
