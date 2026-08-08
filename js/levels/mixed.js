// "The Toolbox Drawer" - tags, describe, deleting branches, restacking, capstone.
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

const LINE_5 = ['C0', 'C1 C0', 'C2 C1', 'C3 C2', 'C4 C3'];
const LINE_6 = [...LINE_5, 'C5 C4'];

export default {
  key: 'mixed',
  name: 'The Toolbox Drawer',
  group: 'Main',
  about:
    'Permanent labels, working out where you are, clearing away branches you have finished with, and putting all of it together on a repository that has gone sideways.',
  levels: [
    // ---------------------------------------------------------------- 1
    {
      id: 'mixed-tags',
      name: 'Tags',
      hint: '`git tag <name> <commit>` pins a name to a commit that will never move.',
      compareMode: 'allBranchesAndTags',
      startTree: tree({
        commits: LINE_5,
        branches: { main: 'C4' },
        head: 'main',
      }),
      goalTree: tree({
        commits: LINE_5,
        branches: { main: 'C4' },
        tags: { v1: 'C1', v2: 'C3' },
        head: 'main',
      }),
      solutionCommand: 'git tag v1 C1; git tag v2 C3',
      dialog: [
        {
          type: 'markdown',
          title: 'A name that stays put',
          markdown: [
            'Branches move, and that is the whole point of them: commit while standing on a branch',
            'and the label follows you forward. It also makes a branch a poor way to say *this',
            'exact commit is version 1.0*, because tomorrow it will be pointing at something else.',
            '',
            'A tag is a label that does not move. You attach it to one commit and it stays there',
            'until somebody deletes it. Releases, milestones and "the last build that actually',
            'worked" are all tag material.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Making them',
          markdown: [
            '```',
            'git tag v1 C1     # pin a name to a specific commit',
            'git tag v2        # pin it to the commit you are on',
            '```',
            '',
            'A tag is not somewhere you can work from. Checking one out leaves you on that commit',
            'with a detached `HEAD`, because there is no branch there to carry your next commit',
            'forward.',
            '',
            'That is deliberate rather than annoying. It stops you quietly building new work on',
            'top of a release marker and wondering later why nothing lines up.',
            '',
            'Both tags you are about to make are *lightweight*: a name and a commit, nothing else.',
            'Real git also has *annotated* tags, made with `git tag -a v1`, which are stored as their',
            'own small object carrying an author, a date and a message. Every tag in this app is the',
            'lightweight kind. That difference is not just trivia, and the next level shows why.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Your task',
          markdown: [
            'Get the tree to look like the goal by putting two permanent markers on this history:',
            '',
            '- `v1` on `C1`',
            '- `v2` on `C3`',
            '',
            '`main` should stay exactly where it is.',
          ].join('\n'),
        },
      ],
    },

    // ---------------------------------------------------------------- 2
    {
      id: 'mixed-describe',
      name: 'Finding a landmark with git describe',
      hint: '`git describe main` names the closest tag behind `main`. Put `stable` on that same commit.',
      compareMode: 'allBranchesAndTags',
      startTree: tree({
        commits: LINE_6,
        branches: { main: 'C5' },
        tags: { v1: 'C2' },
        head: 'main',
      }),
      goalTree: tree({
        commits: LINE_6,
        branches: { main: 'C5' },
        tags: { v1: 'C2', stable: 'C2' },
        head: 'main',
      }),
      solutionCommand: 'git describe main; git tag stable v1',
      dialog: [
        {
          type: 'markdown',
          title: 'Where am I, roughly?',
          markdown: [
            'Drop into an unfamiliar repository and "you are on commit C7" tells you almost',
            'nothing. What you actually want is a landmark: something with a human name, plus a',
            'sense of how far you have travelled since.',
            '',
            '`git describe` gives you that. It walks backwards from a commit until it meets the',
            'closest tag, and then reports what it found along with the distance.',
          ].join('\n'),
        },
        {
          type: 'demo',
          title: 'Reading the answer',
          markdown: [
            'The answer has three pieces: the nearest tag behind that commit, how many commits you',
            'are ahead of it, and an identifier for the commit you asked about. Real git formats it',
            'like `v1-2-g9c1a3f`, which reads as "two commits past the tag `v1`".',
            '',
            'When the commit you ask about *is* the tagged one, there is no distance to report, so',
            'git prints the tag name on its own.',
            '',
            'One catch worth knowing before it wastes an hour of your life: real `git describe` looks',
            'only at annotated tags, and a plain `git tag v1 C1` makes a lightweight one. So in a',
            'real repository this command often answers "no names found" until you add `--tags`,',
            'which tells it to consider lightweight tags as well. This app has only lightweight',
            'tags and uses all of them, so `git describe` always finds them here.',
            '',
            'Try it below. `git describe` only reads the repository, so it cannot disturb the',
            'level.',
          ].join('\n'),
          command: 'git describe main',
        },
        {
          type: 'markdown',
          title: 'Your task',
          markdown: [
            'Run `git describe main` and read which tag it lands on.',
            '',
            'Then put a second tag called `stable` on that same commit, so the release everyone',
            'builds from has a friendly name as well as a version number.',
          ].join('\n'),
        },
      ],
    },

    // ---------------------------------------------------------------- 3
    {
      id: 'mixed-cleanup',
      name: 'Deleting branches, and what goes with them',
      hint: '`git branch -d <name>` for the one whose work is already in `main`. The other one needs `-D`, and git will tell you so.',
      compareMode: 'allBranchesHashAgnostic',
      startTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1', 'C3 C2', 'C4 C1'],
        branches: { main: 'C3', avatars: 'C2', sketch: 'C4' },
        head: 'main',
      }),
      goalTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1', 'C3 C2'],
        branches: { main: 'C3' },
        head: 'main',
      }),
      solutionCommand: 'git branch -d avatars; git branch -D sketch',
      dialog: [
        {
          type: 'markdown',
          title: 'Labels are cheap, but they add up',
          markdown: [
            'A branch costs nothing to make, so after a few months you have thirty of them and no',
            'idea which ones still matter. Deleting one is just as cheap: you are removing a label,',
            'not the commits underneath it.',
            '',
            '```',
            'git branch -d avatars     # the careful delete',
            'git branch -D avatars     # the one that does not ask',
            '```',
            '',
            'Lowercase `-d` checks first, and it lets the delete through as soon as it can see the',
            'work surviving somewhere else. Real git counts two somewhere elses: the history you',
            'currently have checked out, and, if the branch has an upstream on a remote, that',
            'upstream. Work you have already pushed can therefore be tidied away locally without a',
            'complaint, which is usually exactly what you want once a branch has shipped.',
            '',
            'If neither place holds those commits, the label you are about to remove is the only',
            'thing still making them findable, so git refuses and tells you to use `-D` if you really',
            'meant it. Capital `-D` skips the question entirely.',
            '',
            'This app only ever applies the first of those two tests, because none of the branches',
            'here has an upstream to check.',
            '',
            'You also cannot delete the branch you are standing on. Move somewhere else first.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'What the picture does next',
          markdown: [
            'Deleting a label whose commits are already part of `main` changes nothing on the board.',
            'The commits are still reachable through `main`, so they stay exactly where they were.',
            '',
            'Deleting the *last* label that could reach a commit is different. This app draws a',
            'commit only while something can still reach it, so those commits drop out of the picture',
            'the moment the label goes. That is the same rule you watched during the rebase levels,',
            'and here you get to trigger it on purpose.',
            '',
            'Real git is slower to forget. The commits stay in the repository for weeks, `git reflog`',
            'still lists them, and `git branch <name> <id>` puts a label back on one. Eventually a',
            'cleanup pass collects anything nothing refers to. `git reflog` is not a command here, so',
            'in this app the drop is final - which is a reason to be sure before you type `-D`.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Your task',
          markdown: [
            'Two branches are finished with. Get the tree to look like the goal by deleting both.',
            '',
            '- `avatars` shipped a while ago and its work is already part of `main`.',
            '- `sketch` is an experiment that was never merged and is not wanted.',
            '',
            'Try the careful delete on both. The second one will stop you, and the message it prints',
            'tells you exactly what to do next. `main` must not move.',
          ].join('\n'),
        },
      ],
    },

    // ---------------------------------------------------------------- 4
    {
      id: 'mixed-restack',
      name: 'Everybody started on a different day',
      hint: 'Give each branch the base it should have had, working up from the bottom of the pile. `main` is the last label to move, and by then it has nothing of its own left to replay.',
      compareMode: 'allBranchesHashAgnostic',
      startTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1', 'C3 C2', 'C4 C1', 'C5 C2', 'C6 C5'],
        branches: { main: 'C3', icons: 'C4', onboarding: 'C6' },
        head: 'main',
      }),
      goalTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1', 'C3 C2', "C4' C3", "C5' C4'", "C6' C5'"],
        branches: { main: "C6'", icons: "C4'", onboarding: "C6'" },
        head: 'main',
      }),
      solutionCommand:
        'git rebase main icons; git rebase icons onboarding; git checkout main; git rebase onboarding',
      dialog: [
        {
          type: 'markdown',
          title: 'Nobody did anything wrong',
          markdown: [
            'Three people, one repository, three different Mondays. Whoever started `icons` branched',
            'off early and has been heads-down since. Whoever started `onboarding` branched off a',
            'little later. `main` kept moving the whole time, because that is what `main` does.',
            '',
            'So the history now forks in two places for no reason anyone would recognise a month',
            'from now. Nothing is broken and nothing is lost. It has simply stopped telling the',
            'story of what happened, and telling that story is most of what history is for.',
            '',
            'The repair is `git rebase`, used in a deliberate order: give each branch the base it',
            'would have had if everyone had started this morning, oldest base first.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Rebasing a branch you are not standing on',
          markdown: [
            '`git rebase` takes an optional second argument naming the branch to move:',
            '',
            '```',
            'git rebase main icons     # replay icons on top of main',
            '```',
            '',
            'Git checks out `icons` for you, replays its own commits on top of `main`, and leaves',
            'you standing there. With no second argument it acts on the branch you are already on.',
            '',
            'Order matters more than it looks. Rebase the lower branch first and the upper one has a',
            'sensible base waiting for it, so only its own commits need replaying. Do it the other',
            'way round and you end up dragging commits along twice.',
            '',
            'Once a branch is simply behind another, there is nothing left to replay and the label',
            'just slides forward. Both `git rebase` and `git merge` will do that for you.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Your task',
          markdown: [
            'Get the tree to look like the goal: one straight line, with every branch sitting on',
            'the work that came before it.',
            '',
            '1. `icons` should sit on top of `main`.',
            '2. `onboarding` should sit on top of `icons`.',
            '3. `main` should finish on the same commit as `onboarding`.',
            '',
            'You start on `main` and you should end there. Rebasing a named branch leaves you',
            'standing on that branch, so getting back is part of the job rather than an afterthought.',
            '',
            'The originals get copied rather than moved, so as each branch label follows its copies,',
            'the commits it left behind stop being reachable and drop off the board. Two forks go',
            'in; none come out.',
          ].join('\n'),
        },
      ],
    },

    // ---------------------------------------------------------------- 5
    {
      id: 'mixed-capstone',
      name: 'Capstone: ship a release',
      hint: 'No new commands here, only an order. Take what you want out of `feature` before you shorten it, and the rest arranges itself.',
      compareMode: 'allBranchesAndTags',
      startTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1', 'C3 C2', 'C4 C3', 'C5 C1'],
        branches: { main: 'C1', feature: 'C4', hotfix: 'C5' },
        tags: { v1: 'C1' },
        head: 'main',
      }),
      goalTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1', 'C3 C2', 'C5 C1', "C3' C5"],
        branches: { main: "C3'", feature: 'C3', hotfix: 'C5' },
        tags: { v1: 'C1', v2: "C3'" },
        head: 'feature',
      }),
      solutionCommand:
        'git merge hotfix; git cherry-pick C3; git tag v2; git checkout feature; git reset HEAD~1',
      dialog: [
        {
          type: 'markdown',
          title: 'Everything at once',
          markdown: [
            'This level has no new commands in it. It has a situation, which is how git problems',
            'normally turn up.',
            '',
            'A hotfix branch is finished and ready to ship. A feature branch has three commits and',
            'exactly one of them is done. The release wants a version tag. The feature branch wants',
            'its unfinished tip taken off. Four familiar tools, one sensible order, no hurry.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'The tools you have',
          markdown: [
            '- `git merge` brings in a branch that is simply ahead of you, with a fast-forward.',
            '- `git cherry-pick` takes a single commit without its neighbours.',
            '- `git tag` marks the result so it can be found again.',
            '- `git reset` rewinds a branch that is still private.',
            '',
            'Order matters for one reason: do not throw away something you still need. Take the',
            'unfinished tip off `feature` *after* you have copied the good commit out of it, not',
            'before.',
            '',
            '`hint` will nudge you, and `show goal` puts the target tree on screen.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Your task',
          markdown: [
            'You start on `main`. Get the tree to look like the goal:',
            '',
            // One list item per line: the markdown subset has no continuation lines.
            '1. Bring `hotfix` into `main`. It is ahead with nothing in the way, so this is a fast-forward, not a merge commit.',
            '2. Copy `C3` from `feature` onto `main`. That is the one finished commit.',
            '3. Tag the commit you just made as `v2`.',
            '4. Move to `feature` and rewind it by one commit, dropping its unfinished tip.',
            '',
            '`v1` stays exactly where it is, and you finish standing on `feature`.',
            '',
            'That last rewind takes the only label off `C4`, so `C4` leaves the drawing. Real git',
            'would keep the commit, which is why a reset on a private branch is a reversible mistake',
            'there and a final one here.',
          ].join('\n'),
        },
      ],
    },
  ],
};
