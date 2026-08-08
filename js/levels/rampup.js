// "Finding Your Way" - how to say where you are and how to point somewhere else.
//
// The `tree` helper is duplicated in every sequence file on purpose, so each
// sequence stays a self-contained module with no shared imports.

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

const LINE_4 = ['C0', 'C1 C0', 'C2 C1', 'C3 C2'];
const LINE_5 = [...LINE_4, 'C4 C3'];

export default {
  key: 'rampup',
  name: 'Finding Your Way',
  group: 'Main',
  about:
    'HEAD, detached HEAD, and the relative references that let you point at a commit without ever reading an id off the screen. Then the two ways to undo.',
  levels: [
    // ---------------------------------------------------------------- 1
    {
      id: 'rampup-detached-head',
      name: 'Detaching HEAD',
      hint: 'A commit made while `HEAD` is detached has nothing pointing at it. Give it a label before you go anywhere else and it is safe.',
      compareMode: 'allBranchesHashAgnostic',
      startTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1'],
        branches: { main: 'C2' },
        head: 'main',
      }),
      goalTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1', 'C3 C1'],
        branches: { main: 'C2', experiment: 'C3' },
        head: 'C3',
      }),
      solutionCommand: 'git checkout C1; git commit; git branch experiment',
      dialog: [
        {
          type: 'markdown',
          title: 'HEAD is where you are standing',
          markdown: [
            'Every command needs to know which commit it should act on, and git keeps that answer',
            'in a pointer called `HEAD`.',
            '',
            'Almost all the time `HEAD` does not point at a commit directly. It points at a',
            '*branch name*, and the branch points at a commit. That extra hop is what makes',
            'committing work: git moves the branch forward to the new commit, and `HEAD` comes',
            'along for the ride because it is attached to the branch rather than to the commit.',
          ].join('\n'),
        },
        {
          type: 'demo',
          title: 'Checking where you are',
          markdown: [
            '`git status` answers the question directly: it names the branch you are on, or warns',
            'you that you are not on one.',
            '',
            'Try it now. It only reads the repository, so it is always safe to run and it will not',
            'disturb the level.',
          ].join('\n'),
          command: 'git status',
        },
        {
          type: 'markdown',
          title: 'Detaching',
          markdown: [
            'You can also aim `HEAD` straight at a commit by checking out its id:',
            '',
            '```',
            'git checkout C1',
            '```',
            '',
            'Now `HEAD` is *detached*: it names a commit with no branch in between. That is fine',
            'for looking around, and it is exactly what you want when you are about to do',
            'something surgical.',
            '',
            'The risk is that a commit made while detached has no branch pointing at it. Move away',
            'and this app stops drawing it, because nothing can reach it any more. Putting a branch',
            'on it fixes that for good.',
            '',
            'Real git is more forgiving here: the commit survives, and `git reflog` prints every',
            'commit `HEAD` has recently stood on, which is usually enough to find it again. That',
            'command does not exist in this app, so here a commit left behind really is gone.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Your task',
          markdown: [
            'Get the tree to look like the goal:',
            '',
            '1. Check out commit `C1` directly, so `HEAD` is detached.',
            '2. Make one commit there.',
            '3. Create a branch named `experiment` on that new commit.',
            '',
            '`main` should not move at all.',
            '',
            'Finish standing where step three leaves you: still detached, on the new commit, with',
            '`experiment` labelling it. Making the branch is the whole job. Checking it out as well',
            'would attach `HEAD` to a branch again, and the goal wants `HEAD` on the commit itself.',
          ].join('\n'),
        },
      ],
    },

    // ---------------------------------------------------------------- 2
    {
      id: 'rampup-caret',
      name: 'Stepping back with ^',
      hint: '`main^` is the parent of `main`. Two carets go back twice.',
      compareMode: 'allBranchesHashAgnostic',
      startTree: tree({
        commits: LINE_4,
        branches: { main: 'C3' },
        head: 'main',
      }),
      goalTree: tree({
        commits: LINE_4,
        branches: { main: 'C3', stable: 'C2', older: 'C1' },
        head: 'main',
      }),
      solutionCommand: 'git branch stable main^; git branch older main^^',
      dialog: [
        {
          type: 'markdown',
          title: 'Stop typing commit ids',
          markdown: [
            'Commit ids are fine for the computer and awful for people. Most of the time you do',
            'not mean *that exact id*, you mean something like "one before where I am now". Git',
            'has a short way to say that.',
            '',
            'Put a `^` after any reference and you get its parent:',
            '',
            '```',
            'main^      # the commit before main',
            'HEAD^      # the commit before where you are standing',
            'main^^     # two commits before main',
            '```',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'They work anywhere an id works',
          markdown: [
            'A relative reference is accepted anywhere a plain commit id is: check one out, start',
            'a branch from one, reset to one, merge one.',
            '',
            '```',
            'git branch old main^',
            '```',
            '',
            "That puts a branch called `old` on `main`'s parent without you reading a single id off",
            'the screen.',
            '',
            'One detail for later: when a commit has two parents, `^` follows the first of them and',
            '`^2` follows the second. Ordinary commits have only one parent, so plain `^` is never',
            'ambiguous there.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Your task',
          markdown: [
            'Get the tree to look like the goal by creating two branches, without typing a single',
            'commit id:',
            '',
            '- `stable` on the parent of `main`',
            '- `older` on the commit before that',
          ].join('\n'),
        },
      ],
    },

    // ---------------------------------------------------------------- 3
    {
      id: 'rampup-tilde',
      name: 'Counting back with ~',
      hint: 'Count with `~` instead of stacking carets, and remember that moving a branch which already exists needs `git branch -f`.',
      compareMode: 'allBranchesHashAgnostic',
      startTree: tree({
        commits: LINE_5,
        branches: { main: 'C4', keep: 'C4' },
        head: 'keep',
      }),
      goalTree: tree({
        commits: LINE_5,
        branches: { main: 'C1', keep: 'C4' },
        head: 'keep',
      }),
      solutionCommand: 'git branch -f main HEAD~3',
      dialog: [
        {
          type: 'markdown',
          title: 'Going back further',
          markdown: [
            'A caret is perfect for one step and tolerable for two. Counting out `main^^^^^` is not',
            'a good use of an afternoon, so git gives you `~` with a number:',
            '',
            '```',
            'main~1     # the same as main^',
            'main~3     # three commits back',
            'HEAD~5     # five commits back from where you are',
            '```',
            '',
            'The two operators can be chained in one reference, and they read left to right.',
            '`main~2^` means: go back two commits, then take the parent of that.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Branch labels are meant to move',
          markdown: [
            'Because a branch is only a label, pointing it somewhere else is routine rather than an',
            'emergency:',
            '',
            '```',
            'git branch -f some-branch HEAD~3',
            '```',
            '',
            'The `-f` is required. Git will not quietly relocate a branch that already exists, so',
            'you have to say that you meant it.',
            '',
            'Real git also refuses to force-move the branch you are standing on, and tells you to',
            'use `git reset` for that instead. This app lets it happen and prints a warning, so you',
            'can watch what it does. Do not expect that anywhere else.',
            '',
            'Nothing is destroyed when a label moves. The commits it used to point at are still in',
            'the repository, waiting for anything that still refers to them. If nothing does, this',
            'app quietly stops drawing them - reachable is the only reason a commit appears on the',
            'board. Here `keep` still holds on to them, so they stay in view.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Your task',
          markdown: [
            'Three commits were built on `main` by mistake. `keep` points at the same commit, so',
            'none of that work is actually in danger.',
            '',
            'You are standing on `keep`. Get the tree to look like the goal by moving `main` back',
            'three commits, using a relative reference rather than a commit id.',
          ].join('\n'),
        },
      ],
    },

    // ---------------------------------------------------------------- 4
    {
      id: 'rampup-reset-revert',
      name: 'Undoing work: reset versus revert',
      hint: 'Use `git reset` on the private branch and `git revert` on the shared one.',
      compareMode: 'allBranches',
      startTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1', 'C3 C1'],
        branches: { local: 'C2', shared: 'C3' },
        head: 'local',
      }),
      goalTree: tree({
        commits: ['C0', 'C1 C0', 'C3 C1', "C3' C3"],
        branches: { local: 'C1', shared: "C3'" },
        head: 'shared',
      }),
      solutionCommand: 'git reset HEAD~1; git checkout shared; git revert HEAD',
      dialog: [
        {
          type: 'markdown',
          title: 'Two different kinds of undo',
          markdown: [
            'The last commit was a mistake. Git offers two answers, and picking the wrong one is a',
            'classic way to make a mess for other people.',
            '',
            '`git reset` rewinds a branch label to an earlier commit. The bad commit is not erased,',
            'but nothing points at it any more, so as far as that branch is concerned it never',
            'happened. Watch the board when you run it: with no label able to reach that commit,',
            'this app stops drawing it. That is the same disappearing act you triggered while `HEAD`',
            'was detached, and it has the same way back out of it in a real repository.',
            '',
            '`git revert` leaves history alone and adds a *new* commit that undoes the changes of',
            'the old one. The mistake stays visible in the log with its cancellation right after.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Which one to use',
          markdown: [
            'The dividing line is simple: does anybody else already have these commits?',
            '',
            // One list item per line: the markdown subset has no continuation lines.
            '- Still only on your machine: `reset` is fine. Rewriting history nobody has seen costs nothing.',
            '- Already pushed or shared: use `revert`. Resetting a branch other people have leaves their history disagreeing with yours, and the next push turns into an argument.',
            '',
            '```',
            'git reset HEAD~1     # rewind this branch by one commit',
            'git revert HEAD      # add a commit that cancels this one',
            '```',
            '',
            "The revert lands as a new commit drawn `C3'`. Read that apostrophe carefully: earlier",
            'it meant *a copy of*, and this is not one. A revert commit is the opposite of `C3` - it',
            'contains the changes needed to cancel it. The apostrophe here only says "made from',
            '`C3`", not "the same as `C3`".',
            '',
            'One more real-git detail. `git reset` takes `--soft`, `--mixed` or `--hard`, and they',
            'differ only in what happens to your files: `--soft` keeps your changes staged, `--mixed`',
            'keeps them but unstaged, `--hard` throws them away. There are no files in this app, so',
            'all three do the same single thing here - move the label - and the terminal will say so',
            'if you use one.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Your task',
          markdown: [
            'Both branches have one commit too many. Get the tree to look like the goal:',
            '',
            '- `local` has never left this machine. Rewind it by one commit.',
            '- `shared` is public. Cancel its last commit by adding to history instead of rewriting it.',
            '',
            'You start on `local`, and you should finish standing on `shared`.',
            '',
            'That finishing position is part of the goal, not a detail. The cancelling commit has to',
            'be made while you are standing on `shared` anyway, so doing the rewind first and moving',
            'across afterwards leaves you in the right place with nothing extra to type. Do it the',
            'other way round and the picture will be correct while `HEAD` is in the wrong spot, which',
            'reads as an unsolved level for a reason nobody enjoys hunting for.',
          ].join('\n'),
        },
      ],
    },
  ],
};
