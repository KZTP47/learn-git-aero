// Static integrity checks on the shipped files.
//
// These guard the class of failure that unit tests cannot see: a stylesheet that
// stopped existing, a module path that no longer resolves, an asset reference
// that survived a rename, or a stray CDN link that would break the promise that
// this app makes no network requests. None of it needs a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const html = read('index.html');

/** Every file under a directory, recursively, as paths relative to root. */
function walk(rel, out = []) {
  const dir = join(root, rel);
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const child = join(rel, name);
    if (statSync(join(root, child)).isDirectory()) walk(child, out);
    else out.push(child.split('\\').join('/'));
  }
  return out;
}

const sourceFiles = [...walk('js'), ...walk('css'), 'index.html'];

test('index.html references only files that exist', () => {
  const refs = [...html.matchAll(/(?:href|src)="([^"#:]+)"/g)]
    .map((m) => m[1])
    .filter((p) => !p.startsWith('#') && !p.startsWith('http'));

  assert.ok(refs.length > 5, 'expected index.html to reference several local files');
  for (const ref of refs) {
    assert.ok(existsSync(join(root, ref)), `index.html references a missing file: ${ref}`);
  }
});

test('every module import resolves to a real file', () => {
  for (const file of sourceFiles.filter((f) => f.endsWith('.js'))) {
    const src = read(file);
    const specifiers = [...src.matchAll(/(?:^|\s)(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)]
      .map((m) => m[1])
      .concat([...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]))
      .filter((s) => s.startsWith('.'));

    for (const spec of specifiers) {
      const target = resolve(dirname(join(root, file)), spec);
      assert.ok(existsSync(target), `${file} imports a missing module: ${spec}`);
    }
  }
});

/**
 * Inline SVG data URIs contain their own `url(#id)` references, percent-encoded
 * as `%23id`. Those are internal to the image and resolve nothing on disk, so
 * the whole data URI is removed before scanning for real asset references.
 */
const withoutDataUris = (src) => src.replace(/url\(\s*['"]?data:[^)]*\)/gi, 'url(data:)');

test('css @import and url() targets exist', () => {
  for (const file of sourceFiles.filter((f) => f.endsWith('.css'))) {
    const src = withoutDataUris(read(file));
    const urls = [...src.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)]
      .map((m) => m[1].trim())
      .filter(
        (u) =>
          !u.startsWith('data:') &&
          !u.startsWith('http') &&
          !u.startsWith('#') &&
          !u.startsWith('%23')
      );

    for (const url of urls) {
      const target = resolve(dirname(join(root, file)), url.split('#')[0]);
      assert.ok(existsSync(target), `${file} points at a missing asset: ${url}`);
    }
  }
});

test('nothing reaches the network', () => {
  // The app must run fully offline. A CDN font or script would break that
  // silently on a machine that happens to be online while it is tested.
  //
  // What counts as a fetch: a stylesheet link, a script src, an image, a font,
  // an @import, or a call that goes out. What does not: an XML namespace, a
  // localhost address printed as instructions, and a link a reader may click.
  const fetching = /(?:src|href)\s*=\s*['"](https?:[^'"]+)|@import\s+['"](https?:[^'"]+)|url\(\s*['"]?(https?:[^'")]+)|fetch\(\s*['"](https?:[^'"]+)/g;

  const offenders = [];
  for (const file of sourceFiles) {
    const src = read(file);
    for (const m of src.matchAll(fetching)) {
      const url = m[1] || m[2] || m[3] || m[4];
      if (url.startsWith('http://www.w3.org/')) continue; // XML namespace
      if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) continue; // local instructions
      offenders.push(`${file}: ${url}`);
    }
  }
  assert.deepEqual(offenders, [], `external references found:\n${offenders.join('\n')}`);
});

test('index.html keeps the element ids the modules bind to', () => {
  // main.js and the view modules look these up by id. Renaming one in the markup
  // breaks the app at runtime with no build step to catch it.
  const required = [
    'app', 'aero-bg', 'topbar', 'brand', 'level-title', 'level-progress',
    'btn-levels', 'btn-objective', 'btn-solution', 'btn-hint', 'btn-undo',
    'btn-reset', 'btn-help', 'btn-theme', 'btn-sound', 'btn-fullscreen',
    'workspace', 'terminal-pane', 'terminal-host', 'pane-divider',
    'canvas-pane', 'tree-host', 'goal-panel', 'goal-host', 'goal-close',
    'modal-root', 'toast-root', 'command-hint',
  ];
  for (const id of required) {
    assert.ok(html.includes(`id="${id}"`), `index.html is missing #${id}`);
  }
});

test('index.html loads the app as a module and guards the file protocol', () => {
  assert.match(html, /<script type="module" src="js\/main\.js"><\/script>/);
  // Opened over file://, modules are blocked and the page would render a dead
  // shell. The inline guard replaces it with an explanation.
  assert.ok(
    html.includes("location.protocol === 'file:'"),
    'the file:// guard has been removed from index.html'
  );
});

test('every js and css file parses', async () => {
  for (const file of sourceFiles.filter((f) => f.endsWith('.js'))) {
    // Importing a view module would need a DOM, so only check that the engine
    // and level modules - which are DOM-free by contract - actually load.
    if (!/^js\/(git|levels|core)\//.test(file)) continue;
    if (file.endsWith('core/store.js') || file.endsWith('core/util.js')) continue;
    await import(pathToFileURL(join(root, file)).href);
  }
});

test('no source file is empty or suspiciously small', () => {
  for (const file of sourceFiles) {
    const bytes = statSync(join(root, file)).size;
    assert.ok(bytes > 64, `${file} is only ${bytes} bytes - did it get truncated?`);
  }
});

test('assets referenced by the icon sprite are self-contained', () => {
  const sprite = read('assets/icons.svg');
  assert.ok(sprite.includes('<symbol'), 'icons.svg contains no symbols');
  assert.ok(!/<image\b/.test(sprite), 'icons.svg embeds a raster image');
  // Every <use href="assets/icons.svg#icon-x"> in the app must name a real symbol.
  const used = new Set(
    [...html.matchAll(/icons\.svg#([\w-]+)/g)].map((m) => m[1]).concat(
      sourceFiles
        .filter((f) => f.endsWith('.js'))
        .flatMap((f) => [...read(f).matchAll(/icons\.svg#([\w-]+)/g)].map((m) => m[1]))
    )
  );
  for (const id of used) {
    assert.ok(sprite.includes(`id="${id}"`), `icons.svg has no symbol #${id}`);
  }
});

test('css files declare no raw colours outside the token file', () => {
  // Colours live in tokens.css so both themes stay in one place. A hex that
  // creeps into a component file will not follow the theme.
  const offenders = [];
  for (const file of sourceFiles.filter((f) => f.endsWith('.css') && !f.endsWith('tokens.css'))) {
    const src = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      // Fragment identifiers in url(#id) are not colours.
      const before = src.slice(Math.max(0, m.index - 6), m.index);
      if (!/url\(['"]?$/.test(before)) offenders.push(`${file}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `raw colours outside tokens.css:\n${offenders.join('\n')}`);
});

test('no file carries an emoji', () => {
  // House rule: the interface uses drawn icons, never emoji.
  const offenders = [];
  for (const file of [...sourceFiles, ...walk('test')]) {
    if (extname(file) === '.png') continue;
    const src = read(file);
    // Astral-plane characters, which is where the emoji blocks live.
    const hit = src.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    if (hit) offenders.push(`${file}: ${hit[0]}`);
  }
  assert.deepEqual(offenders, [], `emoji found:\n${offenders.join('\n')}`);
});
