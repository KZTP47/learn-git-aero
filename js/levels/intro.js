// "First Steps" - the four ideas every other sequence builds on.
//
// The small `tree` helper below is duplicated in each sequence file on purpose:
// a sequence must stay a single self-contained module with no shared imports.

/**
 * Compact TreeJSON builder.
 * @param {object} spec
 * @param {string[]} spec.commits  entries of the form "C1 C0" or "C4 C3,C2" (merge)
 * @param {object}   spec.branches map of branch name -> commit id
 * @param {object}   [spec.tags]   map of tag name -> commit id
 * @param {string}   spec.head     branch name, or a commit id for a detached HEAD
 */
function tree({ commits, branches, tags, head }) {
  const out = { commits: {}, branches: {}, tags: {}, HEAD: { id: 'HEAD', target: head } };
  for (const entry of commits) {
    const [id, parentList] = entry.split(/\s+/);
    const parents = parentList ? parentList.split(',') : [];
    out.commits[id] = parents.length ? { id, parents } : { id, parents: [], rootCommit: true };
  }
  for (const [id, target] of Object.entries(branches)) {
    out.branches[id] = { id, target, remoteTrackingBranchID: null };
  }
  for (const [id, target] of Object.entries(tags || {})) {
    out.tags[id] = { id, target };
  }
  return out;
}

// A fork used by both the merge and the rebase level: one commit on each side.
const FORK = ['C0', 'C1 C0', 'C2 C1', 'C3 C1'];

export default {
  key: 'intro',
  name: 'First Steps',
  group: 'Main',
  about:
    'Commits, branches, merging and rebasing. Four ideas that carry most of the weight in everyday git.',
  levels: [
    // ---------------------------------------------------------------- 1
    {
      id: 'intro-commits',
      name: 'Making commits',
      hint: 'Type `git commit`, then type it again.',
      compareMode: 'allBranchesHashAgnostic',
      startTree: tree({ commits: ['C0'], branches: { main: 'C0' }, head: 'main' }),
      goalTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1'],
        branches: { main: 'C2' },
        head: 'main',
      }),
      solutionCommand: 'git commit; git commit',
      dialog: [
        {
          type: 'markdown',
          title: 'A commit is a saved moment',
          markdown: [
            "Git keeps your project's history as a chain of snapshots called *commits*. Each",
            'commit holds the state of every file at one moment, and it also remembers which',
            "commit came just before it. That backwards pointer is the commit's *parent*.",
            '',
            'Nothing in the chain is ever edited in place. Saving new work adds a new commit on',
            'the end and links it back. The older commits stay exactly as they were, which is why',
            'you can always go back and see what the project looked like at any point.',
            '',
            'A history of three commits has this shape, newest at the top:',
            '',
            '```',
            'C2      the newest commit',
            '|',
            'C1',
            '|',
            'C0      the first commit',
            '```',
            '',
            'The board behind this panel draws the same thing: one circle per commit, one line per',
            'parent link. Close the panel whenever you want to look at it.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'What ends up inside a commit',
          markdown: [
            'A commit does not automatically hold everything you changed. It holds what you',
            '*staged*.',
            '',
            'Real git keeps a holding area between your files and your history. Editing a file puts',
            'nothing in it. `git add <file>` copies that file, exactly as it looks at that moment,',
            'into the holding area. `git commit` then seals whatever is sitting there into a new',
            'commit.',
            '',
            'The commit does not wipe the holding area. It goes on holding the whole project, now',
            'matching the commit you have just made. That is why `git status` falls quiet straight',
            'afterwards: your files, the holding area and the newest commit all agree, so there is',
            'nothing to report until you change something else.',
            '',
            'That middle step exists so you can choose. Change six files, stage two of them, commit',
            'those two, and the other four wait for later. Until you commit, `git status` lists the',
            'groups separately: staged and ready to go, or changed but not staged yet.',
            '',
            'This app has no files, so it has no holding area and `git add` is not a command here.',
            'Every `git commit` invents a small change and commits it. Skipping the step is fine.',
            'Not knowing what you are skipping is what catches people out later.',
          ].join('\n'),
        },
        {
          type: 'demo',
          title: 'Making one',
          markdown: [
            '`git commit` records the work you have staged as a brand new commit, placed directly',
            'on top of the commit you are on. The branch label you are standing on travels with',
            'you, so it always points at your newest work.',
            '',
            'There is nothing to stage here, so one small change is invented for you. Try it.',
            '',
            '> Running this really does change your repository. Type `reset` if you want the',
            '> starting state back before you begin the task.',
          ].join('\n'),
          command: 'git commit',
        },
        {
          // The two commands below are the whole answer, deliberately. This is
          // the first level of the first sequence: the reader has never typed a
          // git command and the lesson is the command itself, not working out
          // which one it is. Every later level keeps its answer out of the
          // slides and behind the hint and solution buttons.
          type: 'markdown',
          title: 'Your task',
          markdown: [
            'Get the tree to look like the goal by making two commits on `main`.',
            '',
            '```',
            'git commit',
            'git commit',
            '```',
            '',
            'Type `show goal` whenever you want the target tree on screen next to yours.',
          ].join('\n'),
        },
      ],
    },

    // ---------------------------------------------------------------- 2
    {
      id: 'intro-branching',
      name: 'Branching',
      hint: '`git checkout -b feature` creates the branch and moves onto it in one step.',
      compareMode: 'allBranchesHashAgnostic',
      startTree: tree({
        commits: ['C0', 'C1 C0'],
        branches: { main: 'C1' },
        head: 'main',
      }),
      goalTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1'],
        branches: { main: 'C1', feature: 'C2' },
        head: 'feature',
      }),
      solutionCommand: 'git checkout -b feature; git commit',
      dialog: [
        {
          type: 'markdown',
          title: 'A branch is just a label',
          markdown: [
            'A branch is not a copy of your project. It is a small movable label that points at',
            'one commit, and that is genuinely all it is. Creating one writes a handful of bytes,',
            'which is why branching in git is cheap enough to do for every idea you try.',
            '',
            'While you are standing on a branch, every commit you make moves the label forward for',
            'you. Two labels are allowed to sit on the same commit; they stay together until one',
            'of them moves.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Create it, then stand on it',
          markdown: [
            '`git branch feature` makes the label but leaves you where you are. To work on it you',
            'also need `git checkout feature`, which moves you there so your next commit lands on',
            'that branch.',
            '',
            'Those two steps go together so often that git has a shortcut:',
            '',
            '```',
            'git checkout -b feature',
            '```',
            '',
            'That creates the branch and moves onto it at once. `git switch -c feature` is the',
            'newer spelling of exactly the same thing.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Your task',
          markdown: [
            'Get the tree to look like the goal by creating a branch named `feature`, moving onto',
            'it, and making one commit there.',
            '',
            'When you are done, `main` should still point at the commit it started on, and',
            '`feature` should point at a new commit sitting on top of it.',
          ].join('\n'),
        },
      ],
    },

    // ---------------------------------------------------------------- 3
    {
      id: 'intro-merging',
      name: 'Merging branches',
      hint: 'Stand on the branch that should receive the work, then merge the other one into it.',
      compareMode: 'allBranchesHashAgnostic',
      disabledCommands: ['git rebase'],
      startTree: tree({
        commits: FORK,
        branches: { main: 'C3', feature: 'C2' },
        head: 'main',
      }),
      goalTree: tree({
        commits: [...FORK, 'C4 C3,C2'],
        branches: { main: 'C4', feature: 'C2' },
        head: 'main',
      }),
      solutionCommand: 'git merge feature',
      dialog: [
        {
          type: 'markdown',
          title: 'Two lines of work, one project',
          markdown: [
            'As soon as two branches each hold commits the other does not, the history has a fork',
            'in it. Neither side is wrong. They simply grew apart while two people, or two of your',
            'own afternoons, worked in parallel.',
            '',
            'Merging is how you bring them back together, and it throws neither side away. It',
            'creates one new commit whose whole job is to say: *everything from both sides is',
            'included from here on*. That commit has two parents instead of the usual one, which',
            'is what closes the fork in the diagram.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Direction matters',
          markdown: [
            '`git merge` always merges *into* the branch you are standing on. So the order is:',
            'check out the branch that should receive the work, then name the branch you want to',
            'pull in.',
            '',
            '```',
            'git checkout main',
            'git merge feature',
            '```',
            '',
            'Afterwards `main` points at the new merge commit and `feature` has not moved at all.',
            '',
            'If your branch has no commits of its own since the fork, there is nothing to combine.',
            'Git then just slides your label forward to the other branch. That shortcut is called',
            'a fast-forward.',
            '',
            'One thing this app cannot show you. A merge only goes through untouched when the two',
            'sides changed different things. When both sides edited the same lines of the same file,',
            'git cannot decide for you: it stops halfway, writes both versions into the file with',
            'markers around them, and leaves the merge unfinished until you edit those spots by hand',
            'and commit the result. That is a *conflict*. It is an ordinary part of the job rather',
            'than a failure, and git will hand you a way to back out of one if you would rather deal',
            'with it another day.',
            '',
            'There are no file contents in this app, so every merge here lands first time. Do not',
            'read that as a promise.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Your task',
          markdown: [
            'You are standing on `main`. `feature` has one commit that `main` does not have, and',
            '`main` has one that `feature` does not.',
            '',
            'Get the tree to look like the goal by merging `feature` into `main`, so a single',
            'merge commit closes the fork.',
            '',
            '`git rebase` is switched off for this level, because it is the other answer to this',
            'exact fork and it gets a level of its own next. This one is about the merge.',
          ].join('\n'),
        },
      ],
    },

    // ---------------------------------------------------------------- 4
    {
      id: 'intro-rebase',
      name: 'Rebasing instead of merging',
      hint: 'Rebasing is the whole answer, used once in each direction. The second time there is nothing left to replay.',
      compareMode: 'allBranchesHashAgnostic',
      startTree: tree({
        commits: FORK,
        branches: { main: 'C3', feature: 'C2' },
        head: 'feature',
      }),
      // The original C2 is left with nothing pointing at it once the copy exists,
      // so it is not in the goal picture either.
      goalTree: tree({
        commits: ['C0', 'C1 C0', 'C3 C1', "C2' C3"],
        branches: { main: "C2'", feature: "C2'" },
        head: 'main',
      }),
      solutionCommand: 'git rebase main; git checkout main; git rebase feature',
      dialog: [
        {
          type: 'markdown',
          title: 'A different way to combine',
          markdown: [
            'Merging joins two lines of work with a new commit. Rebasing does something else: it',
            'takes the commits that only exist on your branch and makes fresh copies of them on',
            'top of another branch. The result is one straight line, as though you had done your',
            'work last.',
            '',
            'The word *copies* matters. The originals are not moved and not deleted; they are just',
            'left with nothing pointing at them. The new commits are genuinely new, with new ids.',
            "The diagram marks a copy with an apostrophe, so a copy of `C2` shows up as `C2'`.",
            '',
            'Which brings up something about the picture. This app draws a commit only while some',
            'label can still reach it. The moment `feature` moves to the copy, nothing points at the',
            'original `C2` any more, so `C2` disappears from the board as the rebase lands. It is not',
            'in the goal picture either, for the same reason.',
            '',
            'Real git is less dramatic. The commit stays in the repository, and `git reflog` lists',
            'every commit `HEAD` has recently stood on, so you can put a branch back on it for a',
            'while afterwards. `git reflog` is not one of the commands here, but it is the first',
            'thing to type when a commit seems to have gone missing in a real repository.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Straight history, with a catch',
          markdown: [
            'A linear history is easier to read, and that is the main reason people rebase.',
            '',
            'The catch is that rebasing replaces commits with different ones. If a teammate',
            'already has the originals, their history and yours no longer agree, and sorting that',
            'out costs everybody an afternoon. The usual rule is: rebase work that is still only',
            'yours, and merge once the commits have been shared.',
            '',
            '```',
            'git checkout feature',
            'git rebase main',
            '```',
            '',
            "That replays `feature`'s own commits on top of `main`.",
            '',
            'The second catch is the one that turns a two-second command into an afternoon. Every',
            'replayed commit is applied to a file it was never written against, so a rebase can hit',
            'the same conflict a merge would - except that a merge asks you once, and a rebase asks',
            'once per commit it replays. Git stops at the first one it cannot settle and waits',
            'for you. `git rebase --continue` carries on afterwards, and `git rebase --abort` puts',
            'everything back exactly as it was.',
            '',
            'Nothing in this app has file contents, so no rebase here will ever stop to ask. Real',
            'ones stop often, and a long branch replayed onto a base that has moved a long way is',
            'the classic case.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Your task',
          markdown: [
            'You are standing on `feature`. Get the tree to look like the goal by rebasing',
            '`feature` on top of `main`, and then bringing `main` up to that same final commit.',
            '',
            'For the second half, stand on `main` and rebase it onto `feature`. There is nothing',
            'left to replay by then, so git simply slides the label forward.',
          ].join('\n'),
        },
      ],
    },
  ],
};
