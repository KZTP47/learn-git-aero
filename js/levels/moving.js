// "Lifting and Relaying" - copying, reordering and rewriting commits.
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

export default {
  key: 'moving',
  name: 'Lifting and Relaying',
  group: 'Main',
  about:
    'Cherry-pick, interactive rebase and the manual recipe behind both: stand somewhere, replay the commits you want, move the label.',
  levels: [
    // ---------------------------------------------------------------- 1
    {
      id: 'moving-cherry-pick',
      name: 'Cherry-pick: copying commits by name',
      hint: '`git cherry-pick` takes a list of commits and copies them onto you, in the order you list them.',
      compareMode: 'allBranchesHashAgnostic',
      startTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1', 'C3 C2', 'C4 C3'],
        branches: { main: 'C1', side: 'C4' },
        head: 'main',
      }),
      goalTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1', 'C3 C2', 'C4 C3', "C2' C1", "C4' C2'"],
        branches: { main: "C4'", side: 'C4' },
        head: 'main',
      }),
      solutionCommand: 'git cherry-pick C2 C4',
      dialog: [
        {
          type: 'markdown',
          title: 'Taking only the commits you want',
          markdown: [
            'Sometimes a whole branch is far more than you asked for. Somebody fixed one bug on a',
            'branch that also holds half a redesign, and you need the fix today. Merging would drag',
            'the redesign along with it. Rebasing would move the entire stack.',
            '',
            '`git cherry-pick` is the small tool for exactly this. You name the commits you want,',
            'and git makes a copy of each one, in the order you listed them, directly on top of',
            'wherever you are standing right now.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Copies, in your order',
          markdown: [
            '```',
            'git cherry-pick C2 C4',
            '```',
            '',
            'That puts a copy of `C2` on your current commit, then a copy of `C4` on top of that.',
            "The originals never move and the branch you took them from is untouched. Copies get",
            "new ids, which the diagram writes with an apostrophe: `C2` becomes `C2'`.",
            '',
            'Because you choose the order, cherry-pick is also the blunt way to reorder history:',
            'take the commits out in the sequence you wish they had happened in.',
            '',
            'Real git can hit a conflict when a commit does not apply cleanly. There are no file',
            'contents here, so every pick lands.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Your task',
          markdown: [
            '`side` has three commits. Only the first and the last are worth keeping.',
            '',
            'Get the tree to look like the goal by copying `C2` and then `C4` onto `main`, in that',
            'order. `side` must come out of this unchanged.',
          ].join('\n'),
        },
      ],
    },

    // ---------------------------------------------------------------- 2
    {
      id: 'moving-interactive-rebase',
      name: 'Interactive rebase: choosing what replays',
      hint: 'Nothing new here. Pick a base, replay only the commits worth keeping onto it, and remember that a branch label has to be told to follow.',
      compareMode: 'allBranchesHashAgnostic',
      startTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1', 'C3 C1', 'C4 C3', 'C5 C4'],
        branches: { main: 'C2', feature: 'C5' },
        head: 'feature',
      }),
      goalTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1', "C3' C2", "C5' C3'"],
        branches: { main: 'C2', feature: "C5'" },
        head: 'feature',
      }),
      solutionCommand:
        'git checkout C2; git cherry-pick C3 C5; git branch -f feature HEAD; git checkout feature',
      dialog: [
        {
          type: 'markdown',
          title: 'Rebasing, but you get a say',
          markdown: [
            'A plain `git rebase main` replays every commit your branch has, in the order they',
            'happened, and asks you nothing. Interactive rebase asks. Add `-i` and git shows you',
            'the list of commits it is about to replay, before it replays any of them.',
            '',
            'From that list you can drop a commit entirely, change the order, squash several into',
            'one, or stop to reword a message. Nothing is applied until you accept the list, so it',
            'is a safe place to think.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Two ways to do it',
          markdown: [
            '`git rebase -i main` opens a small panel here listing the commits that would move.',
            'Untick the ones you want gone, reorder the rows, confirm. Real interactive rebase can',
            'also squash and reword; this sandbox models keeping, dropping and reordering.',
            '',
            'The manual recipe does the same job with commands you already know, and it is worth',
            'learning because it works everywhere:',
            '',
            '```',
            'git checkout <new base>      # stand where the commits should land',
            'git cherry-pick <keepers>    # replay them, in your order',
            'git branch -f <branch> HEAD  # move the label onto the result',
            'git checkout <branch>        # and stand on it again',
            '```',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Your task',
          markdown: [
            '`feature` has three commits: `C3`, `C4` and `C5`. The middle one is a temporary switch',
            'somebody flipped to reproduce a report, and it should not survive.',
            '',
            'Get the tree to look like the goal by replaying `C3` and `C5` on top of `main`, and',
            'leaving `feature` pointing at the result. `main` itself must not move.',
            '',
            'Finish standing on `feature`. Moving a label is not the same as moving yourself: once',
            'the replay is done you are on the new commits with no branch under you, so put',
            '`feature` there and then check it out.',
            '',
            'Watch the last step. As soon as `feature` moves onto the copies, no label can reach the',
            'three originals, so this app stops drawing them. In a real repository they would still',
            'be sitting there, waiting for anything that cared to name them.',
          ].join('\n'),
        },
      ],
    },

    // ---------------------------------------------------------------- 3
    {
      id: 'moving-rescue-one',
      name: 'Rescuing one commit from a branch nobody will merge',
      hint: 'Count back from the tip of `workshop`: the fix is two steps behind it. Say that with `~`.',
      compareMode: 'allBranchesHashAgnostic',
      disabledCommands: ['git merge', 'git rebase'],
      startTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1', 'C3 C1', 'C4 C3', 'C5 C4', 'C6 C5'],
        branches: { main: 'C2', workshop: 'C6' },
        head: 'main',
      }),
      goalTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1', 'C3 C1', 'C4 C3', 'C5 C4', 'C6 C5', "C4' C2"],
        branches: { main: "C4'", workshop: 'C6' },
        head: 'main',
      }),
      solutionCommand: 'git cherry-pick workshop~2',
      dialog: [
        {
          type: 'markdown',
          title: 'A branch that was never meant to ship',
          markdown: [
            'Somebody built a demo for a training session on a branch called `workshop`. Four',
            'commits: a fake login, then a genuine fix to the date parser they had to write to make',
            'the demo work at all, then two commits of stage dressing for the slides.',
            '',
            'The demo is finished and the branch is finished with it. Nobody is going to merge that',
            'into `main`. But the date parser really is broken in `main`, and the fix for it is',
            'sitting right there, buried under two commits of stage dressing.',
            '',
            '`git cherry-pick` is the way out. It copies the commits you name onto wherever you are',
            'standing and leaves everything else where it is.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Counting back to it',
          markdown: [
            'You could read the id off the board, but you already know a better way to say where a',
            'commit is. Relative references work as arguments to `git cherry-pick` too:',
            '',
            '```',
            'git cherry-pick workshop~2',
            '```',
            '',
            'That means: start at the tip of `workshop`, step back twice, copy what you land on.',
            'It reads as an instruction rather than as a magic number, and it stays true even after',
            'the ids around it change.',
            '',
            '`git merge` and `git rebase` are switched off for this level. Both of them would drag',
            'the whole demo across, which is exactly the outcome the level is about avoiding.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Your task',
          markdown: [
            '`workshop` has four commits of its own, branching off below where `main` is now. The',
            'second one along, two steps back from the tip, is the date parser fix.',
            '',
            'Get the tree to look like the goal by copying that one commit onto `main`, without',
            'typing a commit id.',
            '',
            '`workshop` must come out of this untouched. You are borrowing from it, not taking it',
            'apart.',
          ].join('\n'),
        },
      ],
    },

    // ---------------------------------------------------------------- 4
    {
      id: 'moving-reorder-squash',
      name: 'Reordering a stack, without the squash',
      hint: 'The same recipe as the interactive rebase level. The one new decision is which order you name the keepers in, because that is the order they land in.',
      compareMode: 'allBranchesHashAgnostic',
      startTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1', 'C3 C2', 'C4 C3', 'C5 C4'],
        branches: { main: 'C1', feature: 'C5' },
        head: 'feature',
      }),
      goalTree: tree({
        commits: ['C0', 'C1 C0', "C4' C1", "C2' C4'", "C5' C2'"],
        branches: { main: 'C1', feature: "C5'" },
        head: 'feature',
      }),
      solutionCommand:
        'git checkout C1; git cherry-pick C4 C2 C5; git branch -f feature HEAD; git checkout feature',
      dialog: [
        {
          type: 'markdown',
          title: 'Cleaning a stack before review',
          markdown: [
            'A branch that took three days looks like three days of thinking. A commit in the',
            'wrong place. A follow-up that only fixes a typo in the commit before it. A stray',
            'config change that has nothing to do with anything.',
            '',
            'It all works, and it reads badly, and somebody has to review it. Tidying up before',
            'you ask for that review is normal and polite. The two moves you need are reordering',
            'and squashing.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Squash and drop are not the same thing',
          markdown: [
            'In real git you would open `git rebase -i` and mark the typo fix as `squash`. Its',
            'changes get folded into the commit above it and **survive** there. What disappears is',
            'the separate entry in the log, not the work.',
            '',
            'This app has no file contents, so it cannot fold one commit into another - a commit',
            'here is only a position in the chain. The only way to model the result is to leave that',
            'commit out of the replay, which is a **drop**: in real git that would throw the changes',
            'away.',
            '',
            'So the picture you are about to build is right and the operation behind it is not.',
            'Please keep the two apart. In a real repository, dropping a commit when you meant to',
            'squash it silently loses whatever was in it, and nothing warns you.',
            '',
            'Ordering, at least, is honest here in the sense that matters: the order really is yours',
            'to choose, and the commits really do land in it.',
            '',
            '```',
            'git cherry-pick <the keepers, in the order you want them>',
            'git branch -f feature HEAD   # label follows the copies',
            '```',
            '',
            'What is not honest is how quietly it goes. Moving a commit past another one means',
            'replaying it against a file it was never written against, and the commits in a stack',
            'usually depend on each other - that is what makes it a stack. Reordering one in a real',
            'repository conflicts more often than not, and each replay that stops is one you settle',
            'by hand before the next one starts. Nothing here has file contents, so what you type is',
            'what you get, every time. That part is the sandbox talking, not git.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Your task',
          markdown: [
            '`feature` has four commits sitting on `main`:',
            '',
            '- `C2` is the feature itself',
            '- `C3` is a typo fix that belongs inside `C2`',
            '- `C4` is an unrelated config change',
            '- `C5` is the rest of the feature',
            '',
            'Rewrite `feature` so it reads: config change first, then the feature, then the rest.',
            'Leave `C3` out of the replay. `main` must not move, and you should finish standing on',
            '`feature` rather than on the commit it ends up labelling.',
            '',
            'Remember what that last instruction really is. Here it stands in for a squash; in a',
            'real repository it would be a drop, and the typo fix would go with it.',
            '',
            'All four originals leave the drawing as `feature` moves off them, this app having',
            'nothing left that can reach them. Real git keeps them, which is the difference between',
            'a mistake you can take back and one you cannot.',
          ].join('\n'),
        },
      ],
    },

    // ---------------------------------------------------------------- 5
    {
      id: 'moving-buried-commit',
      name: 'Rewriting a commit that is buried in the middle',
      hint: 'A commit cannot be edited where it sits: `git commit --amend` only ever rewrites the one you are standing on. Rebuild the line upwards from the bad commit, and lean on `backup` - it is there so that being clumsy costs you nothing.',
      // A rewrite in place does not change the shape of the graph, so with only
      // `main` in the picture no hash-agnostic goal could describe this level -
      // the goal would normalise straight back to the start tree and the level
      // would open already solved. The `backup` label is what makes the goal
      // structurally distinct: the old chain survives beside the rebuilt one, so
      // the comparison has something real to check and the reader can collect as
      // many apostrophes as they like on the way.
      compareMode: 'allBranchesHashAgnostic',
      startTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1', 'C3 C2'],
        branches: { main: 'C3', backup: 'C3' },
        head: 'main',
      }),
      goalTree: tree({
        commits: ['C0', 'C1 C0', 'C2 C1', 'C3 C2', "C2' C1", "C3' C2'"],
        branches: { main: "C3'", backup: 'C3' },
        head: 'main',
      }),
      solutionCommand:
        'git checkout C2; git commit --amend; git cherry-pick C3; git branch -f main HEAD; git checkout main',
      dialog: [
        {
          type: 'markdown',
          title: 'The commit you cannot reach',
          markdown: [
            '`git commit --amend` fixes the commit you are standing on. It does not fix a commit',
            'with three others piled on top of it, and that is always the one that turns out to be',
            'wrong.',
            '',
            'The way through is to stop thinking of it as editing history and start thinking of it',
            'as rebuilding history. Go back to the commit before the problem, redo the problem',
            'commit properly, then replay everything that came after it.',
            '',
            'Notice the spare label already sitting on the tip. Somebody ran `git branch backup`',
            'before starting, which is the cheapest habit in git: one label, no copying, and the',
            'line you are about to rewrite cannot get away from you.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'The recipe',
          markdown: [
            '```',
            'git checkout <the commit that went wrong>',
            'git commit --amend                        # replace it with a corrected copy',
            'git cherry-pick <everything that came after it>',
            'git branch -f <branch> HEAD               # move the label onto the result',
            'git checkout <branch>',
            '```',
            '',
            'Every step is something you have already done in an earlier level. Working out which',
            'commit goes in each pair of angle brackets is the whole of the exercise, and the board',
            'in front of you already has every answer on it.',
            '',
            "`--amend` does not edit a commit; it builds a replacement, so it gets a new id and `C2`",
            "becomes `C2'`. Everything replayed on top is a copy too, because a commit's identity",
            'includes the parent it sits on. Change the parent and you have a different commit.',
            '',
            'This is the level where you get to watch that rule from both sides. The rebuilt pair',
            'appears next to the old one, and the old one stays on the board the whole time, because',
            '`backup` is still holding on to it. Take `backup` away and those two commits would',
            'vanish from the picture the moment `main` left them.',
          ].join('\n'),
        },
        {
          type: 'markdown',
          title: 'Your task',
          markdown: [
            '`main` has three commits after the root, and the middle one, `C2`, went in wrong.',
            '',
            'Rebuild `main` so it ends as a corrected copy of `C2` with a copy of `C3` on top of',
            'it. Leave `backup` exactly where it is, so the original line stays visible beside your',
            'new one.',
            '',
            'Finish standing on `main`. The rebuilding happens with `HEAD` detached, so the last',
            'thing to do is put the label on your new tip and step back onto the label.',
            '',
            'The shape is what counts, not how many apostrophes you collect on the way. Amend twice',
            'if you want to; a copy of a copy is still a copy, and this level is checked on shape.',
          ].join('\n'),
        },
      ],
    },
  ],
};
