// Correctness gate for the LEVELS-B sequences (advanced, remote-intro,
// remote-advanced).
//
// The load-bearing assertion is the first one: every stored solutionCommand has
// to genuinely turn startTree into goalTree under that level's compareMode, as
// judged by the same comparison the running app uses. The rest are house-style
// checks plus a set of remote-specific invariants, so a broken level cannot
// reach the page.
//
//   node --test test/levels-b.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { GitEngine } from '../js/git/engine.js';
import { compareTrees } from '../js/git/compare.js';

import advanced from '../js/levels/advanced.js';
import remoteIntro from '../js/levels/remote-intro.js';
import remoteAdvanced from '../js/levels/remote-advanced.js';

const SEQUENCES = [advanced, remoteIntro, remoteAdvanced];
const LEVELS = SEQUENCES.flatMap((sequence) =>
  sequence.levels.map((level) => ({ level, sequence }))
);

// Emoji and the pictographic blocks around them, the variation selector that
// promotes a plain glyph into one, and the private use area icon fonts live in.
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

const isRemote = (sequence) => sequence.group === 'Remote';

/* -------------------------------------------------------------------------- */

/** The engine as main.js configures it for a level. */
function engineFor(level) {
  const engine = new GitEngine(level.startTree);
  engine.setDisabledCommands?.(level.disabledCommands || []);
  engine.setProtectedRefs?.(level.protectedRefs || []);
  return engine;
}

test('every solutionCommand actually solves its level', async (t) => {
  for (const { level, sequence } of LEVELS) {
    await t.test(`${sequence.key}: ${level.id}`, async () => {
      const engine = engineFor(level);

      // A level whose start already matches its goal fires the victory modal
      // before the reader has typed anything.
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
    });
  }
});

// The engine builds its lookup maps with a null prototype, so a branch called
// `__proto__` cannot collide with Object.prototype. Level files are ordinary
// object literals, and a strict deep-equal calls those two different things.
// This test is about content, so both sides go through the same round trip.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('the stored goalTree is exactly what the engine produces', async (t) => {
  // compareTrees is deliberately forgiving (ids are normalised in the
  // hash-agnostic modes). Checking the raw export as well keeps the goal panel,
  // which renders goalTree directly, honest about what the reader will see.
  for (const { level } of LEVELS) {
    await t.test(level.id, async () => {
      const engine = new GitEngine(level.startTree);
      await engine.run(level.solutionCommand);
      assert.deepEqual(plain(engine.exportTree()), plain(level.goalTree));
    });
  }
});

test('level ids are unique across all three sequences', () => {
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
  const expected = {
    advanced: { name: 'Deep Water', group: 'Main' },
    'remote-intro': { name: 'Working With Others', group: 'Remote' },
    'remote-advanced': { name: 'Remote Mastery', group: 'Remote' },
  };
  const keys = new Set();
  for (const sequence of SEQUENCES) {
    assert.ok(expected[sequence.key], `unexpected sequence key "${sequence.key}"`);
    assert.equal(keys.has(sequence.key), false, `duplicate sequence key "${sequence.key}"`);
    keys.add(sequence.key);
    assert.equal(sequence.name, expected[sequence.key].name);
    assert.equal(sequence.group, expected[sequence.key].group);
    assert.ok(sequence.about && sequence.about.length > 20, `${sequence.key} needs an about line`);
    assert.ok(Array.isArray(sequence.levels) && sequence.levels.length, `${sequence.key} has levels`);
    // Ids are prefixed with the sequence key so they stay readable in the URL
    // hash and cannot collide with the LEVELS-A sequences.
    for (const level of sequence.levels) {
      assert.ok(
        level.id.startsWith(`${sequence.key}-`),
        `"${level.id}" should start with "${sequence.key}-"`
      );
    }
  }
  assert.equal(keys.size, 3);
});

test('every level has a hint and between two and four dialog slides', () => {
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
      if (slide.type === 'demo') {
        assert.ok(slide.command && slide.command.trim().length, `${where} is a demo without a command`);
      }
      // Slide length: long enough to teach, short enough to read in one go.
      const words = wordsOf(slide.markdown);
      assert.ok(words >= 45, `${where} is thin at ${words} words`);
      assert.ok(words <= 150, `${where} runs long at ${words} words`);
      // One fenced block per slide at most.
      const fences = (slide.markdown.match(/```/g) || []).length;
      assert.ok(fences % 2 === 0, `${where} has an unclosed fenced block`);
      assert.ok(fences <= 2, `${where} has more than one fenced block`);
    }

    // The last slide is the one the reader acts on, so it must not be a demo
    // that has already done the work for them.
    assert.equal(
      level.dialog[level.dialog.length - 1].type,
      'markdown',
      `${level.id} should finish on a task slide, not a demo`
    );
  }
});

test('demo slides run cleanly and never finish the level', async (t) => {
  for (const { level } of LEVELS) {
    for (const slide of level.dialog.filter((s) => s.type === 'demo')) {
      await t.test(`${level.id}: ${slide.command}`, async () => {
        const engine = new GitEngine(level.startTree);
        const result = await engine.run(slide.command);
        assert.equal(result.ok, true, 'the demo command errors on the starting tree');
        assert.equal(
          compareTrees(engine.getSnapshot(), level.goalTree, level.compareMode),
          false,
          'the demo solves the level, so the victory modal fires over the dialog'
        );
      });
    }
  }
});

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

/**
 * The four hint bounds, expressed once as data so the same code can judge the
 * real hints and a set of deliberately bad ones.
 *
 * Returns one `{ bound, why }` entry per rule the hint breaks. The last three
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
  const longWinded = levelById('advanced-rebase-onto');
  const filler = 'Take your time and look at the board before you type anything at all. ';
  const taskWords = wordsOf(longWinded.dialog[longWinded.dialog.length - 1].markdown);
  const padded = filler.repeat(Math.ceil(taskWords / wordsOf(filler)));

  // 2. Verbatim. Two whole commands of a four-command level, quoted exactly.
  const quoted = levelById('remote-advanced-capstone');

  // 3. Pieces. Three relative refs, none of them a whole command.
  const detailed = levelById('advanced-merge-parents');

  // 4. Ordering. Three beats of a walkthrough, giving nothing else away.
  const narrated = levelById('advanced-rebase-onto');

  const CASES = [
    [longWinded, padded, 'length'],
    [quoted, 'Open with `git fetch` and close with `git push`.', 'verbatim'],
    [detailed, 'The three you need are `main^2`, `main~2^2` and `main~2^`.', 'pieces'],
    [narrated, 'First lift the upper pair off, then step across, and finally close the gap.', 'ordering'],
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
      const trees = [[which, tree]];
      if (tree.originTree) trees.push([`${which}.originTree`, tree.originTree]);

      for (const [where, subject] of trees) {
        assert.ok(subject && subject.commits && subject.branches, `${level.id} ${where} is missing pieces`);
        const roots = Object.values(subject.commits).filter((commit) => !commit.parents.length);
        assert.equal(roots.length, 1, `${level.id} ${where} should have exactly one root commit`);
        for (const commit of Object.values(subject.commits)) {
          for (const parent of commit.parents) {
            assert.ok(subject.commits[parent], `${level.id} ${where}: ${commit.id} has an unknown parent`);
          }
        }
        for (const branch of Object.values(subject.branches)) {
          assert.ok(
            subject.commits[branch.target],
            `${level.id} ${where}: branch ${branch.id} points at a missing commit`
          );
        }
        for (const tag of Object.values(subject.tags || {})) {
          assert.ok(
            subject.commits[tag.target],
            `${level.id} ${where}: tag ${tag.id} points at a missing commit`
          );
        }
        const head = subject.HEAD && subject.HEAD.target;
        assert.ok(
          subject.branches[head] || subject.commits[head],
          `${level.id} ${where}: HEAD points at nothing`
        );
      }

      // The server side is a plain repository: no remote-tracking branches of
      // its own, and no remote of its own.
      if (tree.originTree) {
        assert.equal(tree.originTree.originTree, undefined, `${level.id} ${which}: origin has its own origin`);
        for (const branch of Object.values(tree.originTree.branches)) {
          assert.ok(!branch.id.startsWith('o/'), `${level.id} ${which}: origin carries ${branch.id}`);
          assert.equal(branch.remoteTrackingBranchID, null, `${level.id} ${which}: origin tracks something`);
        }
      }
    }
  }
});

test('remote levels carry an originTree and matching o/ branches', () => {
  for (const { level, sequence } of LEVELS) {
    if (!isRemote(sequence)) {
      assert.equal(level.startTree.originTree, undefined, `${level.id} is not a remote level`);
      assert.equal(level.goalTree.originTree, undefined, `${level.id} is not a remote level`);
      continue;
    }

    // Every remote level ends with a remote. Only the clone level is allowed to
    // start without one, because conjuring it is the whole exercise.
    const clones = level.solutionCommand.includes('git clone');
    assert.equal(
      Boolean(level.startTree.originTree),
      !clones,
      `${level.id} startTree originTree presence is wrong`
    );
    assert.ok(level.goalTree.originTree, `${level.id} goalTree needs an originTree`);
    assert.equal(level.compareMode, 'withOrigin', `${level.id} must compare with the origin`);

    for (const [which, tree] of [
      ['startTree', level.startTree],
      ['goalTree', level.goalTree],
    ]) {
      if (!tree.originTree) continue;
      const remoteNames = new Set(Object.keys(tree.originTree.branches));
      const localNames = new Set(Object.keys(tree.branches));

      // Every o/<name> label is the record of a branch that really exists on
      // the server, and every server branch has a record only once fetched -
      // so o/ is a subset of the remote's branches, never the other way round.
      for (const id of localNames) {
        if (!id.startsWith('o/')) continue;
        assert.ok(
          remoteNames.has(id.slice(2)),
          `${level.id} ${which}: ${id} records a branch the remote does not have`
        );
        assert.equal(
          tree.branches[id].remoteTrackingBranchID,
          null,
          `${level.id} ${which}: ${id} is itself tracking something`
        );
      }

      // An upstream must name an o/ label that exists in the same tree.
      for (const branch of Object.values(tree.branches)) {
        const upstream = branch.remoteTrackingBranchID;
        if (!upstream) continue;
        assert.ok(upstream.startsWith('o/'), `${level.id} ${which}: ${branch.id} tracks "${upstream}"`);
        assert.ok(
          localNames.has(upstream),
          `${level.id} ${which}: ${branch.id} tracks a missing ${upstream}`
        );
      }
    }
  }
});

test('disabledCommands, where used, do not block the stored solution', async (t) => {
  for (const { level } of LEVELS) {
    if (!level.disabledCommands || !level.disabledCommands.length) continue;
    await t.test(level.id, async () => {
      const engine = engineFor(level);
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

test('protectedRefs really do refuse the push the lesson says they refuse', async (t) => {
  // A level may only claim a branch is protected if the engine enforces it.
  // The prose in remote-intro-wrong-branch is false without this.
  for (const { level } of LEVELS) {
    if (!level.protectedRefs || !level.protectedRefs.length) continue;
    await t.test(level.id, async () => {
      assert.equal(
        typeof GitEngine.prototype.setProtectedRefs,
        'function',
        'this engine has no protected-ref support, so the lesson cannot be true'
      );
      for (const ref of level.protectedRefs) {
        for (const attempt of [`git push origin main:${ref}`, `git push -f origin main:${ref}`]) {
          const engine = engineFor(level);
          const result = await engine.run(attempt);
          assert.equal(result.ok, false, `"${attempt}" succeeded against a protected ${ref}`);
          assert.match(result.error.text, /refuses direct pushes/i);
        }
      }

      // And the level must still be solvable with the rule switched on.
      const engine = engineFor(level);
      const solved = await engine.run(level.solutionCommand);
      assert.equal(solved.ok, true, 'the protected ref blocks the stored solution');
    });
  }
});
