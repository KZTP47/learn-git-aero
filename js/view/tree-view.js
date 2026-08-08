// Commit-graph view. Pure inline SVG, no libraries.
//
// Pipeline per render:
//   snapshot -> layoutRegion() (generations, chains, columns, labels, routed
//   edges) -> scene (plain data) -> reconcile against the live DOM -> one rAF
//   tween loop that moves nodes/labels/camera and rebuilds moving edge paths.
//
// Layout invariants the tests rely on:
//   * STRICT DEPTH ROWS. gen(c) = longest path from a root, and y = -gen * ROW
//     with one ROW for the whole region, so every commit at the same depth
//     lands on exactly the same flow-axis coordinate. Nothing may nudge a
//     commit off its row - siblings are told apart on the other axis.
//   * every commit belongs to exactly one first-parent chain, and each chain
//     owns one column, so no two beads can ever share a position and no two
//     siblings can ever share a lane.
//   * cross-column edges that cannot take a clean curve are routed through
//     half-integer "bands" (between rows) and "gutters" (between columns),
//     neither of which can contain a bead or a label.

import { el, svgEl, clamp, uid, prefersReducedMotion, sleep } from '../core/util.js';

const MAIN_NAMES = new Set(['main', 'master']);
const EMPTY_SNAPSHOT = { commits: {}, branches: {}, tags: {}, HEAD: null, origin: null };

const GEOM_DEFAULT = {
  r: 21,
  col: 96,
  row: 104,
  labelH: 24,
  labelGap: 5,
  labelOff: 13,
  pillPad: 10,
  pad: 34,
  regionGap: 72,
  labelFs: 12,
  idFs: 14,
};
const GEOM_VARS = {
  r: '--tv-r',
  col: '--tv-col',
  row: '--tv-row',
  labelH: '--tv-label-h',
  labelGap: '--tv-label-gap',
  labelOff: '--tv-label-off',
  pillPad: '--tv-pill-pad',
  pad: '--tv-pad',
  regionGap: '--tv-region-gap',
  labelFs: '--tv-label-fs',
  idFs: '--tv-id-fs',
};

// Fit fills the stage instead of stopping at 1:1 - a five-commit tree in a
// 1300px pane should read at 1300px, not float as a stamp in empty water. The
// miniature keeps a much lower ceiling so it stays legibly *smaller* than the
// real graph next to it.
const MAX_FIT_SCALE = 3;
const MAX_FIT_SCALE_COMPACT = 2.1;
const FIT_FILL = 0.94;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 3;
// A commit id below this reads as a smudge, so the camera rounds the fit UP to
// it and lets the pane pan over the difference. Fitting a 38-commit history
// into a desktop pane lands on scale 0.26, where the id measures 3.6px: the
// graph is whole, and unreadable, which is the wrong half of the trade to
// keep. Above PAN_MIN the pane is big enough that panning and the zoom
// controls are a real affordance, so the floor is unconditional there and the
// graph is allowed to run off the box.
//   Below PAN_MIN it is not: a 40-commit history on a 360px phone would need
// 13x, and the reader would be left holding a keyhole. There the old rule
// stands - round the fit up only if the whole graph still nearly fits
// (FIT_SPILL), otherwise keep the overview, which is the only useful thing at
// that size.
const MIN_ID_PX = 10;
const FIT_SPILL = 1.12;
const PAN_MIN_W = 420;
const PAN_MIN_H = 320;
// When the floor pushes the graph past its box, the framing starts at the tip
// of history - the newest commits and the refs on them - rather than at the
// geometric middle of a picture whose edges are off-screen anyway.
const SPILL_TOP_PAD = 18;

// LOCAL AND ORIGIN: WHICH WAY ROUND. The pair is stacked down the page when the
// pane is tall, and set side by side when it is wide. The aspect test alone is
// not enough, and this is the whole of the 360px bug: a phone's graph pane is
// about 342x230, which the aspect test calls "wide", so the two frames went
// side by side in two ~100px columns. Side by side they share depth rows - the
// point of the pairing, so a commit at depth d is on one line in both - and the
// deeper repository therefore starts higher up the page. With origin two
// commits ahead, as it is in every fetch lesson, the origin frame's top edge
// measured 100px ABOVE the local frame's, so the first thing read on a phone
// was the server's repository. Below this width there is no room for two frames
// anyway, so the pair stacks whatever the aspect says, and stacked it is local
// first. Compact miniatures are laid out at roughly half these metrics (see
// .tv--compact) and get the same rule at half the width.
const SIDE_BY_SIDE_MIN_W = 420;
const SIDE_BY_SIDE_MIN_W_COMPACT = 240;
const stackedFor = (w, h, compact) =>
  w < (compact ? SIDE_BY_SIDE_MIN_W_COMPACT : SIDE_BY_SIDE_MIN_W) || w / Math.max(h, 1) < 1.05;

// Sibling fan. Branches forking off one commit share a row - that is what a
// depth row means - so they are separated on the other three levers instead:
// each gets its own lane, the rows grow until the fan is not flat, and every
// edge leaves and arrives on its own heading.
const FAN_MIN = 0.3; // rad (~17deg) - arrival heading of the innermost fork
const FAN_MAX = 1.5; // rad (~86deg) - never arrive from below the equator
const FAN_STEP = 0.42; // rad between neighbouring arrival headings
// rad - the least any two arrowheads may share of a rim. At 0.36 the nearest
// pair of tips measured 8.1px apart at the fitted zoom with a head 8.66px
// wide: they did not touch, but only the casing stood between them.
const ARRIVE_SEP = 0.45;
// Five or more arrivals on one bead and the heads themselves come down, so a
// crowded rim reads as separate spokes rather than a ring of paint.
const ARRIVE_CROWD = 5;
const ARROW_CROWD_SCALE = 0.83;
// A fork landing lanes away from its parent would lie almost flat at the base
// row height. Rows are uniform, so the whole region grows instead - and only
// while it is still wider than it is tall, which is exactly what a fan is and
// never what a long history is.
const FORK_SLOPE = 0.62; // tan(~32deg): the flattest a fork edge may lie
// A miniature buys the same guarantee much more cheaply: its fork edges are
// one short lane long, so a 24deg minimum still cannot produce the long
// low-angle sweep the rule exists to stop, and the rows it saves go straight
// into the scale - which is the only thing a legend that cannot be zoomed has.
const FORK_SLOPE_MINI = 0.45;
const FORK_ASPECT = 1.15; // rows may only grow until height ~= width * this
const FAN_SIDES = 3; // this many chains off one commit straddle it
// This many children and the commit is a fan, not a spine with a branch off it.
// See buildChains: at that point no child keeps the parent's own column.
const FAN_WIDE = 4;
// Edges stop this far off the rim. The casing is butt-capped, so nothing of the
// line work is painted under the translucent bead glass.
const EDGE_GAP = 1.6;

// --- small helpers --------------------------------------------------------

const f2 = (n) => Math.round(n * 100) / 100;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function easeBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
const mix = (a, b, t) => a + (b - a) * t;

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// Preference order over --branch-c1..c8, widest hue gaps first. c6 (crimson)
// and c7 (olive) are the only two tokens that go muddy over the water, so they
// are held back until a graph really has more branches than the Aero family:
// sky, seafoam, violet, lime, indigo, coral.
const PALETTE = [1, 5, 3, 2, 8, 4, 6, 7];
const PALETTE_ALT = [5, 3, 2, 8, 4];
const refKey = (name) => String(name || '').replace(/^o\//, '');

function colorIndexFor(name) {
  const base = refKey(name);
  if (MAIN_NAMES.has(base)) return 1;
  return PALETTE_ALT[hash32(base) % PALETTE_ALT.length];
}

// Hash keeps a branch's colour stable as the graph grows; the second pass only
// moves a name when it would otherwise be a twin of one already on screen.
function palette(names) {
  const keys = [...new Set(names.map(refKey))].sort(
    (a, b) => (MAIN_NAMES.has(a) ? 0 : 1) - (MAIN_NAMES.has(b) ? 0 : 1) || cmpId(a, b)
  );
  const taken = new Set();
  const out = new Map();
  for (const key of keys) {
    let want = colorIndexFor(key);
    if (taken.has(want)) want = PALETTE.find((c) => !taken.has(c)) ?? want;
    taken.add(want);
    out.set(key, want);
  }
  return { of: (name) => out.get(refKey(name)) ?? colorIndexFor(name) };
}

const colorVar = (i) => (i >= 1 && i <= 8 ? `var(--branch-c${i})` : 'var(--commit-stroke)');

// PAST SIX BRANCHES, COLOUR ALONE RUNS OUT. The ramp is spaced across a 72deg
// band (150-222) with alternating lightness, so the first six slots handed out
// - PALETTE[0..5] = c1 c5 c3 c2 c8 c4 - are either 29deg apart or 14deg apart
// with 0.15 of OKLCH lightness between them. The last two slots have neither
// left: c6 is 7deg from c5 and the same deep lightness, and c7 is 7deg from c1
// and the same light one. They are twins of colours already on the canvas, and
// a seventh branch is the first time either is handed out - PALETTE_ALT, which
// every branch hashes into, does not contain them, so an index of 6 or 7 can
// only come from the overflow in palette().
//   Those two therefore carry a second, non-colour mark: their ref pill is
// drawn with a DOUBLED OUTLINE - the pill's own rule, plus a second one inset
// inside it - which separates each twin from its partner and so keeps all eight
// branches apart on something other than hue.
//   Why the pill, and why doubled. The bead cannot take it: outside the rim is
// where every arrowhead lands (edges stop at R + EDGE_GAP and the head runs out
// from there), and inside it the bead's own gradient is already inked over its
// lower half, so a ring there is invisible on one side whichever way it is
// painted. Doubling is not a dash: a dashed EDGE already means "second parent
// of a merge" and a dashed PILL already means "goal state, not there yet" in
// the ghost layer, and neither may be borrowed. It is not a weight change
// either, which would collide with .is-highlight and .is-selected - both of
// which thicken the bead rim to say something transient about state. And it
// costs no width, so no lane, no label stack and no fork angle moves.
const RAMP_TWINS = new Set([6, 7]);
const banded = (i) => RAMP_TWINS.has(i);

// Line work - edges, arrowheads, leaders, bead rims - keeps its branch hue and
// chroma but accepts a ceiling on lightness, so the pale half of the day
// palette stops falling under the 3:1 WCAG 1.4.11 asks of a graphical object
// you cannot read the graph without. See --tv-ink-cap in tree.css.
// `oklch(from ...)` is Chrome 119+, Safari 16.4+, Firefox 128+. Where it is
// not understood the declaration is invalid AT COMPUTED-VALUE TIME, which is
// not the same as absent: a var() fallback never fires, and the line work
// would lose its colour rather than fall back to it. So the support is tested
// once and the raw token is used when it is missing.
const INK_CAP_OK =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('color', 'oklch(from red calc(min(l, 0.5)) c h)');
const capped = (c) => (INK_CAP_OK ? `oklch(from ${c} calc(min(l, var(--tv-ink-cap, 1))) c h)` : c);
const inkVar = (i) => capped(colorVar(i));

// C2 < C10 < C10' < C10''
function cmpId(a, b) {
  const ra = /^([^\d]*)(\d+)(.*)$/.exec(a);
  const rb = /^([^\d]*)(\d+)(.*)$/.exec(b);
  if (ra && rb && ra[1] === rb[1]) {
    const d = Number(ra[2]) - Number(rb[2]);
    if (d) return d;
    return ra[3] < rb[3] ? -1 : ra[3] > rb[3] ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function unitTo(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

function roundedPath(points, radius) {
  const pts = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 0.4) pts.push(p);
  }
  if (pts.length < 2) return '';
  let d = `M${f2(pts[0].x)},${f2(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const a = pts[i - 1];
    const b = pts[i + 1];
    const da = Math.hypot(p.x - a.x, p.y - a.y);
    const db = Math.hypot(b.x - p.x, b.y - p.y);
    const rr = Math.min(radius, da / 2, db / 2);
    const va = unitTo(p, a);
    const vb = unitTo(p, b);
    d += `L${f2(p.x + va.x * rr)},${f2(p.y + va.y * rr)}`;
    d += `Q${f2(p.x)},${f2(p.y)} ${f2(p.x + vb.x * rr)},${f2(p.y + vb.y * rr)}`;
  }
  const end = pts[pts.length - 1];
  d += `L${f2(end.x)},${f2(end.y)}`;
  return d;
}

// Top highlight for a capsule, following the capsule's own caps.
// A gloss drawn as "straight top edge, close it off" ends on a hard vertical cut
// at x = r - exactly where the rounded cap begins - so the highlight stops a
// full cap-width short of the pill and the glass reads as a rectangle sitting in
// a capsule. Both ends are arcs of the inset capsule instead, and the only
// straight run is the horizontal chord where the highlight fades out.
//   box:   (x, y, w, h) of the capsule the gloss sits inside
//   inset: how far inside the capsule's edge the highlight starts
//   frac:  where the highlight ends, as a fraction of the capsule's height
function capsuleGloss(x, y, w, h, inset, frac) {
  const r = h / 2;
  const ri = r - inset;
  const cxL = x + r;
  const cxR = x + w - r;
  if (ri <= 0.01 || cxR < cxL) return '';
  const yTop = y + inset;
  const yEnd = y + h * frac;
  const dy = yEnd - (y + r);
  // Half-width of the inset capsule at the height the highlight ends. Clamped so
  // a frac past the capsule's own bottom degrades to a flat end, never to NaN.
  const dx = Math.abs(dy) >= ri ? 0 : Math.sqrt(ri * ri - dy * dy);
  return (
    `M${f2(cxL - dx)},${f2(yEnd)}` +
    `A${f2(ri)} ${f2(ri)} 0 0 1 ${f2(cxL)},${f2(yTop)}` +
    `L${f2(cxR)},${f2(yTop)}` +
    `A${f2(ri)} ${f2(ri)} 0 0 1 ${f2(cxR + dx)},${f2(yEnd)}Z`
  );
}

// The same highlight for the tag pill, whose left end is a point rather than a
// cap: a capsule arc there would sit outside the tag's own slanted edges. The
// two edges meet at x = 0, y = h/2 and inset by `inset` perpendicular, which is
// a horizontal shift of inset * hypot(notch, r) / r on both of them.
function tagGloss(w, h, notch, inset, frac) {
  const r = h / 2;
  const ri = r - inset;
  const cxR = w - r;
  if (ri <= 0.01 || cxR < r) return '';
  const off = (inset * Math.hypot(notch, r)) / r;
  const edgeX = (y) => (notch * Math.abs(y - r)) / r + off;
  const yTop = inset;
  const yEnd = h * frac;
  const dy = yEnd - r;
  const dx = Math.abs(dy) >= ri ? 0 : Math.sqrt(ri * ri - dy * dy);
  return (
    `M${f2(edgeX(yEnd))},${f2(yEnd)}` +
    `L${f2(off)},${f2(r)}` +
    `L${f2(edgeX(yTop))},${f2(yTop)}` +
    `L${f2(cxR)},${f2(yTop)}` +
    `A${f2(ri)} ${f2(ri)} 0 0 1 ${f2(cxR + dx)},${f2(yEnd)}Z`
  );
}

// `bias` desynchronises mirrored pairs: two merge edges that cross - the whole
// point of a criss-cross history - used to be exact reflections of each other,
// so they met almost tangentially and hugged for half their length. Giving each
// one its own swing makes the same crossing happen at a readable angle.
function curveControl(p0, p1, bias = 0.5) {
  const swing = Math.max(Math.abs(p1.y - p0.y) * bias, 16);
  return [
    { x: p0.x, y: p0.y + swing },
    { x: p1.x, y: p1.y - swing },
  ];
}
function curvePath(p0, p1, bias) {
  const [c0, c1] = curveControl(p0, p1, bias);
  return `M${f2(p0.x)},${f2(p0.y)}C${f2(c0.x)},${f2(c0.y)} ${f2(c1.x)},${f2(c1.y)} ${f2(p1.x)},${f2(p1.y)}`;
}
function cubicAt(p0, c0, c1, p1, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * p1.y,
  };
}

function pointInRect(p, rect, pad) {
  return (
    p.x >= rect.x - pad &&
    p.x <= rect.x + rect.w + pad &&
    p.y >= rect.y - pad &&
    p.y <= rect.y + rect.h + pad
  );
}

// --- layout ---------------------------------------------------------------

// Longest-path depth via Kahn's algorithm: gen(c) = 1 + max(gen(parents)), so
// two commits at the same depth always land on the same row. This is the one
// number the whole flow axis is built from - there is deliberately no per-edge
// span, because anything that pushes one sibling deeper than another breaks
// the depth row. Iterative so a 500-commit chain cannot blow the stack;
// malformed cycles degrade instead of hanging.
function generations(commits, ids) {
  const gen = new Map();
  const indeg = new Map();
  const children = new Map();
  for (const id of ids) {
    gen.set(id, 0);
    children.set(id, []);
  }
  for (const id of ids) {
    const parents = (commits[id].parents || []).filter((p) => commits[p]);
    indeg.set(id, parents.length);
    for (const p of parents) children.get(p).push(id);
  }
  const queue = ids.filter((id) => indeg.get(id) === 0);
  let head = 0;
  let seen = 0;
  while (head < queue.length) {
    const u = queue[head++];
    seen++;
    for (const v of children.get(u)) {
      const want = gen.get(u) + 1;
      if (gen.get(v) < want) gen.set(v, want);
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  if (seen < ids.length) {
    // cycle in the data: park the survivors above everything resolved so far.
    let top = 0;
    for (const id of ids) top = Math.max(top, gen.get(id));
    for (const id of ids) if (indeg.get(id) > 0) gen.set(id, top + 1);
  }
  return gen;
}

// showHead is false for the origin region: HEAD is a property of the reader's
// own repository, so drawing a second pointer inside origin is just wrong.
function collectRefs(snap, showHead = true) {
  const branches = snap.branches || {};
  const tags = snap.tags || {};
  const head = showHead ? snap.HEAD || null : null;
  const attached = head && branches[head.target] ? head.target : null;
  const detachedAt = head && !attached && (snap.commits || {})[head.target] ? head.target : null;

  const pal = palette([...Object.keys(branches), ...Object.keys(tags)]);
  const branchList = Object.values(branches)
    .filter((b) => b && b.id)
    .map((b) => ({
      id: b.id,
      target: b.target,
      remote: Boolean(b.remote || String(b.id).startsWith('o/')),
      active: b.id === attached,
      color: pal.of(b.id),
    }));
  branchList.sort((a, b) => {
    const pa = (MAIN_NAMES.has(a.id.replace(/^o\//, '')) ? 0 : 2) + (a.remote ? 1 : 0);
    const pb = (MAIN_NAMES.has(b.id.replace(/^o\//, '')) ? 0 : 2) + (b.remote ? 1 : 0);
    return pa - pb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });

  const tagList = Object.values(tags)
    .filter((t) => t && t.id)
    .map((t) => ({ id: t.id, target: t.target }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { branchList, tagList, attached, detachedAt, head, pal };
}

// Ranks the children that fork away from a commit's own column, nearest lane
// first, each side of the parent counted on its own. The rank picks the heading
// the edge arrives on, so a fan of siblings meets its parent as a spread of
// separate spokes instead of one bundle - and it does that without touching
// anybody's depth.
function forkRanks(commits, ids, chains, owner) {
  const colOf = (id) => (owner.has(id) ? chains[owner.get(id)].column : 0);
  const kids = new Map();
  for (const id of ids) {
    // Only the first-parent link decides where a commit hangs. Merge edges keep
    // their own routing, which reviewers liked.
    const p = (commits[id].parents || [])[0];
    if (!p || !commits[p]) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(id);
  }
  const rank = new Map();
  for (const [p, list] of kids) {
    const pc = colOf(p);
    for (const side of [1, -1]) {
      const forks = list
        .filter((c) => Math.sign(colOf(c) - pc) === side)
        .sort((a, b) => Math.abs(colOf(a) - pc) - Math.abs(colOf(b) - pc) || cmpId(a, b));
      const m = forks.length;
      if (!m) continue;
      forks.forEach((c, i) => rank.set(`${p} ${c}`, { i, m, side }));
    }
  }
  return rank;
}

// Where a fork edge meets its parent: a heading on the parent's upper rim.
// Siblings are spread evenly across the fan so the joins never stack up.
function fanFor(node, parent, info, R, gap) {
  const dx = node.x - parent.x;
  const dy = node.y - parent.y;
  const side = dx >= 0 ? 1 : -1;
  const geo = clamp(Math.atan2(Math.abs(dx), Math.abs(dy) || 1), FAN_MIN, FAN_MAX);
  let a = geo;
  if (info && info.m > 1) {
    // Spread the whole fan over as much of the parent's rim as it needs. The
    // arrivals used to share one 30deg arc, where six arrowheads stacked into a
    // single dark clot on the bead.
    const hi = Math.min(FAN_MAX, FAN_MIN + FAN_STEP * (info.m - 1));
    a = FAN_MIN + (hi - FAN_MIN) * (info.i / (info.m - 1));
  }
  const dir = { x: Math.sin(a) * side, y: -Math.cos(a) };
  const arrive = { x: parent.x + dir.x * (R + gap), y: parent.y + dir.y * (R + gap) };
  const dist = Math.hypot(node.x - arrive.x, node.y - arrive.y) || 1;
  // Outer siblings arrive on a flat heading, so a long pull would make them hug
  // the horizontal and run parallel to their neighbours. Tapering it turns each
  // one into its own diagonal instead.
  const taper = info && info.m > 1 ? 1 - 0.34 * (info.i / (info.m - 1)) : 1;
  // Both control points have to stay inside the band between the two rows. An
  // uncapped pull put the inner spoke's handle *above its own child*, which is
  // what threw those 600px sweeps across empty water: the edge left the canvas
  // it needed and came back. Capped, the same curve reads as a riser out of the
  // child and one bend into the parent.
  const room = Math.max(Math.abs(dy) - R * 2, R * 0.8);
  const rise = dir.y < -0.05 ? room / -dir.y : Infinity;
  return {
    dir,
    arrive,
    lead: clamp(dist * 0.32, R * 0.8, Math.max(Math.abs(dy) * 0.5, R)),
    pull: clamp(dist * 0.45 * taper, R * 1.2, Math.min(Math.abs(dx) * 0.85 + R * 2, rise)),
  };
}

// First-parent chains. Seeded in ref priority order so main keeps the straight
// spine and every other branch gets its own column.
function buildChains(commits, ids, refs, gen) {
  const owner = new Map();
  const chains = [];

  // First-parent children per commit. A commit with FAN_WIDE or more of them
  // is a fan, and no child may keep the parent's own column: the one that did
  // used to leave the parent under lane 3 of 6 - half a lane off the centre of
  // its own fan, which is what made a six-way fork read as five spokes and a
  // spine. Cutting the chain at that commit gives every child a lane of its
  // own and leaves the parent's column empty above it, so the fan straddles
  // the parent exactly and every sibling is drawn the same way.
  const kidCount = new Map();
  for (const id of ids) {
    const p = (commits[id].parents || [])[0];
    if (p && commits[p]) kidCount.set(p, (kidCount.get(p) || 0) + 1);
  }

  const start = (seedId, key, color) => {
    if (!commits[seedId] || owner.has(seedId)) return null;
    const chain = { index: chains.length, key, color, ids: [], baseId: null };
    let cur = seedId;
    let cut = null;
    while (cur && commits[cur] && !owner.has(cur)) {
      owner.set(cur, chain.index);
      chain.ids.push(cur);
      const next = (commits[cur].parents || [])[0];
      if (next && commits[next] && !owner.has(next) && (kidCount.get(next) || 0) >= FAN_WIDE) {
        cur = next;
        cut = next;
        break;
      }
      cur = next;
    }
    chain.baseId = cur && commits[cur] ? cur : null;
    chains.push(chain);
    // The continuation carries this chain's name and colour on, so the trunk
    // below a fan is still main's blue and not a leftover's hash colour.
    if (cut) start(cut, key, color);
    return chain;
  };

  for (const b of refs.branchList) start(b.target, b.id, b.color);
  for (const t of refs.tagList) start(t.target, t.id, refs.pal.of(t.id));
  if (refs.detachedAt) start(refs.detachedAt, 'HEAD', 0);

  const leftovers = ids
    .filter((id) => !owner.has(id))
    .sort((a, b) => gen.get(b) - gen.get(a) || cmpId(a, b));
  for (const id of leftovers) start(id, id, PALETTE_ALT[hash32(id) % PALETTE_ALT.length]);

  return { chains, owner };
}

// Depth-first over the chain forest. Children that fork later sit closer to
// their parent column, which is what keeps merge edges from crossing.
function orderChains(chains, owner, gen) {
  const kids = new Map(chains.map((c) => [c.index, []]));
  const roots = [];
  for (const c of chains) {
    const parent = c.baseId != null ? owner.get(c.baseId) : undefined;
    if (parent === undefined || parent === c.index) roots.push(c);
    else kids.get(parent).push(c);
  }
  const forkGen = (c) => (c.baseId != null ? gen.get(c.baseId) : gen.get(c.ids[c.ids.length - 1]) || 0);
  const byFork = (a, b) => forkGen(b) - forkGen(a) || a.index - b.index;
  for (const list of kids.values()) list.sort(byFork);
  roots.sort((a, b) => a.index - b.index);

  const order = [];
  const walk = (c) => {
    const left = [];
    const right = [];
    const groups = new Map();
    for (const k of kids.get(c.index)) {
      const key = k.baseId == null ? '' : k.baseId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(k);
    }
    // Three or more branches leaving one commit are a fan, and sending a fan
    // all one way builds a firework: every spoke crowds one quadrant of the
    // parent while the gutter on the other side stays empty. Straddling the
    // parent halves the widest span and gives the arrivals both rims. Anything
    // smaller keeps to one side so the spine still reads as a spine.
    for (const group of groups.values()) {
      if (group.length >= FAN_SIDES) group.forEach((k, i) => (i % 2 ? left : right).push(k));
      else for (const k of group) right.push(k);
    }
    for (const k of left.reverse()) walk(k);
    order.push(c);
    for (const k of right) walk(k);
  };
  for (const r of roots) walk(r);
  for (const c of chains) if (!order.includes(c)) order.push(c);
  order.forEach((c, i) => {
    c.column = i;
  });
  return order;
}

// `forceRow` pins the depth-row pitch instead of letting the region pick its
// own. A local+origin pair is read across, so both frames have to be on one set
// of rows; the ghost layer likewise has to land on the rows of the region it is
// drawn over. It is only ever raised to a pitch another region already wants, so
// the label stacks that set `baseRow` still fit.
function layoutRegion(snap, regionKey, geom, measure, forceRow) {
  const commits = snap.commits || {};
  const ids = Object.keys(commits).sort(cmpId);
  // HEAD belongs to the reader's own repository; a second pointer inside the
  // origin frame (or its ghost) is simply wrong.
  const refs = collectRefs(snap, !String(regionKey).startsWith('origin'));
  // Depth is settled first and never revisited: it is the flow axis, and every
  // commit sharing a depth shares a row. Columns and headings are then fitted
  // around it.
  const gen = generations(commits, ids);
  const { chains, owner } = buildChains(commits, ids, refs, gen);
  orderChains(chains, owner, gen);
  const forkRank = forkRanks(commits, ids, chains, owner);

  const R = geom.r;
  const LH = geom.labelH;
  const LGAP = geom.labelGap;

  // --- label rows (one stack per commit, measured before x positions) ------
  const rowsByCommit = new Map();
  const pushRow = (commitId, row) => {
    if (!commits[commitId]) return;
    if (!rowsByCommit.has(commitId)) rowsByCommit.set(commitId, []);
    rowsByCommit.get(commitId).push(row);
  };
  const pillWidth = (text, kind) =>
    measure(text, kind === 'tag' ? 'tv-t-tag' : 'tv-t-pill') + geom.pillPad * 2 + (kind === 'tag' ? LH * 0.42 : 0);

  for (const b of refs.branchList) {
    // The checked-out branch carries a filled caret inside its pill: a shape
    // signal, so "where am I" never rides on colour or stroke weight alone.
    const w = pillWidth(b.id, 'branch') + (b.active ? LH * 0.44 : 0);
    const headW = b.active ? measure('HEAD', 'tv-t-head') + geom.pillPad * 1.6 : 0;
    pushRow(b.target, {
      key: `branch:${b.id}`,
      kind: 'branch',
      text: b.id,
      color: b.color,
      remote: b.remote,
      active: b.active,
      w,
      headW,
      total: w + (b.active ? headW + LH * 0.55 : 0),
    });
  }
  for (const t of refs.tagList) {
    const w = pillWidth(t.id, 'tag');
    pushRow(t.target, { key: `tag:${t.id}`, kind: 'tag', text: t.id, color: 0, w, headW: 0, total: w });
  }
  if (refs.detachedAt) {
    const text = 'HEAD detached';
    const w = measure(text, 'tv-t-head') + geom.pillPad * 2;
    pushRow(refs.detachedAt, {
      key: 'head:HEAD',
      kind: 'head',
      text,
      color: 0,
      detached: true,
      w,
      headW: 0,
      total: w,
    });
  }

  // --- geometry -----------------------------------------------------------
  const stackH = (rows) => rows.length * LH + (rows.length - 1) * LGAP;
  let maxStack = 0;
  let maxPill = 0;
  for (const rows of rowsByCommit.values()) {
    maxStack = Math.max(maxStack, stackH(rows));
    for (const row of rows) maxPill = Math.max(maxPill, row.total);
  }
  const baseRow = Math.max(geom.row, (maxStack + 20) / 0.85);

  const colInfo = new Map();
  for (const id of ids) {
    const col = chains[owner.get(id)].column;
    let info = colInfo.get(col);
    if (!info) colInfo.set(col, (info = { beads: [], labels: [], min: Infinity, max: -Infinity }));
    const g = gen.get(id);
    info.beads.push(g);
    info.min = Math.min(info.min, g);
    info.max = Math.max(info.max, g);
    const rows = rowsByCommit.get(id);
    if (rows) info.labels.push({ g, h: stackH(rows) });
  }

  // A ref label only has to push its column apart when something in the next
  // column is actually at that height. Everywhere else it may overhang the
  // empty lane, which keeps lanes tight and merge edges short. The test is
  // geometric, not "within one generation" - a 24px pill and a bead one row
  // apart are 70px from touching.
  const overhangBlocked = (col, g, h, rowH) => {
    const info = colInfo.get(col);
    if (!info) return false;
    const top = -g * rowH - h / 2 - 6;
    const bot = -g * rowH + h / 2 + 6;
    for (const bg of info.beads) {
      if (-bg * rowH - R < bot && top < -bg * rowH + R) return true;
    }
    for (const l of info.labels) {
      if (-l.g * rowH - l.h / 2 < bot && top < -l.g * rowH + l.h / 2) return true;
    }
    // a parent edge running the length of that column would pass behind it
    return info.beads.length > 1 && -info.max * rowH < bot && top < -info.min * rowH;
  };

  const colCount = chains.length;

  // Columns of a commit whose children straddle it. A label stack only ever
  // widens the lane to its right, so a fan with a HEAD pill on one flank came
  // out lopsided - 96/196/296 to the right of the trunk against 96/196/370 to
  // the left, the outermost lane pushed an extra 74px to clear the pill. The
  // fan is read as one shape, so the clearance is mirrored: lane d gets the
  // same offset on both sides, and the fan is only ever widened, never
  // squeezed.
  const fanTrunks = new Set();
  {
    const sides = new Map();
    for (const [key, r] of forkRank) {
      const p = key.slice(0, key.indexOf(' '));
      if (!sides.has(p)) sides.set(p, { l: false, r: false });
      if (r.side < 0) sides.get(p).l = true;
      else sides.get(p).r = true;
    }
    for (const [p, s] of sides) {
      if (s.l && s.r && owner.has(p)) fanTrunks.add(chains[owner.get(p)].column);
    }
  }
  const mirrorFans = (gaps) => {
    if (!fanTrunks.size) return;
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (const t of fanTrunks) {
        for (let d = 1; d <= colCount; d++) {
          const a = t - d; // the gap that carries lane d on the left
          const b = t + d - 1; // and its mirror on the right
          if (a < 0 || b >= gaps.length) break;
          const m = Math.max(gaps[a], gaps[b]);
          if (m > gaps[a] + 0.01 || m > gaps[b] + 0.01) {
            gaps[a] = m;
            gaps[b] = m;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
  };

  const placeColumns = (rowH) => {
    const colExtent = [];
    for (const [id, rows] of rowsByCommit) {
      const col = chains[owner.get(id)].column;
      const widest = rows.reduce((m, r) => Math.max(m, r.total), 0);
      if (overhangBlocked(col + 1, gen.get(id), stackH(rows), rowH)) {
        colExtent[col] = Math.max(colExtent[col] || 0, widest);
      }
    }
    const gaps = [];
    for (let c = 0; c + 1 < colCount; c++) {
      gaps[c] = Math.max(geom.col, R + geom.labelOff + (colExtent[c] || 0) + geom.labelH * 0.75 + R);
    }
    mirrorFans(gaps);
    const xs = [0];
    for (let c = 1; c < colCount; c++) xs[c] = xs[c - 1] + gaps[c - 1];
    return xs;
  };

  // Rows are uniform - that is what a depth row is - so a fork that lands lanes
  // away from its parent can only be lifted off the horizontal by making EVERY
  // row taller. That is affordable exactly when the region is wide and shallow,
  // which is what a fan is; a long history, where the extra height would only
  // shrink the fit, is capped back to the base row and keeps its lanes instead.
  let ROW = baseRow;
  if (Number.isFinite(forceRow) && forceRow > 0) {
    ROW = Math.max(forceRow, baseRow);
  } else {
    const probe = placeColumns(baseRow);
    let depth = 1;
    for (const g of gen.values()) depth = Math.max(depth, g);
    const width = probe[colCount - 1] - probe[0] + R * 2 + geom.labelOff + maxPill;
    const cap = Math.max(baseRow, (width * FORK_ASPECT) / depth);
    let want = baseRow;
    for (const id of ids) {
      const p = (commits[id].parents || [])[0];
      if (!p || !commits[p]) continue;
      const dx = Math.abs(probe[chains[owner.get(id)].column] - probe[chains[owner.get(p)].column]);
      const rows = Math.max(gen.get(id) - gen.get(p), 1);
      want = Math.max(want, (dx * (geom.forkSlope || FORK_SLOPE)) / rows + R * 2);
    }
    ROW = clamp(want, baseRow, cap);
  }
  const colX = placeColumns(ROW);
  const rowY = (g) => -g * ROW;

  const nodes = [];
  const nodeByIdKey = new Map();
  for (const id of ids) {
    const chain = chains[owner.get(id)];
    const c = commits[id];
    const parents = (c.parents || []).filter((p) => commits[p]);
    const node = {
      key: `${regionKey}:${id}`,
      id,
      region: regionKey,
      x: colX[chain.column],
      y: rowY(gen.get(id)),
      gen: gen.get(id),
      col: chain.column,
      color: chain.color,
      merge: parents.length > 1,
      root: parents.length === 0,
      parents: c.parents || [],
      refs: (rowsByCommit.get(id) || []).map((r) => r.text),
    };
    nodes.push(node);
    nodeByIdKey.set(id, node);
  }

  const labels = [];
  for (const [id, rows] of rowsByCommit) {
    const node = nodeByIdKey.get(id);
    const total = rows.length * LH + (rows.length - 1) * LGAP;
    let ly = node.y - total / 2;
    for (const row of rows) {
      labels.push({
        ...row,
        key: `${regionKey}:${row.key}`,
        region: regionKey,
        commitKey: node.key,
        commitId: id,
        x: node.x + R + geom.labelOff,
        y: ly,
        h: LH,
        // Leader back to the bead, in the pill's own coordinates. Without it a
        // pill sitting in the lane between two columns reads as belonging to
        // neither commit.
        leadX: -(geom.labelOff + 1),
        leadY: node.y - ly,
        delay: node.gen,
      });
      ly += LH + LGAP;
    }
  }

  // Obstacles: beads plus label boxes. Used only to decide whether an edge can
  // take the pretty curve or must fall back to the guaranteed-clear route.
  const beadObstacles = nodes.map((n) => ({ x: n.x, y: n.y, r: R + 5, key: n.key }));
  const rectObstacles = labels.map((l) => ({ x: l.x, y: l.y, w: l.total, h: l.h }));

  // Widest label-free lane between two columns over the vertical span the edge
  // travels. Beads can never be in it; labels are carved out explicitly.
  const gutterX = (colIndex, yLo, yHi) => {
    const lo = colX[colIndex] + R + 8;
    const hi = (colIndex + 1 < colCount ? colX[colIndex + 1] : colX[colIndex] + geom.col) - R - 8;
    if (hi - lo < 6) return (lo + hi) / 2;
    const blocked = labels
      .filter((l) => l.y < yHi && l.y + l.h > yLo)
      .map((l) => [l.x - 6, l.x + l.total + 6])
      .filter(([a, b]) => b > lo && a < hi)
      .sort((a, b) => a[0] - b[0]);
    let best = null;
    let cur = lo;
    for (const [a, b] of blocked) {
      if (a - cur > (best ? best[1] - best[0] : 0)) best = [cur, a];
      cur = Math.max(cur, b);
    }
    if (hi - cur > (best ? best[1] - best[0] : 0)) best = [cur, hi];
    return best && best[1] - best[0] >= 8 ? (best[0] + best[1]) / 2 : (lo + hi) / 2;
  };

  const edges = [];
  const pending = [];
  for (const node of nodes) {
    node.parents.forEach((pid, index) => {
      const parent = nodeByIdKey.get(pid);
      if (!parent) return;
      const merge = index > 0;
      const rank = merge ? null : forkRank.get(`${pid} ${node.id}`);
      // Siblings that have to fall back to a routed edge get one band each,
      // ordered by their fan rank, so the horizontal runs never stack up into
      // the ribbon this layout is here to avoid.
      const spread = rank && rank.m > 1 ? rank.i / (rank.m - 1) - 0.5 : 0;
      const jitter = merge
        ? ((hash32(node.key + pid) % 11) - 5) * (ROW * 0.012)
        : spread * ROW * 0.26;
      const p0 = { x: node.x, y: node.y + R + EDGE_GAP };
      const p1 = { x: parent.x, y: parent.y - R - EDGE_GAP };
      const edge = {
        key: `${regionKey}:e:${node.id}->${pid}:${index}`,
        region: regionKey,
        fromKey: node.key,
        toKey: parent.key,
        merge,
        color: merge ? parent.color : node.color,
        toColor: parent.color,
        r: R,
        gap: EDGE_GAP,
        dirIn: { x: 0, y: -1 },
      };

      // An edge that crosses lanes at a shallow angle has no business drawing a
      // long diagonal across open water: at this angle the eye cannot tell
      // which bead it came from. It gets the railroad instead - a vertical run
      // out of the child, one traverse along an empty band, a vertical run into
      // the parent - which is also the only shape that keeps a clear vertical
      // run when a depth row leaves just one row of height to work with.
      const flat =
        Math.abs(p1.y - p0.y) < Math.abs(p1.x - p0.x) * 0.4 && Math.abs(p1.x - p0.x) > geom.col * 1.6;

      if (Math.abs(p0.x - p1.x) < 0.5) {
        edge.kind = 'line';
      } else if (flat) {
        edge.kind = 'route';
      } else {
        // Beads are hard obstacles - an edge running under one reads as a
        // mistake. Labels are soft: they paint above the edges, so a small
        // amount of overlap is fine and keeps the short curve.
        let probe;
        if (merge) {
          edge.swing = 0.36 + ((hash32(node.key + pid) % 7) / 7) * 0.3;
          const [c0, c1] = curveControl(p0, p1, edge.swing);
          edge.kind = 'curve';
          probe = [p0, c0, c1, p1];
        } else {
          const fan = fanFor(node, parent, rank, R, EDGE_GAP);
          edge.kind = 'fan';
          edge.dirIn = fan.dir;
          edge.lead = fan.lead;
          edge.pull = fan.pull;
          probe = [
            p0,
            { x: p0.x, y: p0.y + fan.lead },
            { x: fan.arrive.x + fan.dir.x * fan.pull, y: fan.arrive.y + fan.dir.y * fan.pull },
            fan.arrive,
          ];
        }
        let hitsBead = false;
        let hitsLabel = 0;
        for (let i = 1; i < 24 && !hitsBead; i++) {
          const p = cubicAt(probe[0], probe[1], probe[2], probe[3], i / 24);
          for (const o of beadObstacles) {
            if (o.key === node.key || o.key === parent.key) continue;
            if (Math.hypot(p.x - o.x, p.y - o.y) < o.r) {
              hitsBead = true;
              break;
            }
          }
          for (const o of rectObstacles) {
            if (pointInRect(p, o, 2)) {
              hitsLabel++;
              break;
            }
          }
        }
        if (hitsBead || hitsLabel > 7) {
          edge.kind = 'route';
          edge.dirIn = { x: 0, y: -1 };
        }
      }

      pending.push({ edge, node, parent, rank, jitter, p0, p1 });
      edges.push(edge);
    });
  }

  // ONE IDIOM PER FAN. The railroad and the curve are two different ways of
  // saying "hangs from", and the choice used to be made per edge on a distance
  // threshold - which falls in the middle of a wide fan, so the outer lanes
  // arrived through square corners while the inner ones arrived on a curve,
  // side by side in one picture of one relationship. The threshold still
  // decides, but it now decides for the whole fan: if any sibling has to take
  // the railroad, they all do. (A sibling in the parent's own column keeps its
  // straight line, which is the same railroad with no traverse.)
  {
    const routed = new Set();
    for (const it of pending) {
      if (!it.edge.merge && it.edge.kind === 'route') routed.add(it.edge.toKey);
    }
    for (const it of pending) {
      if (it.edge.merge || !routed.has(it.edge.toKey)) continue;
      if (it.edge.kind !== 'fan') continue;
      it.edge.kind = 'route';
      it.edge.dirIn = { x: 0, y: -1 };
      delete it.edge.lead;
      delete it.edge.pull;
    }
  }

  for (const { edge, node, parent, jitter, p0, p1 } of pending) {
    if (edge.kind === 'route') {
      // The traverse runs along a band - the empty strip between two rows,
      // where no bead and no pill can ever be - biased towards the parent so
      // that the run *out of the child*, which is the "this hangs from that"
      // cue, is the long one.
      const bandA = node.y + ROW * 0.62 + jitter;
      const bandB = parent.y - ROW * 0.38 + jitter;
      const gx = gutterX(
        parent.col < node.col ? parent.col : parent.col - 1,
        Math.min(bandA, bandB) - 2,
        Math.max(bandA, bandB) + 2
      );
      edge.mid = [
        { x: p0.x, y: bandA },
        { x: gx, y: bandA },
        { x: gx, y: bandB },
        { x: p1.x, y: bandB },
      ];
    }
    {
      // Signed arrival heading, 0 = straight up the parent's column, positive
      // towards its right. Recorded now so every edge landing on one bead can
      // be given its own slice of the rim below.
      edge.want =
        edge.kind === 'line'
          ? 0
          : Math.sign(p0.x - p1.x) *
            clamp(Math.atan2(Math.abs(p0.x - p1.x), Math.abs(p0.y - p1.y) || 1), FAN_MIN, FAN_MAX);
      if (edge.kind === 'fan') edge.want = Math.sign(edge.dirIn.x || 1) * Math.abs(Math.atan2(edge.dirIn.x, -edge.dirIn.y));
    }
  }

  // Arrowheads must not stack. Two edges arriving at one commit from the same
  // heading put their heads at exactly the same point - measured at 0.00px
  // apart - and a four-way fork turned the top of its parent into one dark
  // clot. Every arrival gets its own angle on the circumference; the spine, the
  // straight in-column edge, keeps the north pole.
  const byParent = new Map();
  for (const e of edges) {
    if (!byParent.has(e.toKey)) byParent.set(e.toKey, []);
    byParent.get(e.toKey).push(e);
  }
  for (const list of byParent.values()) {
    for (const e of list) e.crowd = list.length;
    if (list.length < 2) continue;
    const taken = [];
    for (const e of list) if (e.kind === 'line') taken.push(0);
    for (const e of list.slice().sort((a, b) => Math.abs(a.want) - Math.abs(b.want))) {
      if (e.kind === 'line') continue;
      const side = e.want < 0 ? -1 : 1;
      let a = e.want;
      for (let guard = 0; guard < 16; guard++) {
        let clash = null;
        for (const t of taken) if (Math.abs(t - a) < ARRIVE_SEP) clash = t;
        if (clash === null) break;
        a = clash + side * ARRIVE_SEP;
        if (Math.abs(a) > FAN_MAX) {
          a = side * FAN_MAX;
          break;
        }
      }
      taken.push(a);
      e.dirIn = { x: Math.sin(a), y: -Math.cos(a) };
    }
  }

  // --- bounding box -------------------------------------------------------
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  const grow = (x0, y0, x1, y1) => {
    bx0 = Math.min(bx0, x0);
    by0 = Math.min(by0, y0);
    bx1 = Math.max(bx1, x1);
    by1 = Math.max(by1, y1);
  };
  for (const n of nodes) grow(n.x - R, n.y - R, n.x + R, n.y + R * 1.2);
  for (const l of labels) grow(l.x, l.y, l.x + l.total, l.y + l.h);
  if (!nodes.length) grow(0, 0, geom.col, geom.row);

  return {
    key: regionKey,
    nodes,
    edges,
    labels,
    chains,
    rowHeight: ROW,
    head: refs.head,
    attached: refs.attached,
    ids: new Set(ids),
    // name -> commit it points at, used by the ghost layer to spot what moved.
    refTargets: new Map([
      ...refs.branchList.map((b) => [b.id, b.target]),
      ...refs.tagList.map((t) => [t.id, t.target]),
    ]),
    bbox: { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 },
  };
}

// --- ghost layer ----------------------------------------------------------

// Everything the learner has that the target does not: commits the target never
// contains, and refs pointing somewhere else. Laid out with the same engine,
// then slid so the history the two share lines up.
function buildGhost(target, ghostSnap, regionKey, geom, measure) {
  const gr = layoutRegion(ghostSnap, `${regionKey}~g`, geom, measure, target.rowHeight);
  const byId = new Map(target.nodes.map((n) => [n.id, n]));

  const deltas = [];
  for (const n of gr.nodes) {
    const t = byId.get(n.id);
    if (t) deltas.push({ x: t.x - n.x, y: t.y - n.y });
  }
  let dx = 0;
  let dy = 0;
  if (deltas.length) {
    const mid = (key) => {
      const v = deltas.map((d) => d[key]).sort((a, b) => a - b);
      return v[(v.length - 1) >> 1];
    };
    dx = mid('x');
    dy = mid('y');
  } else if (gr.nodes.length && target.nodes.length) {
    dx = target.bbox.x + target.bbox.w / 2 - (gr.bbox.x + gr.bbox.w / 2);
    dy = target.bbox.y + target.bbox.h / 2 - (gr.bbox.y + gr.bbox.h / 2);
  }

  const R = geom.r;
  const keepNode = (n) => !target.ids.has(n.id);
  const nodes = gr.nodes.filter(keepNode).map((n) => ({ ...n, x: n.x + dx, y: n.y + dy }));
  const ghostIds = new Set(nodes.map((n) => n.id));

  // A ghost bead landing exactly behind a target bead means "nothing changed
  // here", so only nudge the ones that half-cover a target bead.
  for (const n of nodes) {
    let clash = null;
    for (const t of target.nodes) {
      const d = Math.hypot(t.x - n.x, t.y - n.y);
      if (d > 0.5 && d < R * 1.7 && (!clash || d < clash.d)) clash = { d, t };
    }
    if (!clash) continue;
    const away = unitTo(clash.t, n);
    n.x += away.x * (R * 1.7 - clash.d);
    n.y += away.y * (R * 1.7 - clash.d);
  }

  const labels = gr.labels
    .filter((l) => {
      if (l.kind === 'head') return target.head ? target.head.target !== l.commitId : true;
      const at = target.refTargets.get(l.text);
      if (at === undefined || at !== l.commitId) return true;
      // Same commit, but HEAD sits on it here and not there: still news.
      return Boolean(l.active) && gr.attached !== target.attached;
    })
    .map((l) => ({ ...l, x: l.x + dx, y: l.y + dy }));

  // Push a ghost pill down until it is clear of the target's own label stack.
  const boxes = target.labels.map((l) => ({ x: l.x, y: l.y, w: l.total, h: l.h }));
  for (const l of labels) {
    for (let tries = 0; tries < 4; tries++) {
      const hit = boxes.some(
        (b) => l.x < b.x + b.w + 4 && b.x < l.x + l.total + 4 && l.y < b.y + b.h + 2 && b.y < l.y + l.h + 2
      );
      if (!hit) break;
      l.y += l.h + geom.labelGap;
      l.leadY -= l.h + geom.labelGap;
    }
    boxes.push({ x: l.x, y: l.y, w: l.total, h: l.h });
  }

  const pos = new Map(nodes.map((n) => [n.key, n]));
  for (const n of gr.nodes) if (!pos.has(n.key)) pos.set(n.key, { ...n, x: n.x + dx, y: n.y + dy });
  const edges = gr.edges
    .filter((e) => ghostIds.has(e.fromKey.split(':').slice(1).join(':')) || ghostIds.has(e.toKey.split(':').slice(1).join(':')))
    .map((e) => ({ ...e, from: pos.get(e.fromKey), to: pos.get(e.toKey) }))
    .filter((e) => e.from && e.to);

  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (const n of nodes) {
    bx0 = Math.min(bx0, n.x - R);
    by0 = Math.min(by0, n.y - R);
    bx1 = Math.max(bx1, n.x + R);
    by1 = Math.max(by1, n.y + R);
  }
  for (const l of labels) {
    bx0 = Math.min(bx0, l.x + l.leadX);
    by0 = Math.min(by0, l.y);
    bx1 = Math.max(bx1, l.x + l.total);
    by1 = Math.max(by1, l.y + l.h);
  }
  const any = nodes.length || labels.length;
  return {
    nodes,
    labels,
    edges,
    count: nodes.length,
    moved: labels.length,
    sig: `${nodes.map((n) => `${n.id}@${f2(n.x)},${f2(n.y)}`).join('|')}#${labels
      .map((l) => `${l.text}@${f2(l.x)},${f2(l.y)}`)
      .join('|')}`,
    bbox: any ? { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 } : null,
  };
}

// --- the view -------------------------------------------------------------

export class TreeView {
  constructor(hostElement, options = {}) {
    this.host = hostElement || document.createElement('div');
    this.compact = Boolean(options.compact);
    this.readOnly = Boolean(options.readOnly);
    this.idPrefix = options.idPrefix || uid('tv');

    this.snapshot = EMPTY_SNAPSHOT;
    this.ghostSnapshot = null;
    this.scene = null;
    this._ghostSig = null;
    this.live = new Map();
    this.textCache = new Map();
    this.size = { w: 640, h: 420 };
    this.view = { x: 0, y: 0, k: 1 };
    this.fitK = 1;
    this.userAdjusted = false;
    this.focusId = null;
    this.selectedId = null;
    this.highlighted = new Set();
    this.onCommitClick = null;

    this._raf = 0;
    this._settle = null;
    this._plan = null;
    this._playToken = 0;
    this._destroyed = false;

    this._buildDom();
    this._bindEvents();
    this.geom = null;
    this._readGeomIfChanged();
    this.resize();
  }

  // --- dom ----------------------------------------------------------------

  _buildDom() {
    this.root = el('div', { class: `tv${this.compact ? ' tv--compact' : ''}${this.readOnly ? ' tv--readonly' : ''}` });

    // Not role="img": that prunes every descendant, and it told screen readers
    // the graph was one opaque picture. The drawing is hidden instead and the
    // real content is mirrored into the list below, which does announce.
    //
    // A read-only view - the goal panel, the four legends in the help dialog -
    // is a picture with that text mirror underneath it and nothing to operate,
    // so its drawing is not focusable. Leaving it focusable put four tab stops
    // in the help dialog that announced nothing at all: focusable, labelled,
    // and inside an aria-hidden subtree, which is exactly WCAG 4.1.2.
    this.svg = svgEl('svg', {
      class: 'tv-svg',
      ...(this.readOnly
        ? { 'aria-hidden': 'true', tabindex: '-1', focusable: 'false' }
        : {
            role: 'group',
            'aria-label': 'Commit graph',
            'aria-describedby': `${this.idPrefix}-desc`,
            tabindex: '0',
          }),
      preserveAspectRatio: 'xMidYMid meet',
      viewBox: '0 0 640 420',
    });
    this.defs = svgEl('defs');
    this.svg.appendChild(this.defs);
    this._buildDefs();

    this.camera = svgEl('g', { class: 'tv-camera', 'aria-hidden': 'true' });
    this.panelLayer = svgEl('g', { class: 'tv-panels' });
    this.ghostLayer = svgEl('g', { class: 'tv-ghosts' });
    this.camera.append(this.panelLayer, this.ghostLayer);
    this.svg.appendChild(this.camera);

    this.regionLayers = new Map();
    this.measureLayer = svgEl('g', { class: 'tv-measure', visibility: 'hidden', 'aria-hidden': 'true' });
    this.svg.appendChild(this.measureLayer);

    this.a11y = el('div', { class: 'tv-a11y', id: `${this.idPrefix}-desc` });

    this.controls = this.readOnly
      ? null
      : el(
          'div',
          { class: 'tv-controls' },
          this._button('zoom-out', 'Zoom out', 'M4 8h8'),
          this._button('zoom-in', 'Zoom in', 'M8 4v8M4 8h8'),
          this._button('fit', 'Fit graph to view', 'M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3')
        );
    this.resetBtn = el(
      'button',
      { class: 'tv-reset', type: 'button', title: 'Return to the fitted view' },
      'Reset view'
    );

    this.tip = el('div', { class: 'tv-tip', hidden: true, role: 'presentation' });
    this.empty = el(
      'div',
      { class: 'tv-empty', hidden: true },
      el('div', { class: 'tv-empty-card' },
        el('div', { class: 'tv-empty-title' }, 'No commits yet'),
        el('div', { class: 'tv-empty-body' }, 'Run git commit to start the history.'))
    );
    this.sr = el('div', { class: 'tv-sr', 'aria-live': 'polite' });

    this.root.append(this.svg, this.a11y);
    if (this.controls) this.root.appendChild(this.controls);
    this.root.append(this.resetBtn, this.tip, this.empty, this.sr);
    this.host.appendChild(this.root);
  }

  _button(action, label, path) {
    const icon = svgEl(
      'svg',
      { class: 'tv-ico', viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
      svgEl('path', { d: path })
    );
    return el('button', { class: 'tv-btn', type: 'button', 'aria-label': label, title: label, dataset: { action } }, icon);
  }

  _buildDefs() {
    const p = this.idPrefix;
    const stop = (offset, color, opacity) =>
      svgEl('stop', { offset, style: `stop-color:${color};stop-opacity:${opacity}` });

    // The bead is glass: a pale core, a coloured body, and the rim carrying the
    // silhouette. The core and the soft inner transition stay on the raw token
    // - that is the glass - but the two OUTER stops, which are what the eye
    // reads as the edge of the bead against the water, go through the same
    // lightness cap as the line work. Without that the cap only ever reached
    // the rim, and the body of a bead measured 1.07-1.44:1 in day.
    for (let i = 0; i <= 8; i++) {
      const raw = i === 0 ? 'var(--commit-fill-2)' : colorVar(i);
      const ink = i === 0 ? capped('var(--commit-fill-2)') : inkVar(i);
      this.defs.appendChild(
        svgEl(
          'radialGradient',
          { id: `${p}-bead-${i}`, cx: '32%', cy: '24%', r: '78%' },
          stop('0', 'var(--commit-fill)', 1),
          stop('0.42', raw, 0.22),
          stop('0.82', ink, 0.72),
          stop('1', ink, 0.97)
        )
      );
    }
    // Radial, not linear: a linear ramp leaves a hard terminator down the sides
    // of the ellipse, which reads as a pasted-on shape rather than a highlight.
    this.defs.appendChild(
      svgEl(
        'radialGradient',
        { id: `${p}-spec`, cx: '50%', cy: '38%', r: '62%' },
        stop('0', 'var(--glass-highlight)', 0.95),
        stop('0.45', 'var(--glass-highlight)', 0.6),
        stop('0.78', 'var(--glass-highlight)', 0.18),
        stop('1', 'var(--glass-highlight)', 0)
      )
    );
    this.defs.appendChild(
      svgEl(
        'linearGradient',
        { id: `${p}-shade`, x1: '0', y1: '0', x2: '0', y2: '1' },
        stop('0', 'var(--glass-shadow)', 0),
        stop('0.55', 'var(--glass-shadow)', 0),
        stop('1', 'var(--glass-shadow)', 0.55)
      )
    );
    this.defs.appendChild(
      svgEl(
        'radialGradient',
        { id: `${p}-drop`, cx: '50%', cy: '50%', r: '50%' },
        stop('0', 'var(--glass-shadow)', 0.55),
        stop('0.6', 'var(--glass-shadow)', 0.22),
        stop('1', 'var(--glass-shadow)', 0)
      )
    );
    this.defs.appendChild(
      svgEl(
        'linearGradient',
        { id: `${p}-pill`, x1: '0', y1: '0', x2: '0', y2: '1' },
        stop('0', 'var(--glass-highlight)', 0.85),
        stop('0.5', 'var(--glass-highlight)', 0.12),
        stop('1', 'var(--glass-highlight)', 0.3)
      )
    );
    this.defs.appendChild(
      svgEl(
        'linearGradient',
        { id: `${p}-panel`, x1: '0', y1: '0', x2: '0', y2: '1' },
        stop('0', 'var(--origin-bg)', 1),
        stop('1', 'var(--origin-bg)', 0.25)
      )
    );
    const glow = svgEl('filter', { id: `${p}-glow`, x: '-40%', y: '-60%', width: '180%', height: '220%' });
    glow.appendChild(svgEl('feGaussianBlur', { stdDeviation: '3', result: 'b' }));
    glow.appendChild(
      svgEl('feComponentTransfer', {}, svgEl('feFuncA', { type: 'linear', slope: '0.9' }))
    );
    this.defs.appendChild(glow);
  }

  _readGeom() {
    const cs = getComputedStyle(this.root);
    const out = {};
    for (const [key, name] of Object.entries(GEOM_VARS)) {
      const raw = parseFloat(cs.getPropertyValue(name));
      out[key] = Number.isFinite(raw) && raw > 0 ? raw : GEOM_DEFAULT[key];
    }
    return out;
  }

  // Reads the metrics again and reports whether they actually moved. The first
  // call inside a document is the one that matters: a view constructed
  // detached has been running on GEOM_DEFAULT until then.
  _readGeomIfChanged() {
    const next = this._readGeom();
    next.forkSlope = this.compact ? FORK_SLOPE_MINI : FORK_SLOPE;
    const sig = (g) => Object.keys(GEOM_VARS).map((k) => g[k]).join('|');
    if (this.geom && sig(next) === sig(this.geom)) return false;
    this.geom = next;
    this.textCache.clear();
    return true;
  }

  // Drops every drawn element so the next render rebuilds them at the current
  // metrics. Only the reusable shells - defs, camera, the a11y mirror - stay.
  _resetLayers() {
    this._cancelAnim();
    for (const layer of this.regionLayers.values()) layer.g.remove();
    this.regionLayers.clear();
    this.live.clear();
    this.panelLayer.textContent = '';
    this.ghostLayer.textContent = '';
    this._ghostSig = null;
  }

  _measure(text, cls) {
    const key = `${cls}|${text}`;
    const cached = this.textCache.get(key);
    if (cached != null) return cached;
    const node = svgEl('text', { class: cls, x: '0', y: '0' });
    node.textContent = text;
    this.measureLayer.appendChild(node);
    let w = 0;
    try {
      w = node.getComputedTextLength();
    } catch {
      w = 0;
    }
    node.remove();
    if (!w || !Number.isFinite(w)) {
      const fs = cls === 'tv-t-head' ? this.geom.labelFs * 0.92 : this.geom.labelFs;
      return String(text).length * fs * 0.62;
    }
    this.textCache.set(key, w);
    return w;
  }

  // --- scene --------------------------------------------------------------

  _buildScene(snapshot, ghostSnap) {
    const geom = this.geom;
    const measure = (t, c) => this._measure(t, c);
    const localSnap = snapshot || EMPTY_SNAPSHOT;
    const regions = [layoutRegion(localSnap, 'local', geom, measure)];
    const originSnap = snapshot && snapshot.origin ? snapshot.origin : null;
    if (originSnap) {
      regions.push(layoutRegion(originSnap, 'origin', geom, measure));
      // Two frames of one history, read across: a commit at a given depth has to
      // sit at the same height in BOTH, or the comparison the view exists for
      // has to be done by eye against two different rulers. Each region still
      // asks for the pitch it wants on its own; the pair then settles on the
      // larger. Raising is the only safe direction - it is a pitch one of them
      // already asked for, so no label stack and no fork angle gets squeezed.
      // Side by side both frames sit at offset.y = 0, so one shared pitch is
      // enough to put depth d on one line across the whole scene.
      const snaps = [localSnap, originSnap];
      const pitch = Math.max(regions[0].rowHeight, regions[1].rowHeight);
      for (let i = 0; i < regions.length; i++) {
        if (pitch > regions[i].rowHeight + 0.01) {
          regions[i] = layoutRegion(snaps[i], regions[i].key, geom, measure, pitch);
        }
      }
    }

    // The ghost is laid out against the target it is compared with, so both
    // regions keep the coordinates they would have had on their own.
    const ghosts = [];
    if (ghostSnap) {
      const sources = [[regions[0], ghostSnap]];
      if (regions[1] && ghostSnap.origin) sources.push([regions[1], ghostSnap.origin]);
      for (const [region, snap] of sources) {
        const g = buildGhost(region, snap, region.key, geom, measure);
        if (g.bbox) ghosts.push({ region: region.key, ...g });
      }
    }

    const pad = geom.pad;
    const stacked = stackedFor(this.size.w, this.size.h, this.compact);
    regions[0].offset = { x: 0, y: 0 };
    if (regions[1]) {
      const a = regions[0].bbox;
      const b = regions[1].bbox;
      if (stacked) {
        // Local first, origin after it - down the page when the pair is
        // stacked, exactly as they read left to right when it is not. The
        // lessons say "push it up to origin", and origin drawn above the
        // learner's own repo told the opposite story.
        regions[1].offset = {
          x: a.x - b.x,
          y: a.y + a.h + pad * 2 + geom.regionGap - b.y,
        };
      } else {
        regions[1].offset = { x: a.x + a.w + pad * 2 + geom.regionGap - b.x, y: 0 };
      }
    }

    const panels = [];
    if (regions.length > 1) {
      for (const r of regions) {
        panels.push({
          key: `panel:${r.key}`,
          title: r.key === 'origin' ? 'origin' : 'local',
          remote: r.key === 'origin',
          x: r.bbox.x + r.offset.x - pad,
          y: r.bbox.y + r.offset.y - pad - geom.labelH,
          w: r.bbox.w + pad * 2,
          h: r.bbox.h + pad * 2 + geom.labelH,
        });
      }
      // Each box hugs its own content. Stretching both to one extent was meant
      // to make them read as a matched pair, but what it actually produced was
      // a frame with 500px of empty water above the first bead in it whenever
      // one repo was shorter than the other - a panel that says "there is
      // something up here" when there is not. The pairing is carried by the
      // shared depth rows, which put a commit at depth d on one line across
      // both frames; the boxes only have to say where each repo ends.
    }

    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    const grow = (x0, y0, x1, y1) => {
      bx0 = Math.min(bx0, x0);
      by0 = Math.min(by0, y0);
      bx1 = Math.max(bx1, x1);
      by1 = Math.max(by1, y1);
    };
    for (const r of regions) {
      grow(r.bbox.x + r.offset.x, r.bbox.y + r.offset.y, r.bbox.x + r.offset.x + r.bbox.w, r.bbox.y + r.offset.y + r.bbox.h);
    }
    for (const p of panels) grow(p.x, p.y, p.x + p.w, p.y + p.h);
    for (const g of ghosts) {
      const off = regions.find((r) => r.key === g.region).offset;
      g.offset = off;
      grow(g.bbox.x + off.x, g.bbox.y + off.y, g.bbox.x + off.x + g.bbox.w, g.bbox.y + off.y + g.bbox.h);
    }

    const divider =
      panels.length > 1
        ? stacked
          ? (() => {
              // Halfway between the bottom of the local box and the top of the
              // origin box below it.
              const y = (panels[0].y + panels[0].h + panels[1].y) / 2;
              return { x1: bx0, y1: y, x2: bx1, y2: y };
            })()
          : {
              x1: (panels[0].x + panels[0].w + panels[1].x) / 2,
              y1: by0,
              x2: (panels[0].x + panels[0].w + panels[1].x) / 2,
              y2: by1,
            }
        : null;

    const total = regions.reduce((n, r) => n + r.nodes.length, 0);
    return {
      regions,
      panels,
      divider,
      ghosts,
      empty: total === 0,
      bbox: { x: bx0 - 8, y: by0 - 8, w: bx1 - bx0 + 16, h: by1 - by0 + 16 },
      summary: this._summarise(snapshot, regions, ghosts),
    };
  }

  _summarise(snapshot, regions, ghosts = []) {
    const local = regions[0];
    const branches = Object.keys((snapshot && snapshot.branches) || {});
    const tags = Object.values((snapshot && snapshot.tags) || {});
    const head = snapshot && snapshot.HEAD;
    const roots = local.nodes.filter((n) => n.root).length;
    const merges = local.nodes.filter((n) => n.merge);
    const tips = local.nodes.filter((n) => !local.nodes.some((o) => o.parents.includes(n.id)));
    // A view carrying a ghost is showing a target, not the learner's tree. That
    // has to be said in words: the difference used to be visual only, so the
    // summary read identically before and after "show goal".
    const bits = [];
    if (this.ghostSnapshot) bits.push('Goal: the target state, with your own tree behind it');
    bits.push(`Commit graph with ${local.nodes.length} commit${local.nodes.length === 1 ? '' : 's'}`);
    if (local.nodes.length) {
      bits.push(
        `${roots || 'no'} root${roots === 1 ? '' : 's'} and ${tips.length} tip${
          tips.length === 1 ? '' : 's'
        }${tips.length ? ` (${tips.map((t) => t.id).join(', ')})` : ''}`
      );
    }
    if (merges.length) {
      bits.push(
        `${merges.length} merge commit${merges.length === 1 ? '' : 's'}: ${merges
          .map((m) => `${m.id} joins ${m.parents.join(' and ')}`)
          .join('; ')}`
      );
    }
    if (branches.length) {
      bits.push(`${branches.length} branch${branches.length === 1 ? '' : 'es'}: ${branches.join(', ')}`);
    }
    if (tags.length) {
      bits.push(`${tags.length} tag${tags.length === 1 ? '' : 's'}: ${tags.map((t) => `${t.id} on ${t.target}`).join(', ')}`);
    }
    if (head) {
      bits.push(
        local.attached ? `HEAD is on branch ${local.attached}` : `HEAD is detached at ${head.target}`
      );
    }
    if (regions[1]) {
      const on = regions[1].nodes.length;
      bits.push(`plus an origin repository with ${on} commit${on === 1 ? '' : 's'}`);
    }
    const gn = ghosts.reduce((n, g) => n + g.count, 0);
    const gm = ghosts.reduce((n, g) => n + g.moved, 0);
    if (gn || gm) {
      const parts = [];
      if (gn) {
        const names = ghosts.flatMap((g) => g.nodes.map((n) => n.id));
        parts.push(`${gn} commit${gn === 1 ? '' : 's'} not in the target (${names.join(', ')})`);
      }
      if (gm) {
        const names = ghosts.flatMap((g) => g.labels.map((l) => `${l.text} on ${l.commitId}`));
        parts.push(`${gm} ref${gm === 1 ? '' : 's'} pointing elsewhere (${names.join(', ')})`);
      }
      bits.push(`Your tree differs: ${parts.join(' and ')}, drawn as dimmed outlines`);
    } else if (this.ghostSnapshot) {
      bits.push('Your tree already matches this target');
    }
    return `${bits.join('. ')}.`;
  }

  // --- public api ---------------------------------------------------------

  // opts: { animate, duration, ghost }
  //   ghost - a second snapshot (typically the learner's live tree) whose
  //   commits and refs that differ from `snapshot` are drawn as dimmed
  //   outlines behind it. Omit to keep whatever ghost was last set; pass null
  //   to clear it.
  //
  // Any render from outside is a new truth, so it INVALIDATES a playFrames
  // sequence still in flight. Settling that sequence's promise is not enough:
  // _cancelAnim() resolves the frame it is awaiting, and the loop would then
  // carry on and paint its remaining frames ~40ms later - i.e. on top of the
  // render that superseded it. Bumping the token here is what stops it.
  async render(snapshot, opts = {}) {
    if (this._destroyed) return;
    return this._render(snapshot, opts, ++this._playToken);
  }

  // The body of render(). `token` is the playFrames generation this paint
  // belongs to; the caller owns the bump, so a frame inside a sequence can
  // render without cancelling its own loop.
  async _render(snapshot, opts, token) {
    if (this._destroyed) return;
    const animate = opts.animate !== false && !prefersReducedMotion();
    const duration = Number.isFinite(opts.duration) ? opts.duration : this.compact ? 320 : 460;
    if ('ghost' in opts) this.ghostSnapshot = opts.ghost || null;

    this._cancelAnim();
    this.snapshot = snapshot || EMPTY_SNAPSHOT;
    this.scene = this._buildScene(this.snapshot, this.ghostSnapshot);

    if (!this.readOnly) this.svg.setAttribute('aria-label', this.scene.summary);
    this.empty.hidden = !this.scene.empty;
    this._paintA11y(this.scene);

    const plan = this._reconcile(this.scene, animate);
    const fit = this._computeFit(this.scene);
    this.fitK = fit.k;
    plan.camFrom = { ...this.view };
    plan.camTo = this.userAdjusted ? { ...this.view } : fit;

    if (!animate || duration <= 0) {
      this._applyPlan(plan, 1);
      this._finishPlan(plan);
      return;
    }
    await this._runAnim(plan, duration);
  }

  async playFrames(frames, opts = {}) {
    const list = (frames || []).filter(Boolean);
    if (!list.length) return;
    const token = ++this._playToken;
    const animate = opts.animate !== false && !prefersReducedMotion();
    const per = animate ? clamp(560 / Math.sqrt(list.length), 200, 520) : 0;
    for (let i = 0; i < list.length; i++) {
      // Checked before every paint and after every await: a render() from
      // outside - a new level, a new command, a hashchange - bumps the token,
      // and this loop has to stop drawing rather than finish a story that is
      // no longer true.
      if (token !== this._playToken || this._destroyed) return;
      await this._render(list[i], { ...opts, animate, duration: per }, token);
      if (token !== this._playToken || this._destroyed) return;
      if (animate && i < list.length - 1) await sleep(40);
    }
  }

  setHighlight(commitIds) {
    const ids = new Set(commitIds || []);
    this.highlighted = ids;
    const reduced = prefersReducedMotion();
    for (const rec of this.live.values()) {
      if (rec.kind !== 'node') continue;
      const on = ids.has(rec.data.id);
      rec.el.classList.toggle('is-highlight', on);
      if (!on || reduced) continue;
      const ring = rec.el.querySelector('.tv-pulse');
      if (!ring || typeof ring.animate !== 'function') continue;
      ring.animate(
        [
          { opacity: 0.9, transform: 'scale(1)' },
          { opacity: 0, transform: 'scale(2.1)' },
        ],
        { duration: 780, iterations: 2, easing: 'cubic-bezier(0.22,1,0.36,1)' }
      );
    }
  }

  resize() {
    if (this._destroyed) return;
    // Metrics first. Custom properties cannot be read off an element that is
    // not in the document yet - getComputedStyle hands back an empty
    // declaration - and every miniature in the help dialog is built detached
    // and inserted afterwards, so each one silently came up on GEOM_DEFAULT:
    // the FULL-SIZE metrics, 21px beads and 104px rows squeezed into a 164px
    // card. That is what made those ids 8.6px, and no amount of tuning
    // .tv--compact could have reached them. The first layout with a real box
    // is where the right metrics arrive, so they are re-read here and the
    // drawing is rebuilt when they turn out to be different ones.
    const rect = this.root.getBoundingClientRect();
    const w = Math.max(Math.round(rect.width) || 0, 120);
    const h = Math.max(Math.round(rect.height) || 0, 120);
    const wasStacked = stackedFor(this.size.w, this.size.h, this.compact);
    this.size = { w, h };
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const newGeom = this._readGeomIfChanged();
    if (!this.scene) return;
    if (newGeom) {
      // Every bead and pill in the DOM was built around the old radius, and
      // nothing short of rebuilding them can change that.
      this._resetLayers();
      this._render(this.snapshot, { animate: false }, this._playToken);
      return;
    }
    const nowStacked = stackedFor(w, h, this.compact);
    if (this.scene.regions.length > 1 && nowStacked !== wasStacked) {
      // Re-laying out for a new box is not a new truth, so it keeps the
      // current playFrames token: a reflow mid-sequence must not freeze the
      // board on whichever frame happened to be showing.
      this._render(this.snapshot, { animate: false }, this._playToken);
      return;
    }
    const fit = this._computeFit(this.scene);
    this.fitK = fit.k;
    if (this.userAdjusted) return;
    this.view = fit;
    // A reflow landing mid-animation used to be overwritten on the next frame
    // by the camera target computed for the *old* size, which is how the root
    // commit ended up sliced off at 360px.
    if (this._plan && this._plan.camTo) {
      this._plan.camFrom = { ...fit };
      this._plan.camTo = fit;
    }
    this._applyCamera();
  }

  // --- element factories --------------------------------------------------

  _regionLayer(key) {
    let layer = this.regionLayers.get(key);
    if (!layer) {
      const g = svgEl('g', { class: 'tv-region', 'data-region': key });
      const edges = svgEl('g', { class: 'tv-layer-edges' });
      const nodes = svgEl('g', { class: 'tv-layer-nodes' });
      const labels = svgEl('g', { class: 'tv-layer-labels' });
      g.append(edges, nodes, labels);
      this.camera.appendChild(g);
      layer = { g, edges, nodes, labels };
      this.regionLayers.set(key, layer);
    }
    return layer;
  }

  _makeNode(data) {
    const R = this.geom.r;
    const p = this.idPrefix;
    const g = svgEl('g', {
      class: 'tv-node',
      'data-id': data.id,
      'data-region': data.region,
      style: `--tv-c:${colorVar(data.color)};--tv-k:${inkVar(data.color)}`,
    });
    g.appendChild(svgEl('title'));
    g.appendChild(svgEl('ellipse', { class: 'tv-drop', cx: 0, cy: R * 0.46, rx: R * 1.02, ry: R * 0.66, fill: `url(#${p}-drop)` }));
    g.appendChild(svgEl('circle', { class: 'tv-pulse', r: R + 3 }));
    g.appendChild(svgEl('circle', { class: 'tv-body', r: R, fill: `url(#${p}-bead-${data.color})` }));
    g.appendChild(svgEl('circle', { class: 'tv-shade', r: R, fill: `url(#${p}-shade)` }));
    // One gloss rule per bead: a single soft radial specular. The old second
    // highlight - a stroked crescent inside the rim - had hard cut ends and a
    // visible gap to the silhouette, so the bead carried two different
    // highlight languages at once and neither one read as glass.
    g.appendChild(svgEl('ellipse', { class: 'tv-spec', cx: 0, cy: -R * 0.4, rx: R * 0.62, ry: R * 0.34, fill: `url(#${p}-spec)` }));
    if (data.merge) g.appendChild(svgEl('circle', { class: 'tv-inner-ring', r: R * 0.6 }));
    if (data.root) g.appendChild(svgEl('circle', { class: 'tv-core', r: R * 0.16 }));
    // The same pale casing the edges carry, for the same reason. A bead is
    // glass, so its body can never be dark enough to stand off bright water on
    // its own - measured 1.51-2.12:1 against the bay, and the inked rim over
    // it only reached 2.13-2.55. The casing gives the rim an adjacent colour
    // of its own, which is what the silhouette is actually read against, and
    // it costs the glass nothing.
    g.appendChild(svgEl('circle', { class: 'tv-rim-casing', r: R + 1.6 }));
    g.appendChild(svgEl('circle', { class: 'tv-rim', r: R - 0.5 }));
    const text = svgEl('text', { class: 'tv-id', 'text-anchor': 'middle', 'dominant-baseline': 'central', y: 0.5 });
    g.appendChild(text);
    g.appendChild(svgEl('circle', { class: 'tv-focus-ring', r: R + 5 }));
    g.appendChild(svgEl('circle', { class: 'tv-hit', r: R + 4 }));
    return g;
  }

  _updateNode(rec, data) {
    const R = this.geom.r;
    const label = `${data.id}${data.merge ? ' (merge commit)' : ''}${data.root ? ' (root commit)' : ''}${
      data.refs.length ? `, refs: ${data.refs.join(', ')}` : ''
    }`;
    rec.el.querySelector('title').textContent = label;
    rec.el.setAttribute('style', `--tv-c:${colorVar(data.color)};--tv-k:${inkVar(data.color)}`);
    rec.el.querySelector('.tv-body').setAttribute('fill', `url(#${this.idPrefix}-bead-${data.color})`);
    const text = rec.el.querySelector('.tv-id');
    if (text.textContent !== data.id) {
      text.textContent = data.id;
      const budget = R * 1.62;
      const raw = this._measure(data.id, 'tv-id');
      const scale = raw > budget ? budget / raw : 1;
      text.setAttribute('style', scale < 1 ? `font-size:${f2(this.geom.idFs * scale)}px` : '');
    }
    rec.data = data;
  }

  _makeLabel(data) {
    const g = svgEl('g', { class: `tv-label tv-label--${data.kind}`, 'data-ref': data.text });
    g.appendChild(svgEl('title'));
    g.appendChild(svgEl('path', { class: 'tv-lead-casing' }));
    g.appendChild(svgEl('path', { class: 'tv-lead' }));
    g.appendChild(svgEl('circle', { class: 'tv-lead-dot', r: 2.6 }));
    g.appendChild(svgEl('path', { class: 'tv-pill-glow', filter: `url(#${this.idPrefix}-glow)` }));
    g.appendChild(svgEl('path', { class: 'tv-pill' }));
    g.appendChild(svgEl('path', { class: 'tv-pill-gloss', fill: `url(#${this.idPrefix}-pill)` }));
    // Second rule inside the pill's own, for the two ramp slots that are twins
    // of a colour already on the canvas. Painted over the gloss: under it the
    // sheen took a third of the rule's contrast away at the top of the capsule.
    g.appendChild(svgEl('path', { class: 'tv-pill-band' }));
    g.appendChild(svgEl('path', { class: 'tv-pill-caret' }));
    g.appendChild(svgEl('text', { class: 'tv-pill-text', 'dominant-baseline': 'central' }));
    g.appendChild(svgEl('g', { class: 'tv-head-mark' }));
    return g;
  }

  _updateLabel(rec, data) {
    const h = data.h;
    const notch = h * 0.42;
    const g = rec.el;
    g.setAttribute('class', `tv-label tv-label--${data.kind}${data.remote ? ' is-remote' : ''}${
      data.active ? ' is-active' : ''
    }${data.detached ? ' is-detached' : ''}${banded(data.color) ? ' is-band' : ''}`);
    g.setAttribute('style', `--tv-c:${colorVar(data.color)};--tv-k:${inkVar(data.color)}`);
    g.setAttribute('data-commit', data.commitId);
    const r = h / 2;
    const w = data.w;
    const shape =
      data.kind === 'tag'
        ? `M${f2(notch)},0 L${f2(w - r)},0 Q${f2(w)},0 ${f2(w)},${f2(r)} L${f2(w)},${f2(h - r)} Q${f2(w)},${f2(h)} ${f2(
            w - r
          )},${f2(h)} L${f2(notch)},${f2(h)} L0,${f2(h / 2)} Z`
        : `M${f2(r)},0 L${f2(w - r)},0 A${f2(r)} ${f2(r)} 0 0 1 ${f2(w - r)},${f2(h)} L${f2(r)},${f2(
            h
          )} A${f2(r)} ${f2(r)} 0 0 1 ${f2(r)},0 Z`;
    g.querySelector('.tv-pill').setAttribute('d', shape);
    g.querySelector('.tv-pill-glow').setAttribute('d', shape);
    g.querySelector('.tv-pill-gloss').setAttribute(
      'd',
      data.kind === 'tag' ? tagGloss(w, h, notch, 1, 0.55) : capsuleGloss(0, 0, w, h, 1, 0.55)
    );

    // The doubled outline. Inset as a fraction of the pill height so it holds
    // at the compact metrics too, and only ever on a capsule: the two slots it
    // marks are branch colours, and a tag or a HEAD capsule never carries one.
    const ins = h * 0.14;
    const bandR = h / 2 - ins;
    g.querySelector('.tv-pill-band').setAttribute(
      'd',
      banded(data.color) && data.kind !== 'tag' && w - ins * 2 >= h - ins * 2
        ? `M${f2(ins + bandR)},${f2(ins)} L${f2(w - ins - bandR)},${f2(ins)} A${f2(bandR)} ${f2(bandR)} 0 0 1 ${f2(
            w - ins - bandR
          )},${f2(h - ins)} L${f2(ins + bandR)},${f2(h - ins)} A${f2(bandR)} ${f2(bandR)} 0 0 1 ${f2(ins + bandR)},${f2(
            ins
          )} Z`
        : ''
    );

    // Leader: a short glass link from the bead's rim into the pill, so a label
    // sitting in the lane between two columns can only read as one commit's.
    const lx = Number.isFinite(data.leadX) ? data.leadX : -12;
    const ly = Number.isFinite(data.leadY) ? data.leadY : h / 2;
    const lead = `M${f2(lx)},${f2(ly)}Q${f2(lx * 0.32)},${f2(ly)} ${f2(lx * 0.32)},${f2(h / 2)}L0.5,${f2(h / 2)}`;
    g.querySelector('.tv-lead').setAttribute('d', lead);
    g.querySelector('.tv-lead-casing').setAttribute('d', lead);
    const dot = g.querySelector('.tv-lead-dot');
    dot.setAttribute('cx', f2(lx));
    dot.setAttribute('cy', f2(ly));

    // Shape signal for the checked-out branch, so "where am I" never depends on
    // colour or stroke weight.
    const caretW = data.active ? h * 0.44 : 0;
    const cx = h * 0.34;
    g.querySelector('.tv-pill-caret').setAttribute(
      'd',
      data.active
        ? `M${f2(cx - h * 0.11)},${f2(h * 0.28)}L${f2(cx + h * 0.15)},${f2(h / 2)}L${f2(cx - h * 0.11)},${f2(
            h * 0.72
          )}Z`
        : ''
    );

    const text = g.querySelector('.tv-pill-text');
    text.textContent = data.text;
    text.setAttribute('x', f2(data.kind === 'tag' ? notch + (w - notch) / 2 : (caretW + w) / 2));
    text.setAttribute('y', f2(h / 2 + 0.5));
    text.setAttribute('text-anchor', 'middle');
    g.querySelector('title').textContent =
      data.kind === 'tag'
        ? `tag ${data.text} points at ${data.commitId}`
        : data.kind === 'head'
        ? `HEAD is detached at ${data.commitId}`
        : `${data.remote ? 'remote-tracking branch' : 'branch'} ${data.text} points at ${data.commitId}`;

    const mark = g.querySelector('.tv-head-mark');
    mark.textContent = '';
    if (data.headW) {
      const gap = h * 0.55;
      const hx = w + gap;
      mark.appendChild(
        svgEl('path', { class: 'tv-head-link', d: `M${f2(w + 2)},${f2(h / 2)} L${f2(hx)},${f2(h / 2)}` })
      );
      mark.appendChild(
        svgEl('path', {
          class: 'tv-head-arrow',
          d: `M${f2(w + 2)},${f2(h / 2)} L${f2(w + gap * 0.7)},${f2(h / 2 - h * 0.2)} L${f2(w + gap * 0.7)},${f2(
            h / 2 + h * 0.2
          )} Z`,
        })
      );
      mark.appendChild(
        svgEl('rect', {
          class: 'tv-head-pill',
          x: f2(hx),
          y: f2(h * 0.1),
          width: f2(data.headW),
          height: f2(h * 0.8),
          rx: f2(h * 0.4),
        })
      );
      // Same capsule, same caps: as a rect this gloss carried rx h*0.19 inside a
      // pill whose rx is h*0.4, so its ends curled on a radius the shape around
      // them never uses.
      mark.appendChild(
        svgEl('path', {
          class: 'tv-head-gloss',
          d: capsuleGloss(hx, h * 0.1, data.headW, h * 0.8, 1, 0.55),
        })
      );
      const t = svgEl('text', {
        class: 'tv-head-text',
        x: f2(hx + data.headW / 2),
        y: f2(h / 2 + 0.5),
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
      });
      t.textContent = 'HEAD';
      mark.appendChild(t);
    }
    rec.data = data;
  }

  // The stroke gradient uses userSpaceOnUse on purpose: an objectBoundingBox
  // gradient is not rendered at all when the path is perfectly vertical (zero
  // bbox width), which silently erased every first-parent edge.
  _makeEdge() {
    const id = `${this.idPrefix}-eg${(this._edgeSeq = (this._edgeSeq || 0) + 1)}`;
    const g = svgEl('g', { class: 'tv-edge' });
    // An edge belongs to its child, so it stays one hue for most of its length
    // and only cross-fades in the last stretch before the join. Blending two
    // hues over the whole run is what turned an olive-to-blue link into mud.
    g.appendChild(
      svgEl(
        'linearGradient',
        { id, gradientUnits: 'userSpaceOnUse' },
        svgEl('stop', { offset: '0' }),
        svgEl('stop', { offset: '0.76' }),
        svgEl('stop', { offset: '1' })
      )
    );
    g.appendChild(svgEl('path', { class: 'tv-edge-casing' }));
    g.appendChild(svgEl('path', { class: 'tv-edge-line', stroke: `url(#${id})` }));
    g.appendChild(svgEl('path', { class: 'tv-edge-arrow' }));
    return g;
  }

  _updateEdge(rec, data) {
    rec.el.setAttribute('class', `tv-edge${data.merge ? ' is-merge' : ''}`);
    rec.el.setAttribute('data-edge', `${data.fromKey}>${data.toKey}`);
    rec.el.setAttribute('data-kind', data.kind || 'line');
    rec.el.setAttribute('style', `--tv-c:${inkVar(data.toColor)}`);
    rec.grad = rec.el.firstElementChild;
    rec.grad.children[0].setAttribute('style', `stop-color:${inkVar(data.color)}`);
    rec.grad.children[1].setAttribute('style', `stop-color:${inkVar(data.color)}`);
    rec.grad.children[2].setAttribute('style', `stop-color:${inkVar(data.toColor)}`);
    rec.data = data;
    this._paintEdge(rec);
  }

  // Rebuilds the path from the *current* animated endpoint positions, keeping
  // the route's fixed midpoints. Called every frame for moving edges.
  _paintEdge(rec) {
    const data = rec.data;
    const from = this.live.get(data.fromKey);
    const to = this.live.get(data.toKey);
    if (!from || !to) return;
    const R = data.r;
    const gap = data.gap || 1;
    // Every parent link is arrowed, so the arrow means "points at its parent"
    // rather than "this one happens to be a merge". Sized at about twice the
    // stroke: any bigger and a fan's worth of heads merges into one blob on the
    // parent's rim.
    const arrow =
      this.geom.r *
      (this.compact ? 0.3 : 0.24) *
      (data.crowd >= ARRIVE_CROWD ? ARROW_CROWD_SCALE : 1);
    const dir = data.dirIn || { x: 0, y: -1 };
    const p0 = { x: from.cur.x, y: from.cur.y + R + gap };
    const tip = { x: to.cur.x + dir.x * (R + gap), y: to.cur.y + dir.y * (R + gap) };
    const p1 = { x: tip.x + dir.x * arrow * 1.05, y: tip.y + dir.y * arrow * 1.05 };
    let d;
    if (data.kind === 'route' && data.mid) {
      const pts = [p0, { ...data.mid[0], x: p0.x }, data.mid[1], data.mid[2], { ...data.mid[3], x: p1.x }, p1];
      // Tight corners on purpose: at the old radius a corner ate most of a
      // riser, and the railroad turned back into a sweep.
      d = roundedPath(pts, Math.min(this.geom.row, this.geom.col) * 0.13);
    } else if (data.kind === 'fan') {
      const c0 = { x: p0.x, y: p0.y + data.lead };
      const c1 = { x: p1.x + dir.x * data.pull, y: p1.y + dir.y * data.pull };
      d = `M${f2(p0.x)},${f2(p0.y)}C${f2(c0.x)},${f2(c0.y)} ${f2(c1.x)},${f2(c1.y)} ${f2(p1.x)},${f2(p1.y)}`;
    } else if (data.kind === 'line' || Math.abs(p0.x - p1.x) < 0.5) {
      d = `M${f2(p0.x)},${f2(p0.y)}L${f2(p1.x)},${f2(p1.y)}`;
    } else {
      d = curvePath(p0, p1, data.swing);
    }
    rec.el.querySelector('.tv-edge-casing').setAttribute('d', d);
    rec.el.querySelector('.tv-edge-line').setAttribute('d', d);
    if (rec.grad) {
      rec.grad.setAttribute('x1', f2(p0.x));
      rec.grad.setAttribute('y1', f2(p0.y));
      rec.grad.setAttribute('x2', f2(p1.x));
      rec.grad.setAttribute('y2', f2(p1.y));
    }
    // Arrowhead sits at the parent end, turned to whatever heading the edge
    // arrives on.
    const head = rec.el.querySelector('.tv-edge-arrow');
    head.setAttribute('d', `M${f2(-arrow * 0.86)},${f2(-arrow * 1.3)}L${f2(arrow * 0.86)},${f2(-arrow * 1.3)}L0,0Z`);
    const deg = (Math.atan2(dir.x, -dir.y) * 180) / Math.PI;
    head.setAttribute(
      'transform',
      `translate(${f2(tip.x)},${f2(tip.y)})${deg ? ` rotate(${f2(deg)})` : ''}`
    );
  }

  // --- reconcile ----------------------------------------------------------

  // Dimmed outlines of everything the learner has that the target does not.
  // Rebuilt only when the diff actually changes, so it does not re-fade on
  // every keystroke.
  _paintGhosts(scene) {
    const sig = (scene.ghosts || []).map((g) => `${g.region}:${g.sig}`).join('||');
    if (sig === this._ghostSig) return;
    this._ghostSig = sig;
    this.ghostLayer.textContent = '';
    const R = this.geom.r;
    for (const ghost of scene.ghosts || []) {
      const layer = svgEl('g', {
        class: 'tv-ghost',
        transform: `translate(${f2(ghost.offset.x)},${f2(ghost.offset.y)})`,
      });
      for (const e of ghost.edges) {
        layer.appendChild(
          svgEl('path', {
            class: 'tv-ghost-edge',
            d: `M${f2(e.from.x)},${f2(e.from.y + R)}L${f2(e.to.x)},${f2(e.to.y - R)}`,
          })
        );
      }
      for (const n of ghost.nodes) {
        const g = svgEl('g', { class: 'tv-ghost-node', transform: `translate(${f2(n.x)},${f2(n.y)})` });
        g.appendChild(svgEl('circle', { class: 'tv-ghost-body', r: f2(R) }));
        const t = svgEl('text', {
          class: 'tv-ghost-id',
          'text-anchor': 'middle',
          'dominant-baseline': 'central',
          y: '0.5',
        });
        t.textContent = n.id;
        g.appendChild(t);
        layer.appendChild(g);
      }
      for (const l of ghost.labels) {
        const g = svgEl('g', { class: 'tv-ghost-label', transform: `translate(${f2(l.x)},${f2(l.y)})` });
        const r = l.h / 2;
        const lx = Number.isFinite(l.leadX) ? l.leadX : -12;
        const ly = Number.isFinite(l.leadY) ? l.leadY : r;
        g.appendChild(
          svgEl('path', {
            class: 'tv-ghost-lead',
            d: `M${f2(lx)},${f2(ly)}Q${f2(lx * 0.32)},${f2(ly)} ${f2(lx * 0.32)},${f2(r)}L0.5,${f2(r)}`,
          })
        );
        g.appendChild(
          svgEl('path', {
            class: 'tv-ghost-pill',
            d: `M${f2(r)},0 L${f2(l.w - r)},0 A${f2(r)} ${f2(r)} 0 0 1 ${f2(l.w - r)},${f2(l.h)} L${f2(
              r
            )},${f2(l.h)} A${f2(r)} ${f2(r)} 0 0 1 ${f2(r)},0 Z`,
          })
        );
        const t = svgEl('text', {
          class: 'tv-ghost-text',
          x: f2(l.w / 2),
          y: f2(l.h / 2 + 0.5),
          'text-anchor': 'middle',
          'dominant-baseline': 'central',
        });
        t.textContent = l.text;
        g.appendChild(t);
        layer.appendChild(g);
      }
      this.ghostLayer.appendChild(layer);
    }
  }

  // Screen readers get the graph as text, not as one opaque image: the summary
  // names the shape, the list gives every commit its parents and its refs.
  _paintA11y(scene) {
    const rows = [];
    for (const region of scene.regions) {
      const where =
        region.key === 'origin' ? 'origin repository: ' : this.ghostSnapshot ? 'Goal: ' : '';
      const byId = new Map(region.nodes.map((n) => [n.id, n]));
      const ordered = [...region.nodes].sort((a, b) => a.gen - b.gen || a.col - b.col);
      for (const n of ordered) {
        const parents = n.parents.filter((p) => byId.has(p));
        const kin = parents.length
          ? `${parents.length > 1 ? 'merge of' : 'child of'} ${parents.join(' and ')}`
          : 'root commit, no parent';
        const refs = n.refs.length ? `. Here: ${n.refs.join(', ')}` : '';
        rows.push(`${where}${n.id}, ${kin}${refs}.`);
      }
    }
    for (const ghost of scene.ghosts || []) {
      for (const n of ghost.nodes) rows.push(`Your tree also has ${n.id}, which the target does not.`);
      for (const l of ghost.labels) rows.push(`Your ${l.text} is on ${l.commitId}; the target moves it.`);
    }
    this.a11y.textContent = '';
    this.a11y.appendChild(el('p', {}, scene.summary));
    const list = el('ul', {});
    for (const row of rows) list.appendChild(el('li', {}, row));
    this.a11y.appendChild(list);
  }

  _reconcile(scene, animate) {
    this._paintPanels(scene);
    this._paintGhosts(scene);
    const seen = new Set();
    const items = [];
    const exits = [];
    const edgeRecs = [];

    for (const region of scene.regions) {
      const layer = this._regionLayer(region.key);
      layer.g.setAttribute('transform', `translate(${f2(region.offset.x)},${f2(region.offset.y)})`);

      for (const node of region.nodes) {
        seen.add(node.key);
        let rec = this.live.get(node.key);
        if (!rec) {
          rec = { key: node.key, kind: 'node', el: this._makeNode(node), cur: { x: node.x, y: node.y, s: 0.2, o: 0 }, data: node, region: region.key };
          layer.nodes.appendChild(rec.el);
          this.live.set(node.key, rec);
        }
        this._updateNode(rec, node);
        rec.region = region.key;
        rec.offset = region.offset;
        items.push({
          rec,
          from: { ...rec.cur },
          to: { x: node.x, y: node.y, s: 1, o: 1 },
          ease: rec.cur.o < 0.5 ? easeBack : easeOut,
          delay: animate ? clamp(node.gen * 0.012, 0, 0.24) : 0,
        });
      }

      for (const label of region.labels) {
        seen.add(label.key);
        let rec = this.live.get(label.key);
        if (!rec) {
          rec = { key: label.key, kind: 'label', el: this._makeLabel(label), cur: { x: label.x, y: label.y, s: 0.8, o: 0 }, data: label, region: region.key };
          layer.labels.appendChild(rec.el);
          this.live.set(label.key, rec);
        }
        this._updateLabel(rec, label);
        rec.region = region.key;
        items.push({
          rec,
          from: { ...rec.cur },
          to: { x: label.x, y: label.y, s: 1, o: 1 },
          ease: easeOut,
          // Same delay as the bead it points at: a leader that lags its own
          // commit would visibly detach mid-animation.
          delay: animate ? clamp((label.delay || 0) * 0.012, 0, 0.24) : 0,
        });
      }

      for (const edge of region.edges) {
        seen.add(edge.key);
        let rec = this.live.get(edge.key);
        const isNew = !rec;
        if (!rec) {
          rec = { key: edge.key, kind: 'edge', el: this._makeEdge(), cur: { x: 0, y: 0, s: 1, o: 0 }, data: edge, region: region.key };
          layer.edges.appendChild(rec.el);
          this.live.set(edge.key, rec);
        }
        this._updateEdge(rec, edge);
        rec.region = region.key;
        edgeRecs.push(rec);
        items.push({
          rec,
          from: { ...rec.cur },
          to: { x: 0, y: 0, s: 1, o: 1 },
          ease: easeOut,
          delay: animate && isNew ? 0.2 : 0,
        });
      }
    }

    for (const [key, rec] of this.live) {
      if (seen.has(key)) continue;
      exits.push({
        rec,
        from: { ...rec.cur },
        to: { x: rec.cur.x, y: rec.cur.y, s: rec.kind === 'node' ? 0.5 : 0.9, o: 0 },
        ease: easeInOut,
        delay: 0,
      });
      this.live.delete(key);
    }

    this._plan = { items, exits, edges: edgeRecs };
    return this._plan;
  }

  _paintPanels(scene) {
    this.panelLayer.textContent = '';
    if (scene.divider) {
      this.panelLayer.appendChild(
        svgEl('line', {
          class: 'tv-divider',
          x1: f2(scene.divider.x1),
          y1: f2(scene.divider.y1),
          x2: f2(scene.divider.x2),
          y2: f2(scene.divider.y2),
        })
      );
    }
    for (const panel of scene.panels) {
      const g = svgEl('g', { class: `tv-panel${panel.remote ? ' is-remote' : ''}` });
      g.appendChild(
        svgEl('rect', {
          class: 'tv-panel-bg',
          x: f2(panel.x),
          y: f2(panel.y),
          width: f2(panel.w),
          height: f2(panel.h),
          rx: f2(this.geom.pad * 0.7),
          fill: `url(#${this.idPrefix}-panel)`,
        })
      );
      const t = svgEl('text', { class: 'tv-panel-title', x: f2(panel.x + this.geom.pad * 0.8), y: f2(panel.y + this.geom.labelH * 0.9) });
      t.textContent = panel.title;
      g.appendChild(t);
      this.panelLayer.appendChild(g);
    }
  }

  // --- animation ----------------------------------------------------------

  _applyPlan(plan, t) {
    const write = (item) => {
      const local = item.delay > 0 ? clamp((t - item.delay) / (1 - item.delay), 0, 1) : t;
      const e = item.ease(local);
      const cur = item.rec.cur;
      cur.x = mix(item.from.x, item.to.x, e);
      cur.y = mix(item.from.y, item.to.y, e);
      cur.s = mix(item.from.s, item.to.s, e);
      cur.o = mix(item.from.o, item.to.o, clamp(local * 1.6, 0, 1));
      const el = item.rec.el;
      if (item.rec.kind === 'edge') {
        el.setAttribute('opacity', f2(cur.o));
      } else {
        el.setAttribute(
          'transform',
          cur.s === 1
            ? `translate(${f2(cur.x)},${f2(cur.y)})`
            : `translate(${f2(cur.x)},${f2(cur.y)}) scale(${f2(cur.s)})`
        );
        el.setAttribute('opacity', f2(cur.o));
      }
    };
    for (const item of plan.items) write(item);
    for (const item of plan.exits) write(item);
    for (const rec of plan.edges) this._paintEdge(rec);

    if (plan.camFrom && plan.camTo) {
      const e = easeInOut(t);
      this.view = {
        x: mix(plan.camFrom.x, plan.camTo.x, e),
        y: mix(plan.camFrom.y, plan.camTo.y, e),
        k: mix(plan.camFrom.k, plan.camTo.k, e),
      };
      this._applyCamera();
    }
  }

  _finishPlan(plan) {
    for (const item of plan.exits) item.rec.el.remove();
    plan.exits.length = 0;
    if (this._plan === plan) this._plan = null;
  }

  _runAnim(plan, duration) {
    return new Promise((resolve) => {
      this._settle = resolve;
      const t0 = performance.now();
      const step = (now) => {
        const t = clamp((now - t0) / duration, 0, 1);
        this._applyPlan(plan, t);
        if (t < 1) {
          this._raf = requestAnimationFrame(step);
          return;
        }
        this._raf = 0;
        this._finishPlan(plan);
        this._settle = null;
        resolve();
      };
      this._raf = requestAnimationFrame(step);
    });
  }

  _cancelAnim() {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
    if (this._plan) this._finishPlan(this._plan);
    if (this._settle) {
      const settle = this._settle;
      this._settle = null;
      settle();
    }
  }

  // --- camera -------------------------------------------------------------

  // Scale the whole bounding box to fill the stage, then centre it. Because the
  // scale is derived from the box, no part of the graph can ever be clipped -
  // at 360px or at 3440px - and a small tree no longer floats as a stamp in a
  // wide pane.
  _computeFit(scene) {
    const { w, h } = this.size;
    const bb = scene && scene.bbox;
    if (!bb || !Number.isFinite(bb.w) || bb.w <= 0 || bb.h <= 0) {
      return { x: w / 2, y: h / 2, k: 1 };
    }
    const maxK = this.compact ? MAX_FIT_SCALE_COMPACT : MAX_FIT_SCALE;
    const box = clamp(Math.min((w * FIT_FILL) / bb.w, (h * FIT_FILL) / bb.h), 0.04, maxK);
    let k = box;
    // Miniatures are exempt from spilling: a goal panel or a help legend that
    // ran over its own frame would hide the very commits it is there to show,
    // and neither one can be panned. They get their legibility from the
    // compact metrics in tree.css instead, which are tuned so the id still
    // lands around 12px at the sizes those panels actually get.
    const want = MIN_ID_PX / this.geom.idFs;
    const room = Math.min((w * FIT_SPILL) / bb.w, (h * FIT_SPILL) / bb.h);
    const pannable = w >= PAN_MIN_W && h >= PAN_MIN_H;
    if (!this.compact && want > k && (room >= want || pannable)) k = Math.min(want, maxK);
    // Centred while the graph fits; anchored to the newest commits once it
    // does not, so the first thing on screen is the head of the history.
    const spillY = bb.h * k - h;
    return {
      x: w / 2 - (bb.x + bb.w / 2) * k,
      y: spillY > 0 ? SPILL_TOP_PAD - bb.y * k : h / 2 - (bb.y + bb.h / 2) * k,
      k,
    };
  }

  _applyCamera() {
    // The scale keeps three decimals where everything else keeps two: at the
    // fitted scale of a large graph, 0.714 rounded to 0.71 is half a percent
    // off, which is enough to put an id that was placed at exactly the floor
    // back under it.
    const k = Math.round(this.view.k * 1000) / 1000;
    this.camera.setAttribute(
      'transform',
      `translate(${f2(this.view.x)},${f2(this.view.y)}) scale(${k})`
    );
  }

  _markAdjusted() {
    if (this.userAdjusted) return;
    this.userAdjusted = true;
    this.root.classList.add('is-adjusted');
  }

  fitToView(animate = true) {
    if (!this.scene) return;
    const target = this._computeFit(this.scene);
    this.fitK = target.k;
    this.userAdjusted = false;
    this.root.classList.remove('is-adjusted');
    if (!animate || prefersReducedMotion()) {
      this.view = target;
      this._applyCamera();
      return;
    }
    this._cancelAnim();
    const plan = { items: [], exits: [], edges: [], camFrom: { ...this.view }, camTo: target };
    this._plan = plan;
    this._runAnim(plan, 340);
  }

  _zoomAt(sx, sy, factor) {
    const kMin = this.fitK * ZOOM_MIN;
    const kMax = this.fitK * ZOOM_MAX;
    const k = clamp(this.view.k * factor, kMin, kMax);
    if (Math.abs(k - this.view.k) < 1e-6) return;
    const ratio = k / this.view.k;
    this.view = { x: sx - (sx - this.view.x) * ratio, y: sy - (sy - this.view.y) * ratio, k };
    this._markAdjusted();
    this._applyCamera();
  }

  _toSvg(clientX, clientY) {
    const rect = this.svg.getBoundingClientRect();
    const sx = ((clientX - rect.left) / Math.max(rect.width, 1)) * this.size.w;
    const sy = ((clientY - rect.top) / Math.max(rect.height, 1)) * this.size.h;
    return { x: sx, y: sy };
  }

  // --- events -------------------------------------------------------------

  _on(target, type, fn, opt) {
    target.addEventListener(type, fn, opt);
    this._listeners.push([target, type, fn, opt]);
  }

  _bindEvents() {
    this._listeners = [];
    const pointers = new Map();
    let drag = null;
    let pinch = null;

    this._on(this.svg, 'wheel', (e) => {
      e.preventDefault();
      const p = this._toSvg(e.clientX, e.clientY);
      const factor = Math.exp(-clamp(e.deltaY, -60, 60) * 0.0022);
      this._zoomAt(p.x, p.y, factor);
    }, { passive: false });

    this._on(this.svg, 'pointerdown', (e) => {
      if (e.button != null && e.button > 1) return;
      this.svg.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, this._toSvg(e.clientX, e.clientY));
      if (pointers.size === 1) {
        const p = pointers.get(e.pointerId);
        drag = { id: e.pointerId, x: p.x, y: p.y, vx: this.view.x, vy: this.view.y, moved: 0, target: e.target };
        this.root.classList.add('is-panning');
      } else if (pointers.size === 2) {
        drag = null;
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
      }
    });

    this._on(this.svg, 'pointermove', (e) => {
      if (!pointers.has(e.pointerId)) {
        this._hoverAt(e);
        return;
      }
      const p = this._toSvg(e.clientX, e.clientY);
      pointers.set(e.pointerId, p);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this._zoomAt(mid.x, mid.y, dist / pinch.dist);
        pinch.dist = dist;
        return;
      }
      if (drag && drag.id === e.pointerId) {
        const dx = p.x - drag.x;
        const dy = p.y - drag.y;
        drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
        if (drag.moved > 3) {
          this.view = { ...this.view, x: drag.vx + dx, y: drag.vy + dy };
          this._markAdjusted();
          this._applyCamera();
          this._hideTip();
        }
      }
    });

    const endPointer = (e) => {
      const wasDrag = drag && drag.id === e.pointerId ? drag : null;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (wasDrag) {
        drag = null;
        this.root.classList.remove('is-panning');
        if (wasDrag.moved <= 3) this._handleClick(wasDrag.target);
      }
    };
    this._on(this.svg, 'pointerup', endPointer);
    this._on(this.svg, 'pointercancel', endPointer);
    this._on(this.svg, 'pointerleave', (e) => {
      endPointer(e);
      this._hideTip();
      this._clearBranchFocus();
    });

    this._on(this.svg, 'pointerover', (e) => this._hoverAt(e));
    this._on(this.svg, 'pointerout', (e) => {
      const to = e.relatedTarget;
      if (to && this.svg.contains(to)) return;
      this._hideTip();
      this._clearBranchFocus();
    });

    if (this.controls) {
      this._on(this.controls, 'click', (e) => {
        const btn = e.target.closest('.tv-btn');
        if (!btn) return;
        const center = { x: this.size.w / 2, y: this.size.h / 2 };
        if (btn.dataset.action === 'zoom-in') this._zoomAt(center.x, center.y, 1.25);
        else if (btn.dataset.action === 'zoom-out') this._zoomAt(center.x, center.y, 0.8);
        else this.fitToView(true);
      });
    }
    this._on(this.resetBtn, 'click', () => this.fitToView(true));

    this._on(this.svg, 'keydown', (e) => this._onKey(e));
    this._on(this.svg, 'blur', () => {
      this.root.classList.remove('is-keyboard');
      this._syncFocusRing();
    });

    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.root);
    }
  }

  _handleClick(target) {
    const node = target && target.closest ? target.closest('.tv-node') : null;
    if (!node) return;
    const id = node.getAttribute('data-id');
    this.focusId = id;
    this.selectedId = id;
    this._syncFocusRing();
    const rec = this.live.get(`${node.getAttribute('data-region')}:${id}`);
    if (rec) this.sr.textContent = `Selected ${this._describe(rec.data)}`;
    if (!this.readOnly && typeof this.onCommitClick === 'function') this.onCommitClick(id);
  }

  _hoverAt(e) {
    const node = e.target && e.target.closest ? e.target.closest('.tv-node') : null;
    const label = e.target && e.target.closest ? e.target.closest('.tv-label') : null;
    if (node) {
      this._clearBranchFocus();
      this._showTip(node.getAttribute('data-id'), node.getAttribute('data-region'), e);
      return;
    }
    if (label) {
      this._hideTip();
      this._focusBranch(label);
      return;
    }
    this._hideTip();
    this._clearBranchFocus();
  }

  _showTip(id, regionKey, e) {
    const region = (this.scene?.regions || []).find((r) => r.key === regionKey);
    const node = region && region.nodes.find((n) => n.id === id);
    if (!node) return;
    const parents = node.parents.length ? node.parents.join(', ') : 'none (root commit)';
    this.tip.textContent = '';
    this.tip.append(
      el('div', { class: 'tv-tip-id' }, node.id, node.merge ? el('span', { class: 'tv-tip-tag' }, 'merge') : null),
      el('div', { class: 'tv-tip-row' }, el('span', { class: 'tv-tip-k' }, 'parents'), el('span', {}, parents)),
      node.refs.length
        ? el('div', { class: 'tv-tip-row' }, el('span', { class: 'tv-tip-k' }, 'refs'), el('span', {}, node.refs.join(', ')))
        : null,
      regionKey === 'origin' ? el('div', { class: 'tv-tip-row tv-tip-muted' }, 'in the origin repository') : null
    );
    this.tip.hidden = false;
    const rect = this.root.getBoundingClientRect();
    const w = this.tip.offsetWidth || 160;
    const h = this.tip.offsetHeight || 60;
    const x = clamp((e.clientX ?? rect.left) - rect.left + 16, 6, Math.max(6, rect.width - w - 6));
    const y = clamp((e.clientY ?? rect.top) - rect.top - h - 12, 6, Math.max(6, rect.height - h - 6));
    this.tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  _hideTip() {
    if (!this.tip.hidden) this.tip.hidden = true;
  }

  _focusBranch(labelEl) {
    const name = labelEl.getAttribute('data-ref');
    if (this._litRef === name) return;
    this._litRef = name;
    const rec = [...this.live.values()].find((r) => r.kind === 'label' && r.data.text === name);
    if (!rec) return;
    const region = (this.scene?.regions || []).find((r) => r.key === rec.data.region);
    if (!region) return;
    const byId = new Map(region.nodes.map((n) => [n.id, n]));
    const lit = new Set();
    const stack = [rec.data.commitId];
    while (stack.length) {
      const id = stack.pop();
      if (!id || lit.has(id) || !byId.has(id)) continue;
      lit.add(id);
      for (const p of byId.get(id).parents) stack.push(p);
    }
    this.root.classList.add('is-focusing');
    for (const r of this.live.values()) {
      if (r.kind === 'node') r.el.classList.toggle('is-lit', r.region === region.key && lit.has(r.data.id));
      else if (r.kind === 'edge') {
        r.el.classList.toggle('is-lit', r.region === region.key && lit.has(r.data.fromKey.split(':').slice(1).join(':')));
      }
    }
  }

  _clearBranchFocus() {
    if (!this._litRef) return;
    this._litRef = null;
    this.root.classList.remove('is-focusing');
    for (const r of this.live.values()) r.el.classList.remove('is-lit');
  }

  // --- keyboard -----------------------------------------------------------

  _allNodes() {
    const out = [];
    for (const region of this.scene?.regions || []) {
      for (const n of region.nodes) out.push({ ...n, ox: n.x + region.offset.x, oy: n.y + region.offset.y });
    }
    return out;
  }

  _describe(node) {
    const parents = node.parents.filter((p) => (this.snapshot.commits || {})[p]);
    const kin = parents.length
      ? `${parents.length > 1 ? 'merge of' : 'child of'} ${parents.join(' and ')}`
      : 'root commit';
    return `${node.id}, ${kin}${node.refs.length ? `, refs ${node.refs.join(', ')}` : ''}`;
  }

  _pan(dx, dy) {
    this.view = { ...this.view, x: this.view.x + dx, y: this.view.y + dy };
    this._markAdjusted();
    this._applyCamera();
  }

  _onKey(e) {
    const arrows = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    const keys = [...arrows, 'Home', 'End', 'Enter', ' ', '+', '=', '-', '_', '0'];
    if (!keys.includes(e.key)) return;
    const nodes = this._allNodes();
    e.preventDefault();

    // Shift+arrow pans, +/- zoom, 0 refits. The panel advertises "drag to pan,
    // scroll to zoom", both of which are pointer-only: with a graph bigger than
    // its pane a keyboard user had no way to reach the rest of the history.
    if (arrows.includes(e.key) && (e.shiftKey || !nodes.length)) {
      const step = Math.max(this.size.w, this.size.h) * 0.16;
      this._pan(
        e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0,
        e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0
      );
      this.sr.textContent = `Panned ${e.key.replace('Arrow', '').toLowerCase()}`;
      return;
    }
    if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
      const inward = e.key === '+' || e.key === '=';
      this._zoomAt(this.size.w / 2, this.size.h / 2, inward ? 1.25 : 0.8);
      this.sr.textContent = `Zoom ${Math.round((this.view.k / (this.fitK || 1)) * 100)} percent`;
      return;
    }
    if (e.key === '0') {
      this.fitToView(true);
      this.sr.textContent = 'Graph fitted to the view';
      return;
    }
    if (!nodes.length) return;
    this.root.classList.add('is-keyboard');

    let current = nodes.find((n) => n.id === this.focusId) || null;
    if (!current || e.key === 'Home' || e.key === 'End') {
      const sorted = [...nodes].sort((a, b) => b.gen - a.gen || a.col - b.col);
      current = e.key === 'End' ? sorted[sorted.length - 1] : sorted[0];
    } else if (e.key === 'Enter' || e.key === ' ') {
      // Enter/Space is a real selection: it marks the bead, says so out loud,
      // and only then tells the host something was picked.
      this.selectedId = current.id;
      this._syncFocusRing();
      this.sr.textContent = `Selected ${this._describe(current)}`;
      if (!this.readOnly && typeof this.onCommitClick === 'function') this.onCommitClick(current.id);
      return;
    } else if (e.key === 'ArrowDown') {
      const parent = nodes.find((n) => n.id === current.parents[0]);
      if (!parent) return this._sayEdge(current, 'down');
      current = parent;
    } else if (e.key === 'ArrowUp') {
      const kids = nodes.filter((n) => n.parents.includes(current.id));
      kids.sort((a, b) => Math.abs(a.col - current.col) - Math.abs(b.col - current.col) || a.gen - b.gen);
      if (!kids.length) return this._sayEdge(current, 'up');
      current = kids[0];
    } else {
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const pool = nodes.filter((n) => (n.ox - current.ox) * dir > 1);
      pool.sort(
        (a, b) =>
          Math.abs(a.ox - current.ox) - Math.abs(b.ox - current.ox) ||
          Math.abs(a.oy - current.oy) - Math.abs(b.oy - current.oy)
      );
      const col = pool.length ? pool[0].ox : null;
      const sameCol = pool.filter((n) => n.ox === col);
      sameCol.sort((a, b) => Math.abs(a.oy - current.oy) - Math.abs(b.oy - current.oy));
      if (!sameCol.length) return this._sayEdge(current, dir > 0 ? 'right' : 'left');
      current = sameCol[0];
    }

    this.focusId = current.id;
    this._syncFocusRing();
    this._ensureVisible(current);
    this.sr.textContent = this._describe(current);
  }

  // A key that silently does nothing is worse than one that navigates: at the
  // edge of the graph the arrow says where the edge is instead of swallowing
  // the press. The alternating trailing space is deliberate - a live region
  // does not re-announce text identical to what it already holds, so pressing
  // ArrowUp twice at a tip would say it once.
  _sayEdge(node, where) {
    const said = {
      up: `${node.id} is a tip, nothing newer this way`,
      down: `${node.id} is a root commit, nothing older this way`,
      left: `Nothing to the left of ${node.id}`,
      right: `Nothing to the right of ${node.id}`,
    }[where];
    this._srTick = (this._srTick || 0) + 1;
    this.sr.textContent = this._srTick % 2 ? said : `${said} `;
  }

  _syncFocusRing() {
    const active = this.root.classList.contains('is-keyboard') ? this.focusId : null;
    for (const rec of this.live.values()) {
      if (rec.kind !== 'node') continue;
      rec.el.classList.toggle('is-focused', Boolean(active) && rec.data.id === active);
      rec.el.classList.toggle('is-selected', Boolean(this.selectedId) && rec.data.id === this.selectedId);
    }
  }

  _ensureVisible(node) {
    const k = this.view.k;
    const sx = node.ox * k + this.view.x;
    const sy = node.oy * k + this.view.y;
    const m = this.geom.r * k + 24;
    let dx = 0;
    let dy = 0;
    if (sx < m) dx = m - sx;
    if (sx > this.size.w - m) dx = this.size.w - m - sx;
    if (sy < m) dy = m - sy;
    if (sy > this.size.h - m) dy = this.size.h - m - sy;
    if (!dx && !dy) return;
    this.view = { ...this.view, x: this.view.x + dx, y: this.view.y + dy };
    this._markAdjusted();
    this._applyCamera();
  }

  destroy() {
    this._destroyed = true;
    this._cancelAnim();
    this._playToken++;
    if (this._ro) this._ro.disconnect();
    for (const [target, type, fn, opt] of this._listeners || []) target.removeEventListener(type, fn, opt);
    this._listeners = [];
    this.live.clear();
    this.root.remove();
  }
}
