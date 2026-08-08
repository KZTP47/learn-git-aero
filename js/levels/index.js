// Level registry. Each sequence lives in its own file and is loaded lazily so a
// missing sequence during development cannot take the whole app down.

const SEQUENCE_FILES = [
  './intro.js',
  './rampup.js',
  './moving.js',
  './mixed.js',
  './advanced.js',
  './remote-intro.js',
  './remote-advanced.js',
];

const FALLBACK_TREE = {
  commits: { C0: { id: 'C0', parents: [], rootCommit: true } },
  branches: { main: { id: 'main', target: 'C0', remoteTrackingBranchID: null } },
  tags: {},
  HEAD: { id: 'HEAD', target: 'main' },
};

let cache = null;

function normaliseLevel(level, sequence, index) {
  return {
    compareMode: 'allBranchesHashAgnostic',
    disabledCommands: [],
    protectedRefs: [],
    dialog: [],
    hint: '',
    ...level,
    sequenceKey: sequence.key,
    sequenceName: sequence.name,
    index,
  };
}

/** @returns {Promise<Array<{key,name,about,group,levels:Array}>>} */
export async function loadSequences() {
  if (cache) return cache;

  const modules = await Promise.all(
    SEQUENCE_FILES.map(async (path) => {
      try {
        const mod = await import(path);
        return mod.default ?? null;
      } catch (err) {
        console.warn(`[levels] "${path}" not loaded:`, err.message);
        return null;
      }
    })
  );

  const sequences = modules
    .filter((seq) => seq && Array.isArray(seq.levels) && seq.levels.length)
    .map((seq) => ({
      group: seq.group || (seq.key.startsWith('remote') ? 'Remote' : 'Main'),
      ...seq,
      levels: seq.levels.map((level, i) => normaliseLevel(level, seq, i)),
    }));

  // The sandbox is always available, not just as an emergency fallback: free
  // play is where a lot of the learning happens once the lessons run out.
  const sandboxSequence = {
    key: 'sandbox',
    name: 'Sandbox',
    group: 'Main',
    about: 'A repository with no goal and nothing to get wrong. Try things and see what happens.',
    levels: [
      normaliseLevel(
        {
          id: 'sandbox',
          name: 'Sandbox',
          hint: 'Nothing to solve here. Every command is available; `reset` gives you a clean repository back.',
          startTree: FALLBACK_TREE,
          goalTree: null,
          solutionCommand: '',
        },
        { key: 'sandbox', name: 'Sandbox' },
        0
      ),
    ],
  };

  const remoteSandbox = {
    ...FALLBACK_TREE,
    branches: { main: { id: 'main', target: 'C0', remoteTrackingBranchID: 'o/main' } },
  };
  sandboxSequence.levels.push(
    normaliseLevel(
      {
        id: 'sandbox-remote',
        name: 'Remote sandbox',
        hint: 'A repository that already has an origin. Push, fetch and pull as much as you like.',
        startTree: {
          ...remoteSandbox,
          branches: {
            ...remoteSandbox.branches,
            'o/main': { id: 'o/main', target: 'C0', remoteTrackingBranchID: null },
          },
          originTree: FALLBACK_TREE,
        },
        goalTree: null,
        solutionCommand: '',
      },
      { key: 'sandbox', name: 'Sandbox' },
      1
    )
  );

  sequences.push(sandboxSequence);

  cache = sequences;
  return cache;
}

export async function allLevels() {
  const sequences = await loadSequences();
  return sequences.flatMap((seq) => seq.levels);
}

export async function findLevel(id) {
  return (await allLevels()).find((level) => level.id === id) || null;
}

export async function nextLevel(id) {
  const levels = await allLevels();
  const at = levels.findIndex((level) => level.id === id);
  return at >= 0 && at < levels.length - 1 ? levels[at + 1] : null;
}

export { FALLBACK_TREE };
