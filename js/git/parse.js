// Pure text work: splitting a line into commands, quote-aware tokenising,
// turning flags into a normalised object, and the grammar for ref expressions
// such as `HEAD~2^1`. Nothing in this file knows what a repository is - ref
// lookups happen through a caller-supplied predicate.

export class CommandParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommandParseError';
    this.type = 'CommandParseError';
  }
}

export class GitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitError';
    this.type = 'GitError';
  }
}

const QUOTES = new Set(["'", '"']);
const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v';

/**
 * The two helpers every map keyed by a name the reader controls depends on.
 * They live here because parse.js has no dependencies, so engine.js and
 * commands.js can both use the same pair without an import cycle.
 *
 * `branch`, `constructor` and `toString` are all legal git ref names. On an
 * ordinary object `map['constructor']` reads a function off Object.prototype,
 * so a truthiness check says "already there" for a name that does not exist,
 * and `map['__proto__'] = x` re-points the map's prototype instead of adding a
 * key. Null-prototype maps plus own-property checks make that whole class of
 * bug impossible, rather than blacklisting a list of names that will never be
 * complete.
 */
export function emptyMap() {
  return Object.create(null);
}

export function own(map, key) {
  return map != null && Object.prototype.hasOwnProperty.call(map, key);
}

// A quote only opens a string when it starts a token. That keeps commit ids
// like `C2'` and `C2'^4` usable as plain words while `-m 'hello world'` still
// works the way a shell user expects.

/** Split one input line into individual commands on `;` / newlines. */
export function splitCommands(input) {
  const text = String(input ?? '');
  const parts = [];
  let current = '';
  let quote = null;
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '\r') {
      parts.push(current);
      current = '';
      started = false;
      continue;
    }
    if (isSpace(ch)) {
      current += ch;
      started = false;
      continue;
    }
    if (QUOTES.has(ch) && !started) {
      quote = ch;
      current += ch;
      started = true;
      continue;
    }
    current += ch;
    started = true;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Break a command into words, honouring quoted sections. */
export function tokenize(input) {
  const text = String(input ?? '');
  const tokens = [];
  let token = '';
  let started = false;
  let quote = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else token += ch;
      continue;
    }
    if (isSpace(ch) || ch === '\n' || ch === '\r') {
      if (started) tokens.push(token);
      token = '';
      started = false;
      continue;
    }
    if (QUOTES.has(ch) && !started) {
      quote = ch;
      started = true;
      continue;
    }
    token += ch;
    started = true;
  }
  if (quote) {
    throw new CommandParseError(
      `That ${quote === '"' ? 'double' : 'single'} quote is never closed. Add the matching ${quote} and run it again.`
    );
  }
  if (started) tokens.push(token);
  return tokens;
}

/** `--set-upstream` -> `setUpstream`, `-f` -> `f`. */
export function camel(flagName) {
  return String(flagName)
    .replace(/^-+/, '')
    .replace(/-([a-z])/gi, (_, c) => c.toUpperCase());
}

/**
 * Turn tokens into `{ flags, args }` using a spec:
 *   { booleans:[..], values:[..], aliases:{ '-m':'--message' }, example:'...' }
 * Unknown options raise a CommandParseError with a readable message.
 */
export function parseOptions(tokens, spec = {}, context = 'that command') {
  const booleans = new Set(spec.booleans || []);
  const values = new Set(spec.values || []);
  const aliases = spec.aliases || emptyMap();
  // Flags real git has but this model cannot honour. Saying so is far better
  // than accepting one and quietly doing something else.
  const unsupported = spec.unsupported || emptyMap();
  const flags = emptyMap();
  const args = [];
  let literal = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!literal && token === '--') {
      literal = true;
      continue;
    }
    // `-2` is a count, not an option - git reads it that way too (`git log -5`).
    const looksLikeFlag = !literal && token.length > 1 && token[0] === '-' && !/^-\d+$/.test(token);
    if (!looksLikeFlag) {
      args.push(token);
      continue;
    }

    let name = token;
    let inline = null;
    const eq = token.indexOf('=');
    if (token.startsWith('--') && eq > 2) {
      name = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }
    const canonical = own(aliases, name) ? aliases[name] : name;

    if (own(unsupported, canonical) && unsupported[canonical]) {
      throw new CommandParseError(
        `"${canonical}" is real git, but this model does not simulate ${unsupported[canonical]}. Leave the flag off and ${context} still works.`
      );
    }
    if (booleans.has(canonical)) {
      if (inline !== null) {
        throw new CommandParseError(`"${canonical}" is a switch - it does not take a value.`);
      }
      flags[camel(canonical)] = true;
      continue;
    }
    if (values.has(canonical)) {
      if (inline !== null) {
        flags[camel(canonical)] = inline;
        continue;
      }
      const next = tokens[i + 1];
      if (next === undefined) {
        throw new CommandParseError(
          `"${canonical}" needs a value.${spec.example ? ` Try: ${spec.example}` : ''}`
        );
      }
      flags[camel(canonical)] = next;
      i++;
      continue;
    }

    // `display` lets a command advertise the spellings real git has, rather
    // than the internal long names used as flag keys.
    const known = spec.display ? [...spec.display] : [...booleans, ...values].sort();
    throw new CommandParseError(
      `"${token}" is not an option ${context} understands.` +
        (known.length ? ` It accepts: ${known.join(', ')}.` : ' It takes no options.')
    );
  }

  return { flags, args };
}

/** `main:feature` -> `{ src:'main', dst:'feature' }`. */
export function parseRefspec(text) {
  const value = String(text ?? '');
  const at = value.indexOf(':');
  if (at === -1) return { src: value, dst: value };
  return { src: value.slice(0, at), dst: value.slice(at + 1) };
}

/**
 * Split a ref expression into a base name plus `~n` / `^n` steps.
 * `isKnownName(candidate)` decides what counts as a name, so ids that contain
 * `'` or `^` (like `C2'^4`) win over the modifier grammar when they exist.
 * Returns null when nothing sensible matches.
 */
export function splitRefExpression(text, isKnownName) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  if (isKnownName(value)) return { base: value, steps: [] };

  for (let cut = value.length - 1; cut > 0; cut--) {
    const head = value.slice(0, cut);
    if (!isKnownName(head)) continue;
    const steps = parseRefSteps(value.slice(cut));
    if (steps) return { base: head, steps };
  }
  return null;
}

/** `~2^1` -> `[{kind:'~',n:2},{kind:'^',n:1}]`; null when the tail is junk. */
export function parseRefSteps(tail) {
  const text = String(tail ?? '');
  const steps = [];
  let at = 0;
  while (at < text.length) {
    const kind = text[at];
    if (kind !== '~' && kind !== '^') return null;
    at++;
    let digits = '';
    while (at < text.length && text[at] >= '0' && text[at] <= '9') digits += text[at++];
    const n = digits === '' ? 1 : Number(digits);
    if (!Number.isFinite(n) || n > 1e6) return null;
    steps.push({ kind, n });
  }
  return steps;
}

/** Cheap edit distance, used only for "did you mean" hints. */
export function editDistance(a, b) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = new Array(t.length + 1);
  let row = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    row[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = row;
    row = swap;
  }
  return prev[t.length];
}

export function suggest(input, candidates) {
  const needle = String(input ?? '').toLowerCase().trim();
  if (!needle) return null;
  let best = null;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const score = editDistance(needle, String(candidate).toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  const limit = Math.max(2, Math.floor(needle.length / 3));
  return bestScore <= limit ? best : null;
}

/**
 * Decide what a single command line is.
 * Returns one of:
 *   { kind:'git', name, args, flags, tokens }
 *   { kind:'ui',  name, rest }
 * and throws CommandParseError with an instructive message otherwise.
 */
export function parseCommandLine(rawInput, registry = {}) {
  const uiNames = registry.uiNames || [];
  const gitSpecs = registry.gitSpecs || emptyMap();
  const allNames = registry.allNames || [];
  const input = String(rawInput ?? '').trim();

  if (!input) {
    throw new CommandParseError('There is no command there. Type "help" to see what you can run.');
  }

  // Multi-word UI commands are matched against the raw text so that payloads
  // (`import tree {...}`) keep their original spacing and quotes.
  const ordered = [...uiNames].sort((a, b) => b.length - a.length);
  for (const name of ordered) {
    const pattern = new RegExp(
      `^${name.split(/\s+/).map(escapeRegex).join('\\s+')}(?:\\s+([\\s\\S]*))?$`,
      'i'
    );
    const match = input.match(pattern);
    if (match) return { kind: 'ui', name, rest: (match[1] || '').trim() };
  }

  const gitMatch = input.match(/^git(?:\s+([\s\S]*))?$/i);
  if (gitMatch) {
    const remainder = (gitMatch[1] || '').trim();
    if (!remainder) {
      throw new CommandParseError(
        'git on its own does not do anything. Add a subcommand, for example "git status" or "git commit -m \'first\'". Type "show commands" for the full list.'
      );
    }
    const tokens = tokenize(remainder);
    // Keep the spelling the reader typed for messages; match on the lower-cased
    // form so "git Status" and "git status" both resolve.
    const typed = tokens.shift() || '';
    const name = typed.toLowerCase();
    // Own-property lookup: `git constructor` must be an unknown command, not a
    // hit on Object.prototype that hands parseOptions the `Object` function.
    const spec = own(gitSpecs, name) ? gitSpecs[name] : null;
    if (!spec || typeof spec !== 'object') {
      const hint = suggest(`git ${name}`, Object.keys(gitSpecs).map((key) => `git ${key}`));
      throw new CommandParseError(
        `"git ${typed}" is not a command this app knows.${hint ? ` Did you mean "${hint}"?` : ''} Type "show commands" for the full list.`
      );
    }
    const label = `git ${typed}`;
    const { flags, args } = parseOptions(tokens, spec, label);
    return { kind: 'git', name, label, args, flags, tokens };
  }

  const first = input.split(/\s+/)[0];
  const hint = suggest(input, allNames) || suggest(first, allNames);
  throw new CommandParseError(
    `"${truncate(input, 40)}" is not a command I know.${hint ? ` Did you mean "${hint}"?` : ''} Type "help" for a tour, or "show commands" for every command.`
  );
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(text, max) {
  const value = String(text);
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
