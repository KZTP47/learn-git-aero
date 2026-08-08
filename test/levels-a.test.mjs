// Correctness gate for the LEVELS-A sequences (intro, rampup, moving, mixed).
//
// The important assertion is the first one: every stored solutionCommand must
// really turn startTree into goalTree under that level's compareMode. Everything
// else is a house-style check so a bad level cannot reach the page.
//
//   node --test test/levels-a.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { GitEngine } from '../js/git/engine.js';
import { compareTrees } from '../js/git/compare.js';

import intro from '../js/levels/intro.js';
import rampup from '../js/levels/rampup.js';
import moving from '../js/levels/moving.js';
import mixed from '../js/levels/mixed.js';

const SEQUENCES = [intro, rampup, moving, mixed];
const LEVELS = SEQUENCES.flatMap((sequence) =>
  sequence.levels.map((level) => ({ level, sequence }))
);

// Ranges that cover emoji and the pictographic blocks around them, plus the
// variation selector that turns a plain glyph into one, plus the private use
// area that icon fonts live in.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{E000}-\u{F8FF}\u{1F1E6}-\u{1F1FF}]/u;

/** Every human-readable string a level puts on screen. */
function proseOf(level) {
  const parts = [level.name, level.hint, level.solutionCommand];
  for (const slide of level.dialog || []) {
    parts.push(slide.title, slide.markdown, slide.command);
  }
  return parts.filter((part) => typeof part === 'string');
}

/** Prose only, with fenced blocks and inline code removed. */
function wordsOf(markdown) {
  return String(markdown)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

// Operations named as actions. The ambiguous words are deliberately missing:
// "branch", "commit", "tag" and "merge commit" are ordinary nouns in this
// prose, and a hint that only describes the picture must not be punished for
// using them.
const OPERATIONS = [
  /\bcherry-?pick(?:s|ed|ing)?\b/i,
  /\breb(?:ase|ases|ased|asing)\b/i,
  /\bamend(?:s|ed|ing)?\b/i,
  /\bsquash(?:es|ed|ing)?\b/i,
  /\brevert(?:s|ed|ing)?\b/i,
  /\breset(?:s|ting)?\b/i,
  /\bfetch(?:es|ed|ing)?\b/i,
  /\bpush(?:es|ed|ing)?\b/i,
  /\bpull(?:s|ed|ing)?\b/i,
  /\bclones?\b|\bcloning\b/i,
  /\bfast-forwards?(?:ed|ing)?\b/i,
  /\bcheckouts?\b|\bcheck(?:s|ed|ing)?\s+out\b/i,
  /\bdescribe(?:s|d)?\b/i,
  /\bmerge(?:s|d|r)?\b|\bmerging\b/i,
];

// Words a hint uses when it is walking the reader through a sequence rather
// than naming the idea behind it.
const ORDER_WORDS = /\b(?:first|then|next|after that|afterwards|finally|lastly|second|third|again)\b/gi;

/** Commit ids, relative refs and operation names the hint hands over. */
function givenAway(hint) {
  const given = new Set();
  for (const [id] of hint.matchAll(/\bC\d+'*/g)) given.add(id);
  for (const [ref] of hint.matchAll(/\b[A-Za-z][\w/-]*(?:[~^]\d*)+/g)) given.add(ref);
  OPERATIONS.forEach((pattern) => {
    const hit = hint.match(pattern);
    if (hit) given.add(hit[0].toLowerCase());
  });
  return given;
}

/* -------------------------------------------------------------------------- */

test('every solutionCommand actually solves its level', async (t) => {
  for (const { level, sequence } of LEVELS) {
    await t.test(`${sequence.key}: ${level.id}`, async () => {
      const engine = new GitEngine(level.startTree);

      // The start tree must not already satisfy the goal, or the level is a
      // no-op and the victory modal fires before the user types anything.
      assert.equal(
        compareTrees(engine.getSnapshot(), level.goalTree, level.compareMode),
        false,
        'startTree already matches goalTree - this level solves itself'
      );

      const result = await engine.run(level.solutionCommand);
      const failures = (result.messages || [])
        .filter((message) => message.type === 'error')
        .map((message) => message.text)
        .join(' | ');
      assert.equal(result.ok, true, `solutionCommand reported an error: ${failures}`);

      assert.equal(
        compareTrees(engine.getSnapshot(), level.goalTree, level.compareMode),
        true,
        `solutionCommand did not reach goalTree under "${level.compareMode}"`
      );

      // compareTrees only walks out from the refs, so a goalTree may carry
      // commits the solved repository does not have. The goal panel draws every
      // commit it is given, so those strays would appear as a picture the player
      // can never reproduce. Keep the two commit sets identical.
      const solved = Object.keys(engine.exportTree().commits).sort();
      const goal = Object.keys(level.goalTree.commits).sort();
      assert.deepEqual(
        goal,
        solved,
        'goalTree draws commits the solved repository does not have (or is missing some)'
      );
    });
  }
});

// Item-by-item, the two traps that have already bitten this sequence set.
//
// 1. A level whose solution only *rewrites* commits in place has the same shape
//    before and after, so no hash-agnostic goal can describe it - the goal
//    normalises straight back to the start tree and the level opens solved. The
//    "startTree already matches goalTree" assertion above catches that.
// 2. The other side of it: a level that compares ids exactly silently refuses to
//    accept a correct answer that happens to carry an extra apostrophe. Levels
//    that hand the reader a rewriting tool must survive the reader using it
//    twice.
test('rewrite levels accept an answer with extra apostrophes on it', async (t) => {
  const REWORKED = [
    ['moving-buried-commit', 'git checkout C2; git commit --amend; git commit --amend; git cherry-pick C3; git branch -f main HEAD; git checkout main'],
  ];
  for (const [id, longWayRound] of REWORKED) {
    await t.test(id, async () => {
      const { level } = LEVELS.find((entry) => entry.level.id === id) || {};
      assert.ok(level, `no level called "${id}"`);
      const engine = new GitEngine(level.startTree);
      const result = await engine.run(longWayRound);
      assert.equal(result.ok, true, 'the scenic route errored');
      assert.equal(
        compareTrees(engine.getSnapshot(), level.goalTree, level.compareMode),
        true,
        'an extra --amend broke the level, so the reader is being told to start over for nothing'
      );
    });
  }
});

// Every flag a stored solution uses must be introduced by the level that needs
// it. "Same recipe as before" is fine as a nudge, but the reader must be able to
// find the actual spelling without leaving the level.
test('solutions only use flags the level itself shows', () => {
  for (const { level } of LEVELS) {
    // Everything the reader can actually read. proseOf() includes the stored
    // solution, which would make this check pass against itself.
    const shown = proseOf(level)
      .filter((text) => text !== level.solutionCommand)
      .join('\n');
    for (const [, flag] of String(level.solutionCommand).matchAll(/(?:^|\s)(--?[a-zA-Z][\w-]*)/g)) {
      assert.ok(
        shown.includes(flag),
        `${level.id} solves with "${flag}" but never shows it in the lesson or the hint`
      );
    }
  }
});

test('every level declares a compare mode the engine knows', () => {
  const MODES = new Set([
    'main',
    'allBranches',
    'allBranchesHashAgnostic',
    'allBranchesAndTags',
    'allBranchesAndTagsHashAgnostic',
    'tagsOnly',
    'withOrigin',
  ]);
  for (const { level } of LEVELS) {
    assert.ok(MODES.has(level.compareMode), `${level.id} has compareMode "${level.compareMode}"`);
  }
});

test('level ids are unique across all four sequences', () => {
  const seen = new Map();
  for (const { level, sequence } of LEVELS) {
    assert.equal(typeof level.id, 'string');
    assert.match(level.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `"${level.id}" is not kebab-case`);
    assert.equal(seen.has(level.id), false, `duplicate level id "${level.id}"`);
    seen.set(level.id, sequence.key);
  }
  assert.equal(seen.size, LEVELS.length);
});

test('sequence metadata is complete', () => {
  const keys = new Set();
  for (const sequence of SEQUENCES) {
    assert.ok(sequence.key, 'sequence needs a key');
    assert.equal(keys.has(sequence.key), false, `duplicate sequence key "${sequence.key}"`);
    keys.add(sequence.key);
    assert.ok(sequence.name, `${sequence.key} needs a name`);
    assert.equal(sequence.group, 'Main', `${sequence.key} belongs to the Main group`);
    assert.ok(sequence.about && sequence.about.length > 20, `${sequence.key} needs an about line`);
    assert.ok(Array.isArray(sequence.levels) && sequence.levels.length, `${sequence.key} has levels`);
    // Every level id is prefixed with its sequence key, so ids stay readable in
    // the URL hash and cannot collide with LEVELS-B.
    for (const level of sequence.levels) {
      assert.ok(
        level.id.startsWith(`${sequence.key}-`),
        `"${level.id}" should start with "${sequence.key}-"`
      );
    }
  }
});

test('every level has a hint and at least two dialog slides', () => {
  for (const { level } of LEVELS) {
    assert.ok(level.name && level.name.trim().length, `${level.id} needs a name`);
    assert.ok(level.hint && level.hint.trim().length, `${level.id} needs a non-empty hint`);
    assert.ok(Array.isArray(level.dialog), `${level.id} needs a dialog array`);
    assert.ok(level.dialog.length >= 2, `${level.id} needs at least 2 dialog slides`);
    assert.ok(level.dialog.length <= 4, `${level.id} should have at most 4 dialog slides`);

    for (const [i, slide] of level.dialog.entries()) {
      const where = `${level.id} slide ${i + 1}`;
      assert.ok(['markdown', 'demo'].includes(slide.type), `${where} has an unknown type`);
      assert.ok(slide.title && slide.title.trim().length, `${where} needs a title`);
      assert.ok(slide.markdown && slide.markdown.trim().length, `${where} needs markdown`);
      // The dialog chrome already prints slide.title as the heading, so the body
      // must not open with one that repeats it.
      assert.equal(
        /^\s*#/.test(slide.markdown),
        false,
        `${where} starts with a heading that duplicates its title`
      );
      if (slide.type === 'demo') {
        assert.ok(slide.command && slide.command.trim().length, `${where} is a demo without a command`);
      }
    }

    // The last slide is the one the reader acts on.
    const last = level.dialog[level.dialog.length - 1];
    assert.match(last.title, /Your task/i, `${level.id} should end on a task slide`);
  }
});

/**
 * The four hint bounds, expressed once as data so the same code can judge the
 * real hints and a set of deliberately bad ones.
 *
 * Returns one `{ bound, why }` entry per rule the hint breaks. The first three
 * rules only apply to multi-command levels: on a single-command level, naming
 * the one command is the lesson.
 */
function hintFaults(level, hint) {
  const faults = [];
  const task = level.dialog[level.dialog.length - 1];
  const hintWords = wordsOf(hint);
  const taskWords = wordsOf(task.markdown);

  // 1. A hint is a nudge. A hint the length of the instructions is a copy of
  //    them, however it is phrased.
  if (hintWords * 2 > taskWords) {
    faults.push({
      bound: 'length',
      why: `runs ${hintWords} words against a ${taskWords}-word task slide - that is a restatement, not a nudge`,
    });
  }

  const commands = [
    ...new Set(
      level.solutionCommand
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
    ),
  ];
  if (commands.length < 2) return faults;

  // 2. Verbatim commands.
  const lower = hint.toLowerCase();
  const spelled = commands.filter((command) => lower.includes(command.toLowerCase()));
  if (spelled.length > 1 || spelled.length >= commands.length) {
    faults.push({
      bound: 'verbatim',
      why: `spells out ${spelled.length} of ${commands.length} solution commands: ${spelled.join(' | ')}`,
    });
  }

  // 3. The concrete pieces. Bounding verbatim commands is not enough: a hint
  //    can narrate every step without quoting one, by naming the ids, the
  //    relative refs and each operation in turn. Two of those is a nudge; more
  //    is a walkthrough with the backticks taken off.
  const given = givenAway(hint);
  if (given.size > 2) {
    faults.push({
      bound: 'pieces',
      why: `hands over ${given.size} pieces of the answer (${[...given].join(', ')}) - two is the budget`,
    });
  }

  // 4. Ordering. A hint that says first, then, finally is a numbered list in a
  //    raincoat.
  const beats = new Set([...hint.matchAll(ORDER_WORDS)].map((match) => match[0].toLowerCase()));
  if (beats.size > 1) {
    faults.push({
      bound: 'ordering',
      why: `walks the solution in order ("${[...beats].join('", "')}") - name the idea instead`,
    });
  }

  return faults;
}

test('hints name the idea, not the keystrokes', () => {
  for (const { level } of LEVELS) {
    const faults = hintFaults(level, level.hint);
    assert.deepEqual(
      faults.map((fault) => `${level.id} hint ${fault.why}`),
      []
    );
  }
});

// The bounds above are only worth having if they actually fire. Nothing else in
// this file would notice a comparison flipped the wrong way round: every real
// hint passes, so an inverted rule would simply stop objecting to anything.
//
// Each fixture below is built to trip exactly one bound, so a broken rule shows
// up as a missing entry rather than being masked by its neighbours.
test('each hint bound fires on a hint built to break it', () => {
  const levelById = (id) => {
    const found = LEVELS.find((entry) => entry.level.id === id);
    assert.ok(found, `no level called "${id}"`);
    return found.level;
  };

  // 1. Length. Bland filler: no commit ids, no relative refs, no operation
  //    names and no ordering words, so the only thing wrong with it is size.
  const longWinded = levelById('moving-buried-commit');
  const filler = 'Take your time and look at the board before you type anything at all. ';
  const taskWords = wordsOf(longWinded.dialog[longWinded.dialog.length - 1].markdown);
  const padded = filler.repeat(Math.ceil(taskWords / wordsOf(filler)));

  // 2. Verbatim. Both commands of a two-command level, quoted exactly.
  const quoted = levelById('intro-branching');

  // 3. Pieces. Three concrete parts of the answer, none of them a whole command.
  const detailed = levelById('rampup-reset-revert');

  // 4. Ordering. Three beats of a walkthrough, giving nothing else away.
  const narrated = levelById('intro-branching');

  const CASES = [
    [longWinded, padded, 'length'],
    [quoted, 'Run `git checkout -b feature` and `git commit`.', 'verbatim'],
    [detailed, 'Think about `HEAD~1`, and about which branch deserves a reset and which deserves a revert.', 'pieces'],
    [narrated, 'First make the branch, then stand on it, and finally commit.', 'ordering'],
  ];

  for (const [level, badHint, expected] of CASES) {
    const bounds = hintFaults(level, badHint).map((fault) => fault.bound);
    assert.deepEqual(
      bounds,
      [expected],
      `the "${expected}" bound did not fire alone on ${level.id} for: ${badHint.slice(0, 60)}`
    );
  }

  // And the control: the real hints of those same levels are clean, so the
  // fixtures above are measuring the hint rather than the level.
  for (const [level] of CASES) {
    assert.deepEqual(hintFaults(level, level.hint), []);
  }
});

// renderMarkdown() in js/core/util.js has no notion of a continuation line: an
// indented line after a list item flushes the list and becomes its own
// paragraph, which silently restarts the numbering. Every list item and
// paragraph line must therefore start at column zero.
test('markdown stays inside the subset renderMarkdown supports', () => {
  for (const { level } of LEVELS) {
    for (const [i, slide] of level.dialog.entries()) {
      let inFence = false;
      for (const line of slide.markdown.split('\n')) {
        if (/^\s*```/.test(line)) {
          inFence = !inFence;
          continue;
        }
        if (inFence) continue;
        assert.equal(
          /^\s+\S/.test(line),
          false,
          `${level.id} slide ${i + 1} has an indented line, which breaks lists: "${line}"`
        );
      }
      assert.equal(inFence, false, `${level.id} slide ${i + 1} has an unclosed code fence`);
    }
  }
});

test('no emoji anywhere in the prose', () => {
  for (const { level } of LEVELS) {
    for (const text of proseOf(level)) {
      const hit = text.match(EMOJI);
      assert.equal(hit, null, `${level.id} contains a pictographic character: ${hit && hit[0]}`);
    }
  }
  for (const sequence of SEQUENCES) {
    assert.equal(EMOJI.test(sequence.about), false, `${sequence.key} about line contains an emoji`);
    assert.equal(EMOJI.test(sequence.name), false, `${sequence.key} name contains an emoji`);
  }
});

test('level trees are well formed', () => {
  for (const { level } of LEVELS) {
    for (const [which, tree] of [
      ['startTree', level.startTree],
      ['goalTree', level.goalTree],
    ]) {
      assert.ok(tree && tree.commits && tree.branches, `${level.id} ${which} is missing pieces`);
      const roots = Object.values(tree.commits).filter((commit) => !commit.parents.length);
      assert.equal(roots.length, 1, `${level.id} ${which} should have exactly one root commit`);
      for (const commit of Object.values(tree.commits)) {
        for (const parent of commit.parents) {
          assert.ok(tree.commits[parent], `${level.id} ${which}: ${commit.id} has an unknown parent`);
        }
      }
      for (const branch of Object.values(tree.branches)) {
        assert.ok(
          tree.commits[branch.target],
          `${level.id} ${which}: branch ${branch.id} points at a missing commit`
        );
      }
      for (const tag of Object.values(tree.tags || {})) {
        assert.ok(
          tree.commits[tag.target],
          `${level.id} ${which}: tag ${tag.id} points at a missing commit`
        );
      }
      const head = tree.HEAD && tree.HEAD.target;
      assert.ok(
        tree.branches[head] || tree.commits[head],
        `${level.id} ${which}: HEAD points at nothing`
      );
    }
  }
});

test('disabledCommands, where used, do not block the stored solution', async (t) => {
  for (const { level } of LEVELS) {
    if (!level.disabledCommands || !level.disabledCommands.length) continue;
    await t.test(level.id, async () => {
      const engine = new GitEngine(level.startTree);
      engine.setDisabledCommands(level.disabledCommands);
      const result = await engine.run(level.solutionCommand);
      assert.equal(result.ok, true, 'the solution uses a command this level switches off');
      assert.equal(
        compareTrees(engine.getSnapshot(), level.goalTree, level.compareMode),
        true,
        'the solution stops working once disabledCommands are applied'
      );
    });
  }
});
