// Sequence: Working With Others. First contact with remotes - clone, remote
// tracking branches, fetch, pull, push, and what to do when the server says no.
//
// Tree convention (see CONTRACT.md section 1): the local repository carries an
// `originTree` describing the server, and `o/<branch>` labels are the local
// record of where the server's branches were last seen.

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

/** The server side of a level: same shape, never has remote-tracking branches. */
function origin(commitSpec, branchSpec, head = 'main') {
  return tree(commitSpec, branchSpec, head);
}

// --- 1. Cloning --------------------------------------------------------------

const clone = {
  id: 'remote-intro-clone',
  name: 'Making a copy',
  hint: 'One command: `git clone`.',
  compareMode: 'withOrigin',
  startTree: tree({ C0: [], C1: ['C0'] }, { main: 'C1' }, 'main'),
  goalTree: tree(
    { C0: [], C1: ['C0'] },
    { main: ['C1', 'o/main'], 'o/main': 'C1' },
    'main',
    origin({ C0: [], C1: ['C0'] }, { main: 'C1' })
  ),
  solutionCommand: 'git clone',
  dialog: [
    {
      type: 'markdown',
      title: 'A second copy',
      markdown: [
        'Everything up to now happened in one repository on one machine. A **remote** is a second copy of the same repository, usually on a server everybody can reach.',
        '',
        'Nothing magic happens when you add one. A remote is just another repository, with its own branches, that you can send commits to and take commits from.',
        '',
        '`git clone` makes that second copy. In real life you clone the server down to your laptop. Here we do it the other way round, so that both repositories can be drawn at once: you already have the repository, and cloning creates the server.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Run it and look at what appears',
      markdown: [
        'Type `git clone`.',
        '',
        'Two things show up. A second repository appears, drawn in its own panel and labelled **origin** - simply the name git gives the remote it cloned from. Nothing more is implied by it.',
        '',
        'And in your own repository there is a new label: `o/main`. It is not a copy of your `main`, and it is not the server\'s branch either. It is your own note of where the server\'s `main` was the last time the two of you spoke. The next few levels all come back to that one sentence.',
      ].join('\n'),
    },
  ],
};

// --- 2. What o/main is -------------------------------------------------------

const remoteBranches = {
  id: 'remote-intro-remote-branches',
  name: 'What o/main really is',
  hint: 'Just `git commit` twice. `o/main` will not move, and that is the lesson.',
  compareMode: 'withOrigin',
  startTree: tree(
    { C0: [], C1: ['C0'] },
    { main: ['C1', 'o/main'], 'o/main': 'C1' },
    'main',
    origin({ C0: [], C1: ['C0'] }, { main: 'C1' })
  ),
  goalTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'] },
    { main: ['C3', 'o/main'], 'o/main': 'C1' },
    'main',
    origin({ C0: [], C1: ['C0'] }, { main: 'C1' })
  ),
  solutionCommand: 'git commit; git commit',
  dialog: [
    {
      type: 'markdown',
      title: 'A label that records a fact',
      markdown: [
        '`o/main` looks like a branch and moves like a branch, but you never work on it directly. Its job is to record one fact:',
        '',
        '> The last time I talked to the server, its `main` was here.',
        '',
        'That is why it does not budge when you commit. Your commit happened on your machine, the server has not heard about it, and the recorded fact has not changed. `o/main` only moves when git genuinely talks to the remote.',
        '',
        'The `o/` prefix is this app\'s short form. Real git writes it `origin/main`.',
      ].join('\n'),
    },
    {
      type: 'demo',
      title: 'Commit and watch',
      command: 'git commit',
      markdown: [
        'There it is. `main` stepped forward, `o/main` did not, and the origin repository is untouched.',
        '',
        'You are now one commit ahead of the server, and git knows that precisely, because it has two local labels to compare.',
        '',
        'This is also how git can tell you "your branch is ahead of origin/main by 1 commit" the instant you ask, without touching the network. It is reading `main` and `o/main` and subtracting.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Open the gap',
      markdown: [
        'Make one more commit, so `main` ends up two commits ahead of `o/main`.',
        '',
        'Nothing is sent anywhere, and that is the point of the level. Work piles up locally until you deliberately push it, and the distance between `main` and `o/main` is exactly the size of the pile.',
        '',
        'One last thing about `o/main`: it is not somewhere you can stand and work. Check it out, here or in real git, and you land on a detached `HEAD`, because a record of where somebody else\'s branch was has no business carrying your next commit. Try it once the level is done - `git checkout main` brings you back.',
      ].join('\n'),
    },
  ],
};

// --- 3. Fetch ----------------------------------------------------------------

const fetch = {
  id: 'remote-intro-fetch',
  name: 'Bringing commits down',
  hint: 'One command: `git fetch`. Do not expect `main` to move.',
  compareMode: 'withOrigin',
  startTree: tree(
    { C0: [], C1: ['C0'] },
    { main: ['C1', 'o/main'], 'o/main': 'C1' },
    'main',
    origin({ C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'] }, { main: 'C3' })
  ),
  goalTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'] },
    { main: ['C1', 'o/main'], 'o/main': 'C3' },
    'main',
    origin({ C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'] }, { main: 'C3' })
  ),
  solutionCommand: 'git fetch',
  dialog: [
    {
      type: 'markdown',
      title: 'The server moved on',
      markdown: [
        'While you were away, the server\'s `main` picked up two commits. Your repository has not noticed - look at `o/main`, still parked where it was.',
        '',
        '`git fetch` is the command that goes and asks. It does two things, and only two:',
        '',
        '1. downloads commits the remote has and you do not',
        '2. updates your remote-tracking branches to match what it found',
        '',
        'It does not touch `main`. It does not touch anything you are working on. After a fetch your files are exactly as they were.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Fetch is the safe one',
      markdown: [
        'Run `git fetch`.',
        '',
        'The two new commits appear in your repository and `o/main` slides forward onto the newest of them. Your own `main` stays put, which looks unhelpful until you notice it is the entire feature: fetching cannot break anything. You can do it at any moment, mid-task, with unfinished work everywhere.',
        '',
        'Getting those commits into `main` is a separate decision and a separate command. That is the next level.',
      ].join('\n'),
    },
  ],
};

// --- 4. Pull -----------------------------------------------------------------

const pull = {
  id: 'remote-intro-pull',
  name: 'Fetch, then merge',
  hint: 'One command: `git pull`. It fetches first, then merges `o/main` into `main`.',
  compareMode: 'withOrigin',
  startTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'] },
    { main: ['C2', 'o/main'], 'o/main': 'C1' },
    'main',
    origin({ C0: [], C1: ['C0'], C3: ['C1'] }, { main: 'C3' })
  ),
  goalTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C1'], C4: ['C2', 'C3'] },
    { main: ['C4', 'o/main'], 'o/main': 'C3' },
    'main',
    origin({ C0: [], C1: ['C0'], C3: ['C1'] }, { main: 'C3' })
  ),
  solutionCommand: 'git pull',
  dialog: [
    {
      type: 'markdown',
      title: 'The second half of the job',
      markdown: [
        'After a fetch, the new commits sit in your repository but none of your branches point at them. You still have to join them to your work.',
        '',
        '`git merge o/main` is the ordinary way to do that. `o/main` is a perfectly normal ref, so merging it is a perfectly normal merge - there is no special remote version of the command.',
        '',
        'Doing those two steps by hand every time gets tedious, so git bundles them. `git pull` is fetch followed by merge, and nothing else.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'What this pull will build',
      markdown: [
        'These two are the same thing:',
        '',
        '```',
        'git fetch',
        'git merge o/main',
        '```',
        '',
        'and `git pull`.',
        '',
        'Right now you have one commit the server has never seen, and the server has one you have never seen. Neither side contains the other, so the merge cannot be a simple slide forward. It will build a merge commit with two parents, one from each side.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Pull it in',
      markdown: [
        'Run `git pull` and read the result in order.',
        '',
        '`o/main` moves first, because the fetch happens first. Then the merge commit appears on `main`, with your commit as one parent and the server\'s commit as the other.',
        '',
        'Notice what did not happen: the origin repository is unchanged. Pulling brings work **in**. Nothing you do locally reaches the server until you push, which is two levels away.',
      ].join('\n'),
    },
  ],
};

// --- 5. A teammate got there first ------------------------------------------

const teammate = {
  id: 'remote-intro-teammate',
  name: 'Someone got there first',
  hint: 'Ask the server what it has before you decide where your own commit belongs. Once `o/main` has moved, it is an ordinary ref and an ordinary rebase target.',
  compareMode: 'withOrigin',
  startTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'] },
    { main: ['C2', 'o/main'], 'o/main': 'C1' },
    'main',
    origin({ C0: [], C1: ['C0'], C3: ['C1'], C4: ['C3'] }, { main: 'C4' })
  ),
  goalTree: tree(
    { C0: [], C1: ['C0'], C3: ['C1'], C4: ['C3'], "C2'": ['C4'] },
    { main: ["C2'", 'o/main'], 'o/main': 'C4' },
    'main',
    origin({ C0: [], C1: ['C0'], C3: ['C1'], C4: ['C3'] }, { main: 'C4' })
  ),
  solutionCommand: 'git fetch; git rebase o/main',
  dialog: [
    {
      type: 'markdown',
      title: 'Two people, one starting point',
      markdown: [
        'The server\'s `main` has picked up two commits from somebody else while you were writing one of your own. Theirs are on the server, yours is on your laptop, and all three were built on the same commit.',
        '',
        'How work gets up there is the next level. All that matters here is that it is already up there, and that this is the everyday shape of working with other people. Nothing is broken. There is simply work on each side that the other side has never seen.',
        '',
        'Your `o/main` is still telling the old story, because you have not spoken to the server since before any of it arrived.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Merge or rebase',
      markdown: [
        'You have a choice about how to join the two lines up.',
        '',
        'A **merge** keeps both lines and adds a commit tying them together. It is honest, and it never rewrites anything.',
        '',
        'A **rebase** picks your commit up and replays it on top of theirs, so the history reads as though you had waited for them. One straight line, no merge commit, but your original commit is replaced by a copy.',
        '',
        'Neither is wrong. Teams pick one and stay consistent.',
        '',
        'Both can also stop and ask you to settle a conflict by hand, and the rebase can ask once for every commit it replays. Nothing in this app has file contents, so neither of them will ask you here.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Do it in two steps',
      markdown: [
        'Take the rebase route, and split it so you can watch both halves.',
        '',
        'First `git fetch`. Their two commits arrive and `o/main` moves onto the newer one. Your `main` will not move; it never does on a fetch.',
        '',
        'Then `git rebase o/main`. A remote-tracking branch is an ordinary ref, so this is the same rebase you have done before. Your commit is lifted off its old base and laid back down on top of theirs.',
        '',
        'Your original leaves the drawing as the copy replaces it, since nothing can reach it any more. Real git keeps it and `git reflog` lists it for weeks, which is the safety net that makes replaying your own unpushed work a cheap habit.',
        '',
        '`git pull --rebase` does both steps in one command once you trust it.',
      ].join('\n'),
    },
  ],
};

// --- 6. Push -----------------------------------------------------------------

const push = {
  id: 'remote-intro-push',
  name: 'Sending it back',
  hint: 'One command: `git push`. Watch `o/main` move at the same time as the server.',
  compareMode: 'withOrigin',
  startTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'] },
    { main: ['C3', 'o/main'], 'o/main': 'C1' },
    'main',
    origin({ C0: [], C1: ['C0'] }, { main: 'C1' })
  ),
  goalTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'] },
    { main: ['C3', 'o/main'], 'o/main': 'C3' },
    'main',
    origin({ C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'] }, { main: 'C3' })
  ),
  solutionCommand: 'git push',
  dialog: [
    {
      type: 'markdown',
      title: 'The mirror image of fetch',
      markdown: [
        'You have commits the server does not. `git push` uploads them and asks the server to move its `main` onto the newest one.',
        '',
        'If the server agrees, two labels move at the same moment: the server\'s `main` in the origin repository, and your `o/main` at home. That second one is easy to miss. `o/main` is not updated only by fetching - **any** successful conversation with the server updates it, because your record of the server has just stopped being out of date.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Send the pile',
      markdown: [
        'Two of your commits have never been seen by anybody else. Send them with `git push`.',
        '',
        'Three things move: the commits appear in the origin repository, the server\'s `main` lands on the newest one, and your `o/main` catches up to match.',
        '',
        'Afterwards `main` and `o/main` sit on the same commit. That is git\'s way of saying there is nothing left to push.',
        '',
        'Push is the first command in this sequence that changes the origin repository at all.',
      ].join('\n'),
    },
  ],
};

// --- 7. Diverged -------------------------------------------------------------

const diverged = {
  id: 'remote-intro-diverged',
  name: 'When push is refused',
  hint: 'A push is only ever allowed to add. Make their commit part of your own history, in the flavour that replays instead of merging, and the same push is accepted.',
  compareMode: 'withOrigin',
  startTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'], C3: ['C2'] },
    { main: ['C3', 'o/main'], 'o/main': 'C1' },
    'main',
    origin({ C0: [], C1: ['C0'], C4: ['C1'] }, { main: 'C4' })
  ),
  goalTree: tree(
    { C0: [], C1: ['C0'], C4: ['C1'], "C2'": ['C4'], "C3'": ["C2'"] },
    { main: ["C3'", 'o/main'], 'o/main': "C3'" },
    'main',
    origin({ C0: [], C1: ['C0'], C4: ['C1'], "C2'": ['C4'], "C3'": ["C2'"] }, { main: "C3'" })
  ),
  solutionCommand: 'git pull --rebase; git push',
  dialog: [
    {
      type: 'markdown',
      title: 'Why the server says no',
      markdown: [
        'You have two commits the server does not. The server has one you do not. Now imagine pushing.',
        '',
        'The server would have to move its `main` onto a commit that does not have the current `main` in its history. The commit somebody else pushed would fall off the end and disappear for anybody who has not fetched it yet. Git refuses to do that quietly.',
        '',
        'The rule is short: a push is allowed when it only **adds** to what the server already has.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'The fix is always the same shape',
      markdown: [
        'Bring their work down, put yours on top of it, then push a history that only adds. You have met both halves already, and one command runs the pair - the level about the teammate who got there first ended by naming it.',
        '',
        'Once your `main` contains their commit, the push only adds, so the server takes it without an argument. Merging instead works too; it just leaves a merge commit in the middle of what could have been a straight line.',
        '',
        'There is one other button, worth knowing about mostly so you can leave it alone. `git push -f` marks the update as forced, asking the server to move its branch even though your history does not contain what is sitting there. If it agrees, the other commit stops being reachable and everybody who has not fetched it loses their only pointer to it.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Land your work',
      markdown: [
        'Get both of your commits onto the server, and leave the history as one straight line - so use the rebase form, not the merge form.',
        '',
        'Two commands, and neither of them is `-f`. Try the bare `git push` if you want to see the refusal; nothing bad happens, git just says no and changes nothing.',
        '',
        'Both of your originals leave the drawing as the replayed copies take their place. That is this app being strict; real git keeps them.',
        '',
        'When you are finished, `main`, `o/main` and the server\'s `main` should all be sitting on the same commit, with your work at the top of it.',
      ].join('\n'),
    },
  ],
};

// --- 8. Landing work the project will accept ---------------------------------

const wrongBranch = {
  id: 'remote-intro-wrong-branch',
  name: 'Right commit, wrong branch',
  hint: 'The server will take this commit on `feature`. You already know a command that copies one named commit onto the branch you are standing on - and afterwards `main` should mirror `o/main` rather than lead it.',
  compareMode: 'withOrigin',
  // origin declines direct pushes here, which is the whole premise of the level.
  protectedRefs: ['main'],
  startTree: tree(
    { C0: [], C1: ['C0'], C2: ['C1'] },
    {
      main: ['C2', 'o/main'],
      'o/main': 'C1',
      feature: ['C1', 'o/feature'],
      'o/feature': 'C1',
    },
    'main',
    origin({ C0: [], C1: ['C0'] }, { main: 'C1', feature: 'C1' })
  ),
  goalTree: tree(
    { C0: [], C1: ['C0'], "C2'": ['C1'] },
    {
      main: ['C1', 'o/main'],
      'o/main': 'C1',
      feature: ["C2'", 'o/feature'],
      'o/feature': "C2'",
    },
    'feature',
    origin({ C0: [], C1: ['C0'], "C2'": ['C1'] }, { main: 'C1', feature: "C2'" })
  ),
  solutionCommand: 'git checkout feature; git cherry-pick main; git push; git branch -f main o/main',
  dialog: [
    {
      type: 'markdown',
      title: 'A door that does not open',
      markdown: [
        'This project does not accept pushes straight to `main`. The refusal happens on the server, before anything is written, so it does not matter how tidy your history is.',
        '',
        '`-f` will not help either, and it is worth being exact about why: force does two things, and only one of them is yours to decide.',
        '',
        'It switches off the check your own git makes before it sends anything. Your git reads the ref values the remote currently holds, works out locally whether your update would only add to them, and refuses on the spot if it would not. Force removes that refusal, so the request really is sent.',
        '',
        'It also marks the update as forced, which is a request that the server accept a history not built on what it already holds. The first half always works. The second is only ever a request, and this server has already decided.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Three moves',
      markdown: [
        'Changes here are expected to arrive on a branch and be merged after review. You committed onto `main` out of habit; the commit itself is good, and only its address is wrong. A branch called `feature` already exists on both sides, waiting for exactly this.',
        '',
        'Nothing new is needed. You have done every piece of this before.',
        '',
        'Your commit has to exist on `feature`, and you already know a command that copies a named commit onto the branch you are standing on. A branch name works fine as the ref: `main` means whatever `main` currently points at.',
        '',
        'Then publish it. `feature` already tracks the server\'s `feature`, so the bare form of push finds the right destination on its own.',
        '',
        'Finally `main` has to stop leading and go back to mirroring `o/main`.',
      ].join('\n'),
    },
    {
      type: 'markdown',
      title: 'Land it another way',
      markdown: [
        'Four commands, in this order: move onto `feature`, copy the commit across, push, then put `main` back level with `o/main`.',
        '',
        'Try a bare `git push` from `main` first if you want to hear the refusal in the server\'s own words. Nothing is harmed by asking.',
        '',
        'When you are done, your commit lives on `feature` in both repositories and `main` agrees with `o/main` again. The commit you originally made on `main` disappears from the drawing at that moment, because the copy on `feature` is the one everybody will use from now on.',
        '',
        'That vanishing is this app rather than git. Real git keeps the original; here nothing can reach it, so nothing draws it.',
      ].join('\n'),
    },
  ],
};

export default {
  key: 'remote-intro',
  name: 'Working With Others',
  group: 'Remote',
  about:
    'Clone, remote-tracking branches, fetch, pull and push - what lives on your machine, what lives on the server, and how the two stay in step.',
  levels: [clone, remoteBranches, fetch, pull, teammate, push, diverged, wrongBranch],
};
