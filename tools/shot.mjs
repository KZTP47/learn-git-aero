#!/usr/bin/env node
/**
 * Headless screenshot + scripting harness. Pure Node (>=22), zero dependencies:
 * it drives an already-installed Chrome/Edge over the DevTools protocol using
 * Node's built-in fetch and WebSocket.
 *
 * Every run picks its own free debugging port and its own throwaway profile, so
 * many agents can run this at the same time without colliding.
 *
 * USAGE
 *   node tools/shot.mjs --url <url> --out <file.png> [options]
 *
 * OPTIONS
 *   --url <url>          page to open (required)
 *   --out <file>         png path (required unless the recipe has its own shots)
 *   --width <n>          viewport width  (default 1440)
 *   --height <n>         viewport height (default 900)
 *   --dpr <n>            device pixel ratio (default 2)
 *   --mobile             use touch emulation
 *   --theme <day|dusk>   seeds localStorage lga:theme before the first paint
 *   --wait-fn "<js>"     poll this expression until it is truthy (default: document.readyState==='complete')
 *   --wait-ms <n>        extra settle time after wait-fn (default 350)
 *   --timeout <ms>       overall budget (default 45000)
 *   --eval "<js>"        run after load, before the shot; repeatable, awaited if it returns a promise
 *   --recipe <file.json> array of steps, see below; overrides --eval
 *   --full               capture the full scrollable page instead of the viewport
 *   --clip "<selector>"  capture only this element's box
 *   --json <file>        write the console/error report here (default: <out>.json)
 *   --quiet              only print the JSON summary
 *
 * RECIPE STEPS (array of objects, executed in order)
 *   {"eval": "js"}                     run javascript (awaited)
 *   {"type": "git commit", "into": "#terminal input"}   focus + type text with real key events
 *   {"key": "Enter", "modifiers": 0}   send a key
 *   {"click": "<selector>"}            click the centre of an element
 *   {"hover": "<selector>"}
 *   {"scroll": 400, "in": "<selector>"}
 *   {"wait": 500}                      sleep milliseconds
 *   {"waitFor": "js"}                  poll until truthy
 *   {"resize": [width, height]}
 *   {"theme": "dusk"}
 *   {"shot": "name.png"}               screenshot to this path (relative to --out's folder)
 *   {"shot": "name.png", "full": true, "clip": "#sel"}
 *
 * EXIT CODE 0 on success, 1 on harness failure. Page console errors do NOT fail
 * the run - read them from the JSON report.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import net from 'node:net';

// --- argv -----------------------------------------------------------------

function parseArgs(argv) {
  const out = { eval: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const flags = { mobile: 1, full: 1, quiet: 1 };
    if (flags[key]) {
      out[key] = true;
      continue;
    }
    const value = argv[++i];
    if (key === 'eval') out.eval.push(value);
    else out[key] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const log = (...a) => {
  if (!args.quiet) console.error(...a);
};

if (!args.url) {
  console.error('shot.mjs: --url is required');
  process.exit(1);
}

const WIDTH = Number(args.width || 1440);
const HEIGHT = Number(args.height || 900);
const DPR = Number(args.dpr || 2);
const TIMEOUT = Number(args.timeout || 45000);
const WAIT_MS = Number(args['wait-ms'] ?? 350);
const WAIT_FN = args['wait-fn'] || "document.readyState === 'complete'";

// --- browser discovery ----------------------------------------------------

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findBrowser() {
  for (const path of CANDIDATES) if (existsSync(path)) return path;
  throw new Error('No Chrome or Edge found. Set CHROME_PATH.');
}

const freePort = () =>
  new Promise((res, rej) => {
    const srv = net.createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- minimal CDP client ---------------------------------------------------

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, TIMEOUT);
    });
  }

  /** Evaluate an expression in the page and return its (awaited) value. */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { return (${expression}); })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`page threw: ${d.exception?.description || d.text}`);
    }
    return res.result?.value;
  }

  async waitFor(expression, budget = TIMEOUT) {
    const deadline = Date.now() + budget;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (err) {
        last = err.message;
      }
      await sleep(100);
    }
    throw new Error(`waitFor timed out: ${expression} (last: ${JSON.stringify(last)})`);
  }
}

// --- report ---------------------------------------------------------------

const report = {
  url: args.url,
  viewport: { width: WIDTH, height: HEIGHT, dpr: DPR },
  consoleErrors: [],
  consoleWarnings: [],
  pageExceptions: [],
  failedRequests: [],
  shots: [],
  steps: [],
  ok: true,
};

function attachDiagnostics(cdp) {
  cdp.on('Runtime.consoleAPICalled', ({ type, args: a = [] }) => {
    if (type !== 'error' && type !== 'warning' && type !== 'assert') return;
    const text = a
      .map((x) => x.value ?? x.description ?? x.unserializableValue ?? x.type)
      .join(' ');
    (type === 'warning' ? report.consoleWarnings : report.consoleErrors).push(text);
  });
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    report.pageExceptions.push(
      exceptionDetails.exception?.description || exceptionDetails.text || 'unknown exception'
    );
  });
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error') report.consoleErrors.push(`[${entry.source}] ${entry.text}`);
    else if (entry.level === 'warning') report.consoleWarnings.push(`[${entry.source}] ${entry.text}`);
  });
  cdp.on('Network.loadingFailed', ({ errorText, type }) => {
    report.failedRequests.push(`${type}: ${errorText}`);
  });
  cdp.on('Network.responseReceived', ({ response, type }) => {
    if (response.status >= 400) report.failedRequests.push(`${response.status} ${type} ${response.url}`);
  });
}

// --- screenshots ----------------------------------------------------------

async function capture(cdp, outPath, { full = false, clip = null } = {}) {
  const params = { format: 'png', captureBeyondViewport: full };
  if (clip) {
    const box = await cdp.eval(
      `(() => { const n = document.querySelector(${JSON.stringify(clip)});
         if (!n) return null; const r = n.getBoundingClientRect();
         return {x:r.x + scrollX, y:r.y + scrollY, width:r.width, height:r.height}; })()`
    );
    if (!box) throw new Error(`clip selector not found: ${clip}`);
    params.clip = { ...box, scale: 1 };
    params.captureBeyondViewport = true;
  } else if (full) {
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize;
    params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
  }
  const { data } = await cdp.send('Page.captureScreenshot', params);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.from(data, 'base64'));
  report.shots.push(outPath);
  log(`shot -> ${outPath}`);
  return outPath;
}

// --- input helpers --------------------------------------------------------

const KEY_CODES = {
  Enter: { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: '\r' },
  Tab: { windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' },
  Escape: { windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' },
  ArrowUp: { windowsVirtualKeyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
  ArrowDown: { windowsVirtualKeyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
  ArrowLeft: { windowsVirtualKeyCode: 37, code: 'ArrowLeft', key: 'ArrowLeft' },
  ArrowRight: { windowsVirtualKeyCode: 39, code: 'ArrowRight', key: 'ArrowRight' },
  Backspace: { windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' },
  Home: { windowsVirtualKeyCode: 36, code: 'Home', key: 'Home' },
  End: { windowsVirtualKeyCode: 35, code: 'End', key: 'End' },
};

async function pressKey(cdp, name, modifiers = 0) {
  const spec = KEY_CODES[name] || { key: name, text: name, code: `Key${name.toUpperCase()}` };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...spec });
  if (spec.text) await cdp.send('Input.dispatchKeyEvent', { type: 'char', modifiers, text: spec.text, key: spec.key });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...spec });
}

async function typeText(cdp, text) {
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
}

async function centreOf(cdp, selector) {
  const box = await cdp.eval(
    `(() => { const n = document.querySelector(${JSON.stringify(selector)});
       if (!n) return null; const r = n.getBoundingClientRect();
       return {x: r.x + r.width/2, y: r.y + r.height/2}; })()`
  );
  if (!box) throw new Error(`selector not found: ${selector}`);
  return box;
}

async function clickAt(cdp, selector) {
  const { x, y } = await centreOf(cdp, selector);
  const common = { x, y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...common });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
}

// --- main -----------------------------------------------------------------

async function main() {
  const browserPath = findBrowser();
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'shot-profile-'));
  const outPath = args.out ? resolve(args.out) : null;
  const outDir = outPath ? dirname(outPath) : process.cwd();

  const flags = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-features=Translate,OptimizationHints',
    '--hide-scrollbars',
    '--mute-audio',
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ];

  const child = spawn(browserPath, flags, { stdio: 'ignore' });
  let ws;
  let cdp;

  const cleanup = () => {
    try {
      ws?.close();
    } catch {}
    try {
      child.kill();
    } catch {}
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {}
  };
  process.on('exit', cleanup);

  try {
    // Wait for the DevTools endpoint.
    let pageWsUrl = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !pageWsUrl) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page) pageWsUrl = page.webSocketDebuggerUrl;
      } catch {
        /* not up yet */
      }
      if (!pageWsUrl) await sleep(150);
    }
    if (!pageWsUrl) throw new Error('browser never exposed a page target');

    if (typeof WebSocket === 'undefined') throw new Error('Node 22+ with global WebSocket required');
    ws = new WebSocket(pageWsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('devtools socket error')), { once: true });
    });

    cdp = new CDP(ws);
    attachDiagnostics(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: DPR,
      mobile: Boolean(args.mobile),
      screenWidth: WIDTH,
      screenHeight: HEIGHT,
    });
    if (args.mobile) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    if (args.theme) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try { localStorage.setItem('lga:theme', ${JSON.stringify(JSON.stringify(args.theme))}); } catch (e) {}`,
      });
    }

    const loaded = new Promise((res) => cdp.on('Page.loadEventFired', res));
    await cdp.send('Page.navigate', { url: args.url });
    await Promise.race([loaded, sleep(TIMEOUT)]);

    await cdp.waitFor(WAIT_FN, Math.min(TIMEOUT, 20000)).catch((err) => {
      report.ok = false;
      report.steps.push({ step: 'wait-fn', error: err.message });
    });
    await sleep(WAIT_MS);

    // Steps
    const recipe = args.recipe ? JSON.parse(readFileSync(resolve(args.recipe), 'utf8')) : null;
    const steps = recipe || args.eval.map((expression) => ({ eval: expression }));

    for (const [i, step] of steps.entries()) {
      const label = JSON.stringify(step).slice(0, 160);
      try {
        if (step.eval !== undefined) {
          const value = await cdp.eval(step.eval);
          report.steps.push({ i, step: label, value });
          continue;
        }
        if (step.waitFor !== undefined) await cdp.waitFor(step.waitFor, step.budget || 15000);
        if (step.resize) {
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: step.resize[0],
            height: step.resize[1],
            deviceScaleFactor: DPR,
            mobile: Boolean(args.mobile),
          });
          await sleep(250);
        }
        if (step.theme !== undefined) {
          await cdp.eval(`document.documentElement.dataset.theme = ${JSON.stringify(step.theme)}`);
          await sleep(200);
        }
        if (step.click) await clickAt(cdp, step.click);
        if (step.hover) {
          const { x, y } = await centreOf(cdp, step.hover);
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        }
        if (step.into) await cdp.eval(`document.querySelector(${JSON.stringify(step.into)})?.focus()`);
        if (step.type !== undefined) await typeText(cdp, step.type);
        if (step.key) await pressKey(cdp, step.key, step.modifiers || 0);
        if (step.scroll !== undefined) {
          const sel = step.in ? JSON.stringify(step.in) : 'null';
          await cdp.eval(
            `(() => { const n = ${sel} ? document.querySelector(${sel}) : document.scrollingElement;
               if (n) n.scrollTop += ${Number(step.scroll)}; return true; })()`
          );
        }
        if (step.wait !== undefined) await sleep(Number(step.wait));
        if (step.shot) await capture(cdp, resolve(outDir, step.shot), { full: step.full, clip: step.clip });
        report.steps.push({ i, step: label, ok: true });
      } catch (err) {
        report.ok = false;
        report.steps.push({ i, step: label, error: err.message });
        log(`step ${i} failed: ${err.message}`);
      }
    }

    if (outPath) await capture(cdp, outPath, { full: args.full, clip: args.clip });
  } catch (err) {
    report.ok = false;
    report.error = err.message;
    log(`shot.mjs: ${err.message}`);
  } finally {
    const jsonPath = args.json
      ? resolve(args.json)
      : outPath
        ? `${outPath}.json`
        : resolve(outDir, 'shot-report.json');
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          error: report.error,
          shots: report.shots.map((s) => basename(s)),
          consoleErrors: report.consoleErrors.slice(0, 20),
          consoleWarnings: report.consoleWarnings.slice(0, 10),
          pageExceptions: report.pageExceptions.slice(0, 10),
          failedRequests: report.failedRequests.slice(0, 10),
          stepErrors: report.steps.filter((s) => s.error),
          stepValues: report.steps.filter((s) => s.value !== undefined),
          reportPath: jsonPath,
        },
        null,
        2
      )
    );
    cleanup();
  }

  process.exit(report.ok ? 0 : 1);
}

main();
