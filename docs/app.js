/* CFB Two-Minute Drill: game engine + UI. Data comes from data.json (see build/build.py). */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let D = null;
const app = $('#app');

// ---------- storage (per-viewer convenience only) ----------
const STORE_KEY = 'cfb2md:v1';
function loadStore() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { daily: {}, practice: {} }; } catch { return { daily: {}, practice: {} }; } }
function saveStore() { try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* storage unavailable */ } }
const store = loadStore();

// ---------- rng ----------
let seed = Date.now() >>> 0;
function rand() { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }

// ---------- models ----------
const sig = z => 1 / (1 + Math.exp(-z));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function wpModel(s, T, ytg, down, dist, toO, toD, elo) {
  if (T <= 0) return s > 0 ? 1 : s < 0 ? 0 : clamp(0.5 + elo / 4000, 0.3, 0.7);
  const q = clamp(T / 720, 0, 1), v = (100 - ytg) / 100, e = Math.exp(-T / 30);
  const f = [1, v, v * v, q, v * q, Math.sqrt(q), down >= 3 ? 1 : 0, Math.log1p(Math.min(dist, 30)) / 3, toO / 3, toD / 3,
    clamp(elo, -800, 800) / 400, down === 4 ? 1 : 0, clamp(Math.abs(s), 0, 24) / 8, e, e * v, e * v * v];
  const cats = D.wp.cats; let c = 0;
  for (let i = 0; i < cats.length; i++) if (s >= cats[i][0] && s <= cats[i][1]) { c = i; break; }
  let z = 0; const w = D.wp.w, o = c * f.length;
  for (let i = 0; i < f.length; i++) z += w[o + i] * f[i];
  return sig(z);
}
// win chance for "us" when the other team gets the ball
const oppBall = (st, s, T, oppYtg) => 1 - wpModel(-s, T, clamp(oppYtg, 1, 99), 1, Math.min(10, oppYtg), st.dto, st.to, -st.elo);
const fgProb = (ytg, kick = 0) => { const d = ytg + 17; return d > 67 ? 0 : clamp(sig(D.fg[0] + D.fg[1] * d) + kick, 0.02, 0.99); };
let XP = 0.94, TWO = 0.45, ONSIDE = 0.10; // replaced by the measured rates once data loads
const R = (k, d) => (D && D.rates && D.rates[k] != null && !Number.isNaN(D.rates[k])) ? D.rates[k] : d;

// Pre-snap defensive look. Sampled per snap from the situation; it tilts every option, and the animation aligns to it.
const LOOKS = {
  base:    { label: 'Base', sub: 'Balanced, 6 in the box' },
  loaded:  { label: 'Loaded box', sub: '7 or more near the line' },
  light:   { label: 'Light box', sub: 'Two-minute defense, extra DBs' },
  blitz:   { label: 'Showing blitz', sub: 'Linebackers creeping to the line' },
  prevent: { label: 'Prevent', sub: 'Safeties way back, corners off' },
};
// which side the extra defender is on (loaded box: the safety down; blitz: the creeping backer). L = top of the field.
function lookSub(st) {
  const k = st.look || 'base', sideWord = st.lookSide === 'L' ? 'left' : 'right';
  if (k === 'loaded') return `7 or more near the line, safety down on the ${sideWord}`;
  if (k === 'blitz') return `Linebacker creeping on the ${sideWord}`;
  return LOOKS[k].sub;
}
function sampleLook(st, pers = '11') {
  const w = { base: 1, loaded: .35, light: .5, blitz: .35, prevent: .15 };
  const box = persOf(pers).box; // the defense matches personnel: tight ends bring a loaded box, four wide brings extra DBs
  if (box > 0) { w.loaded += box; w.light = Math.max(0, w.light - box * .3); } else if (box < 0) { w.light += -box; w.loaded = Math.max(0, w.loaded + box * .5); w.prevent += .1; }
  if (st.dist <= 2) { w.loaded += 1.2; w.light -= .3; }
  if (st.ytg <= 10) { w.loaded += .6; w.prevent = 0; }
  if (st.down >= 3 && st.dist >= 7) { w.blitz += .7; w.prevent += .3; }
  if (st.T <= 40 && st.ytg >= 35) { w.prevent += 1.2; w.loaded = 0; }
  if (st.T <= 90) w.light += .3;
  const keys = Object.keys(w), tot = keys.reduce((a, k) => a + Math.max(0, w[k]), 0);
  let u = rand() * tot;
  for (const k of keys) { u -= Math.max(0, w[k]); if (u <= 0) return k; }
  return 'base';
}

// ---------- calls ----------
const CALLS = {
  run:    { grp: 'Run', label: 'Run', sub: 'Pick the concept and the side, or tap the hole on the field', dur: 5, pick: true },
  // run concepts: pool is the set of real snaps the result is drawn from (inside vs outside); lane is where the back aims
  r_in:     { label: 'Inside zone', sub: 'One cut, between the tackles', dur: 5, run: true, pool: 'r_in', lane: 'in', say: 'up the middle' },
  r_power:  { label: 'Power', sub: 'Off tackle behind a pulling guard', dur: 5, run: true, pool: 'r_in', lane: 'tackle', say: 'off tackle' },
  r_counter:{ label: 'Counter', sub: 'Fake one way, hit the other', dur: 6, run: true, pool: 'r_in', lane: 'tackle', counter: true, say: 'on the counter' },
  r_out:    { label: 'Outside zone', sub: 'Stretch it to the edge', dur: 6, run: true, pool: 'r_out', lane: 'out', say: 'to the outside' },
  r_toss:   { label: 'Toss', sub: 'Pitch it and get to the corner', dur: 6, run: true, pool: 'r_out', lane: 'out', toss: true, say: 'on the toss' },
  r_draw:   { label: 'Draw', sub: 'Pass set, late handoff', dur: 6, run: true, pool: 'r_in', lane: 'in', draw: true, say: 'on the draw' },
  r_qb:     { label: 'QB keeper', sub: 'Designed quarterback run', dur: 5, run: true, pool: 'r_qb', lane: 'tackle', qb: true, say: 'on a keeper' },
  r_sneak:  { grp: 'Run', label: 'QB sneak', sub: 'Short-yardage push', dur: 3, run: true, pool: 'r_sneak', lane: 'in', qb: true, say: 'on a sneak' },
  pass:   { grp: 'Pass', label: 'Pass', sub: 'Pick a route for each receiver, then throw', dur: 5, pick: true },
  p_short_side: { label: 'Out', dur: 5, depth: 'short', side: 'side' },
  p_short_mid:  { label: 'Slant', dur: 5, depth: 'short', side: 'mid' },
  p_deep_side:  { label: 'Go', dur: 7, depth: 'deep', side: 'side' },
  p_deep_mid:   { label: 'Post', dur: 7, depth: 'deep', side: 'mid' },
  p_rb:   { label: 'Screen', sub: 'To the back, blockers in front', dur: 5 },
  hail:   { label: 'Hail Mary', sub: 'Everyone to the end zone', dur: 9 },
  // trick plays: the whole bag, every down. Each rides a real-snap pool (base) with its own tilt vs the look, its own
  // sack/pick/fumble risk, and a chance of getting blown up in the backfield. Long-developing plays take longer off the clock.
  trick:  { grp: 'Trick', label: 'Trick play', sub: 'Flea flicker, reverse, Philly Special, fake kicks and the rest', dur: 6, pick: true },
  t_flea:   { label: 'Flea flicker', sub: 'Handoff, pitch back, go deep', dur: 8, trick: true, base: 'p_deep_side', tilt: { loaded: .04, blitz: .02, base: .01, light: -.03, prevent: -.06 }, sack: 1.7, int: 1.1, blow: .08 },
  t_hbpass: { label: 'Halfback pass', sub: 'Toss, then the back throws deep', dur: 7, trick: true, base: 'p_deep_side', tilt: { loaded: .03, blitz: .01, base: 0, light: -.02, prevent: -.05 }, sack: .8, int: 1.6, blow: .10, passer: 'rb' },
  t_reverse:{ label: 'Reverse', sub: 'Hand off one way, receiver takes it the other', dur: 7, trick: true, base: 'r_out', tilt: { blitz: .03, loaded: .02, base: 0, light: -.04, prevent: -.02 }, fum: 2.0, blow: .14 },
  t_jet:    { label: 'Jet sweep', sub: 'Receiver in motion takes the handoff', dur: 5, trick: true, base: 'r_out', tilt: { blitz: .01, loaded: .01, base: .005, light: -.01, prevent: .01 }, fum: 1.3, blow: .06, carrier: 'wr' },
  t_wildcat:{ label: 'Wildcat', sub: 'Direct snap to the back, QB split wide', dur: 5, trick: true, base: 'r_in', tilt: { light: .015, prevent: .02, base: 0, blitz: -.01, loaded: -.02 }, fum: 1.2, blow: .05, qbSplit: true },
  t_statue: { label: 'Statue of Liberty', sub: 'Fake the throw, hand it off behind the back', dur: 6, trick: true, base: 'r_out', tilt: { blitz: .04, light: .02, base: .005, loaded: -.02, prevent: 0 }, fum: 1.5, blow: .08 },
  t_hook:   { label: 'Hook and ladder', sub: 'Short catch, lateral to the trailing back', dur: 6, trick: true, base: 'p_short_side', tilt: { prevent: .03, light: .01, base: 0, loaded: 0, blitz: -.01 }, sack: 1.0, int: 1.0, lateral: true },
  t_philly: { label: 'Philly Special', sub: 'Direct snap, pitch, the tight end throws to the QB', dur: 6, trick: true, base: 'p_short_mid', tilt: { loaded: .035, blitz: .02, base: .01, light: -.01, prevent: -.02 }, sack: .6, int: 1.3, blow: .09, qbTarget: true, passer: 'te' },
  t_fakefg: { label: 'Fake field goal', sub: 'Holder keeps it and runs the edge', dur: 6, trick: true, base: 'r_out', tilt: { loaded: .02, base: .03, light: .03, blitz: .02, prevent: .04 }, fum: 1.5, blow: .12, qb: true, needsFg: true },
  t_fakepunt:{ label: 'Fake punt', sub: 'Punter runs it up the middle', dur: 6, trick: true, base: 'r_in', tilt: { base: .03, light: .04, prevent: .05, loaded: 0, blitz: .01 }, fum: 1.2, blow: .10, qb: true, needsPunt: true },
  spike:  { grp: 'Clock & kicks', label: 'Spike it', sub: 'Stop the clock, lose a down', dur: 1 },
  kneel:  { grp: 'Clock & kicks', label: 'Kneel', sub: 'Run the clock', dur: 2 },
  fg:     { grp: 'Clock & kicks', label: 'Field goal', sub: '', dur: 5 },
  punt:   { grp: 'Clock & kicks', label: 'Punt', sub: 'Flip the field', dur: 7 },
};
// Routes a receiver can run. Each maps to a pool of real snaps (depth x side); dur is the extra time a longer route takes.
// The full route tree. Every receiver can run any of them. p(sd, mid) draws the route on the field (offense moves +x;
// sd is the receiver's sideline direction, mid is toward the middle). grp groups the picker; id is the pool of real snaps.
const ROUTES = {
  flat:     { label: 'Flat', grp: 'Short', id: 'p_rb', dur: 0, say: 'in the flat', p: (sd, m) => `l 15 ${sd * 85} l 60 0` },
  swing:    { label: 'Swing', grp: 'Short', id: 'p_rb', dur: 0, say: 'on a swing pass', p: (sd, m) => `q 10 ${sd * 60} 60 ${sd * 80} l 40 0` },
  screen:   { label: 'Screen', grp: 'Short', id: 'p_rb', dur: 0, say: 'on a screen', p: (sd, m) => `l -25 ${sd * 30} l 45 0` },
  hitch:    { label: 'Hitch', grp: 'Short', id: 'p_short_side', dur: 0, say: 'on a hitch', p: (sd, m) => `l 60 0 l -15 ${sd * 12}` },
  out:      { label: 'Out', grp: 'Short', id: 'p_short_side', dur: 0, say: 'on an out', p: (sd, m) => `l 70 0 l 0 ${sd * 70}` },
  slant:    { label: 'Slant', grp: 'Short', id: 'p_short_mid', dur: 0, say: 'on a slant', p: (sd, m) => `l 30 0 l 90 ${m * 70}` },
  drag:     { label: 'Drag', grp: 'Short', id: 'p_short_mid', dur: 0, say: 'on a shallow drag', p: (sd, m) => `l 35 0 l 10 ${m * 120}` },
  angle:    { label: 'Angle', grp: 'Short', id: 'p_rb', dur: 0, say: 'on an angle route', p: (sd, m) => `l 40 ${sd * 60} l 80 ${-sd * 90}` },
  curl:     { label: 'Curl', grp: 'Intermediate', id: 'p_short_side', dur: 1, say: 'on a curl', p: (sd, m) => `l 95 0 l -18 ${m * 14}` },
  dig:      { label: 'Dig', grp: 'Intermediate', id: 'p_short_mid', dur: 1, say: 'on a dig', p: (sd, m) => `l 110 0 l 0 ${m * 90}` },
  comeback: { label: 'Comeback', grp: 'Intermediate', id: 'p_short_side', dur: 1, say: 'on a comeback', p: (sd, m) => `l 130 0 l -25 ${sd * 35}` },
  cross:    { label: 'Deep cross', grp: 'Intermediate', id: 'p_short_mid', dur: 2, say: 'on a deep crosser', p: (sd, m) => `l 90 0 l 120 ${m * 130}` },
  go:       { label: 'Go', grp: 'Deep', id: 'p_deep_side', dur: 2, say: 'on a go route', p: (sd, m) => `l 320 0` },
  fade:     { label: 'Fade', grp: 'Deep', id: 'p_deep_side', dur: 2, say: 'on a fade', p: (sd, m) => `q 150 ${sd * 15} 300 ${sd * 45}` },
  corner:   { label: 'Corner', grp: 'Deep', id: 'p_deep_side', dur: 2, say: 'on a corner route', p: (sd, m) => `l 130 0 l 130 ${sd * 90}` },
  wheel:    { label: 'Wheel', grp: 'Deep', id: 'p_deep_side', dur: 2, say: 'on a wheel route', p: (sd, m) => `l 25 ${sd * 75} l 240 0` },
  post:     { label: 'Post', grp: 'Deep', id: 'p_deep_mid', dur: 2, say: 'on a post', p: (sd, m) => `l 130 0 l 150 ${m * 110}` },
  seam:     { label: 'Seam', grp: 'Deep', id: 'p_deep_mid', dur: 2, say: 'up the seam', p: (sd, m) => `l 280 0` },
  postcorner: { label: 'Post-corner', grp: 'Deep', id: 'p_deep_side', dur: 3, say: 'on a post-corner', p: (sd, m) => `l 110 0 l 60 ${m * 50} l 110 ${sd * 110}` },
  block:    { label: 'Stay in & block', grp: 'Protect', id: null, dur: 0, say: '', p: (sd, m) => `l 12 0 m -4 -8 l 0 16` },
};
const ROUTE_GROUPS = ['Short', 'Intermediate', 'Deep', 'Protect'];
// Field-tap quick cycle: the common handful per position. The chip opens the full tree.
const ROUTE_CYCLE = { WR: ['out', 'slant', 'curl', 'dig', 'go', 'corner', 'post'], TE: ['out', 'slant', 'dig', 'seam', 'corner', 'block'], RB: ['flat', 'swing', 'angle', 'wheel', 'block'] };
const DEFAULT_ROUTES = { WR0: 'go', WR1: 'out', WR2: 'slant', WR3: 'curl', TE: 'dig', TE2: 'out', TE3: 'block', RB: 'flat', RB2: 'block' };
// One-tap concepts: set every receiver at once
const CONCEPTS = {
  'Four verts': { WR0: 'go', WR1: 'go', WR2: 'seam', WR3: 'seam', TE: 'seam', TE2: 'seam', TE3: 'block', RB: 'block', RB2: 'block' },
  'Mesh':       { WR0: 'drag', WR1: 'corner', WR2: 'drag', WR3: 'corner', TE: 'dig', TE2: 'drag', TE3: 'block', RB: 'swing', RB2: 'flat' },
  'Smash':      { WR0: 'hitch', WR1: 'hitch', WR2: 'corner', WR3: 'corner', TE: 'corner', TE2: 'hitch', TE3: 'block', RB: 'flat', RB2: 'block' },
  'Flood':      { WR0: 'go', WR1: 'post', WR2: 'out', WR3: 'corner', TE: 'corner', TE2: 'out', TE3: 'block', RB: 'flat', RB2: 'flat' },
  'Spacing':    { WR0: 'curl', WR1: 'curl', WR2: 'hitch', WR3: 'hitch', TE: 'hitch', TE2: 'curl', TE3: 'block', RB: 'flat', RB2: 'flat' },
  'Max protect':{ WR0: 'post', WR1: 'comeback', WR2: 'dig', WR3: 'go', TE: 'block', TE2: 'block', TE3: 'block', RB: 'block', RB2: 'block' },
};
// Personnel groupings: first digit backs, second tight ends, the rest receivers. Heavier groups block better and
// pull the defense in; lighter groups spread it out and find more targets. Subbing lets the defense sub too.
const PERSONNEL = {
  '10': { rb: 1, te: 0, wr: 4, label: '10', sub: '1 RB · 0 TE · 4 WR', run: -.03, pass: .015, box: -.35 },
  '11': { rb: 1, te: 1, wr: 3, label: '11', sub: '1 RB · 1 TE · 3 WR', run: 0, pass: 0, box: 0 },
  '12': { rb: 1, te: 2, wr: 2, label: '12', sub: '1 RB · 2 TE · 2 WR', run: .015, pass: -.01, box: .5 },
  '13': { rb: 1, te: 3, wr: 1, label: '13', sub: '1 RB · 3 TE · 1 WR', run: .03, pass: -.025, box: 1.1 },
  '21': { rb: 2, te: 1, wr: 2, label: '21', sub: '2 RB · 1 TE · 2 WR', run: .02, pass: -.01, box: .5, lead: true },
  '22': { rb: 2, te: 2, wr: 1, label: '22', sub: '2 RB · 2 TE · 1 WR', run: .035, pass: -.025, box: 1.1, lead: true },
};
const persOf = p => PERSONNEL[p] || PERSONNEL['11'];
// does the roster have the bodies for this grouping?
function persAvailable(sc, p) { const g = persOf(p), L = sc.lineup.rec; const n = pos => L.filter(r => r.pos === pos).length; return n('WR') >= g.wr && n('TE') >= g.te && n('RB') >= g.rb; }
function routeOk(st, key) { const r = ROUTES[key]; if (!r.id) return false; return r.id === 'p_deep_side' ? st.ytg > 20 : r.id === 'p_deep_mid' ? st.ytg > 25 : true; }
// extra blockers: only players on the field for this personnel grouping count (the off-field slots keep a default route)
function blockers() { return receivers(G.sc).filter(r => routeFor(r) === 'block').length; }
// a pass by any name: the pass concepts, the Hail Mary, and the trick plays that end in a throw
const isPassId = id => id.startsWith('p_') || id === 'hail' || !!(CALLS[id] && CALLS[id].trick && CALLS[id].base.startsWith('p_'));
function available(st, id) {
  const c = CALLS[id];
  if (st.twoPt && ['fg', 'punt', 'spike', 'kneel', 'hail', 't_fakefg', 't_fakepunt'].includes(id)) return false; // a two-point try is one snap from the 3
  if (c && c.trick) {
    if (c.needsFg) return st.ytg + 17 <= 65;
    if (c.needsPunt) return st.down === 4 && st.ytg > 40;
    return true;
  }
  switch (id) {
    case 'r_sneak': return st.dist <= 2;
    case 'r_draw': return st.down < 4 || st.dist <= 5;
    case 'p_deep_side': return st.ytg > 20;
    case 'p_deep_mid': return st.ytg > 25;
    case 'hail': return st.ytg >= 35 && st.ytg <= 65;
    case 'spike': return st.down < 4;
    case 'kneel': return st.s >= 0;
    case 'fg': return st.ytg + 17 <= 65;
    case 'punt': return st.down === 4 && st.ytg > 40;
    default: return true;
  }
}
const zoneOf = y => y <= 10 ? 'g' : y <= 20 ? 'r' : y <= 50 ? 'o' : 'w';

// pools: [yards, flags, epa, gameRef, text]; flags 1 complete, 2 td, 4 oob, 8 turnover, 16 sack, 32 def td
const poolVar = {};
function pool(key, ...fallbacks) {
  for (const k of [key, ...fallbacks]) { const p = D.pools[k]; if (p && p.length >= 15) return [k, p]; }
  return [key, D.pools[key] || []];
}
function tilted(key, rows, adv) {
  if (!(key in poolVar)) { const m = rows.reduce((a, r) => a + r[2], 0) / rows.length; poolVar[key] = rows.reduce((a, r) => a + (r[2] - m) ** 2, 0) / rows.length || 1; }
  const lam = clamp(adv / poolVar[key], -0.8, 0.8);
  const w = rows.map(r => Math.exp(lam * clamp(r[2], -6, 6)));
  const t = w.reduce((a, b) => a + b, 0);
  return w.map(x => x / t);
}

// Distribution of outcomes for a call: [{p, y, f, src}]
function outcomes(st, id, tgt, mods = {}) {
  const S = st.sc, L = S.lineup, z = zoneOf(st.ytg), dg = st.down >= 3 ? 'L' : 'E', sy = st.dist <= 2 ? 'S' : 'N';
  const out = [];
  const tc = CALLS[id];
  if (tc && tc.trick) { // a trick play is its base play with the trick's risks layered on top
    const look0 = st.look || 'base';
    const base = tc.base.startsWith('p_deep') && st.ytg <= 20 ? 'p_short_side' : tc.base; // near the goal line the deep tricks throw short
    const isP = base.startsWith('p_');
    const inner = outcomes(st, base, isP ? (tgt || trickTarget(S, tc)) : null, { ...mods, trick: tc, trickAdv: (tc.tilt[look0] || 0) });
    const blow = tc.blow || 0;
    let rows = inner.map(o => ({ ...o, p: o.p * (1 - blow) }));
    // blown up: the defense doesn't bite and the ball carrier is met in the backfield; sometimes the ball comes out
    if (blow) rows.push({ p: blow * .4, y: -3, f: 0, src: null, blown: true }, { p: blow * .3, y: -6, f: 0, src: null, blown: true }, { p: blow * .15, y: -9, f: 0, src: null, blown: true }, { p: blow * .15, y: -4, f: 8, src: null, fumble: true, blown: true });
    if (tc.lateral) { // the lateral: half the catches pick up extra yards, and once in a while it hits the ground
      const out2 = [];
      for (const o of rows) {
        if ((o.f & 1) && !(o.f & 8) && !o.blown) out2.push({ ...o, p: o.p * .465, lateral: true }, { ...o, p: o.p * .465, y: o.y + 7, f: o.f & ~4, lateral: true }, { p: o.p * .07, y: -4, f: 8, src: o.src, fumble: true, lateralLost: true });
        else out2.push(o);
      }
      rows = out2;
    }
    return rows;
  }
  const addPool = (key, rows, adv, mass) => { const w = tilted(key, rows, adv); rows.forEach((r, i) => out.push({ p: mass * w[i], y: r[0], f: r[1], src: r })); };
  const lgSack = D.rates.sack, lgInt = D.rates.int;
  // the defensive look tilts the play: a loaded box eats runs and opens the pass, a blitz brings sacks and big plays, prevent gives up the short stuff
  const look = st.look || 'base';
  const LK = { base: { run: 0, short: 0, deep: 0, sack: 1, int: 1 }, loaded: { run: -.045, short: .02, deep: .03, sack: .9, int: 1 },
    light: { run: .04, short: -.01, deep: -.01, sack: 1, int: 1 }, blitz: { run: .015, short: .015, deep: .05, sack: 1.5, int: 1.1 },
    prevent: { run: .035, short: .035, deep: -.055, sack: .7, int: .85 } }[look];
  const c0 = CALLS[id];
  if (c0 && c0.run) {
    // concept vs look: counters and draws punish aggression, tosses need the edge, and running away from the
    // safety or the blitz is worth something
    const CONCEPT = { r_counter: { blitz: .03, loaded: .015, light: -.01, base: 0, prevent: 0 }, r_toss: { loaded: .01, light: -.015, blitz: -.01, base: 0, prevent: .01 },
      r_draw: { blitz: .035, light: .01, loaded: -.03, prevent: .02, base: .005 }, r_power: { light: .01, loaded: -.01, blitz: 0, base: 0, prevent: .01 } }[id];
    let sideAdv = 0;
    if (mods.side && st.lookSide && (look === 'loaded' || look === 'blitz')) sideAdv = (mods.side === st.lookSide ? -.02 : .02) + (c0.counter && mods.side !== st.lookSide ? .01 : 0);
    const PG = persOf(st.pers); // extra tight ends block; a second back leads through the hole on power, counter and toss
    const persAdv = (id === 'r_sneak' ? 0 : PG.run) + (PG.lead && (id === 'r_power' || id === 'r_counter' || id === 'r_toss') ? .01 : 0);
    const adv = S.orat.or + S.drat.dr + (c0.qb ? (L.qb.adj || 0) * .3 : (L.rb.adj || 0) * .6) + (id === 'r_sneak' ? LK.run * .4 : LK.run) + (CONCEPT ? CONCEPT[look] || 0 : 0) + sideAdv + (mods.trickAdv || 0) + persAdv;
    const fum = D.rates.fumble * (c0.toss ? 1.6 : c0.counter ? 1.2 : 1) * (mods.trick && mods.trick.fum ? mods.trick.fum : 1);
    const [k, rows] = id === 'r_sneak' ? pool('r_sneak') : c0.pool === 'r_qb' ? pool('r_qb_' + z) : pool(`${c0.pool}_${z}${sy}`, `${c0.pool}_${z}N`);
    addPool(k, rows, adv, 1 - fum);
    out.push({ p: fum, y: 1, f: 8, src: null, fumble: true });
    return out;
  }
  if (id.startsWith('p_')) {
    const c = CALLS[id];
    const rec = tgt ?? (id === 'p_rb' ? receivers(S, st.pers).find(r => r.pos === 'RB') : null);
    // play action sells the run: deep throws open up, but the QB holds it longer; a roll-out shortens the sack window and favors the sideline
    // extra blockers: fewer sacks, but fewer receivers to find; heavy personnel means fewer routes for the defense to cover
    const nb = Math.min(3, mods.blockers || 0);
    const lookAdv = c.depth === 'deep' ? LK.deep : LK.short + (id === 'p_rb' && look === 'blitz' ? .05 : 0);
    const tk = mods.trick || {};
    const adv = S.orat.op + S.drat.dp + (rec ? (rec.adj || 0) * .6 : 0) + (mods.pa ? (c.depth === 'deep' ? .04 : -.01) : 0) + (mods.roll ? (c.side === 'side' ? .015 : -.02) : 0) - .012 * nb + lookAdv + (mods.trickAdv || 0) + (tk.passer === 'rb' ? -(L.qb.adj || 0) * .6 - .02 : 0) + persOf(st.pers).pass;
    const depthF = (id === 'p_rb' ? .55 : c.depth === 'deep' ? 1.35 : .85) * (mods.pa ? 1.3 : 1) * (mods.roll ? .75 : 1) * (1 - .15 * nb) * LK.sack * (tk.sack || 1) * (persOf(st.pers).te >= 2 ? .93 : 1);
    const intF = (id === 'p_rb' ? .45 : c.depth === 'deep' ? 1.9 : c.side === 'mid' ? 1.05 : .75) * (mods.roll ? .9 : 1) * LK.int * (tk.int || 1);
    const pSack = clamp((dg === 'L' ? D.rates.sackL : lgSack) * depthF * Math.sqrt((L.qb.sack || lgSack) / lgSack) * (1 + S.drat.dp), .01, .25);
    const pInt = clamp(lgInt * intF * Math.sqrt((L.qb.int || lgInt) / lgInt) * (1 + 2 * S.drat.dp), .004, .12) * (1 - pSack);
    const [sk, srows] = pool('sack_' + z, 'sack_o');
    addPool(sk, srows, 0, pSack * 0.9);
    out.push({ p: pSack * 0.1, y: -8, f: 8 | 16, src: null, strip: true }); // strip sack, defense recovers
    // the QB pulls it down and runs: a scramble, drawn from real QB carries (not when someone else is throwing)
    const pScr = id === 'p_rb' || tk.passer ? 0 : R('scramble', .05) * (mods.roll ? 1.4 : 1) * (look === 'blitz' ? 1.3 : 1) * (1 - pSack - pInt);
    if (pScr > 0) { const [qk, qrows] = pool('r_qb_' + z, 'r_qb_o'); const w = tilted(qk, qrows, (L.qb.adj || 0) * .3); qrows.forEach((row, i) => out.push({ p: pScr * w[i], y: row[0], f: row[1] & ~1, src: row, scramble: true })); }
    const ints = D.pools.int;
    const dtd = ints.filter(r => r[1] & 32).length / ints.length;
    out.push({ p: pInt * (1 - dtd), y: 0, f: 8, src: null, int: true });
    out.push({ p: pInt * dtd, y: 0, f: 8 | 32, src: null, int: true });
    const [k, rows] = id === 'p_rb' ? pool('p_rb_' + z, 'p_rb_o') :
      pool(`p_${c.depth}_${c.side}_${z}${dg}`, `p_${c.depth}_side_${z}${dg}`, `p_${c.depth}_${c.side}_o${dg}`, `p_short_${c.side}_${z}${dg}`);
    addPool(k, rows, adv, 1 - pSack - pInt - pScr);
    return out;
  }
  if (id === 'hail') {
    const td = st.ytg <= 45 ? .09 : st.ytg <= 55 ? .06 : .03;
    return [{ p: td, y: st.ytg, f: 3, src: null }, { p: .2, y: 0, f: 8, src: null, int: true }, { p: .05, y: Math.max(1, st.ytg - 6), f: 1, src: null },
      { p: 1 - td - .25, y: 0, f: 0, src: null }];
  }
  if (id === 'spike') return [{ p: 1, y: 0, f: 0, src: null, spike: true }];
  if (id === 'kneel') return [{ p: 1, y: -1, f: 0, src: null, kneel: true }];
  if (id === 'fg') { const p = fgProb(st.ytg, S.kick); return [{ p, fg: true, made: true, y: 0, f: 0 }, { p: 1 - p, fg: true, made: false, y: 0, f: 0 }]; }
  if (id === 'punt') return [{ p: 1, punt: true, y: 0, f: 0 }];
  return [];
}

// Apply an outcome. Returns {st (new state), end (terminal info or null), first, yards, ...}
function apply(st, id, o) {
  const c = CALLS[id];
  const n = { ...st, snaps: st.snaps + 1, look: null };
  n.T = Math.max(0, st.T - c.dur);
  const r = { yards: 0, first: false, end: null, td: false, stop: false };
  if (o.flag) { // penalty: the play comes back (or never happened)
    const yds = o.pen[0];
    r.flag = o.pen; r.yards = 0;
    if (!o.pre) n.T = Math.max(0, st.T - c.dur); else n.T = st.T;
    if (yds > 0) { // on the defense
      const ny = Math.max(1, st.ytg - yds);
      const half = Math.floor(st.ytg / 2);
      n.ytg = Math.max(1, st.ytg - Math.min(yds, half > 0 ? Math.max(yds, 0) : yds));
      if (o.pen[2] || yds >= st.dist) { n.down = 1; n.dist = Math.min(10, n.ytg); r.first = true; } else { n.down = st.down; n.dist = st.dist - yds; }
    } else { // on the offense
      const back = Math.min(-yds, Math.floor((100 - st.ytg) / 2));
      n.ytg = Math.min(99, st.ytg + back);
      n.down = o.pen[3] ? st.down + 1 : st.down; n.dist = st.dist + back;
      if (n.down > 4) { r.end = { kind: 'opp', oppYtg: 100 - n.ytg, why: 'Turnover on downs' }; return { n, r }; }
    }
    n.pending = 0; r.stop = true;
    if (n.T <= 0) r.end = { kind: 'time' };
    return { n, r };
  }
  if (o.fg) {
    if (o.made) { n.os += 3; n.s += 3; r.end = { kind: 'fg' }; }
    else r.end = { kind: 'opp', oppYtg: st.ytg <= 20 ? 80 : 100 - st.ytg, why: 'Missed field goal' };
    return { n, r };
  }
  if (o.punt) {
    const land = st.ytg - 38;
    r.end = { kind: 'opp', oppYtg: land <= 0 ? 80 : 100 - land, why: 'Punt' };
    return { n, r };
  }
  if (o.spike) { n.down += 1; n.pending = 0; r.stop = true; return { n, r }; }
  if (o.f & 8) { // turnover
    if (o.f & 32) { n.ds += 7; n.s -= 7; r.end = { kind: 'opp', oppYtg: 75, why: o.int ? 'Pick six' : 'Fumble returned for a TD' }; return { n, r }; }
    if (o.int) { const spot = st.ytg - 12; r.end = { kind: 'opp', oppYtg: spot <= 0 ? 80 : clamp(100 - spot - 8, 1, 99), why: 'Interception' }; }
    else { const spot = st.ytg - (o.y || 0); r.end = { kind: 'opp', oppYtg: clamp(100 - spot, 1, 99), why: 'Fumble lost' }; }
    return { n, r };
  }
  const y = o.y;
  r.yards = y;
  const ny = st.ytg - y;
  if (ny <= 0 || (o.f & 2 && ny <= 3)) { n.os += 6; n.s += 6; n.ytg = 0; r.td = true; r.yards = st.ytg; r.end = { kind: 'td' }; return { n, r }; }
  if (ny >= 100) { n.ds += 2; n.s -= 2; r.end = { kind: 'opp', oppYtg: 60, why: 'Safety' }; return { n, r }; }
  n.ytg = ny;
  const incomplete = isPassId(id) && !o.scramble && !o.blown ? !(o.f & 1) && !(o.f & 16) : false;
  const oob = !!(o.f & 4);
  if (y >= st.dist) { r.first = true; n.down = 1; n.dist = Math.min(10, ny); }
  else { n.down = st.down + 1; n.dist = st.dist - y; }
  // clock between snaps, from how long these plays really took late in real games (time to the next snap, minus the play)
  const after = k => Math.max(0, Math.round(R(k, 18) - c.dur));
  if (o.kneel) { n.pending = 40; }
  else if (incomplete) { n.pending = 0; r.stop = true; }
  else if (oob) { n.pending = n.T <= 120 ? 0 : after('el_oob'); r.stop = true; }
  else if (r.first) { n.pending = n.T <= 120 ? Math.min(8, after('el_first')) : after('el_first'); }
  else if (o.f & 16) n.pending = after('el_sack');
  else if ((isPassId(id) && !o.blown) || o.scramble) n.pending = after('el_comp_in');
  else n.pending = after('el_rush');
  r.incomplete = incomplete; r.oob = oob;
  if (n.down > 4) { r.end = { kind: 'opp', oppYtg: 100 - ny, why: 'Turnover on downs' }; return { n, r }; }
  if (n.T <= 0) r.end = { kind: 'time' };
  return { n, r };
}

// Win chance after the drive ends. For scores, assumes the best PAT and kickoff choice.
function endValue(n, end) {
  if (end.kind === 'opp') return oppBall(n, n.s, n.T, end.oppYtg);
  if (end.kind === 'time') return wpModel(n.s, 0, 50, 1, 10, 0, 0, n.elo);
  const afterPAT = s => afterScore(n, s).best;
  if (end.kind === 'td') return Math.max(XP * afterPAT(n.s + 1) + (1 - XP) * afterPAT(n.s), TWO * afterPAT(n.s + 2) + (1 - TWO) * afterPAT(n.s));
  return afterPAT(n.s);
}
function afterScore(n, s) {
  const T = n.T;
  if (T <= 0) { const v = wpModel(s, 0, 50, 1, 10, 0, 0, n.elo); return { deep: v, onside: v, best: v }; }
  const deep = oppBall(n, s, T, 75);
  const onside = ONSIDE * wpModel(s, Math.max(0, T - 4), 55, 1, 10, n.to, n.dto, n.elo) + (1 - ONSIDE) * oppBall(n, s, Math.max(0, T - 4), 45);
  return { deep, onside, best: Math.max(deep, onside) };
}
// Win chance of a mid-drive state, accounting for clock that will run before the snap
function contValue(n) {
  const run = n.pending || 0;
  const T = n.to > 0 && run > 0 ? n.T - Math.min(run, 3) : n.T - run;
  if (T <= 0) return wpModel(n.s, 0, n.ytg, n.down, n.dist, n.to, n.dto, n.elo);
  return wpModel(n.s, T, n.ytg, n.down, n.dist, n.to, n.dto, n.elo);
}
function expected(st, id, tgt, mods = {}) {
  let ev = 0;
  for (const o of outcomes(st, id, tgt, mods)) {
    if (o.p <= 0) continue;
    const { n, r } = apply(st, id, o);
    ev += o.p * (r.end ? endValue(n, r.end) : contValue(n));
  }
  return ev;
}
// All options at a state, each pass concept evaluated with its best target
function scoreOptions(st) {
  const R = receivers(st.sc, st.pers), rows = [];
  for (const id of Object.keys(CALLS)) {
    if (!available(st, id) || CALLS[id].pick) continue;
    const c = CALLS[id];
    if (c.depth) {
      for (const rc of R.filter(r => r.pos !== 'RB')) rows.push({ id, tgt: rc, ev: expected(st, id, rc), label: `${c.label} to ${short(rc.name)}` });
    } else if (id === 'p_rb') {
      const rb = R.find(r => r.pos === 'RB'); if (rb) rows.push({ id, tgt: rb, ev: expected(st, id, rb), label: `Screen to ${short(rb.name)}` });
    } else rows.push({ id, ev: expected(st, id), label: c.label });
  }
  return rows.sort((a, b) => b.ev - a.ev);
}

// ---------- color commentary ----------
// Dry, literal, occasionally too specific. Shows up on about a third of snaps and never twice in a row.
const QUIPS = {
  sack: ['The offensive line would like to be excluded from this narrative.', 'He held it for 3.1 seconds. The ball has thoughts about that.', 'A sack. The pocket became a suggestion.', 'Everyone in the stadium saw that coming except the five people paid to.'],
  strip: ['The ball left. It did not say goodbye.', 'Strip sack. That is two bad things, stapled together.'],
  int: ["That's their ball now. Legally.", 'The defensive back read it like it had subtitles.', 'Intercepted. He threw it to the one guy wearing the other shirt.'],
  pick6: ['He ran it back and the band started playing without being asked.', 'A pick six. The scoreboard operator needed a moment.'],
  fumble: ['The ball is on the ground, which is the one place it is not supposed to be.', 'Fumble. Eleven people are now very interested in one object.'],
  tfl: ['He ran that one straight into a meeting.', 'Tackle for loss. The hole closed like a shop at 5:01.', 'Negative yards. Technically still yards.'],
  inc: ["That one's still in the air somewhere over the student section.", 'Incomplete. The clock stops for this, per rule 3-3-2, roughly.', 'Ball meets turf. Clock meets pause. Fans meet television.', 'He threw it to a spot. The spot was open. The receiver was not.'],
  drop: ['It hit both hands. Both of them.', 'Dropped. The receiver would like to report the ball was slippery. It was not.'],
  pbu: ['Broken up. The corner got there first and is telling everyone about it.', 'Pass defended. The receiver and the corner have a shared memory now.'],
  thrownaway: ['Thrown away, deliberately, which counts as a decision.', 'He threw it to the sideline. The sideline was open.'],
  bigpass: ['Somebody check whether that corner is still enrolled.', 'Twenty-plus yards. The safety saw it. He just saw it late.', 'A big one. The press box went quiet, then loud, then quiet.'],
  bigrun: ['He hit the hole like it owed him money.', 'Chunk play on the ground. The linebackers are now behind him, which is the wrong side.', 'Big run. Somebody in the box is being told about it right now.'],
  td: ['Touchdown. Six points, same as it has been since 1912.', 'Touchdown. The extra point is a formality, which is what everyone says right before it is not.', 'He scored. The scoreboard has been updated. So has the mood.'],
  fgGood: ['Kicker does kicker things.', 'Three points. He will be left alone now, as kickers prefer.', 'Good. The holder also did his job, which no one will mention.'],
  fgMiss: ['No good. It went wide, which is the main way they go.', 'Missed. The kicker is walking off in the specific way kickers walk off.'],
  flagOff: ['A flag. A yellow one. The worst color.', 'Penalty on the offense. Someone moved before the ball did, which is the one rule.', 'Five yards the wrong way. The drive is now longer, like a meeting.'],
  flagDef: ['Flag on the defense. Free yards, the best kind.', 'Penalty, defense. The referee explained it to 90,000 people who already knew.', 'The defense gave you yards. Rude of them, in a helpful way.'],
  spike: ['Spike. Ball meets ground. Clock stops. Civilization continues.', 'He spiked it. The ball is fine.'],
  kneel: ['He took a knee. The clock is losing its mind.'],
  timeout: ['Timeout. Everyone in the stadium is doing math.', 'Timeout called. The coach is holding a laminated sheet very close to his face.'],
  milk: ['Milking it. The play clock has never felt so seen.', 'Letting it run. Seconds are leaving. That was the plan.'],
  hustle: ['No huddle. No time. No regrets.', 'Hurry-up. The center is sprinting, which the center did not sign up for.'],
  hailMiss: ['Everyone was in the end zone. The ball was not.', 'The Hail Mary was not answered. They rarely are, hence the name.'],
  hailHit: ['He caught it. Nobody is sure how. Replay will not help.', 'Hail Mary, answered. Somebody is going to be on a poster.'],
  scramble: ['He ran. Nobody told him to. It worked.', 'Scramble. The play broke down and he fixed it with his legs.'],
  first: ['First down. The chains moved, which is their whole job.', 'Fresh set of downs. The sticks are being carried by two people who never get thanked.'],
  oob: ['Out of bounds. The clock stops, the sideline reporter steps back.', 'He got out. The clock is paused. Someone exhales.'],
  nogain: ['No gain. The ball is exactly where it was, which is at least consistent.', 'Zero yards. A play happened and nothing did.'],
  short: ['A few yards. Honest work.', 'Short gain. The box score will remember this as a number.'],
  trickHit: ['A trick play. It worked, which is the only kind anyone remembers.', 'Drawn up in the dirt, apparently by an architect.', 'The defense is still looking for the ball. It is downfield.'],
  trickBlown: ['The defense had seen that one. Possibly on television.', 'Blown up. Eight seconds to develop, one to end.', 'The trick did not work, and now everyone has to pretend it was a good idea at the time.'],
  trickMeh: ['A trick play for a normal gain. All that choreography for a modest number.', 'Trickery, modestly rewarded.', 'It worked, technically. The crowd is not sure what it saw.'],
  twoGood: ['Two points. Somebody in the booth has a chart and it is vindicated.', 'Converted. The chart was right, which the chart will mention.'],
  twoFail: ['No good. The chart is being quietly folded.', 'Stopped. Two points were available and are no longer.'],
};
function pickQuip(key) { const a = QUIPS[key]; return a ? a[Math.floor(rand() * a.length)] : null; }
function maybeQuip(o, r, id, mods, st) {
  if (G.lastQuipSnap === st.snaps - 1 && st.snaps > 0) return null; // never back to back
  const prob = (o.flag || o.int || o.strip || r.td || o.fumble || (o.f & 16)) ? 0.6 : 0.3;
  if (rand() > prob) return null;
  let key = null;
  if (o.flag) key = o.pen[0] > 0 ? 'flagDef' : 'flagOff';
  else if (o.fg) key = o.made ? 'fgGood' : 'fgMiss';
  else if (o.spike) key = 'spike';
  else if (o.kneel) key = 'kneel';
  else if (o.strip) key = 'strip';
  else if (o.int) key = (o.f & 32) ? 'pick6' : 'int';
  else if (o.fumble) key = 'fumble';
  else if (o.f & 16) key = 'sack';
  else if (o.scramble) key = 'scramble';
  else if (st.twoPt) key = r.td ? 'twoGood' : 'twoFail';
  else if (CALLS[id].trick) key = o.blown ? 'trickBlown' : (r.td || r.yards >= 15) ? 'trickHit' : r.incomplete ? 'inc' : 'trickMeh';
  else if (id === 'hail') key = (o.f & 1) ? 'hailHit' : 'hailMiss';
  else if (r.td) key = 'td';
  else if (r.incomplete) { const t = (o.src && o.src[4] || '').toLowerCase(); key = t.includes('drop') ? 'drop' : t.includes('broken up') ? 'pbu' : (t.includes('hurried') || t.includes('pressure')) && rand() < 0.5 ? 'thrownaway' : 'inc'; }
  else if ((id.startsWith('p_')) && r.yards >= 20) key = 'bigpass';
  else if (id.startsWith('r_') && r.yards >= 12) key = 'bigrun';
  else if (id.startsWith('r_') && r.yards <= -2) key = 'tfl';
  else if (r.oob) key = 'oob';
  else if (r.first) key = 'first';
  else if (r.yards === 0) key = 'nogain';
  else key = 'short';
  const q = pickQuip(key);
  if (q) G.lastQuipSnap = st.snaps;
  return q;
}
const VERDICTS = {
  win: ['You beat {c}. On a couch. He was on a sideline with 90,000 people screaming.', 'You beat {c}, with a replay button and no headset.', 'You beat {c}. He could not see this screen. He also could not pause.'],
  even: ['{c} tied you with a worse view and no second chances.', 'Dead even with {c}. He did his live.', 'A tie with {c}, who was not allowed to think for 40 seconds between snaps.'],
  loss: ['{c} wins. He did it once, live, no do-overs.', '{c} wins this one. He does this for a living, which is not an excuse for you.', '{c} had the better drive. You had the better chair.'],
};
const PCT_LINES = [
  [90, 'Top of the room. The simulated play-callers are made of math and you still beat them.'],
  [70, 'Better than most of the room, which was full of spreadsheets with opinions.'],
  [50, 'Middle of the pack. Respectable. Nobody writes a column about the middle.'],
  [25, 'Below the middle. Some of the simulated callers were set to "guess".'],
  [0, 'The simulated play-callers send their regards. They are not real, and they know it.'],
];

// ---------- defenders ----------
// Who makes the play on defense, drawn from the real tackle/PBU/sack/interception counts in the play-by-play.
function pickDefender(sc, kind) {
  const d = sc.dlineup || []; if (!d.length) return null;
  const w = d.map(x => kind === 'sack' ? (x.sk * 3 + (x.role === 'DL' ? 1 : 0)) : kind === 'int' ? (x.int * 3 + x.pbu + (x.role === 'DB' ? 1 : 0)) : kind === 'pbu' ? (x.pbu * 3 + x.int + (x.role === 'DB' ? 1 : 0)) : kind === 'pass' ? (x.tk * (x.role === 'DB' ? 1.4 : x.role === 'LB' ? 1 : .3)) : (x.tk * (x.role === 'DL' ? 1.2 : x.role === 'LB' ? 1.3 : .6)));
  const tot = w.reduce((a, b) => a + b, 0); if (tot <= 0) return null;
  let u = rand() * tot; for (let i = 0; i < d.length; i++) { u -= w[i]; if (u <= 0) return d[i]; }
  return d[d.length - 1];
}
const defName = x => x ? `#${x.num} ${x.name.replace(/^([A-Z])\.\s?(?=[A-Z])/, '$1. ')}` : '';
// Defensive slots for the field (4 DL, 2 LB, nickel, 2 CB, 2 S) filled by role from the real roster
function defenseSlots(sc) {
  const d = (sc.dlineup || []).slice(); const take = role => { const i = d.findIndex(x => x.role === role); return i >= 0 ? d.splice(i, 1)[0] : null; };
  const any = () => d.length ? d.shift() : null;
  const dl = [take('DL'), take('DL'), take('DL'), take('DL')].map(x => x || take('LB') || any());
  const lb = [take('LB'), take('LB')].map(x => x || any());
  const dbs = [take('DB'), take('DB'), take('DB'), take('DB'), take('DB')].map(x => x || any());
  return { dl, lb, nb: dbs[2], cb: [dbs[0], dbs[1]], s: [dbs[3], dbs[4]] };
}

// ---------- helpers ----------
const short = n => { const p = String(n).split(' '); return p.length > 1 ? `${p[0][0]}. ${p.slice(1).filter(x => !/^(Jr\.?|Sr\.?|II|III|IV)$/.test(x)).join(' ') || p[1]}` : n; };
const T_ = id => D.teams[id];
const clock = t => `${Math.floor(t / 60)}:${String(Math.max(0, Math.round(t % 60))).padStart(2, '0')}`;
const pct = x => `${Math.round(x * 100)}%`;
const ord = d => ['', '1st', '2nd', '3rd', '4th'][d] || `${d}th`;
function spot(ytg, sc) { if (ytg === 50) return 'midfield'; return ytg > 50 ? `${T_(sc.off).abbr} ${100 - ytg}` : `${T_(sc.dfn).abbr} ${ytg}`; }
function downText(st) { return st.twoPt ? 'Two-point try' : `${ord(st.down)} & ${st.dist >= st.ytg ? 'goal' : st.dist}`; }
function gameLabel(sc) {
  const g = D.games[sc.g];
  const h = T_(g[3]), a = T_(g[4]);
  const when = sc.post ? 'Bowl / Playoff' : `Week ${sc.week}`;
  return { title: `${a.school} ${g[5] ? 'vs' : 'at'} ${h.school}`, when: `${sc.year} · ${when}` };
}
function headline(sc) {
  const d = sc.os - sc.ds;
  return d === 0 ? 'Tied' : `Down by ${-d}`;
}
function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 1800); }

// ---------- daily ----------
const LAUNCH = Date.UTC(2026, 9, 15);
function todayIndex() { const now = new Date(); const d = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()); return Math.floor((d - LAUNCH) / 864e5); }
const pick = (list, i) => list[((i % list.length) + list.length) % list.length];
// the local calendar date, the same day todayIndex counts
function localDay() { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; }
function dailyScenario() {
  const i = todayIndex(), pinned = D.featured && D.featured[localDay()];
  return { no: i + 1, sc: pinned != null && D.scen[pinned] ? D.scen[pinned] : pick(D.free, i) };
}
// "From Saturday": a hand-picked drive from the last week reads as news, not history
function freshLine(sc) {
  if (!sc.feat || !sc.date) return '';
  const days = Math.round((Date.parse(localDay()) - Date.parse(sc.date)) / 864e5);
  if (days < 0 || days > 9) return '';
  const wd = new Date(sc.date + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' });
  return days <= 1 ? 'From yesterday' : days <= 6 ? `From ${wd}` : `From last ${wd}`;
}
// Saban mode: the drives almost nobody wins. Its daily order is its own, offset so it never shares a game with the regular daily.
function sabanScenario() { const i = todayIndex(); return { no: i + 1, sc: pick(D.hard, i * 7 + 3) }; }
const HARD_WP = 0.10, CIG_WP = 0.25;
const twoScore = s => s.os - s.ds <= -9;
// Saban pool: brutal but attainable. One score down at 1-10% with time to run a play, or two scores down with at
// least a minute left and a model that still gives it a pulse. The truly hopeless ones are kept out of everything.
const isHard = s => (s.wp0 <= HARD_WP && s.wp0 >= 0.01 && s.secs >= 25 && !twoScore(s)) || (twoScore(s) && s.secs >= 60 && s.wp0 >= 0.003);
const isHopeless = s => !isHard(s) && (s.wp0 < 0.01 || twoScore(s));
// Cignetti mode: one shelf up from Saban. One score down, 10-25% to win. Hard, not hopeless.
const isCig = s => s.os - s.ds >= -8 && s.wp0 > HARD_WP && s.wp0 <= CIG_WP;
function cignettiScenario() { const i = todayIndex(); return { no: i + 1, sc: pick(D.cig, i * 5 + 1) }; }
const HARD_MODES = {
  saban:    { label: 'Saban mode', tag: 'SABAN MODE', lvl: 'Hardest', tagline: 'Nobody wins this one', eyebrow: 'Saban mode · Hardest', btn: 'Nobody wins this one', cls: 'saban', fine: `Saban mode drives start at ${Math.round(HARD_WP * 100)}% win chance or worse, or two scores down.`, pitch: (sc, two) => `Starting win chance: <b>${pct(sc.wp0)}</b>.${two ? ' Two scores down: you need a touchdown, the onside kick, and then some.' : ''}<br>${esc(sc.coach)} didn't pull it off. Can you?` },
  cignetti: { label: 'Cignetti mode', tag: 'CIGNETTI MODE', lvl: 'Hard', tagline: 'Hard, not hopeless', eyebrow: 'Cignetti mode · Hard', btn: 'Google me', cls: 'cignetti', fine: `Cignetti mode drives start between ${Math.round(HARD_WP * 100)}% and ${Math.round(CIG_WP * 100)}% win chance. Hard, not hopeless.`, pitch: sc => `Starting win chance: <b>${pct(sc.wp0)}</b>. Hard, not hopeless. The kind of drive that gets a coach a statue or a buyout.<br>${esc(sc.coach)} ${sc.won ? 'got it done' : "didn't"}. Your turn.` },
};
const isHardMode = m => m === 'saban' || m === 'cignetti';
// Difficulty. Saban is the cliff (100/100): green only for the exact best call, and the simulated room is sharp.
// Cignetti (80/100) loosens both a notch. Everything free (Daily, Survival, the library) is 60/100: graded on the
// same curve the real coach gets, against a room that makes human mistakes. Trophies are judged on the cliff regardless.
const DIFF = {
  saban:    { green: .005, yellow: .03,  temp: [.006, .034], curve: 'He is graded on a curve. You are not. He has a staff.' },
  cignetti: { green: .01,  yellow: .045, temp: [.008, .05],  curve: 'He is graded on a curve. Yours is steeper. He has a staff.' },
  free:     { green: .02,  yellow: .06,  temp: [.012, .09],  curve: 'Same curve for both of you. He had a staff and a headset.' },
};
// which curve applies: the hard modes by name, and a hard drive replayed from a library or reached deep in a Survival run
function diffFor() {
  if (!G) return DIFF.free;
  if (isHardMode(G.mode)) return DIFF[G.mode];
  if (G.sc && isHard(G.sc)) return DIFF.saban;
  if (G.sc && isCig(G.sc)) return DIFF.cignetti;
  return DIFF.free;
}
// The hard modes are paid. In the app: one in-app purchase (RevenueCat, see native.js). On the web: a Stripe Payment
// Link; after paying, Stripe sends the player back here with the Checkout session id, the unlock worker verifies it
// with Stripe and returns a signed unlock code, which the site keeps (and the player can paste on another device).
const WEB_UNLOCKED = false;
const STRIPE_LINK = 'https://buy.stripe.com/4gMcN47ic63E3UZ9dedAk00';   // Stripe → Payment Links → the $0.99 "Hard modes" link
const UNLOCK_API = 'https://ncaa2mindrill-unlock.unlock-worker.workers.dev'; // the Cloudflare Worker in unlock-worker/
const UNLOCK_KEY = 'cfb2md:unlock';
function webUnlockCode() { try { return localStorage.getItem(UNLOCK_KEY) || ''; } catch { return ''; } }
function premiumUnlocked() {
  if (window.Native && window.Native.isNative) return !!window.Native.entitled;
  return WEB_UNLOCKED || !!webUnlockCode();
}
function storeUnlock(code) {
  try { localStorage.setItem(UNLOCK_KEY, code); } catch { /* storage unavailable: unlocked for this visit only */ }
  paintLocks();
  beacon('/unlocked', { code, src: window.Native && window.Native.isNative ? 'app' : 'web', from: firstSource() });
  track('purchase', { value: 0.99, currency: 'USD', transaction_id: code });
}
// Where this browser first came from: utm_source/utm_campaign (or ?s=) on the first visit, kept so an unlock weeks
// later is still credited to the campaign that brought the player. "direct" when there was nothing on the link.
function firstSource() {
  const KEY = 'cfb2md:src';
  try {
    const had = localStorage.getItem(KEY); if (had) return had;
    const q = new URLSearchParams(location.search);
    // no tag on the link: fall back to where the click came from (X wraps links in t.co)
    let ref = ''; try { ref = new URL(document.referrer).hostname.replace(/^www\./, ''); } catch { /* no referrer */ }
    const fromRef = /(^|\.)t\.co$|(^|\.)x\.com$|twitter\.com$/.test(ref) ? 'x' : /reddit\.com$/.test(ref) ? 'reddit' : /google\./.test(ref) ? 'google' : /facebook\.com$|instagram\.com$/.test(ref) ? 'meta' : /tiktok\.com$/.test(ref) ? 'tiktok' : ref && !/ncaa2mindrill\.com$/.test(ref) ? ref.slice(0, 30) : '';
    const s = (q.get('utm_source') || q.get('s') || fromRef || '').toLowerCase(), c = (q.get('utm_campaign') || q.get('c') || '').toLowerCase();
    const src = (s ? s + (c ? '/' + c : '') : 'direct').replace(/[^\w./-]/g, '').slice(0, 48) || 'direct';
    localStorage.setItem(KEY, src); return src;
  } catch { return 'direct'; }
}
// Ad-platform events, only when the tags are loaded (see window.ADS in index.html). purchase and begin_checkout are
// the ones campaigns optimise on; drive_start and drive_done describe the funnel.
function track(ev, p = {}) {
  try {
    const A = window.ADS || {};
    if (window.gtag && A.gtag) window.gtag('event', ev, p);
    if (window.fbq && A.meta) {
      if (ev === 'purchase') window.fbq('track', 'Purchase', { value: p.value, currency: p.currency });
      else if (ev === 'begin_checkout') window.fbq('track', 'InitiateCheckout', { value: p.value, currency: p.currency });
      else window.fbq('trackCustom', ev, p);
    }
    if (window.twq && A.x && A.xEvents) {
      if (ev === 'purchase' && A.xEvents.purchase) window.twq('event', A.xEvents.purchase, { value: p.value, currency: p.currency, conversion_id: p.transaction_id });
      else if (ev === 'begin_checkout' && A.xEvents.lead) window.twq('event', A.xEvents.lead, {});
    }
  } catch { /* measurement never breaks the game */ }
}
// a fire-and-forget ping to the worker (visit tally, unlock tally); never blocks the game
function beacon(path, params) {
  if (UNLOCK_API.includes('REPLACE_ME')) return;
  try { const u = new URL(path, UNLOCK_API); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); fetch(u, { keepalive: true, mode: 'cors', cache: 'no-store' }).catch(() => {}); } catch { /* ignore */ }
}
async function unlockApi(path, params) {
  const u = new URL(path, UNLOCK_API); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { cache: 'no-store' });
  if (!r.ok) throw new Error(`unlock service ${r.status}`);
  return r.json();
}
// Back from Stripe: ?unlock=<checkout session id>. Claim it, keep the code, clean the URL.
async function claimFromUrl() {
  const sid = new URLSearchParams(location.search).get('unlock');
  if (!sid) return false;
  history.replaceState(null, '', location.pathname + (location.hash || ''));
  if (UNLOCK_API.includes('REPLACE_ME')) { // no verification service yet: trust Stripe's redirect
    if (/^cs_(live|test)_[A-Za-z0-9]+$/.test(sid)) { storeUnlock(sid); toast('Unlocked. Both modes are yours.'); return true; }
    return false;
  }
  const looksReal = /^cs_(live|test)_[A-Za-z0-9]+$/.test(sid);
  try {
    const r = await unlockApi('/claim', { session_id: sid });
    if (r && r.ok && r.code) { storeUnlock(r.code); toast('Unlocked. Both modes are yours.'); return true; }
    if (r && r.reason === 'unpaid') { toast('Payment not confirmed yet. If you paid, use "I already paid" with your receipt email.'); return false; }
  } catch (e) { /* service down: fall through */ }
  // the service couldn't answer: trust Stripe's redirect rather than strand a paying customer
  if (looksReal) { storeUnlock(sid); toast('Unlocked. Both modes are yours.'); return true; }
  toast('Could not confirm the payment. Try again in a minute.');
  return false;
}
// the difficulty ladder on the locked screen: the free daily, then the two shelves the unlock opens
function ladderHTML(here) {
  const rungs = [
    ['daily', 'Daily', 'Normal', 'Free', `Starts 30–75% to win. Graded on the same curve as the real coach.`],
    ['cignetti', 'Cignetti mode', 'Hard', 'Unlock', `Starts ${Math.round(HARD_WP * 100)}–${Math.round(CIG_WP * 100)}% to win, one score down. Graded on a steeper curve than the coach got.`],
    ['saban', 'Saban mode', 'Hardest', 'Unlock', `Starts under ${Math.round(HARD_WP * 100)}%, or two scores down. Only the best call grades green. The 28–3 drives.`],
  ];
  return `<div class="ladder" aria-label="Difficulty">${rungs.map(([k, name, lvl, price, desc]) =>
    `<div class="rung ${k}${k === here ? ' here' : ''}"><div class="nm">${name}<i>${lvl}</i></div><div class="px">${k === here ? 'You picked' : price}</div><div class="ds">${desc}</div></div>`).join('')}</div>`;
}
function renderPaywall(mode) {
  const m = HARD_MODES[mode], native = window.Native && window.Native.isNative;
  const configured = !STRIPE_LINK.includes('REPLACE_ME');
  app.innerHTML = `<section class="intro paywall">
    <div class="eyebrow">${esc(m.eyebrow)} · locked</div>
    <h2 class="headline" style="font-size:clamp(40px,10vw,72px)">${esc(m.label)}<small>${esc(m.tagline)}</small></h2>
    ${ladderHTML(mode)}
    <div class="pitch">One $0.99 unlock gets you <b>both</b>, with a new drive of each every day.</div>
    ${native ? `<button class="cta" id="buyBtn">Unlock both modes · ${esc(window.Native.price || '$0.99')}</button><button class="cta ghost" id="restoreBtn">Restore purchase</button><div class="fine" id="buyNote"></div>`
      : `${configured ? `<a class="cta" id="stripeBtn" href="${esc(STRIPE_LINK)}">Unlock both modes · $0.99</a>` : `<button class="cta" disabled>Unlock both modes · $0.99 · checkout opens soon</button>`}
         <details class="restore"><summary>I already paid, or I have a gift code</summary><div class="fine">Paste the unlock code from your first device, the receipt email Stripe sent you, or a friend's GIFT code.</div><div class="row"><input id="codeIn" class="codein" placeholder="Unlock code, receipt email, or GIFT-…" autocomplete="off"><button class="cta ghost" id="codeBtn">Unlock</button></div><div class="fine" id="buyNote"></div></details>
         <div class="fine">Card payments by Stripe. One payment unlocks Cignetti mode and Saban mode, forever. It's also in the <a href="https://ncaa2mindrill.com/app">app</a>.</div>`}
  </section>`;
  const sb = $('#stripeBtn'); if (sb) sb.addEventListener('click', () => track('begin_checkout', { value: 0.99, currency: 'USD' }));
  const b = $('#buyBtn'); if (b) b.onclick = async () => { track('begin_checkout', { value: 0.99, currency: 'USD' }); b.disabled = true; $('#buyNote').textContent = 'Opening the store…'; try { const ok = await window.Native.buy(); if (ok) { toast('Unlocked. Go win.'); setTab(mode); } else $('#buyNote').textContent = 'No purchase made.'; } catch (e) { $('#buyNote').textContent = 'Purchase failed: ' + (e && e.message || e); } b.disabled = false; };
  const r = $('#restoreBtn'); if (r) r.onclick = async () => { $('#buyNote').textContent = 'Checking…'; try { const ok = await window.Native.restore(); $('#buyNote').textContent = ok ? 'Restored.' : 'No previous purchase found for this account.'; if (ok) setTab(mode); } catch (e) { $('#buyNote').textContent = 'Restore failed: ' + (e && e.message || e); } };
  const cb = $('#codeBtn'); if (cb) cb.onclick = async () => {
    const v = ($('#codeIn').value || '').trim(); if (!v) return;
    $('#buyNote').textContent = 'Checking…';
    if (/^GIFT-/i.test(v)) { // a friend's gift code
      try { const r = await unlockApi('/gift/redeem', { code: v.toUpperCase(), token: playerToken() }); if (r && r.ok && r.code) { storeUnlock(r.code); toast('Unlocked. Thank your friend.'); setTab(mode); } else $('#buyNote').textContent = r && r.reason === 'redeemed' ? 'That gift code was already used.' : 'That gift code didn\'t check out.'; } catch (e) { $('#buyNote').textContent = 'Could not reach the unlock service. Try again in a minute.'; }
      return;
    }
    if (UNLOCK_API.includes('REPLACE_ME')) { // no verification service yet: a session id from the receipt URL works
      if (/^cs_(live|test)_[A-Za-z0-9]+$/.test(v)) { storeUnlock(v); toast('Unlocked.'); setTab(mode); } else $('#buyNote').textContent = 'Paste the code from the device you paid on (it starts with cs_). Email lookup is coming.';
      return;
    }
    try {
      const res = v.includes('@') ? await unlockApi('/restore', { email: v }) : await unlockApi('/verify', { code: v });
      if (res && res.ok && res.code) { storeUnlock(res.code); toast('Unlocked.'); setTab(mode); }
      else $('#buyNote').textContent = res && res.reason === 'not_found' ? 'No payment found for that. Check the email on your Stripe receipt.' : 'That code didn\'t check out.';
    } catch (e) { $('#buyNote').textContent = 'Could not reach the unlock service. Try again in a minute.'; }
  };
}
// a small card on the hard-mode intro so players can copy their code to another device
function unlockCodeNote() {
  const code = webUnlockCode();
  if (!code || (window.Native && window.Native.isNative)) return '';
  return `<div class="fine">Unlocked on this device. Your code for other devices: <code class="code">${esc(code)}</code> <button class="mod" id="copyCode">Copy</button></div>`;
}

// ---------- game state ----------
let G = null; // current game
function newGame(sc0, mode, no) {
  const sc = { ...sc0, lineup: JSON.parse(JSON.stringify(sc0.lineup)) }; // this game's own copy of the lineup: benching never touches the data
  G = {
    mode, no, sc, sc0, subs: [], log: [], grades: [], snaps: [], survKind: mode === 'survival' ? survKind : null,
    st: { sc, s: sc.os - sc.ds, os: sc.os, ds: sc.ds, T: sc.secs, ytg: sc.ytg, down: sc.down, dist: sc.dist, to: sc.to, dto: sc.dto, elo: sc.elo, pending: 0, snaps: 0 },
    useTO: false, tempo: 'neutral', picking: null, pickerSlot: null, last: null, busy: false, done: null, routes: { ...DEFAULT_ROUTES }, mods: {}, runSide: 'R', aim: null, twoPt: null,
    pers: persAvailable(sc, store.pers || '11') ? (store.pers || '11') : '11',
  };
  G.wp0 = wpModel(G.st.s, G.st.T, G.st.ytg, G.st.down, G.st.dist, G.st.to, G.st.dto, G.st.elo);
}

// ---------- rendering: field ----------
function fieldSVG(st, sc, anim) {
  const off = T_(sc.off), def = T_(sc.dfn);
  const X = ytg => 100 + (100 - ytg) * 10; // our team drives left to right
  let s = `<svg viewBox="0 0 1200 533" role="img" aria-label="Field: ball on the ${esc(spot(st.ytg, sc))}">`;
  s += `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#fff"/></marker></defs>`;
  s += `<rect width="1200" height="533" fill="var(--turf)"/>`;
  for (let i = 0; i < 20; i++) if (i % 2) s += `<rect x="${100 + i * 50}" width="50" height="533" fill="var(--turf-2)"/>`;
  s += `<rect width="100" height="533" fill="${off.color}" opacity=".85"/><rect x="1100" width="100" height="533" fill="${def.color}" opacity=".85"/>`;
  s += `<text x="50" y="266" fill="#fff" font-family="Graduate, serif" font-size="40" text-anchor="middle" dominant-baseline="middle" transform="rotate(-90 50 266)" letter-spacing="6">${esc(off.abbr)}</text>`;
  s += `<text x="1150" y="266" fill="#fff" font-family="Graduate, serif" font-size="40" text-anchor="middle" dominant-baseline="middle" transform="rotate(90 1150 266)" letter-spacing="6">${esc(def.abbr)}</text>`;
  for (let yd = 5; yd < 100; yd += 5) {
    const x = 100 + yd * 10;
    s += `<line x1="${x}" x2="${x}" y1="0" y2="533" stroke="#fff" stroke-opacity="${yd % 10 ? .25 : .55}" stroke-width="2"/>`;
    if (yd % 10 === 0) { const lab = yd <= 50 ? yd : 100 - yd; s += `<text x="${x}" y="70" fill="#fff" fill-opacity=".6" font-family="Saira Condensed, sans-serif" font-size="34" font-weight="700" text-anchor="middle">${lab}</text><text x="${x}" y="488" fill="#fff" fill-opacity=".6" font-family="Saira Condensed, sans-serif" font-size="34" font-weight="700" text-anchor="middle">${lab}</text>`; }
  }
  for (let yd = 1; yd < 100; yd++) { const x = 100 + yd * 10; s += `<line x1="${x}" x2="${x}" y1="200" y2="210" stroke="#fff" stroke-opacity=".35"/><line x1="${x}" x2="${x}" y1="323" y2="333" stroke="#fff" stroke-opacity=".35"/>`; }
  s += `<line x1="100" x2="100" y1="0" y2="533" stroke="#fff" stroke-width="4"/><line x1="1100" x2="1100" y1="0" y2="533" stroke="#fff" stroke-width="4"/>`;
  const los = X(st.ytg);
  if (!G.done) {
    const fd = X(Math.max(0, st.ytg - st.dist));
    s += `<line x1="${los}" x2="${los}" y1="0" y2="533" stroke="#4aa3ff" stroke-width="5"/>`;
    if (st.dist < st.ytg) s += `<line x1="${fd}" x2="${fd}" y1="0" y2="533" stroke="#f6d32d" stroke-width="5"/>`;
    // formation (offense faces right)
    const L = sc.lineup, col = off.color, alt = off.alt;
    const dot = (x, y, num, fill, stroke, r = 15, attr = '') => `<g ${attr}><circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="3"/><text x="${x}" y="${y + 1}" fill="${stroke}" font-family="Saira Condensed, sans-serif" font-weight="700" font-size="16" text-anchor="middle" dominant-baseline="middle">${esc(num)}</text></g>`;
    s += '<g id="formation">';
    {
      [-60, -30, 0, 30, 60].forEach(dy => { s += dot(los - 18, 266 + dy, '', col, alt, 13); });
      const picking = G.picking === 'pass';
      for (const r of receivers(sc)) {
        if (picking) s += routePath(r, los, G.routes[r.slot]);
        s += dot(los - r.dx, r.y, r.num, col, alt, 15, picking ? `data-rec="${r.slot}" style="cursor:pointer" role="button" aria-label="Change ${esc(short(r.name))}'s route"` : '');
      }
      if (G.picking === 'run' && G.aim) { // the hole he's aiming for, and the path from the backfield to it
        const a = G.aim, rbx = los - 72, rby = 310;
        s += `<path d="M ${rbx} ${rby} Q ${los - 20} ${a.y} ${a.x} ${a.y}" stroke="#fff" stroke-width="3" stroke-dasharray="9 7" fill="none" opacity=".85" marker-end="url(#arrow)"/>`;
        s += `<g transform="translate(${a.x} ${a.y})"><circle r="16" fill="none" stroke="#ffd166" stroke-width="3"/><circle r="4" fill="#ffd166"/><line x1="-24" x2="-18" y1="0" y2="0" stroke="#ffd166" stroke-width="3"/><line x1="18" x2="24" y1="0" y2="0" stroke="#ffd166" stroke-width="3"/><line y1="-24" y2="-18" x1="0" x2="0" stroke="#ffd166" stroke-width="3"/><line y1="18" y2="24" x1="0" x2="0" stroke="#ffd166" stroke-width="3"/></g>`;
      }
      s += dot(los - 70, 266, L.qb.num, col, alt);
      const dc = def.color, da = def.alt, ds = defenseSlots(sc);
      const dslots = [[18, 236, ds.dl[0]], [18, 266, ds.dl[1]], [18, 296, ds.dl[2]], [18, 206, ds.dl[3]], [60, 230, ds.lb[0]], [60, 300, ds.lb[1]], [55, 150, ds.nb], [40, 60, ds.cb[0]], [40, 470, ds.cb[1]], [150, 190, ds.s[0]], [150, 350, ds.s[1]]];
      dslots.forEach(([dx, y, pl]) => { s += `<g><circle cx="${los + dx}" cy="${y}" r="11" fill="${da}" stroke="${dc}" stroke-width="4" opacity=".9"/>${pl ? `<text x="${los + dx}" y="${y + 1}" fill="${dc}" font-family="Saira Condensed, sans-serif" font-weight="700" font-size="11" text-anchor="middle" dominant-baseline="middle">${esc(pl.num)}</text>` : ''}</g>`; });
    }
    s += '</g>';
  }
  if (anim) {
    const from = X(anim.from), to = X(anim.to);
    if (anim.pass) s += `<path d="M ${from - 60} 266 Q ${(from + to) / 2} ${anim.high ? 40 : 150} ${to} ${anim.y}" stroke="#fff" stroke-width="3" stroke-dasharray="10 8" fill="none" opacity=".8"/>`;
    else s += `<line x1="${from}" y1="266" x2="${to}" y2="266" stroke="#fff" stroke-width="4" opacity=".7"/>`;
    s += `<line x1="${from}" x2="${from}" y1="0" y2="533" stroke="#4aa3ff" stroke-width="4" opacity=".6"/>`;
  }
  const bx = anim ? X(anim.from) : los, by = 266;
  s += `<g class="ball" id="ball" style="transform: translate(${bx}px, ${by}px)"><ellipse rx="13" ry="8" fill="#7a3f1d" stroke="#fff" stroke-width="2"/><line x1="-4" x2="4" y1="0" y2="0" stroke="#fff" stroke-width="2"/></g>`;
  s += `</svg>`;
  return s;
}

// The skill group on the field for a personnel grouping: slot, screen position (dx back from the line, y across the
// field) and sideline direction. The main back is the team's lead rusher; the second back lines up as a fullback.
const SLOT_SPOT = { WR0: [18, 60, -1], WR1: [30, 470, 1], WR2: [30, 150, -1], WR3: [30, 390, 1], TE: [22, 356, 1], TE2: [22, 176, -1], TE3: [30, 410, 1], RB: [72, 310, 1], RB2: [62, 222, -1] };
function receivers(sc, pers) {
  const p = pers || (G && G.pers) || '11', g = persOf(p), L = sc.lineup, out = [];
  const wr = L.rec.filter(r => r.pos === 'WR').slice(0, g.wr), te = L.rec.filter(r => r.pos === 'TE').slice(0, g.te);
  const rbs = L.rec.filter(r => r.pos === 'RB');
  const lead = rbs.find(r => r.name === L.rb.name) || rbs[0];
  const rb = (lead ? [lead, ...rbs.filter(r => r !== lead)] : rbs).slice(0, g.rb);
  // WR3 takes the TE's spot when there is no tight end; TE2 fills the slot when there are two receivers or fewer
  const wrSlots = g.te === 0 ? ['WR0', 'WR1', 'WR2', 'WR3'] : g.wr === 1 ? ['WR0'] : ['WR0', 'WR1', 'WR2', 'WR3'];
  wr.forEach((r, i) => { const s = wrSlots[i], [dx, y, sd] = SLOT_SPOT[s]; out.push({ ...r, slot: s, dx, y, sideDir: sd }); });
  te.forEach((r, i) => { const s = ['TE', 'TE2', 'TE3'][i], [dx, y, sd] = SLOT_SPOT[s]; out.push({ ...r, slot: s, dx, y, sideDir: sd }); });
  rb.forEach((r, i) => { const s = ['RB', 'RB2'][i], [dx, y, sd] = SLOT_SPOT[s]; out.push({ ...r, slot: s, dx, y, sideDir: sd }); });
  return out;
}
function routeFor(r) { return G.routes?.[r.slot] || DEFAULT_ROUTES[r.slot] || 'out'; }
// who a trick play throws to: the best receiver on the field, or the quarterback himself on the Philly Special
function trickTarget(sc, tc) {
  if (!tc.base.startsWith('p_')) return null;
  const L = sc.lineup;
  if (tc.qbTarget) return { name: L.qb.name, num: L.qb.num, adj: 0, pos: 'QB', slot: 'QB', c: .6, yds: 0 };
  const wrs = receivers(sc).filter(r => r.pos !== 'RB');
  return [...wrs].sort((a, b) => (b.adj || 0) - (a.adj || 0))[0] || wrs[0] || receivers(sc)[0];
}
// the Philly Special thrower: the tight end if there is one, else a slot receiver
function phillyThrower(sc) { const R = receivers(sc); return R.find(r => r.slot === 'TE') || R.find(r => r.slot === 'WR2') || R.find(r => r.slot === 'WR1') || R[0]; }
// the routes a trick play needs from the other receivers (null keeps the player's own choice)
function trickRoute(id, r, tgt) {
  const c = CALLS[id]; if (!c || !c.trick || !c.base.startsWith('p_')) return null;
  const isT = tgt && r.slot === tgt.slot;
  if (id === 't_hook') return isT ? 'curl' : r.pos === 'RB' ? 'flat' : 'go';
  if (id === 't_philly') return r.pos === 'RB' ? 'block' : 'go';
  return isT ? 'go' : r.pos === 'RB' ? 'block' : 'go';
}
// SVG path of a route, drawn from the receiver's spot; offense moves +x, sideline is sideDir
function routePath(r, los, key) {
  const x0 = los - r.dx, y0 = r.y, sd = r.sideDir, mid = y0 > 266 ? -1 : 1;
  const rt = ROUTES[key] || ROUTES.out;
  const d = `M ${x0} ${y0} ${rt.p(sd, mid)}`;
  if (!rt.id) return `<path d="${d}" stroke="#fff" stroke-width="4" fill="none" opacity=".8"/>`;
  return `<path d="${d}" stroke="#fff" stroke-width="3" stroke-dasharray="9 7" fill="none" opacity=".85" marker-end="url(#arrow)"/>`;
}
// Tiny route icon for the picker (receiver at bottom-left, moving right)
function routeIcon(key) {
  const rt = ROUTES[key];
  return `<svg viewBox="-8 -40 60 50" width="30" height="25" aria-hidden="true"><path d="M 0 0 ${rt.p(-1, -1)}" transform="scale(.14)" vector-effect="non-scaling-stroke" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/><circle r="2.6" fill="currentColor"/></svg>`;
}

// ---------- rendering: shared bits ----------
function bug(st, sc) {
  const off = T_(sc.off), def = T_(sc.dfn);
  const tos = (n) => [0, 1, 2].map(i => `<i class="${i < n ? '' : 'used'}"></i>`).join('');
  return `<div class="bug">
    <div class="tm"><div class="chip" style="background:${off.color}"></div><div class="nm"><div class="ab">${esc(off.abbr)}<em>YOU</em></div><div class="tos" aria-label="${st.to} timeouts">${tos(st.to)}</div></div><div class="sc">${st.os}</div></div>
    <div class="mid"><div class="clock"><div class="q">Q4</div><div class="t">${clock(st.T)}</div></div></div>
    <div class="tm r"><div class="chip" style="background:${def.color}"></div><div class="nm"><div class="ab">${esc(def.abbr)}</div><div class="tos" aria-label="${st.dto} timeouts">${tos(st.dto)}</div></div><div class="sc">${st.ds}</div></div>
  </div>`;
}
function lineupHTML(sc) {
  const off = T_(sc.off), L = sc.lineup;
  // every offensive chip is a button when someone on the bench can take that spot
  const chip = (num, name, pos, key) => `<button class="pl ${key ? 'can' : ''}" ${key ? `data-bench="${key}" title="Bench ${esc(short(name))}"` : 'disabled'}><span class="n" style="background:${off.color};color:${off.alt}">${esc(num || '–')}</span>${esc(short(name))} <span class="ps">${pos}</span></button>`;
  const def = T_(sc.dfn), dl = (sc.dlineup || []).slice(0, 4);
  const dchip = x => `<span class="pl" title="${x.tk} tackles${x.sk ? ', ' + x.sk + ' sacks' : ''}${x.pbu ? ', ' + x.pbu + ' PBU' : ''}${x.int ? ', ' + x.int + ' INT' : ''}"><span class="n" style="background:${def.alt};color:${def.color};border:2px solid ${def.color}">${esc(x.num)}</span>${esc(x.name)} <span class="ps">${x.role}</span></span>`;
  const R = receivers(sc); // the group on the field for the chosen personnel
  const can = key => benchOptions(key).length ? key : null;
  return `<div class="lineup">${chip(L.qb.num, L.qb.name, 'QB', can('QB'))}${R.filter(r => r.pos === 'RB').map(r => chip(r.num, r.name, r.slot === 'RB2' ? 'FB' : 'RB', can(r.slot))).join('')}${R.filter(r => r.pos !== 'RB').map(r => chip(r.num, r.name, r.pos, can(r.slot))).join('')}${dl.length ? `<span class="gl" style="align-self:center">vs</span>${dl.map(dchip).join('')}` : ''}</div>`;
}
// ---------- the bench ----------
// Who could take a spot: the backup quarterback, or anyone on the bench at the same position. The lineup is this
// game's own copy, so a sub lasts the drive and the data stays untouched. Season numbers follow the player.
function benchOptions(key) {
  if (!G) return [];
  const L = G.sc.lineup, R = receivers(G.sc), onField = new Set(R.map(r => r.name));
  if (key === 'QB') return L.qb2 ? [L.qb2] : [];
  const slot = R.find(r => r.slot === key); if (!slot) return [];
  return L.rec.filter(r => r.pos === slot.pos && !onField.has(r.name));
}
function benchPlayer(key, name) {
  const L = G.sc.lineup, sit = clock(G.st.T);
  let outName, inName;
  if (key === 'QB') {
    if (!L.qb2 || L.qb2.name !== name) return;
    const was = L.qb; L.qb = L.qb2; L.qb2 = was; outName = was.name; inName = L.qb.name;
  } else {
    const R = receivers(G.sc), slot = R.find(r => r.slot === key); if (!slot) return;
    const i = L.rec.findIndex(r => r.name === slot.name), j = L.rec.findIndex(r => r.name === name);
    if (i < 0 || j < 0) return;
    [L.rec[i], L.rec[j]] = [L.rec[j], L.rec[i]];
    outName = slot.name; inName = name;
    if (key === 'RB') { const c = L.rec[i]; L.rb = { name: c.name, num: c.num, n: c.rn || 0, ypc: c.ypc || 4.5, adj: c.radj || 0 }; } // the new lead back carries the ball
  }
  const where = key === 'RB2' ? 'FB' : key.replace(/\d/, '');
  G.subs.push({ out: outName, in: inName, pos: where });
  G.log.push({ sit, text: `Sub: ${short(inName)} in for ${short(outName)} at ${where}.` });
  G.picking = null; G.pickerSlot = null; G.benchKey = null; renderPlay();
}
function benchLine(key, r) {
  if (key === 'QB') return `${r.n} dropbacks · ${r.adj >= 0 ? 'above' : 'below'} league by ${Math.abs(r.adj).toFixed(2)} EPA per play · sacked ${(r.sack * 100).toFixed(1)}% · picked ${(r.int * 100).toFixed(1)}%`;
  const rec = r.n ? `${Math.round(r.c * 100)}% caught · ${Number(r.yds).toFixed(1)} yds per target · ${r.n} targets` : 'no targets this season · league-average hands';
  return rec + (r.rn ? ` · ${r.ypc} per carry on ${r.rn} carries` : r.pos === 'RB' ? ' · no carries on record' : '');
}

// ---------- screens ----------
let tab = 'daily';
let survView = 'run';
function paintLocks() { document.documentElement.classList.toggle('locked', !premiumUnlocked()); }
function setTab(t) {
  paintLocks();
  if (t === 'practice') { survView = 'library'; t = 'survival'; } // the drive library lives under Survival
  tab = t;
  for (const [id, k] of [['tabDaily', 'daily'], ['tabSaban', 'saban'], ['tabCignetti', 'cignetti'], ['tabSurvival', 'survival'], ['tabCoaches', 'coaches']]) $('#' + id).setAttribute('aria-pressed', String(k === t));
  document.documentElement.classList.toggle('saban', t === 'saban');
  document.documentElement.classList.toggle('cignetti', t === 'cignetti');
  const sn = $('#subnav');
  if (sn) {
    if (isHardMode(t) && premiumUnlocked()) {
      const v = hardView[t] || 'today';
      sn.hidden = false;
      sn.innerHTML = `<button data-view="today" aria-pressed="${v === 'today'}">Today's drive</button><button data-view="survival" aria-pressed="${v === 'survival'}">Survival</button><button data-view="library" aria-pressed="${v === 'library'}">Library</button>`;
      sn.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { hardView[t] = b.dataset.view; setTab(t); });
    } else if (t === 'survival') {
      sn.hidden = false;
      sn.innerHTML = `<button data-view="run" aria-pressed="${survView === 'run'}">Run</button><button data-view="library" aria-pressed="${survView === 'library'}">Drive library</button>`;
      sn.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { survView = b.dataset.view; setTab('survival'); });
    } else sn.hidden = true;
  }
  if (t === 'daily') showDaily('daily');
  else if (t === 'saban' || t === 'cignetti') { const v = hardView[t] || 'today'; if (v === 'library' && premiumUnlocked()) renderLibrary(t); else if (v === 'survival' && premiumUnlocked()) showSurvival(t); else showDaily(t); }
  else if (t === 'survival') { if (survView === 'library') showPractice(); else showSurvival('free'); }
  else showCoaches();
  if (window.Sound && !(G && G.st && !G.done && /game/.test(app.firstElementChild?.className || ''))) Sound.ambience(0);
  window.scrollTo(0, 0);
}

function showDaily(mode) {
  const { no, sc } = mode === 'saban' ? sabanScenario() : mode === 'cignetti' ? cignettiScenario() : dailyScenario();
  const prev = (store[mode] ||= {})[no];
  const date = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  $('#subline').textContent = isHardMode(mode) ? `${HARD_MODES[mode].label} · No. ${no} · ${date}` : `No. ${no} · ${date}`;
  if (isHardMode(mode) && !premiumUnlocked()) { renderPaywall(mode); return; }
  if (prev && prev.done) { newGame(sc, mode, no); G.done = prev.done; G.grades = prev.grades || []; G.log = prev.log || []; G.snaps = prev.snaps || []; renderFinal(); return; }
  showIntro(sc, mode, no);
}

function showIntro(sc, mode, no) {
  if (mode === 'practice' && !premiumUnlocked() && (isHard(sc) || isCig(sc))) { renderPaywall(isHard(sc) ? 'saban' : 'cignetti'); return; }
  const off = T_(sc.off), def = T_(sc.dfn), gl = gameLabel(sc);
  const st = { s: sc.os - sc.ds };
  if (mode === 'practice') $('#subline').textContent = `Drive library · ${gl.when}`;
  if (mode === 'survival') $('#subline').textContent = `Survival · round ${no}`;
  const hard = isHard(sc), hm = isHardMode(mode) ? HARD_MODES[mode] : null, saban = !!hm;
  const eyebrow = hm ? hm.eyebrow : mode === 'daily' ? "Today's drive" : mode === 'survival' ? `Survival · round ${no}${hard ? ' · Saban drive' : isCig(sc) ? ' · Cignetti drive' : ''}` : hard ? 'Library · Saban-hard drive' : isCig(sc) ? 'Library · Cignetti-hard drive' : 'Library drive';
  const twoScore = sc.os - sc.ds <= -9;
  const pitch = hm
    ? `Your ball, ${downText(sc)} at the ${esc(spot(sc.ytg, sc))}, calling it for <b>${esc(off.school)}</b>. ${hm.pitch(sc, twoScore)}`
    : mode === 'survival'
    ? `Your ball, ${downText(sc)} at the ${esc(spot(sc.ytg, sc))}, calling it for <b>${esc(off.school)}</b> against ${esc(sc.coach === sc.dcoach ? 'them' : sc.dcoach)}.<br><b>Win to stay alive. Lose and the run is over. Tied at the end: overtime.</b>`
    : `Your ball, ${downText(sc)} at the ${esc(spot(sc.ytg, sc))}. You're calling it for <b>${esc(off.school)}</b>.<br>Can you do better than <b>${esc(sc.coach)}</b> did?`;
  const fresh = freshLine(sc);
  app.innerHTML = `<section class="intro">
    <div class="eyebrow">${eyebrow} · ${fresh ? `<b style="color:var(--amber)">${esc(fresh)}</b> · ` : ''}${esc(gl.when)}</div>
    <div class="eyebrow" style="color:var(--chalk)">${esc(gl.title)}</div>
    <h2 class="headline">${headline(sc)}<small>${clock(sc.secs)} left in the game</small></h2>
    ${bug({ ...st, os: sc.os, ds: sc.ds, T: sc.secs, to: sc.to, dto: sc.dto }, sc)}
    <div class="pitch">${pitch}</div>
    <button class="cta" id="go">${hm ? hm.btn : mode === 'survival' ? `Round ${no}` : 'Take the field'}</button>
    <div class="fine">Real score, clock, ball, timeouts and skill players from that game. ${esc(def.school)} coached by ${esc(sc.dcoach)}.${hm ? ' ' + hm.fine : ''}</div>
    ${hm ? unlockCodeNote() : ''}
  </section>`;
  $('#go').onclick = () => { track('drive_start', { mode }); newGame(sc, mode, no); renderPlay(); };
  const cc = $('#copyCode'); if (cc) cc.onclick = () => navigator.clipboard?.writeText(webUnlockCode()).then(() => toast('Code copied'), () => toast(webUnlockCode()));
}

// seconds that come off a running clock before the next snap, by tempo (college play clock is 40 s)
function runoff(pending, tempo) {
  if (tempo === 'hustle') return Math.min(pending, 5);
  if (tempo === 'milk') return Math.max(pending, 34);
  return pending;
}
function renderPlay() {
  const st = G.st, sc = G.sc;
  if (!st.look && !G.done) { st.look = sampleLook(st, G.pers); st.lookSide = rand() < 0.5 ? 'L' : 'R'; } // the defense shows its look once per snap (and again if you sub)
  const sitBits = [`<b>${downText(st)}</b>`, `ball on the ${esc(spot(st.ytg, sc))}`];
  if (st.pending > 0) sitBits.push(`<b style="color:var(--amber)">clock running</b>`); else sitBits.push('clock stopped');
  app.innerHTML = `<div class="game ${G.picking ? 'picking' : ''}">
    <div class="main">
      ${bug(st, sc)}
      <div class="sit">${sitBits.join(' · ')}</div>
      <div class="fieldbox" id="field">${fieldSVG(st, sc, G.anim)}</div>
      ${lineupHTML(sc)}
      ${logHTML()}
    </div>
    <div class="side" id="side"></div>
  </div>`;
  renderSide();
  if (window.Sound) Sound.ambience(crowdLevel());
  if (G.anim) { const a = G.anim; requestAnimationFrame(() => requestAnimationFrame(() => { const b = $('#ball'); if (b) b.style.transform = `translate(${100 + (100 - a.to) * 10}px, ${a.y}px)`; })); }
  $('#field').querySelectorAll('[data-rec]').forEach(g => g.onclick = () => cycleRoute(g.dataset.rec));
  if (!G.animating && !G.busy && !G.done) app.querySelectorAll('[data-bench]').forEach(b => b.onclick = () => { G.benchKey = b.dataset.bench; G.picking = 'bench'; G.pickerSlot = null; G.aim = null; renderPlay(); });
  if (G.picking === 'run' && !G.animating) {
    const svg = $('#field svg');
    svg.style.cursor = 'crosshair';
    svg.onclick = e => {
      const p = fieldPoint(svg, e); if (!p) return;
      const L = los(G.st);
      G.aim = { x: clamp(p.x, L - 5, Math.min(L + 220, 1115)), y: clamp(p.y, 30, 503) };
      G.runSide = G.aim.y < 266 ? 'L' : 'R';
      renderPlay();
    };
  }
}

function logHTML() {
  const items = G.animating ? G.log.slice(0, -1) : G.log;   // no spoilers: the newest line waits until the play is over
  if (!items.length) return '';
  return `<details class="log" open><summary>Play-by-play</summary><ol>${items.map(l => `<li><span>${esc(l.sit)}</span> — ${esc(l.text)}</li>`).join('')}</ol></details>`;
}

// who the stadium is rooting for, and how loud it is: a close game late gets loud
function soundCtx() { return { home: !!(G && G.sc && G.sc.home), neutral: !!(G && G.sc && G.sc.neutral) }; }
function crowdLevel() {
  if (!G || !G.st || G.done) return 0;
  const st = G.st;
  const late = Math.max(0, Math.min(1, 1 - st.T / 240)), close = Math.abs(st.s) <= 8 ? 1 : 0.55;
  let lvl = 0.25 + 0.55 * late * close;           // the stands fill in as a close game gets late
  if (st.down >= 3) lvl += G.sc.neutral ? 0.1 : G.sc.home ? -0.08 : 0.3;   // the home crowd roars on the road team's third down, hushes for its own offense
  if (st.ytg <= 20) lvl += 0.15;                  // red zone
  if (st.T <= 60) lvl += 0.15;                    // the last minute
  return Math.max(0.15, Math.min(1.1, lvl));
}
function resultMini() {
  const L = G.last; if (!L) return '';
  const color = L.good ? 'var(--good)' : L.bad ? 'var(--bad)' : 'var(--panel-2)';
  return `<div class="resmini" aria-label="Last play"><span class="yd" style="background:${color}">${esc(L.badge)}</span><span class="t">${esc(L.title)}</span><span class="g">${L.grade.e}</span></div>`;
}
// on a phone the field sits above the call sheet: bring it back into view when a snap starts
function showFieldOnPhone() {
  if (!window.matchMedia || !matchMedia('(max-width: 860px)').matches) return;
  const f = $('#field'); if (!f) return;
  const r = f.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight) window.scrollTo({ top: Math.max(0, scrollY + r.top - 60), behavior: 'smooth' });
}
function resultHTML() {
  const L = G.last; if (!L) return '';
  const cls = L.grade.cls;
  const color = L.good ? 'var(--good)' : L.bad ? 'var(--bad)' : 'var(--panel-2)';
  const opts = L.opts.slice(0, 8).map((o, i) => {
    const you = o.id === L.id && (!o.tgt || o.tgt === L.tgt);
    const isCoach = L.coachCall && o.id === L.coachCall && (!o.tgt || o === L.opts.find(x => x.id === L.coachCall));
    return `<div class="optrow ${you ? 'you' : isCoach ? 'coach' : ''}"><div>${esc(o.label)}${you ? '<span class="tag you">You</span>' : ''}${isCoach ? `<span class="tag coach">${esc(G.sc.coach.split(' ').slice(-1)[0])}</span>` : ''}<div class="bar"><i style="width:${(o.ev * 100).toFixed(1)}%"></i></div></div><div class="v">${pct(o.ev)}</div></div>`;
  }).join('');
  return `<div class="result" aria-live="polite">
    <div class="top"><div class="yd" style="background:${color}">${esc(L.badge)}</div><div class="what"><b>${esc(L.title)}</b><div>${esc(L.text)}</div></div></div>
    <div class="wp">Win chance ${pct(L.wpBefore)} → ${pct(L.wpAfter)}</div>
    <div class="grade ${cls}">${L.grade.text}</div>
    ${L.quip ? `<div class="quip">${esc(L.quip)}</div>` : ''}
    ${L.real ? `<div class="real">Real snap behind this result: <q>${esc(L.real)}</q></div>` : ''}
    <details class="opts"><summary>How every option scored</summary><div>${opts}</div><p class="note">Expected win chance after the snap, using every real play in each option's pool.</p></details>
  </div>`;
}

function renderSide() {
  const side = $('#side'), st = G.st, sc = G.sc;
  if (G.done) return;
  if (G.animating) { side.innerHTML = `<div class="snapping"><span class="spin"></span> Snap…</div><div class="note">Tap the field to skip.</div>`; return; }
  // in a picker the last play shrinks to one line, so the choices start right under the field
  const gm = document.querySelector('.game'); if (gm) gm.classList.toggle('picking', !!G.picking);
  let h = G.picking ? resultMini() : resultHTML();
  if (G.picking === 'run') {
    const rs = G.runSide, aim = G.aim;
    const lane = aim ? laneOf(aim) : null;
    const concepts = ['r_in', 'r_power', 'r_counter', 'r_out', 'r_toss', 'r_draw', 'r_qb', 'r_sneak'].filter(id => available(st, id));
    h += `<div class="grp"><div class="h">Run <button class="back" id="back">◀ Back</button></div>
      <div class="note">${aim ? `Aim point set: <b>${esc(laneWord(lane))}, ${rs === 'L' ? 'left' : 'right'}</b>, ${Math.round((aim.x - los(st)) / 10)} yards past the line. Pick how he gets there.` : 'Tap the field where you want him to hit the hole, or pick a concept and a side.'}</div>
      <div class="mods"><span class="gl">Side</span><button class="mod" data-side="L" aria-pressed="${rs === 'L'}">◀ Left</button><button class="mod" data-side="R" aria-pressed="${rs === 'R'}">Right ▶</button>${aim ? '<button class="mod" id="clearAim">Clear aim</button>' : ''}<span class="note">${st.look === 'loaded' || st.look === 'blitz' ? `Extra defender on the ${st.lookSide === 'L' ? 'left' : 'right'}.` : ''}</span></div>
      <div class="calls">${concepts.map(id => { const c = CALLS[id]; const fits = !aim || !lane || c.lane === lane || (lane === 'tackle' && (c.lane === 'in' || c.lane === 'out')) || c.qb; return `<button class="call ${fits ? '' : 'dim'}" data-rcall="${id}"><b>${runIcon(id, rs)}${esc(c.label)}</b><small>${esc(c.sub)}${c.qb ? ` · ${esc(short(sc.lineup.qb.name))}` : ` · ${esc(short(sc.lineup.rb.name))}`}</small></button>`; }).join('')}</div></div>`;
    side.innerHTML = h;
    $('#back').onclick = () => { G.picking = null; G.aim = null; renderPlay(); };
    side.querySelectorAll('[data-side]').forEach(b => b.onclick = () => { G.runSide = b.dataset.side; if (G.aim) G.aim = { ...G.aim, y: 266 + (G.runSide === 'L' ? -1 : 1) * Math.abs(G.aim.y - 266) }; renderPlay(); });
    const ca = $('#clearAim'); if (ca) ca.onclick = () => { G.aim = null; renderPlay(); };
    side.querySelectorAll('[data-rcall]').forEach(b => b.onclick = () => { const id = b.dataset.rcall; runPlay(id, null, { side: G.runSide, aim: G.aim ? { ...G.aim } : null, lane: G.aim ? laneOf(G.aim) : CALLS[id].lane }); });
    return;
  }
  if (G.picking === 'pass') {
    const recs = receivers(sc);
    const m = G.mods, nb = blockers();
    const picker = slot => `<div class="picker" data-picker="${slot}">${ROUTE_GROUPS.map(gname => `<div class="pg"><div class="gl">${gname}</div><div class="pr">${Object.entries(ROUTES).filter(([, r]) => r.grp === gname).map(([k, r]) => {
      const ok = r.id ? routeOk(st, k) : true;
      return `<button class="rt" data-set="${slot}:${k}" aria-pressed="${routeFor({ slot }) === k}" ${ok ? '' : 'disabled'} title="${esc(r.label)}">${routeIcon(k)}<span>${esc(r.label)}</span></button>`;
    }).join('')}</div></div>`).join('')}</div>`;
    h += `<div class="grp"><div class="h">Pass <button class="back" id="back">◀ Back</button></div>
      <div class="note">Tap a receiver's route chip to pick any route (or tap him on the field to flip through the usual ones). Tap his name to throw it to him.</div>
      <div class="mods"><span class="gl">Concept</span>${Object.keys(CONCEPTS).map(c => `<button class="mod" data-concept="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div class="mods"><span class="gl">Quarterback</span><button class="mod" data-mod="pa" aria-pressed="${!!m.pa}">Play action</button><button class="mod" data-mod="roll" aria-pressed="${!!m.roll}">Roll out</button>${nb ? `<span class="note">${nb} extra blocker${nb > 1 ? 's' : ''}: fewer sacks, fewer targets</span>` : ''}</div>
      <div class="calls">${recs.map(r => {
        const key = routeFor(r), rt = ROUTES[key], ok = routeOk(st, key), open = G.pickerSlot === r.slot;
        return `<div class="reccard ${open ? 'open' : ''}"><button class="call rec" data-tgt="${r.slot}" ${ok ? '' : 'disabled'}><span class="who"><b>${esc(r.num ? '#' + r.num + ' ' : '')}${esc(short(r.name))}</b><small>${r.pos} · ${Math.round(r.c * 100)}% caught · ${r.yds.toFixed(1)} yds/target</small></span></button><button class="route ${rt.id ? '' : 'blk'}" data-route="${r.slot}" aria-expanded="${open}" aria-label="Change ${esc(short(r.name))}'s route">${routeIcon(key)}${esc(rt.label)}${rt.id && !ok ? ' · too deep' : ''}</button>${open ? picker(r.slot) : ''}</div>`;
      }).join('')}</div>
      <div class="calls">${available(st, 'hail') ? `<button class="call" data-call="hail"><b>Hail Mary</b><small>Everyone to the end zone</small></button>` : ''}</div></div>`;
    side.innerHTML = h;
    $('#back').onclick = () => { G.picking = null; G.pickerSlot = null; renderPlay(); };
    side.querySelectorAll('[data-mod]').forEach(b => b.onclick = () => { G.mods[b.dataset.mod] = !G.mods[b.dataset.mod]; renderSide(); });
    side.querySelectorAll('[data-concept]').forEach(b => b.onclick = () => { Object.assign(G.routes, CONCEPTS[b.dataset.concept]); G.pickerSlot = null; renderPlay(); });
    side.querySelectorAll('[data-route]').forEach(b => b.onclick = () => { G.pickerSlot = G.pickerSlot === b.dataset.route ? null : b.dataset.route; renderSide(); });
    side.querySelectorAll('[data-set]').forEach(b => b.onclick = () => { const [slot, k] = b.dataset.set.split(':'); G.routes[slot] = k; G.pickerSlot = null; renderPlay(); });
    side.querySelectorAll('[data-tgt]').forEach(b => b.onclick = () => { const r = recs.find(x => x.slot === b.dataset.tgt); runPlay(ROUTES[routeFor(r)].id, r, { ...G.mods, route: routeFor(r), blockers: nb }); });
    side.querySelectorAll('[data-call]').forEach(b => b.onclick = () => runPlay(b.dataset.call, null, { ...G.mods, blockers: nb }));
    return;
  }
  if (G.picking === 'bench' && G.benchKey) {
    const key = G.benchKey, L = sc.lineup, R = receivers(sc);
    const cur = key === 'QB' ? L.qb : R.find(r => r.slot === key);
    const opts = benchOptions(key), where = key === 'RB2' ? 'fullback' : key.replace(/\d/, '');
    h += `<div class="grp"><div class="h">Bench ${esc(short(cur ? cur.name : ''))} <button class="back" id="back">◀ Back</button></div>
      <div class="note">${key === 'QB' ? 'The backup takes every snap from here. His season numbers drive every throw.' : `Who comes in at ${esc(where)}? His season numbers decide how the ball finds him.`}</div>
      <div class="calls">${opts.map(r => `<button class="call" data-sub="${esc(r.name)}"><b>${esc(r.num ? '#' + r.num + ' ' : '')}${esc(short(r.name))}</b><small>${esc(benchLine(key, r))}</small></button>`).join('') || '<div class="note">Nobody else on the roster at this spot.</div>'}</div>
      ${cur ? `<div class="note">Now: ${esc(short(cur.name))} · ${esc(benchLine(key, cur))}</div>` : ''}</div>`;
    side.innerHTML = h;
    $('#back').onclick = () => { G.picking = null; G.benchKey = null; renderPlay(); };
    side.querySelectorAll('[data-sub]').forEach(b => b.onclick = () => benchPlayer(key, b.dataset.sub));
    return;
  }
  if (G.picking === 'trick') {
    const rs = G.runSide, L = sc.lineup, look = st.look || 'base';
    const qb = short(L.qb.name), rb = short(L.rb.name), te = short(phillyThrower(sc).name);
    const who = { t_flea: `${rb} to ${qb}`, t_hbpass: `${rb} throws`, t_reverse: 'receiver carries', t_jet: 'receiver carries', t_wildcat: `${rb} takes the snap`, t_statue: rb, t_hook: `lateral to ${rb}`, t_philly: `${te} to ${qb}`, t_fakefg: 'holder keeps it', t_fakepunt: 'punter keeps it' };
    const why = id => { const c = CALLS[id]; if (c.needsFg) return 'Out of field goal range'; if (c.needsPunt) return 'Fourth down only'; return ''; };
    const read = id => { const t = CALLS[id].tilt[look] || 0; return t >= .02 ? 'The look favors it' : t <= -.02 ? 'Wrong look for it' : ''; };
    h += `<div class="grp"><div class="h">Trick play <button class="back" id="back">◀ Back</button></div>
      <div class="note">Every trick in the bag, every down. Each one is a real kind of snap with extra risk stapled on: fakes get bitten on against a loaded box or a blitz, and ignored by a prevent shell. Long-developing plays eat clock.</div>
      <div class="mods"><span class="gl">Side</span><button class="mod" data-side="L" aria-pressed="${rs === 'L'}">◀ Left</button><button class="mod" data-side="R" aria-pressed="${rs === 'R'}">Right ▶</button><span class="note">${st.look === 'loaded' || st.look === 'blitz' ? `Extra defender on the ${st.lookSide === 'L' ? 'left' : 'right'}.` : ''}</span></div>
      <div class="calls">${Object.keys(CALLS).filter(id => CALLS[id].trick).map(id => { const c = CALLS[id], ok = available(st, id), rd = ok ? read(id) : why(id); return `<button class="call ${ok ? '' : 'dim'}" data-tcall="${id}" ${ok ? '' : 'disabled'}><b>${esc(c.label)}</b><small>${esc(c.sub)}${who[id] ? ` · ${esc(who[id])}` : ''}${rd ? ` · ${esc(rd)}` : ''}</small></button>`; }).join('')}</div></div>`;
    side.innerHTML = h;
    $('#back').onclick = () => { G.picking = null; renderPlay(); };
    side.querySelectorAll('[data-side]').forEach(b => b.onclick = () => { G.runSide = b.dataset.side; renderSide(); });
    side.querySelectorAll('[data-tcall]').forEach(b => b.onclick = () => runPlay(b.dataset.tcall, null, { side: G.runSide }));
    return;
  }
  h += `<div class="h">Your call <span>${downText(st)} · ${esc(spot(st.ytg, sc))}</span></div>`;
  const lk = LOOKS[st.look || 'base'];
  h += `<div class="look"><span class="gl">Defense</span><b>${esc(lk.label)}</b><small>${esc(lookSub(st))}</small></div>`;
  if (st.pending > 0) {
    const off = G.useTO ? 0 : runoff(st.pending, G.tempo);
    const tempoBtn = (k, label, sub) => `<button class="mod" data-tempo="${k}" aria-pressed="${G.tempo === k}" title="${esc(sub)}">${label}</button>`;
    h += `<div class="toggle col"><div class="row2"><span>Clock running. <b>${G.useTO ? 'Timeout: no time comes off.' : `About ${off}s comes off before the snap.`}</b>${st.to === 0 && !G.useTO ? ' No timeouts left. This is the part where fans yell at the television.' : ''}</span>${st.to > 0 ? `<button id="toBtn" aria-pressed="${G.useTO}">${G.useTO ? 'Timeout called' : `Timeout (${st.to} left)`}</button>` : ''}</div>
      <div class="mods"><span class="gl">Tempo</span>${tempoBtn('hustle', 'Hustle', 'Sprint to the line, snap it fast')}${tempoBtn('neutral', 'Neutral', 'Normal pace')}${tempoBtn('milk', 'Milk it', 'Let the play clock run down')}</div></div>`;
  }
  if (st.twoPt) h += `<div class="note"><b>Two-point try.</b> One snap from the 3, untimed. Run it, throw it, or get cute. It is graded like every other call.</div>`;
  h += `<div class="mods pers"><span class="gl" title="First digit backs, second tight ends, the rest receivers">Personnel</span>${Object.keys(PERSONNEL).map(k => `<button class="mod" data-pers="${k}" aria-pressed="${G.pers === k}" title="${esc(persOf(k).sub)}${persAvailable(sc, k) ? '' : ' · not enough bodies on this roster'}" ${persAvailable(sc, k) ? '' : 'disabled'}>${k}</button>`).join('')}<span class="note">${esc(persOf(G.pers).sub)}. Sub, and the defense subs too.</span></div>`;
  const groups = {};
  for (const [id, c] of Object.entries(CALLS)) if (c.grp) (groups[c.grp] ||= []).push(id);
  for (const [g, ids] of Object.entries(groups)) {
    if (st.twoPt && g === 'Clock & kicks') continue;
    h += `<div class="grp"><div class="gl">${g}</div><div class="calls">`;
    for (const id of ids) {
      const c = CALLS[id], ok = available(st, id);
      if (!ok && (id === 'r_sneak' || id === 'hail' || id === 'kneel' || id === 'punt')) continue;
      let sub = c.sub;
      if (id === 'fg') sub = ok ? `${st.ytg + 17}-yard try · ${pct(fgProb(st.ytg, sc.kick))} make rate${sc.kick >= .04 ? ' · strong kicker' : sc.kick <= -.04 ? ' · shaky kicker' : ''}` : 'Out of range';
      if (id === 'run') sub += ` · ${short(sc.lineup.rb.name)}`;
      h += `<button class="call ${c.pick ? 'wide' : ''}" data-call="${id}" ${ok ? '' : 'disabled'}><b>${esc(c.label)}</b><small>${esc(sub)}</small></button>`;
    }
    h += `</div></div>`;
  }
  side.innerHTML = h;
  const tb = $('#toBtn'); if (tb) tb.onclick = () => { G.useTO = !G.useTO; if (G.useTO && window.Sound) Sound.play('timeout'); renderSide(); };
  side.querySelectorAll('[data-tempo]').forEach(b => b.onclick = () => { G.tempo = b.dataset.tempo; renderSide(); });
  side.querySelectorAll('[data-pers]').forEach(b => b.onclick = () => { // you sub, they sub: the look is drawn again for the new grouping
    const k = b.dataset.pers; if (k === G.pers || !persAvailable(sc, k)) return;
    G.pers = k; store.pers = k; saveStore(); G.st.look = null; G.pickerSlot = null; renderPlay();
  });
  side.querySelectorAll('[data-call]').forEach(b => b.onclick = () => {
    const id = b.dataset.call;
    if (CALLS[id].pick) { G.picking = id; renderPlay(); return; }
    runPlay(id, null);
  });
}
// run aiming: field px -> lane. Left is the top of the field (the offense moves right, so its left hand points up).
const los = st => 100 + (100 - st.ytg) * 10;
function laneOf(aim) { const dy = Math.abs(aim.y - 266); return dy < 38 ? 'in' : dy < 85 ? 'tackle' : 'out'; }
const laneWord = lane => ({ in: 'inside', tackle: 'off tackle', out: 'outside' }[lane] || 'inside');
function runIcon(id, side) {
  const s = side === 'L' ? -1 : 1;
  const P = { r_in: `l 14 0 l 12 ${s * 4}`, r_power: `l 10 0 l 10 ${s * 9} l 8 0`, r_counter: `l 5 ${-s * 7} l 8 ${s * 16} l 12 0`, r_out: `l 6 ${s * 12} l 20 ${s * 2}`, r_toss: `m 0 0 l 0 ${s * 12} l 24 ${s * 3}`, r_draw: `l -8 0 l 20 0 l 10 ${s * 5}`, r_qb: `l 6 ${s * 8} l 18 0`, r_sneak: `l 20 0` }[id] || 'l 20 0';
  return `<svg viewBox="-12 -18 44 36" width="30" height="24" aria-hidden="true" style="vertical-align:middle;margin-right:4px"><path d="M 0 0 ${P}" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle r="2.6" fill="currentColor"/></svg>`;
}
function fieldPoint(svg, e) {
  const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
  const m = svg.getScreenCTM(); if (!m) return null;
  const p = pt.matrixTransform(m.inverse()); return { x: p.x, y: p.y };
}
function cycleRoute(slot) {
  const pos = slot.replace(/\d/, '');
  const list = ROUTE_CYCLE[pos] || ROUTE_CYCLE.WR;
  const cur = G.routes[slot] || DEFAULT_ROUTES[slot];
  G.routes[slot] = list[(list.indexOf(cur) + 1) % list.length];
  G.pickerSlot = null;
  renderPlay();
}

// What did the real coach call on the opening snap?
function coachOpening(sc) {
  const r = sc.real.find(p => p.c && !['timeout', 'penalty', 'other'].includes(p.c));
  return r ? r.c : null;
}

function narrateTrick(id, o, r, tgt, sc) {
  const L = sc.lineup, qb = short(L.qb.name), rb = short(L.rb.name), wrs = L.rec.filter(x => x.pos === 'WR'), wr = short((wrs[0] || L.rec[0]).name), wr2 = short(phillyThrower(sc).name);
  const to = tgt ? short(tgt.name) : wr;
  const yds = n => `${Math.abs(n)} yard${Math.abs(n) === 1 ? '' : 's'}`;
  const gain = r.yards < 0 ? `a loss of ${yds(r.yards)}` : r.yards === 0 ? 'no gain' : yds(r.yards);
  const tail = (r.td ? ' Touchdown!' : '') + (r.oob ? ' Out of bounds.' : '') + (r.first && !r.td ? ' First down.' : '');
  if (o.lateralLost) return `Hook and ladder: ${to} catches it and the lateral to ${rb} hits the ground. Defense recovers.`;
  if (o.scramble) return `${CALLS[id].label}: nothing there, so ${qb} pulls it down and runs for ${gain}.${tail}`;
  if (o.blown && o.fumble) return `${CALLS[id].label}: blown up in the backfield and the ball comes out. Defense recovers.`;
  if (o.blown) return `${CALLS[id].label}: the defense doesn't bite. Blown up for a loss of ${yds(o.y)}.`;
  if (o.strip) return `${CALLS[id].label}: the throw never comes. Strip sack, defense recovers.`;
  if (o.f & 16) return `${CALLS[id].label}: it takes too long. Sacked for a loss of ${yds(o.y)}.`;
  if (o.int) return (o.f & 32) ? `${CALLS[id].label}: the throw is picked off and returned for a touchdown.` : `${CALLS[id].label}: the throw is intercepted.`;
  if (o.fumble) return `${CALLS[id].label}: the exchange is fumbled. Defense recovers.`;
  switch (id) {
    case 't_flea': return (o.f & 1) ? `Flea flicker: ${rb} takes it, pitches back, and ${qb} hits ${to} deep for ${gain}.${tail}` : `Flea flicker: ${rb} pitches it back and ${qb}'s deep ball to ${to} falls incomplete.`;
    case 't_hbpass': return (o.f & 1) ? `Halfback pass: ${rb} pulls up and finds ${to} for ${gain}.${tail}` : `Halfback pass: ${rb} pulls up and throws it over ${to}'s head.`;
    case 't_reverse': return `Reverse: ${rb} hands it to ${wr} going the other way, ${gain}.${tail}`;
    case 't_jet': return `Jet sweep to ${wr} for ${gain}.${tail}`;
    case 't_wildcat': return `Wildcat: direct snap to ${rb}, ${gain}.${tail}`;
    case 't_statue': return `Statue of Liberty: ${qb} fakes the throw and ${rb} takes it behind his back for ${gain}.${tail}`;
    case 't_hook': return (o.f & 1) ? `Hook and ladder: ${to} catches it and laterals to ${rb}, ${gain} in all.${tail}` : `Hook and ladder: the first pass to ${to} is incomplete. The lateral never happens.`;
    case 't_philly': return (o.f & 1) ? `Philly Special: ${rb} pitches to ${wr2}, who throws to ${qb} for ${gain}.${tail}` : `Philly Special: ${wr2}'s throw to ${qb} is off the mark.`;
    case 't_fakefg': return `Fake field goal: the holder keeps it, ${gain}.${tail}`;
    case 't_fakepunt': return `Fake punt, ${gain}.${tail}`;
  }
  return `${CALLS[id].label} for ${gain}.${tail}`;
}
function narrate(id, o, r, tgt, sc, mods = {}) {
  const L = sc.lineup, qb = short(L.qb.name), rb = short(L.rb.name), c = CALLS[id];
  const to = tgt ? short(tgt.name) : 'the back';
  const yds = n => `${Math.abs(n)} yard${Math.abs(n) === 1 ? '' : 's'}`;
  if (o.fg) return o.made ? `Field goal is good from ${G.prevYtg + 17}.` : `The ${G.prevYtg + 17}-yard try is no good.`;
  if (o.punt) return 'Punt away.';
  if (o.spike) return `${qb} spikes it. Clock stopped.`;
  if (o.kneel) return `${qb} takes a knee.`;
  if (o.flag) { const [y, kind] = o.pen; return `Flag: ${kind} on the ${y > 0 ? 'defense' : 'offense'}, ${Math.abs(y)} yards${o.pen[2] ? ', automatic first down' : o.pen[3] ? ', loss of down' : y < 0 ? ', replay the down' : ''}.`; }
  if (c.trick) return narrateTrick(id, o, r, tgt, sc);
  if (o.scramble) return `${qb} pulls it down and scrambles for ${r.yards < 0 ? 'a loss of ' + yds(r.yards) : r.yards === 0 ? 'no gain' : yds(r.yards)}.${(r.td ? ' Touchdown!' : '') + (r.oob ? ' Out of bounds.' : '') + (r.first && !r.td ? ' First down.' : '')}`;
  if (o.strip) return `${qb} is strip-sacked and the defense recovers.`;
  if (o.f & 16) return `${qb} is sacked for a loss of ${yds(o.y)}.`;
  if (o.int) return (o.f & 32) ? `${qb} is picked off and it's returned for a touchdown.` : `${qb}'s pass for ${to} is intercepted.`;
  if (o.fumble) return `${rb} fumbles and the defense recovers.`;
  const tail = (r.td ? ' Touchdown!' : '') + (r.oob ? ' Out of bounds.' : '') + (r.first && !r.td ? ' First down.' : '');
  if (id === 'hail') return (o.f & 1) ? `${qb} heaves it and ${to} hauls it in for ${yds(r.yards)}.${tail}` : `${qb}'s Hail Mary falls incomplete.`;
  if (id.startsWith('p_')) {
    const lead = mods.pa ? `${qb} fakes the handoff and ` : mods.roll ? `${qb} rolls out and ` : '';
    const where = mods.route ? ROUTES[mods.route].say : id === 'p_rb' ? 'on the screen' : c.depth ? `${c.depth} ${c.side === 'mid' ? 'over the middle' : 'to the sideline'}` : 'underneath';
    const who = lead || `${qb} `;
    if (!(o.f & 1)) return `${who}throws for ${to} ${where}: incomplete.`;
    return `${who}finds ${to} ${where} for ${o.y >= 0 ? yds(r.yards) : 'a loss of ' + yds(o.y)}.${tail}`;
  }
  const runner = c.qb ? qb : rb;
  const how = c.say || 'up the middle';
  const dir = mods.side && !['r_sneak', 'r_in', 'r_draw'].includes(id) ? ` to the ${mods.side === 'L' ? 'left' : 'right'}` : '';
  const lead = c.toss ? `${qb} pitches to ${rb}, who goes${dir} for ` : c.draw ? `${qb} drops, hands it late to ${rb}${dir} for ` : `${runner} runs ${how}${dir} for `;
  return `${lead}${r.yards < 0 ? 'a loss of ' + yds(r.yards) : r.yards === 0 ? 'no gain' : yds(r.yards)}.${tail}`;
}

function runPlay(id, tgt, mods = {}) {
  if (G.busy) return;
  const sc = G.sc;
  let st = { ...G.st, pers: G.pers };
  if (st.twoPt) return runTwoPoint(id, tgt, mods);
  if (CALLS[id].trick && !tgt) tgt = trickTarget(sc, CALLS[id]);
  // clock between snaps: timeout, or the tempo you chose (hustle to the line, neutral, milk it)
  if (st.pending > 0) {
    if (G.useTO && st.to > 0) { st.to -= 1; G.log.push({ sit: clock(st.T), text: `${T_(sc.off).abbr} timeout` }); }
    else { const off = runoff(st.pending, id === 'spike' ? 'hustle' : G.tempo); st.T = Math.max(0, st.T - off); if (G.tempo !== 'neutral' && id !== 'spike') { G.log.push({ sit: clock(st.T + off), text: G.tempo === 'milk' ? `Milk it: ${off}s run off before the snap` : `Hustle: snapped it ${off}s later` }); if (rand() < 0.3) G.tempoQuip = G.tempo; } }
  }
  G.useTO = false; st.pending = 0;
  if (st.T <= 0) { G.st = st; finish({ kind: 'time' }, st); return; }
  const opts = scoreOptions(st);
  const wpBefore = contValue(st);
  // sample an outcome
  const dist = outcomes(st, id, tgt, mods);
  let u = rand() * dist.reduce((a, o) => a + o.p, 0), o = dist[dist.length - 1];
  for (const d of dist) { u -= d.p; if (u <= 0) { o = d; break; } }
  // a flag on the play, at the real late-game rate; pre-snap flags wipe the play, live-ball flags bring it back
  let played = o;
  if (!o.fg && !o.punt && !o.spike && !o.kneel && rand() < R('pen', .057)) {
    const pre = rand() < R('pen_pre_share', .45);
    const poolKey = pre ? 'pen_pre' : (isPassId(id) ? 'pen_pass' : 'pen_run');
    const rows = D.pools[poolKey] || D.pools.pen_pre || [[-5, 'False Start', 0, 0]];
    const row = rows[Math.floor(rand() * rows.length)];
    o = { flag: true, pre, pen: row, y: 0, f: 0, src: null };
  }
  G.prevYtg = st.ytg;
  if (mods.route) st = { ...st, T: Math.max(0, st.T - ROUTES[mods.route].dur) };
  const { n, r } = apply(st, id, o);
  // the defender who made the play, by what happened
  const who = whoMadeIt(sc, id, o, r);
  mods.who = who;
  let text = narrate(id, o, r, tgt, sc, mods) + whoText(who, o, r);
  const sit = `${downText(st)} ${spot(st.ytg, sc)} ${clock(st.T)}`;
  G.log.push({ sit, text });
  const ev = expected(st, id, tgt, mods);
  const best = opts[0]?.ev ?? ev;
  const gap = best - ev;
  // You are graded on a cliff: green is the best call and nothing else. The coach gets a curve (see coachSnaps).
  const bestWord = ['✓ The best call on the board.', '✓ The best call. The model and you agree, which it will not admit.', '✓ Best call available. Frame it, it may not happen again.'];
  const nearWord = ['Close, not correct.', 'Not the call. Near it.', 'Almost. A coach gets fired for almost.'];
  const costWord = ['Wrong.', 'Wrong. The model winced.', 'Wrong. That one goes in the film session, with the lights on.'];
  const pts = Math.max(1, Math.round(gap * 100)), DF = diffFor();
  const grade = gap <= DF.green ? { cls: '', text: bestWord[rand() < 0.75 ? 0 : 1 + Math.floor(rand() * 2)], e: '🟩' }
    : gap <= DF.yellow ? { cls: 'mid', text: `${nearWord[Math.floor(rand() * nearWord.length)]} ${esc(opts[0].label)} was worth ${pts} more point${pts > 1 ? 's' : ''} of win chance.`, e: '🟨' }
    : { cls: 'low', text: `${costWord[rand() < 0.6 ? 0 : 1 + Math.floor(rand() * 2)]} ${esc(opts[0].label)} was worth ${pts} more points of win chance.`, e: '🟥' };
  G.grades.push(grade.e);
  const coachCall = G.st.snaps === 0 ? coachOpening(sc) : null;
  const callLabel = mods.route ? `${ROUTES[mods.route].label} to ${short(tgt.name)}` : tgt ? `${CALLS[id].label} to ${short(tgt.name)}` : CALLS[id].run && mods.side && !['r_sneak', 'r_in', 'r_draw'].includes(id) ? `${CALLS[id].label} ${mods.side === 'L' ? 'left' : 'right'}` : CALLS[id].label;
  G.snaps.push({ sit: `${downText(st)} · ${spot(st.ytg, sc)} · ${clock(st.T)}`, call: callLabel + (mods.pa ? ' (play action)' : mods.roll ? ' (roll out)' : ''), text, wpBefore, wpAfter: r.end ? endValue(n, r.end) : contValue(n), e: grade.e, gap, best: opts[0]?.label, kind: isPassId(id) ? 'pass' : (id.startsWith('r_') || CALLS[id].trick) ? 'run' : id, down: st.down, dist: st.dist, deep: CALLS[id].depth === 'deep' || id === 'hail' || (CALLS[id].trick && CALLS[id].base.startsWith('p_deep') && st.ytg > 20), short: mods.route ? ROUTES[mods.route].label : CALLS[id].label, trick: !!CALLS[id].trick });
  const wpAfter = r.end ? endValue(n, r.end) : contValue(n);
  const { badge, title } = badgeTitle(o, r, n);
  const g = o.src ? D.games[o.src[3]] : null;
  const quip = maybeQuip(o, r, id, mods, st) || (G.tempoQuip ? (G.tempoQuip === 'milk' ? pickQuip('milk') : pickQuip('hustle')) : null);
  G.tempoQuip = null;
  const newLast = {
    id, tgt, opts, coachCall, grade, wpBefore, wpAfter, text, title, badge, quip,
    good: r.td || (o.fg && o.made) || r.first, bad: !!(o.f & 8) || (o.fg && !o.made) || (o.f & 16),
    real: o.src && o.src[4] ? `${o.src[4]} (${T_(g[4]).school} ${g[5] ? 'vs' : 'at'} ${T_(g[3]).school}, ${g[0]})` : null,
  };
  G.last = null; G.anim = null; G.picking = null; G.pickerSlot = null; G.aim = null;
  // Animate the snap from the pre-snap state, then land the result
  const spec = animSpec(st, id, tgt, mods, o, played, r, n, who);
  G.busy = true; G.animating = true; G.st = st; renderPlay(); showFieldOnPhone();
  const box = $('#field');
  spec.clock = { from: st.T, to: n.T, el: $('.bug .clock .t') }; // the game clock ticks while the play runs
  spec.sound = soundCtx();
  if (window.Sound) { Sound.beginPlay(); if (spec.kind !== 'flag') Sound.play('snap'); }
  const run = spec.kind === 'punt' ? Promise.resolve() : PlayAnim.play(box, spec);
  run.then(() => {
    // the animation's popups already set off the crowd; this covers a skipped or popup-less play
    if (window.Sound) Sound.result(o.flag ? 'flag' : r.td ? 'td' : o.fg ? (o.made ? 'good' : 'bad') : (o.f & 8) ? 'turnover' : (o.f & 16) || r.yards <= -2 ? 'bad' : r.yards >= 15 ? 'big' : r.first ? 'first' : r.incomplete ? 'inc' : null, spec.sound);
    G.animating = false; G.busy = false; G.st = n; G.last = newLast;
    if (r.end) { renderPlay(); G.busy = true; setTimeout(() => { G.busy = false; finish(r.end, n); }, 900); }
    else renderPlay();
  });
}

// the defender who made the play, by what happened
function whoMadeIt(sc, id, o, r) {
  const isPassPlay = isPassId(id) && !o.scramble && !o.blown;
  return o.flag ? null : o.strip || (o.f & 16) ? pickDefender(sc, 'sack') : o.int ? pickDefender(sc, 'int') : o.fumble ? pickDefender(sc, 'run')
    : (r.incomplete && !o.spike) ? ((o.src && o.src[4] || '').toLowerCase().includes('broken up') ? pickDefender(sc, 'pbu') : null)
    : (!r.td && !r.oob && !o.fg && !o.spike && !o.kneel && !o.punt) ? pickDefender(sc, isPassPlay ? 'pass' : 'run') : null;
}
function whoText(who, o, r) {
  if (!who) return '';
  return o.strip || (o.f & 16) ? ` ${defName(who)} got home.` : o.int ? ` ${defName(who)} with the pick.` : o.lateralLost ? ` ${defName(who)} fell on it.` : o.fumble ? ` ${defName(who)} forced it.` : r.incomplete ? ` ${defName(who)} broke it up.` : ` Tackle by ${defName(who)}.`;
}
function badgeTitle(o, r, n) {
  const badge = o.flag ? 'FLAG' : r.td ? 'TD' : o.fg ? (o.made ? 'FG' : 'NO') : (o.f & 8) ? 'TO' : o.spike ? 'SPK' : (r.incomplete ? 'INC' : (r.yards > 0 ? '+' : '') + r.yards);
  let title = o.flag ? `${o.pen[1]}, ${o.pen[0] > 0 ? 'defense' : 'offense'}` : r.td ? 'Touchdown' : o.fg ? (o.made ? 'Field goal good' : 'Field goal missed') : o.int ? 'Intercepted' : o.strip ? 'Strip sack' : o.fumble ? 'Fumble' : (o.f & 16) ? 'Sacked' : o.spike ? 'Spiked' : r.incomplete ? 'Incomplete' : r.first ? 'First down' : o.blown ? 'Blown up' : (r.end?.why || (r.yards === 0 ? 'No gain' : r.yards < 0 ? `Loss of ${-r.yards}` : `${r.yards} yard${r.yards === 1 ? '' : 's'}`));
  if (r.end?.kind === 'opp' && !o.int && !o.fumble && !o.strip && !o.fg) title = r.end.why;
  if (!r.end && !o.spike && !o.flag) title += n.pending > 0 ? ', clock running' : ', clock stopped';
  return { badge, title };
}
// What the animation needs to know: the play that happened on the field (a live-ball flag shows the play, then the flag)
function animSpec(st, id, tgt, mods, o, played, r, n, who) {
  const sc = G.sc, c = CALLS[id], isPass = isPassId(id);
  const shown = o.flag && !o.pre ? played : o;
  const srcText = shown.src && shown.src[4] ? shown.src[4].toLowerCase() : '';
  const shownR = o.flag && !o.pre ? apply(st, id, played).r : r;
  const finalYtg = o.flag ? (o.pre ? st.ytg : clamp(st.ytg - (shownR.yards || 0), 0, 100)) : r.end?.kind === 'opp' ? clamp(100 - r.end.oppYtg, 0, 100) : n.ytg;
  const trickDeep = c.trick && isPass && c.base.startsWith('p_deep') && st.ytg > 20;
  return {
    kind: o.flag && o.pre ? 'flag' : shown.fg ? 'fg' : shown.punt ? 'punt' : shown.spike ? 'spike' : shown.kneel ? 'kneel' : (isPass && (!shown.scramble || c.trick)) ? 'pass' : 'run',
    flag: o.flag ? { pre: o.pre, kind: o.pen[1], onDefense: o.pen[0] > 0 } : null, look: st.look || 'base', scramble: !!shown.scramble,
    air: shown.src && shown.src.length > 5 && shown.src[5] != null ? shown.src[5] : null,
    los: 100 + (100 - st.ytg) * 10, routes: ROUTES, recs: receivers(sc).map(x => ({ ...x, route: trickRoute(id, x, tgt) || routeFor(x) })),
    qb: sc.lineup.qb, rb: sc.lineup.rb, offColor: T_(sc.off).color, offAlt: T_(sc.off).alt, defColor: T_(sc.dfn).color, defAlt: T_(sc.dfn).alt,
    targetSlot: tgt ? tgt.slot : null, rbTarget: id === 'p_rb', depth: c.depth || (id === 'p_rb' ? 'short' : c.trick && isPass ? (trickDeep ? 'deep' : 'short') : null), hail: id === 'hail',
    pa: !!mods.pa, roll: !!mods.roll, sack: !!(shown.f & 16) || (!!shown.blown && isPass), strip: !!shown.strip || (!!shown.blown && !!shown.fumble && isPass), int: !!shown.int, intTd: !!(shown.f & 32), complete: !!(shown.f & 1) || !!shown.lateralLost,
    td: shownR.td, oob: shownR.oob, yards: shownR.yards, first: shownR.first, finalYtg: shownR.td ? 0 : finalYtg, fumble: !!shown.fumble,
    outside: c.lane === 'out' || (c.trick && c.base === 'r_out'), qbRun: !!c.qb || !!shown.scramble, sneak: id === 'r_sneak', made: !!shown.made,
    runType: c.run ? id : c.trick && !isPass ? c.base : null, side: mods.side === 'L' ? -1 : 1, aim: mods.aim || null, lane: mods.lane || c.lane || null,
    dropped: !(shown.f & 1) && !shown.int && srcText.includes('drop'), pbu: srcText.includes('broken up'), contested: srcText.includes('contested'),
    hurried: srcText.includes('hurried') || srcText.includes('pressure'),
    trick: c.trick ? id : null, blown: !!shown.blown, lateral: !!shown.lateral, lateralLost: !!shown.lateralLost, passerSlot: id === 't_philly' ? phillyThrower(sc).slot : null,
    twoPt: !!st.twoPt,
    dlineup: sc.dlineup || [], whoNum: who ? who.num : null,
  };
}

// ---------- the two-point try: a real snap from the 3 ----------
// Every option's conversion chance comes from the real goal-line pools, then the board is anchored so its average
// is the measured college two-point rate; the relative order of the calls is what the pools say.
function twoOptions(st) {
  const sc = st.sc, rows = [];
  const succ = (id, tgt) => { let p = 0, tot = 0; for (const o of outcomes(st, id, tgt)) { tot += o.p; if (!(o.f & 8) && (o.y >= st.ytg || (o.f & 2))) p += o.p; } return tot > 0 ? p / tot : 0; };
  for (const id of Object.keys(CALLS)) {
    if (!available(st, id) || CALLS[id].pick) continue;
    const c = CALLS[id];
    if (c.depth) { for (const rc of receivers(sc).filter(r => r.pos !== 'RB')) rows.push({ id, tgt: rc, p: succ(id, rc), label: `${c.label} to ${short(rc.name)}` }); }
    else if (id === 'p_rb') { const rb = receivers(sc).find(r => r.pos === 'RB'); if (rb) rows.push({ id, tgt: rb, p: succ(id, rb), label: `Screen to ${short(rb.name)}` }); }
    else rows.push({ id, p: succ(id), label: c.label });
  }
  const core = rows.filter(r => !CALLS[r.id].trick);
  const mean = core.reduce((a, r) => a + r.p, 0) / Math.max(1, core.length);
  const k = mean > 0 ? TWO / mean : 1;
  for (const r of rows) r.p = clamp(r.p * k, 0.02, 0.95);
  return rows.sort((a, b) => b.p - a.p);
}
function startTwoPoint(n) {
  G.twoPt = { n: { ...n } };
  G.st = { ...n, ytg: 3, down: 1, dist: 3, pending: 0, look: null, twoPt: true };
  G.last = null; G.anim = null; G.picking = null; G.useTO = false;
  renderPlay();
}
function runTwoPoint(id, tgt, mods = {}) {
  const sc = G.sc, st = { ...G.st, pers: G.pers }, base = G.twoPt.n;
  if (CALLS[id].trick && !tgt) tgt = trickTarget(sc, CALLS[id]);
  const a2 = afterScore(base, base.s + 2).best, a0 = afterScore(base, base.s).best;
  const opts = twoOptions(st).map(o => ({ ...o, ev: o.p * a2 + (1 - o.p) * a0 }));
  const mine = opts.find(o => o.id === id && (!o.tgt || !tgt || o.tgt.slot === tgt.slot)) || { p: TWO, ev: TWO * a2 + (1 - TWO) * a0 };
  const ok = rand() < mine.p;
  // then a real snap that matches: a conversion, or a stop
  const conv = o => !(o.f & 8) && (o.y >= st.ytg || (o.f & 2));
  const all = outcomes(st, id, tgt, mods).filter(o => o.p > 0);
  let rows = all.filter(o => conv(o) === ok);
  if (!rows.length) rows = ok ? [{ p: 1, y: 3, f: isPassId(id) ? 3 : 2, src: null }] : [{ p: 1, y: isPassId(id) ? 0 : 1, f: 0, src: null }];
  let u = rand() * rows.reduce((a, o) => a + o.p, 0), o = rows[rows.length - 1];
  for (const d of rows) { u -= d.p; if (u <= 0) { o = d; break; } }
  G.prevYtg = 3;
  const { n, r } = apply(st, id, o);
  const who = whoMadeIt(sc, id, o, r);
  mods.who = who;
  const text = (narrate(id, o, r, tgt, sc, mods) + whoText(who, o, r)).replace(/ Touchdown!/g, ' Two points!');
  G.log.push({ sit: '2PT', text: (ok ? 'Two-point try is good. ' : 'Two-point try fails. ') + text });
  const gap = opts[0].ev - mine.ev, pts = Math.max(1, Math.round(gap * 100)), DF = diffFor();
  const grade = gap <= DF.green ? { cls: '', text: '✓ The best call on the board.', e: '🟩' }
    : gap <= DF.yellow ? { cls: 'mid', text: `Close, not correct. ${esc(opts[0].label)} was worth ${pts} more point${pts > 1 ? 's' : ''} of win chance.`, e: '🟨' }
    : { cls: 'low', text: `Wrong. ${esc(opts[0].label)} was worth ${pts} more points of win chance.`, e: '🟥' };
  G.grades.push(grade.e);
  const callLabel = tgt ? `${CALLS[id].label} to ${short(tgt.name)}` : CALLS[id].label;
  const wpBefore = TWO * a2 + (1 - TWO) * a0, wpAfter = ok ? a2 : a0;
  G.snaps.push({ sit: 'Two-point try · from the 3', call: callLabel, text, wpBefore, wpAfter, e: grade.e, gap, best: opts[0].label, kind: isPassId(id) ? 'pass' : 'run', down: 1, dist: 3, deep: false, short: CALLS[id].label, trick: !!CALLS[id].trick, twoPt: true });
  const g = o.src ? D.games[o.src[3]] : null;
  const quip = maybeQuip(o, r, id, mods, st);
  const r2 = { ...r, td: ok, first: false };
  const { badge, title } = badgeTitle(o, r2, { pending: 0 });
  const newLast = { id, tgt, opts, coachCall: null, grade, wpBefore, wpAfter, text, title: ok ? 'Two-point conversion good' : `No good: ${title.replace(/, clock (running|stopped)$/, '')}`, badge: ok ? '+2' : badge === 'TD' ? 'NO' : badge, quip,
    good: ok, bad: !ok, real: o.src && o.src[4] ? `${o.src[4]} (${T_(g[4]).school} ${g[5] ? 'vs' : 'at'} ${T_(g[3]).school}, ${g[0]})` : null };
  G.last = null; G.anim = null; G.picking = null; G.pickerSlot = null; G.aim = null;
  const spec = animSpec(st, id, tgt, mods, o, o, r2, { ...n, ytg: ok ? 0 : Math.max(1, 3 - (r.yards || 0)) }, who);
  spec.td = ok; spec.finalYtg = ok ? 0 : clamp(3 - (r.yards || 0), 1, 20); spec.twoPt = true;
  G.busy = true; G.animating = true; G.st = st; renderPlay(); showFieldOnPhone();
  const box = $('#field');
  spec.sound = soundCtx();
  if (window.Sound) { Sound.beginPlay(); Sound.play('snap'); }
  PlayAnim.play(box, spec).then(() => {
    if (window.Sound) Sound.result(ok ? 'td' : (o.f & 8) ? 'turnover' : 'bad', spec.sound);
    const n2 = { ...base, os: base.os + (ok ? 2 : 0), s: base.s + (ok ? 2 : 0), snaps: base.snaps + 1 };
    G.twoPt = null; G.animating = false; G.busy = false; G.st = n2; G.last = newLast;
    renderPlay(); G.busy = true;
    setTimeout(() => { G.busy = false; kickChoice(n2, ok ? 'Two-point conversion good.' : 'Two-point try failed.'); }, 900);
  });
}

// ---------- end of drive ----------
function finish(end, n) {
  G.st = n; G.anim = null;
  if (end.kind === 'td') return patChoice(n);
  if (end.kind === 'fg') return kickChoice(n, 'Field goal is good.');
  conclude(end, n);
}
function patChoice(n) {
  const kick = XP * afterScore(n, n.s + 1).best + (1 - XP) * afterScore(n, n.s).best;
  const two = TWO * afterScore(n, n.s + 2).best + (1 - TWO) * afterScore(n, n.s).best;
  sideDecision(n, 'Touchdown! Now the extra point.', [
    { label: 'Kick the extra point', sub: `${pct(XP)} conversion · win chance ${pct(kick)}`, go: () => { const ok = rand() < XP; n.os += ok ? 1 : 0; n.s += ok ? 1 : 0; G.log.push({ sit: 'PAT', text: ok ? 'Extra point is good.' : 'Extra point is no good.' }); kickChoice(n, ok ? 'Extra point good.' : 'Extra point missed.'); } },
    { label: 'Go for two', sub: `${pct(TWO)} conversion · win chance ${pct(two)} · you call the play from the 3`, go: () => startTwoPoint(n) },
  ]);
}
function kickChoice(n, msg) {
  if (n.T <= 0) return conclude({ kind: 'time' }, n);
  const a = afterScore(n, n.s);
  if (n.s > 0 || a.onside <= a.deep + 0.002 && n.s >= 0) return conclude({ kind: 'kick', oppYtg: 75 }, n, msg);
  sideDecision(n, `${msg} Kickoff decision.`, [
    { label: 'Kick it deep', sub: `They start at their 25 · win chance ${pct(a.deep)}`, go: () => conclude({ kind: 'kick', oppYtg: 75 }, n, msg) },
    { label: 'Onside kick', sub: `About ${pct(ONSIDE)} recovered in college · win chance ${pct(a.onside)}`, go: () => {
      n.T = Math.max(0, n.T - 4);
      if (rand() < ONSIDE) { G.log.push({ sit: clock(n.T), text: 'Onside kick recovered!' }); Object.assign(n, { ytg: 55, down: 1, dist: 10, pending: 0 }); G.st = n; G.last = null; G.anim = null; renderPlay(); toast('You recovered the onside kick!'); }
      else { G.log.push({ sit: clock(n.T), text: 'Onside kick recovered by the defense.' }); conclude({ kind: 'opp', oppYtg: 45, why: 'Onside kick recovered by the defense' }, n, msg); }
    } },
  ]);
}
function sideDecision(n, msg, choices) {
  G.st = n; G.picking = null; renderPlay();
  const side = $('#side');
  side.innerHTML = resultHTML() + `<div class="h">${esc(msg)}</div><div class="calls">${choices.map((c, i) => `<button class="call" data-i="${i}"><b>${esc(c.label)}</b><small>${esc(c.sub)}</small></button>`).join('')}</div>`;
  side.querySelectorAll('[data-i]').forEach(b => b.onclick = () => choices[+b.dataset.i].go());
}
function conclude(end, n, msg) {
  let wp, desc;
  if (end.kind === 'time') { wp = wpModel(n.s, 0, 50, 1, 10, 0, 0, n.elo); desc = n.s > 0 ? 'Clock hits zero. You win.' : n.s < 0 ? 'Clock hits zero. You lose.' : 'Clock hits zero. Headed to overtime.'; }
  else if (end.kind === 'kick') { wp = oppBall(n, n.s, n.T, end.oppYtg); desc = `${msg || ''} ${T_(G.sc.dfn).school} gets the ball back with ${clock(n.T)} left.`.trim(); }
  else { wp = oppBall(n, n.s, n.T, end.oppYtg); desc = `${end.why}. ${T_(G.sc.dfn).school} takes over with ${clock(n.T)} left.`; }
  const scored = n.os - G.sc.os;
  G.done = { wp, desc, os: n.os, ds: n.ds, T: n.T, scored, snaps: n.snaps };
  if (G.mode === 'survival') { // the rest of the game plays out at the model's odds: win to stay alive
    const S = survState(G.survKind || 'free'), cur = S.cur || (S.cur = { streak: 0, drives: [], over: false });
    const won = wp >= 0.999 ? true : wp <= 0.001 ? false : rand() < wp;
    cur.drives.push({ sid: G.sc.id, wp, cwp: G.sc.cwp, won, round: G.no }); cur.next = null;
    if (won) { cur.streak += 1; S.best = Math.max(S.best || 0, cur.streak); } else { cur.over = true; S.runs = (S.runs || 0) + 1; }
    G.done.surv = { won, round: G.no, streak: cur.streak, best: S.best };
  }
  G.done.trophy = judgeTrophy();
  if (G.done.trophy) { (store.trophies ||= { saban: [], cignetti: [] })[G.done.trophy].push({ no: G.no, mode: G.mode, date: new Date().toISOString().slice(0, 10), game: gameLabel(G.sc).title }); }
  if (G.mode === 'daily' || isHardMode(G.mode)) {
    // the first attempt is the record; a retry only counts how many times you came back
    if (!G.retry) (store[G.mode] ||= {})[G.no] = { done: G.done, grades: G.grades, log: G.log, snaps: G.snaps, coachWp: G.sc.cwp, sid: G.sc.id };
    else { const rec = (store[G.mode] ||= {})[G.no]; if (rec) rec.retries = (rec.retries || 0) + 1; }
  }
  else { store.practice[G.sc.id] = { wp, coachWp: G.sc.cwp }; }
  saveStore();
  track('drive_done', { mode: G.mode, wp: Math.round(wp * 100), beat_coach: wp >= G.sc.cwp ? 1 : 0 });
  if (window.Sound) { Sound.play('final', { ...soundCtx(), won: wp >= 0.5 }); Sound.ambience(0.12); }
  renderFinal();
  submitResult();
}
// ---------- real-player leaderboard (needs the worker's D1 table; silently skipped until it exists) ----------
function playerToken() { let t = ''; try { t = localStorage.getItem('cfb2md:token') || ''; if (!t) { t = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12); localStorage.setItem('cfb2md:token', t); } } catch { t = 'anon' + Math.random().toString(36).slice(2, 10); } return t; }
async function submitResult() {
  if (!(G.mode === 'daily' || isHardMode(G.mode)) || !G.no || G.retry || UNLOCK_API.includes('REPLACE_ME')) return;
  try {
    const r = await unlockApi('/lb/submit', { day: G.no, mode: G.mode, wp: G.done.wp.toFixed(4), token: playerToken() });
    if (r && r.ok && r.n) showLeaderboard(r);
  } catch { /* leaderboard unavailable */ }
}
function showLeaderboard(r) {
  const el = $('#lbCard'); if (!el) return;
  const d = G.done, p = Math.round(r.below / r.n * 100);
  el.innerHTML = `<div class="who">Vs real players today</div><div class="big">${r.n < 5 ? `${r.n}<small>played so far</small>` : `${p}%<small>beaten</small>`}</div><div class="end">${r.n < 5 ? 'Not enough results yet to rank you. Come back tonight.' : `Your ${pct(d.wp)} beat ${r.below} of ${r.n} people who played this drive today${r.median != null ? ` (median ${pct(r.median)})` : ''}. ${r.wins} finished at 50% or better.`}</div>${r.bins ? `<div class="hist">${(() => { const mx = Math.max(1, ...r.bins); return r.bins.map((b, i) => `<i style="height:${Math.max(2, b / mx * 100)}%" class="${Math.min(9, Math.floor(d.wp * 10)) === i ? 'me' : ''}"></i>`).join(''); })()}</div>` : ''}`;
  el.hidden = false;
}

// ---------- simulated play-callers ----------
// A few hundred synthetic college play-callers run this exact drive through the same engine. Each has a temperament:
// how sharply it prefers the best option (temp), a run/pass lean, how quickly it burns timeouts. Your final win
// chance is ranked against theirs.
function simulateCallers(sc, N, onProgress, onDone) {
  const results = []; let i = 0;
  const one = () => {
    const [t0, t1] = diffFor().temp; // how sharp the room is: Saban's room barely misses, the free room makes human mistakes
    const temp = t0 + rand() * (t1 - t0), lean = (rand() - 0.5) * 0.04, toProb = 0.4 + rand() * 0.6;
    let st = { sc, s: sc.os - sc.ds, os: sc.os, ds: sc.ds, T: sc.secs, ytg: sc.ytg, down: sc.down, dist: sc.dist, to: sc.to, dto: sc.dto, elo: sc.elo, pending: 0, snaps: 0, look: null, pers: '11' };
    for (let guard = 0; guard < 40; guard++) {
      if (st.pending > 0) { if (st.to > 0 && st.T < 75 && rand() < toProb) st.to -= 1; else st.T = Math.max(0, st.T - st.pending); st.pending = 0; }
      if (st.T <= 0) return wpModel(st.s, 0, 50, 1, 10, 0, 0, st.elo);
      st.look = sampleLook(st, '11');
      const opts = scoreOptions(st);
      if (!opts.length) return contValue(st);
      const w = opts.map(o => Math.exp((o.ev + (o.id.startsWith('r_') ? lean : o.id.startsWith('p_') ? -lean : 0)) / temp));
      const tot = w.reduce((a, b) => a + b, 0); let u = rand() * tot, pick = opts[0];
      for (let k = 0; k < opts.length; k++) { u -= w[k]; if (u <= 0) { pick = opts[k]; break; } }
      const dist = outcomes(st, pick.id, pick.tgt);
      let v = rand() * dist.reduce((a, o) => a + o.p, 0), o = dist[dist.length - 1];
      for (const d of dist) { v -= d.p; if (v <= 0) { o = d; break; } }
      if (!o.fg && !o.punt && !o.spike && !o.kneel && rand() < R('pen', .057)) {
        const pre = rand() < R('pen_pre_share', .45);
        const rows = D.pools[pre ? 'pen_pre' : (isPassId(pick.id) ? 'pen_pass' : 'pen_run')] || [[-5, 'False Start', 0, 0]];
        o = { flag: true, pre, pen: rows[Math.floor(rand() * rows.length)], y: 0, f: 0, src: null };
      }
      const { n, r } = apply(st, pick.id, o);
      if (!r.end) { st = n; continue; }
      const end = r.end;
      if (end.kind === 'td') {
        const kick = XP * afterScore(n, n.s + 1).best + (1 - XP) * afterScore(n, n.s).best, two = TWO * afterScore(n, n.s + 2).best + (1 - TWO) * afterScore(n, n.s).best;
        const goTwo = two > kick + 0.01; const ok = rand() < (goTwo ? TWO : XP); const add = ok ? (goTwo ? 2 : 1) : 0; n.os += add; n.s += add;
      }
      if (end.kind === 'td' || end.kind === 'fg') {
        if (n.T <= 0) return wpModel(n.s, 0, 50, 1, 10, 0, 0, n.elo);
        const a = afterScore(n, n.s);
        if (n.s < 0 && a.onside > a.deep + 0.002) {
          n.T = Math.max(0, n.T - 4);
          if (rand() < ONSIDE) { st = { ...n, ytg: 55, down: 1, dist: 10, pending: 0, look: null }; continue; }
          return oppBall(n, n.s, n.T, 45);
        }
        return oppBall(n, n.s, n.T, 75);
      }
      return endValue(n, end);
    }
    return contValue(st);
  };
  const chunk = () => {
    const t0 = performance.now();
    while (i < N && performance.now() - t0 < 40) { results.push(one()); i++; }
    if (onProgress) onProgress(i, N);
    if (i < N) setTimeout(chunk, 0); else onDone(results);
  };
  setTimeout(chunk, 0);
}

// ---------- which real head coach you call it like ----------
function resemblance() {
  if (!D.tend) return null;
  const plays = G.snaps.filter(s => s.kind === 'pass' || s.kind === 'run');
  if (!plays.length) return null;
  const rate = (arr, k = 3, prior = 0.52) => { const n = arr.length, p = arr.filter(s => s.kind === 'pass').length; return (k * prior + p) / (k + n); };
  const early = plays.filter(s => s.down <= 2), pd = plays.filter(s => s.down >= 3 || s.dist >= 7);
  const me = { pass: rate(plays), early: rate(early, 3, 0.5), pd: rate(pd, 3, 0.62), deep: plays.length ? plays.filter(s => s.deep).length / plays.length : 0 };
  const W = [1, 0.8, 0.6];
  const ranked = Object.entries(D.tend).map(([coach, t]) => {
    const d = Math.sqrt(W[0] * (me.pass - t[1]) ** 2 + W[1] * (me.early - t[2]) ** 2 + W[2] * (me.pd - t[3]) ** 2);
    return { coach, school: t[0], pass: t[1], early: t[2], pd: t[3], trail: t[4], ex: t[5], d };
  }).sort((a, b) => a.d - b.d);
  return { me, best: ranked[0], next: ranked.slice(1, 3), n: plays.length };
}

// ---------- comparison with the real coach ----------
const CALL_WORD = { p_short_side: 'Short pass, sideline', p_short_mid: 'Short pass, middle', p_deep_side: 'Deep pass, sideline', p_deep_mid: 'Deep pass, middle', p_rb: 'Pass to the back', pass: 'Pass', r_in: 'Inside run', r_out: 'Outside run', r_qb: 'QB run', r_sneak: 'QB sneak', run: 'Run', spike: 'Spike', kneel: 'Kneel', fg: 'Field goal', punt: 'Punt', timeout: 'Timeout', penalty: 'Penalty', other: 'Play' };
// the coach's real call graded by the same board you faced, but on a curve: within 2 points counts as the best call
function gradeCoachCall(sc, p, to, dto) {
  // a feed that only says "pass" or "run" still gets graded: against the best option of that family (generous, like the curve)
  const generic = p.c === 'pass' ? 'p_' : p.c === 'run' ? 'r_' : null;
  const id = generic || ['timeout', 'penalty', 'other'].includes(p.c) || !CALLS[p.c] ? null : p.c;
  if (!generic && !id) return null;
  if (p.dist == null || p.y == null) return null;
  const st = { sc, s: sc.os - sc.ds, os: sc.os, ds: sc.ds, T: p.s, ytg: p.y, down: p.d, dist: p.dist, to, dto, elo: sc.elo, pending: 0, snaps: 0, look: 'base', pers: '11' };
  if (id && !available(st, id)) return null;
  let opts; try { opts = scoreOptions(st); } catch { return null; }
  if (!opts.length) return null;
  const mine = opts.filter(o => generic ? o.id.startsWith(generic) : o.id === id);
  const ev = mine.length ? Math.max(...mine.map(o => o.ev)) : null;
  if (ev == null) return null;
  const gap = opts[0].ev - ev;
  return { gap, e: gap <= 0.02 ? '🟩' : gap <= 0.06 ? '🟨' : '🟥', best: opts[0].label };
}
function coachSnaps(sc) {
  // the real drive, with our win-probability model run at every snap so both sides are judged the same way
  let to = sc.to, dto = sc.dto; const out = [];
  for (const p of sc.real) {
    if (p.c === 'timeout') { if (p.t.toLowerCase().includes(T_(sc.off).school.toLowerCase().split(' ')[0])) to = Math.max(0, to - 1); else dto = Math.max(0, dto - 1); out.push({ kind: 'timeout', text: p.t, sit: p.s != null ? clock(p.s) : '' }); continue; }
    if (p.d == null || p.s == null) { out.push({ kind: p.c, text: p.t, sit: p.s != null ? clock(p.s) : '' }); continue; }
    const wp = wpModel(sc.os - sc.ds, p.s, p.y, p.d, p.dist, to, dto, sc.elo);
    const g = gradeCoachCall(sc, p, to, dto);
    out.push({ kind: p.c === 'timeout' ? 'timeout' : p.c.startsWith('p_') || p.c === 'pass' ? 'pass' : p.c.startsWith('r_') || p.c === 'run' ? 'run' : p.c, call: CALL_WORD[p.c] || 'Play', text: p.t, sit: `${ord(p.d)} & ${p.dist} · ${p.y === 50 ? 'midfield' : p.y > 50 ? T_(sc.off).abbr + ' ' + (100 - p.y) : T_(sc.dfn).abbr + ' ' + p.y} · ${clock(p.s)}`, wpBefore: wp, e: g ? g.e : null, gap: g ? g.gap : null });
  }
  return out;
}
// Trophies. A Saban is a perfect game: every snap the best call, at least five snaps, and you beat the coach.
// A Cignetti is every snap green or yellow with at least 60% best calls, and you beat the coach. Rare on purpose.
function judgeTrophy() {
  if (!G.done || !G.snaps.length || G.mode === 'practice' || G.mode === 'survival' || G.retry) return null;
  // judged on the cliff whatever curve the screen used: the exact best call is green, 3 points off is red
  const cliff = DIFF.saban, gapOf = s => s.gap != null ? s.gap : (s.e === '🟩' ? 0 : s.e === '🟨' ? .02 : .05);
  const n = G.snaps.length, greens = G.snaps.filter(s => gapOf(s) <= cliff.green).length, reds = G.snaps.filter(s => gapOf(s) > cliff.yellow).length;
  const beat = G.done.wp >= G.sc.cwp;
  if (n >= 5 && greens === n && beat) return 'saban';
  if (n >= 4 && reds === 0 && greens / n >= 0.6 && beat) return 'cignetti';
  return null;
}
const TROPHY = {
  saban: { label: 'A Saban', line: 'A perfect game. Every call the best call, and you beat the coach. This gets handed out about as often as a shiny.', stamp: 'SABAN GAME' },
  cignetti: { label: 'A Cignetti', line: 'No wrong calls, mostly right ones, and you beat the coach. Google yourself.', stamp: 'CIGNETTI GAME' },
};
function comparison(sc) {
  const mine = G.snaps, theirs = coachSnaps(G.sc0 || sc); // the coach is graded with the lineup he actually had
  const count = (arr, k) => arr.filter(s => s.kind === k).length;
  const theirPlays = theirs.filter(s => s.wpBefore != null);
  const myBest = mine.filter(s => s.e === '🟩').length, myGraded = mine.length;
  const cGraded = theirPlays.filter(s => s.e), cBest = cGraded.filter(s => s.e === '🟩').length;
  const subs = (G.subs || []).length;
  const summary = `<div><b>You</b>: ${count(mine, 'pass')} pass${count(mine, 'pass') === 1 ? '' : 'es'}, ${count(mine, 'run')} run${count(mine, 'run') === 1 ? '' : 's'}${count(mine, 'spike') ? `, ${count(mine, 'spike')} spike` : ''}${count(mine, 'fg') ? ', a field goal try' : ''}${subs ? `, ${subs} sub${subs === 1 ? '' : 's'}` : ''} · ${G.done.snaps} snaps · ended with ${clock(G.done.T)} left</div>
    <div><b>${esc(sc.coach)}</b>: ${count(theirPlays, 'pass')} pass${count(theirPlays, 'pass') === 1 ? '' : 'es'}, ${count(theirPlays, 'run')} run${count(theirPlays, 'run') === 1 ? '' : 's'}${count(theirs, 'timeout') ? `, ${count(theirs, 'timeout')} timeout${count(theirs, 'timeout') > 1 ? 's' : ''}` : ''}${count(theirPlays, 'fg') ? ', a field goal try' : ''} · ${theirPlays.length} snaps · ${esc(resultWord(sc).toLowerCase())}</div>
    <div class="scoreline"><b>Best call on the board:</b> you ${myBest} of ${myGraded}${cGraded.length ? ` · ${esc(sc.coach)} ${cBest} of ${cGraded.length}` : ''}. <span class="muted">${esc(diffFor().curve)}</span></div>`;
  const n = Math.max(mine.length, theirs.length);
  let rows = '';
  for (let i = 0; i < n; i++) {
    const a = mine[i], b = theirs[i];
    rows += `<div class="cell ${a ? '' : 'empty'}">${a ? `<div class="sit">${esc(a.sit)}</div><div class="call">${a.e} ${esc(a.call)}</div><div class="res">${esc(a.text)}</div><div class="wpl">${pct(a.wpBefore)} → <b>${pct(a.wpAfter)}</b></div>` : ''}</div>`;
    rows += `<div class="cell ${b ? '' : 'empty'}">${b ? `<div class="sit">${esc(b.sit)}</div><div class="call">${b.e ? b.e + ' ' : ''}${esc(b.call || (b.kind === 'timeout' ? 'Timeout' : 'Play'))}</div><div class="res">${esc(b.text)}</div>${b.wpBefore != null ? `<div class="wpl">${pct(b.wpBefore)}${theirs[i + 1] && theirs[i + 1].wpBefore != null ? ` → <b>${pct(theirs[i + 1].wpBefore)}</b>` : ` → <b>${pct(sc.cwp)}</b>`}</div>` : ''}` : ''}</div>`;
  }
  let turn = '';
  const swing = mine.reduce((best, s) => Math.abs(s.wpAfter - s.wpBefore) > Math.abs(best.wpAfter - best.wpBefore) ? s : best, mine[0]);
  if (swing) turn = `Your biggest swing: ${esc(swing.call)} (${pct(swing.wpBefore)} → ${pct(swing.wpAfter)}). ${esc(swing.text)}`;
  return { summary, rows, turn };
}
function shareText() {
  const sc = G.sc, d = G.done, gl = gameLabel(sc), saban = isHardMode(G.mode);
  const verdict = d.wp - sc.cwp > 0.02 ? `I beat ${sc.coach}` : Math.abs(d.wp - sc.cwp) <= 0.02 ? `Dead even with ${sc.coach}` : `${sc.coach} got me`;
  const surv = G.mode === 'survival' && d.surv ? `\nSurvival · ${d.surv.won ? `survived round ${d.surv.round}` : `run over after ${d.surv.streak}`}` : '';
  return `${verdict} ${pct(d.wp)}–${pct(sc.cwp)}${d.trophy ? ` · ${TROPHY[d.trophy].stamp}` : ''}${G.retry ? ' (retry)' : ''}\nNCAA Two-Minute Drill${saban ? ' · ' + HARD_MODES[G.mode].tag : ''}${G.no && G.mode !== 'survival' ? ' #' + G.no : ''} · ${gl.title} (${sc.year})${saban ? ` · started at ${pct(sc.wp0)}` : ''}${surv}\n${G.grades.join('')}\nncaa2mindrill.com`;
}
// 1200-wide share card, in the look people already screenshot from the NFL game: the score, the checkmark grid,
// the YOU VS COACH box, the real-game footnote - plus who you called it like, which theirs doesn't have.
// Shared cards get looked at about 350px wide on a phone, so no text on it is under 34px, and the card
// grows taller with the grid rather than shrinking anything.
function drawShareCard(cv) {
  const sc = G.sc, d = G.done, gl = gameLabel(sc), off = T_(sc.off), def = T_(sc.dfn);
  const UI = '"Saira Condensed", "Arial Narrow", sans-serif', BODY = '"Barlow", "Segoe UI", sans-serif';
  const CHALK = '#eef2f6', MUTED = '#a7b5c8', AMBER = '#e9b949', GREEN = '#4cc27a', RED = '#ff8d7e';
  const W = 1200;
  // the grid: one tile per call, the biggest tiles that fit in two rows
  const marks = G.snaps.length ? G.snaps.map(x => x.e) : G.grades.slice();
  const per = (t, g) => Math.floor((W - 220 + g) / (t + g));
  const [tile, gap] = [[56, 10], [46, 8], [38, 7]].find(([t, g]) => Math.ceil(marks.length / per(t, g)) <= 2) || [30, 6];
  const rows = []; for (let i = 0; i < marks.length; i += per(tile, gap)) rows.push(marks.slice(i, i + per(tile, gap)));
  const shown = rows.slice(0, 3);
  // lay out top to bottom first; setting the size clears the canvas
  const yEyebrow = 66, yBig = 168, yTiles = 196;
  const by = yTiles + Math.max(1, shown.length) * (tile + gap) - gap + 26, bh = 250;
  const res = resemblance();
  const yLike = by + bh + 54, yFoot = res ? yLike + 52 : yLike, py = yFoot + 32, ph = 64;
  const H = py + ph + 30;
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = '#0e1118'; c.fillRect(0, 0, W, H);
  c.fillStyle = off.color; c.fillRect(0, 0, 14, H); c.fillStyle = def.color; c.fillRect(W - 14, 0, 14, H);
  c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  const fit = (text, font, maxW) => { c.font = font; let fs = +font.match(/(\d+)px/)[1]; while (c.measureText(text).width > maxW && fs > 24) { fs -= 2; c.font = font.replace(/\d+px/, fs + 'px'); } };
  const line = (text, font, color, y, maxW) => { c.fillStyle = color; fit(text, font, maxW); c.fillText(text, W / 2, y); };
  const box = (x, y, w, h, r) => { c.beginPath(); c.roundRect ? c.roundRect(x, y, w, h, r) : c.rect(x, y, w, h); };
  const clear = d.trophy ? W - 540 : W - 160;      // the top two lines stay clear of the stamp
  // eyebrow: the situation and the game
  line(`${headline(sc)} \u00b7 ${gl.title} \u00b7 ${gl.when}`.toUpperCase(), `700 36px ${UI}`, AMBER, yEyebrow, clear);
  // the big line
  const decided = d.T <= 0 || d.wp >= 0.999 || d.wp <= 0.001;
  let big;
  if (d.surv) big = d.surv.won ? `SURVIVED \u00b7 ROUND ${d.surv.round}` : `RUN OVER \u00b7 ROUND ${d.surv.round}`;
  else if (decided) big = d.os === d.ds ? `TO OVERTIME ${d.os}\u2013${d.ds}` : (d.os > d.ds || d.wp >= 0.999) ? `YOU WIN ${d.os}\u2013${d.ds}` : `YOU LOSE ${d.os}\u2013${d.ds}`;
  else big = `${pct(d.wp)} TO WIN \u00b7 ${d.os}\u2013${d.ds}`;
  line(big, `800 100px ${UI}`, CHALK, yBig, clear);
  // the grid
  let ty = yTiles;
  for (const row of shown) {
    let tx = W / 2 - (row.length * (tile + gap) - gap) / 2;
    for (const e of row) {
      c.fillStyle = e === '\ud83d\udfe9' ? '#3f9b53' : e === '\ud83d\udfe8' ? '#d9a13a' : '#c24a3f';
      box(tx, ty, tile, tile, 9); c.fill();
      c.fillStyle = '#0e1118'; c.font = `800 ${Math.round(tile * 0.62)}px ${BODY}`;
      c.fillText(e === '\ud83d\udfe9' ? '\u2713' : e === '\ud83d\udfe8' ? '!' : '\u2717', tx + tile / 2, ty + tile * 0.72);
      tx += tile + gap;
    }
    ty += tile + gap;
  }
  // the verdict box: you vs the coach
  const last = sc.coach.split(' ').slice(-1)[0].toUpperCase();
  const diff = d.wp - sc.cwp;
  const verdict = diff > 0.02 ? 'YOU DID BETTER' : diff < -0.02 ? `${last} DID BETTER` : 'DEAD EVEN';
  const vcol = diff > 0.02 ? GREEN : diff < -0.02 ? RED : CHALK;
  const bx = 140, bw = W - 280;
  c.strokeStyle = vcol; c.lineWidth = 3; box(bx, by, bw, bh, 14); c.stroke();
  line(`YOU  VS  ${sc.coach.toUpperCase()}`, `700 34px ${UI}`, MUTED, by + 46, bw - 60);
  line(verdict, `800 70px ${UI}`, vcol, by + 120, bw - 60);
  c.strokeStyle = '#2a3d57'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(bx + 26, by + 144); c.lineTo(bx + bw - 26, by + 144); c.stroke();
  const rowLine = (label, value, y) => {
    c.font = `600 36px ${BODY}`;
    c.textAlign = 'left'; c.fillStyle = CHALK; c.fillText(label, bx + 36, y);
    c.textAlign = 'right'; c.fillStyle = '#c9d3df'; c.fillText(value, bx + bw - 36, y);
    c.textAlign = 'center';
  };
  rowLine('You', decided ? (d.os > d.ds ? `Won ${d.os}\u2013${d.ds}` : d.os < d.ds ? `Lost ${d.os}\u2013${d.ds}` : `Tied ${d.os}\u2013${d.ds}`) : `${pct(d.wp)} to win \u00b7 ${d.os}\u2013${d.ds}`, by + 190);
  rowLine(sc.coach, `${sc.won ? 'Won' : 'Lost'} ${sc.final[0]}\u2013${sc.final[1]}`, by + 232);
  // who you called it like (ours, not theirs)
  if (res) line(`YOU CALLED IT LIKE ${res.best.coach} (${res.best.school})`.toUpperCase(), `700 36px ${UI}`, AMBER, yLike, W - 200);
  // the real-game footnote, short enough for one line
  const r = sc.result === 'FUMBLE' ? 'lost fumble' : resultWord(sc).toLowerCase();
  const foot = /clock/.test(r) ? `In the real game, ${sc.coach}'s drive ran out the clock.`
    : `In the real game, ${sc.coach}'s drive ended in ${/^[aeiou]/.test(r) ? 'an' : 'a'} ${r}.`;
  line(foot, `500 34px ${BODY}`, MUTED, yFoot, W - 200);
  // the pill
  c.fillStyle = '#f2f1ec'; box(220, py, W - 440, ph, 14); c.fill();
  c.fillStyle = '#15171c'; c.font = `800 32px ${UI}`; c.fillText('N C A A 2 M I N D R I L L . C O M', W / 2, py + 43);
  if (d.trophy) {
    c.save(); c.translate(W - 140, 74); c.rotate(-0.14);
    c.strokeStyle = d.trophy === 'saban' ? '#d9433a' : AMBER; c.lineWidth = 5; c.strokeRect(-112, -30, 224, 60);
    c.fillStyle = c.strokeStyle; c.font = `800 34px ${UI}`; c.fillText(TROPHY[d.trophy].stamp, 0, 12); c.restore();
  }
  c.textAlign = 'left';
}
function resultWord(sc) {
  const m = { TD: 'Touchdown', FG: 'Field goal', INT: 'Interception', DOWNS: 'Turnover on downs', PUNT: 'Punt', FUMBLE: 'Fumble lost', 'MISSED FG': 'Missed field goal', 'END OF GAME': 'Ran out the clock', 'INT TD': 'Pick six', 'END OF 4TH QUARTER': 'Clock ran out' };
  return m[sc.result] || sc.result;
}
function renderFinal() {
  const sc = G.sc, d = G.done, gl = gameLabel(sc), off = T_(sc.off), def = T_(sc.dfn);
  const diff = d.wp - sc.cwp;
  const vpool = VERDICTS[Math.abs(diff) < 0.02 ? 'even' : diff > 0 ? 'win' : 'loss'];
  const vi = (G.no || sc.id) % vpool.length; // stable for the day, varied across days
  const verdict = vpool[vi].replace('{c}', sc.coach);
  const you = d.wp >= sc.cwp;
  const saban = isHardMode(G.mode);
  const sabanLine = saban ? `<div class="eyebrow" style="text-align:center;color:var(--amber)">${d.wp >= 0.5 ? (G.mode === 'saban' ? 'You pulled it off. Saban would nod, once.' : 'You pulled it off. Google yourself.') : d.wp > sc.wp0 ? `You raised a ${pct(sc.wp0)} shot to ${pct(d.wp)}.` : `A ${pct(sc.wp0)} shot stayed a long shot.`}</div>` : '';
  const real = sc.real.map(p => `<li><span>${p.d ? `${ord(p.d)}&${p.dist}` : '—'} ${p.s != null ? clock(p.s) : ''}</span>${esc(p.t)}</li>`).join('');
  const cmp = comparison(sc);
  const shareTxt = shareText();
  const res = resemblance();
  const tiles = G.snaps.length ? `<div class="gradegrid" aria-label="Your call grades">${G.snaps.map((s, i) => `<div class="gtile ${s.e === '🟩' ? 'g' : s.e === '🟨' ? 'y' : 'r'}" title="${esc(s.sit + ' — ' + s.text)}"><span>${i + 1}</span><b>${esc(s.short || s.call)}</b></div>`).join('')}</div>` : `<div class="grid-emoji" aria-label="Your play grades">${G.grades.join('')}</div>`;
  app.innerHTML = `<section class="final">
    <div class="eyebrow" style="text-align:center">${esc(gl.when)} · ${esc(gl.title)}</div>
    <div class="finalscore"><div class="fs"><span class="chip" style="background:${off.color}"></span><b>${esc(off.abbr)}</b><em>${d.os}</em></div><div class="fsmid"><div class="gl">After your drive</div><div class="note">${clock(d.T)} left</div></div><div class="fs r"><em>${d.ds}</em><b>${esc(def.abbr)}</b><span class="chip" style="background:${def.color}"></span></div></div>
    <h2 class="verdict">${esc(verdict)}</h2>
    ${G.retry ? `<div class="eyebrow" style="text-align:center;color:var(--muted)">Retry${G.attempt ? ' · attempt ' + G.attempt : ''} · does not count. Your first attempt stands${G.firstWp != null ? ` at ${pct(G.firstWp)}` : ''}.</div>` : ''}
    ${survivalHTML()}
    ${d.trophy ? `<div class="trophy ${d.trophy}"><div class="who">Awarded</div><div class="big">${esc(TROPHY[d.trophy].label)}</div><div class="end">${esc(TROPHY[d.trophy].line)}</div></div>` : ''}
    ${giftHTML()}
    ${sabanLine}
    ${tiles}
    <div class="vs">
      <div class="${you ? 'winner' : ''}"><div class="who">You</div><div class="big">${pct(d.wp)}<small>win chance</small></div><div class="end">${esc(d.desc)}</div><div class="note">Score ${off.abbr} ${d.os}, ${def.abbr} ${d.ds} · ${d.snaps} snaps</div></div>
      <div class="${you ? '' : 'winner'}"><div class="who">${esc(sc.coach)}</div><div class="big">${pct(sc.cwp)}<small>win chance</small></div><div class="end">${esc(resultWord(sc))}. ${sc.won ? 'Won' : 'Lost'} ${sc.final[0]}–${sc.final[1]}.</div><div class="note">Win chance at the end of the real drive, same model as yours.</div></div>
    </div>
    <div id="lbCard" class="card lb" hidden></div>
    <div class="vs">
      <div id="pctCard"><div class="who">Vs simulated play-callers</div><div class="big" id="pctBig">…</div><div class="end" id="pctText">Simulating 300 college play-callers on this exact drive…</div><div class="hist" id="pctHist"></div></div>
      <div>${res ? `<div class="who">You call it like</div><div class="big" style="font-size:30px;line-height:1.1">${esc(res.best.coach)}</div><div class="end">${esc(res.best.school)} · ${pct(res.best.pass)} pass overall, ${pct(res.best.early)} on early downs, ${pct(res.best.pd)} on passing downs</div><div class="note">You: ${pct(res.me.pass)} pass, ${pct(res.me.early)} early downs, ${pct(res.me.pd)} passing downs, ${pct(res.me.deep)} deep shots (${res.n} calls). Next closest: ${esc(res.next.map(c => c.coach).join(', '))}. ${res.n < 6 ? 'Small sample. Coaches get a season; you got a drive.' : res.me.pass >= 0.8 ? 'Your tendencies, his résumé. You throw a lot.' : res.me.pass <= 0.35 ? 'Your tendencies, his résumé. You run a lot, on purpose, late.' : 'Your tendencies, his résumé.'}</div>` : '<div class="who">You call it like</div><div class="note">Call a few plays to get a match.</div>'}</div>
    </div>
    <div class="sharebox">
      <canvas id="shareCanvas" width="1200" height="740" aria-label="Share card"></canvas>
      <div class="row">
        <button class="cta" id="shareImg">Share</button>
        <button class="cta ghost" id="shareX">Post on X</button>
        <button class="cta ghost" id="shareCopy">Copy text</button>
        <a class="cta ghost" id="shareDl" download="ncaa2mindrill-${G.no || sc.id}.png" href="#">Save image</a>
      </div>
      ${G.mode === 'practice' ? '<div class="row"><button class="cta ghost" id="again">Replay this drive</button></div>' : ''}
      ${G.mode === 'daily' || isHardMode(G.mode) ? `<div class="row"><button class="cta ghost" id="retry">${G.retry ? 'Retry again' : 'Retry this drive'}</button></div><div class="note" style="text-align:center">Retries are for pride. The record, the leaderboard and the trophies keep your first attempt.</div>` : ''}
    </div>
    ${G.mode === 'survival' && d.surv ? `<div class="row">${d.surv.won ? '<button class="cta" id="survNext">Next drive · round ' + (d.surv.round + 1) + '</button>' : '<button class="cta" id="survNew">Start a new run</button>'}</div>` : ''}
    <div class="realdrive cmp">
      <div class="h">Snap by snap: you vs ${esc(sc.coach)}</div>
      <div class="cmpsum">${cmp.summary}</div>
      <div class="cmpgrid"><div class="cmphead">You</div><div class="cmphead">${esc(sc.coach)}</div>${cmp.rows}</div>
      ${cmp.turn ? `<div class="note">${cmp.turn}</div>` : ''}
    </div>
    <div class="realdrive"><div class="h">What ${esc(sc.coach)} actually called</div><ol>${real}</ol></div>
    ${G.log.length ? `<div class="realdrive"><div class="h">Your drive</div><ol>${G.log.map(l => `<li><span>${esc(l.sit)}</span>${esc(l.text)}</li>`).join('')}</ol></div>` : ''}
    <div class="row"><button class="cta ghost" id="more">Play another drive</button></div>
  </section>`;
  drawShareCard($('#shareCanvas'));
  wireGift();
  if (G.done && (G.mode === 'daily' || isHardMode(G.mode)) && G.no && !G.retry && !UNLOCK_API.includes('REPLACE_ME')) unlockApi('/lb/stats', { day: G.no, mode: G.mode, wp: G.done.wp.toFixed(4) }).then(r => { if (r && r.ok && r.n) showLeaderboard(r); }).catch(() => {});
  const cached = G.pctl;
  const showPct = wps => {
    const below = wps.filter(w => w < d.wp - 1e-9).length, tie = wps.filter(w => Math.abs(w - d.wp) <= 1e-9).length;
    const p = Math.round((below + tie / 2) / wps.length * 100);
    G.pctl = { p, n: wps.length, wps };
    const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][Math.min(n % 10, 4)] || 'th');
    $('#pctBig').innerHTML = `${ordinal(p)}<small>percentile</small>`;
    const pl = PCT_LINES.find(([lo]) => p >= lo)[1];
    $('#pctText').textContent = `Your ${pct(d.wp)} beat ${below} of ${wps.length} simulated college play-callers on this drive (their median: ${pct(wps.slice().sort((a, b) => a - b)[Math.floor(wps.length / 2)])}). ${pl}`;
    const bins = new Array(10).fill(0); for (const w of wps) bins[Math.min(9, Math.floor(w * 10))]++;
    const mx = Math.max(...bins);
    $('#pctHist').innerHTML = bins.map((b, i) => `<i style="height:${Math.max(2, b / mx * 100)}%" class="${Math.floor(d.wp * 10) === i || (d.wp >= 1 && i === 9) ? 'me' : ''}" title="${i * 10}–${i * 10 + 10}%: ${b}"></i>`).join('');
    drawShareCard($('#shareCanvas'));
  };
  if (cached && cached.wps) showPct(cached.wps);
  else simulateCallers(sc, 300, (i, n) => { const el = $('#pctText'); if (el) el.textContent = `Simulating ${n} college play-callers on this exact drive… ${i}/${n}`; }, wps => { if ($('#pctBig')) showPct(wps); });
  $('#shareCopy').onclick = () => navigator.clipboard?.writeText(shareTxt).then(() => toast('Copied'), () => toast('Could not copy'));
  $('#shareX').onclick = () => { const u = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(shareTxt); if (window.Native && window.Native.isNative) window.Native.open(u); else window.open(u, '_blank', 'noopener'); };
  $('#shareImg').onclick = async () => {
    const canvas = $('#shareCanvas');
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    const file = blob && new File([blob], `ncaa2mindrill-${G.no || sc.id}.png`, { type: 'image/png' });
    try {
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text: shareTxt }); return; }
      if (navigator.share) { await navigator.share({ text: shareTxt, url: 'https://ncaa2mindrill.com' }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    await navigator.clipboard?.writeText(shareTxt).catch(() => {});
    toast('Text copied. Use Save image for the card.');
  };
  const dl = $('#shareDl'); dl.onclick = () => { dl.href = $('#shareCanvas').toDataURL('image/png'); };
  const ag = $('#again'); if (ag) ag.onclick = () => { newGame(G.sc0 || sc, G.mode, G.no); renderPlay(); };
  const rt = $('#retry'); if (rt) rt.onclick = () => { // the daily again, off the record
    const mode = G.mode, no = G.no, first = (store[mode] || {})[no];
    newGame(G.sc0 || sc, mode, no); G.retry = true; G.attempt = ((first && first.retries) || 0) + 2; G.firstWp = first && first.done ? first.done.wp : null; renderPlay();
  };
  const goOn = () => { survKind = G.survKind || 'free'; survNext(); };
  const sn = $('#survNext'); if (sn) sn.onclick = goOn;
  const sw = $('#survNew'); if (sw) sw.onclick = goOn;
  $('#more').onclick = () => { if (G.mode === 'survival') { survHome(G.survKind || 'free'); return; } if (G.mode === 'saban' || isHard(sc)) pf = { q: '', year: '', kind: 'saban' }; else if (G.mode === 'cignetti' || isCig(sc)) pf = { q: '', year: '', kind: 'cignetti' }; setTab('practice'); };
}

// ---------- survival: win to stay alive ----------
// Three runs. The free one climbs from regular drives to the Cignetti shelf (rounds 7-9) to the Saban pool (10+).
// The Cignetti and Saban runs stay inside their own pool, easiest drives first, then harder.
let survKind = 'free';
const SURV_KINDS = {
  free:     { key: 'survival', label: 'Survival', eyebrow: 'Survival', pitch: () => `A random real drive, then another, each one harder. Win the game to stay alive. Lose once and the run is over.<br>Rounds 1–6 are regular drives (45%+ to start, then 35–50%, then 28–40%). Rounds 7–9 come off the Cignetti shelf, 10 and up out of the Saban pool.${premiumUnlocked() ? '' : ' The deep end takes the unlock.'}` },
  cignetti: { key: 'survCig', label: 'Cignetti survival', eyebrow: 'Cignetti mode · Survival', pitch: () => 'Every drive comes off the Cignetti shelf: 10–25% to win at the start, the friendlier ones first, then the rest. Win the game to stay alive. Lose once and the run is over. Hard, not hopeless, repeatedly.' },
  saban:    { key: 'survSaban', label: 'Saban survival', eyebrow: 'Saban mode · Survival', pitch: () => 'Every drive comes out of the Saban pool: 10% to win or worse, or two scores down. The attainable end of hopeless, easiest first. Win to stay alive. Nobody is expected to survive two.' },
};
function survState(kind = survKind) { const k = (SURV_KINDS[kind] || SURV_KINDS.free).key; return store[k] ||= { best: 0, runs: 0, cur: null }; }
const SURV_BAND = r => r <= 2 ? [0.45, 1.01] : r <= 4 ? [0.35, 0.50] : r <= 6 ? [0.28, 0.40] : r <= 9 ? [HARD_WP, CIG_WP] : [0, HARD_WP];
function survPool(kind, round, used) {
  let pool;
  if (kind === 'cignetti' || kind === 'saban') { // the mode's own pool, sorted easiest first, in thirds by round
    const all = (kind === 'saban' ? D.hard : D.cig).slice().sort((a, b) => b.wp0 - a.wp0), n = all.length;
    pool = round <= 2 ? all.slice(0, Math.ceil(n * .4)) : round <= 4 ? all.slice(Math.floor(n * .3), Math.ceil(n * .7)) : all.slice(Math.floor(n * .6));
  } else {
    const [lo, hi] = SURV_BAND(round);
    pool = round >= 10 ? D.hard : round >= 7 ? D.cig : D.scen.filter(s => !isHopeless(s) && !isHard(s) && !isCig(s) && s.wp0 > lo && s.wp0 <= hi);
  }
  const fresh = pool.filter(s => !used.includes(s.id));
  if (fresh.length) return fresh;
  return pool.length ? pool : D.std.filter(s => !isHopeless(s) && !isHard(s) && !isCig(s));
}
function survNext() {
  const kind = survKind, S = survState(kind);
  if (!S.cur || S.cur.over) S.cur = { streak: 0, drives: [], over: false, started: Date.now() };
  const round = S.cur.streak + 1;
  if (kind === 'free' && round >= 7 && !premiumUnlocked()) { renderSurvPaywall(round); return; }
  if (kind !== 'free' && !premiumUnlocked()) { renderPaywall(kind); return; }
  let sc = S.cur.next != null ? D.scen[S.cur.next] : null; // the next drive is drawn once, so a reload doesn't reroll it
  if (!sc || S.cur.drives.some(d => d.sid === sc.id)) { const pool = survPool(kind, round, S.cur.drives.map(d => d.sid)); sc = pool[Math.floor(rand() * pool.length)]; S.cur.next = sc.id; }
  saveStore();
  showIntro(sc, 'survival', round);
}
function showSurvival(kind = 'free') {
  survKind = kind;
  const K = SURV_KINDS[kind], S = survState(kind), cur = S.cur, alive = !!(cur && !cur.over);
  $('#subline').textContent = `${K.label} · best run ${S.best || 0}`;
  const done = cur && cur.drives.length ? cur.drives.map(d => `<span class="sd ${d.won ? 'w' : 'l'}" title="Round ${d.round}: ${pct(d.wp)} win chance">${d.won ? '✓' : '✗'}</span>`).join('') : '';
  app.innerHTML = `<section class="intro">
    <div class="eyebrow">${esc(K.eyebrow)}${alive && cur.streak ? ` · ${cur.streak} in a row` : ''}</div>
    <h2 class="headline">${alive && cur.streak ? `${cur.streak}<small>drive${cur.streak === 1 ? '' : 's'} survived · round ${cur.streak + 1} is next</small>` : `Win to<small>stay alive</small>`}</h2>
    <div class="pitch">${K.pitch()}</div>
    ${done ? `<div class="survrow" aria-label="This run">${done}</div>` : ''}
    <button class="cta" id="survGo">${alive && cur.streak ? `Round ${cur.streak + 1}` : 'Start a run'}</button>
    ${alive && cur.streak ? `<button class="cta ghost" id="survQuit">Walk away with ${cur.streak}</button>` : ''}
    <div class="fine">Best run: ${S.best || 0} · Runs finished: ${S.runs || 0}. The rest of each game plays out at the model's odds, so a 70% finish survives 7 times in 10. Saved in this browser.</div>
  </section>`;
  $('#survGo').onclick = survNext;
  const q = $('#survQuit'); if (q) q.onclick = () => { S.runs = (S.runs || 0) + 1; S.cur.over = true; saveStore(); showSurvival(kind); };
}
// back to the run's home: the Survival tab, or the hard mode's Survival view
function survHome(kind) { if (kind === 'cignetti' || kind === 'saban') { hardView[kind] = 'survival'; setTab(kind); } else { survView = 'run'; setTab('survival'); } }
function renderSurvPaywall(round) {
  renderPaywall('cignetti');
  const h = $('.paywall .headline'); if (h) h.innerHTML = 'The deep end<small>Rounds 7 and up</small>';
  const e = $('.paywall .eyebrow'); if (e) e.textContent = `Survival · round ${round} · the deep end is locked`;
  const p = $('.paywall .pitch'); if (p) p.insertAdjacentHTML('afterbegin', `You survived ${round - 1}. Rounds 7 and up are Cignetti and Saban drives, which come with the unlock. Your run is saved here until you come back.<br><br>`);
}
function survivalHTML() {
  const d = G.done, s = d && d.surv; if (!s) return '';
  const line = s.won
    ? (d.wp >= 0.999 ? 'Final. You won it on the field.' : `The rest of the game played out and your ${pct(d.wp)} held up.`) + ` ${s.streak} in a row.${s.streak >= 7 ? ' This is the deep end now.' : ''}`
    : (d.wp <= 0.001 ? 'Final. You lost it on the field.' : `The rest of the game played out and your ${pct(d.wp)} did not hold up.`) + ` ${s.streak} drive${s.streak === 1 ? '' : 's'} survived${s.streak > 0 && s.streak >= s.best ? ', which ties or sets your best' : ''}.`;
  return `<div class="trophy surv ${s.won ? 'alive' : 'dead'}"><div class="who">${esc((SURV_KINDS[G.survKind] || SURV_KINDS.free).label)} · round ${s.round}</div><div class="big">${s.won ? 'SURVIVED' : 'RUN OVER'}</div><div class="end">${esc(line)}</div></div>`;
}

// ---------- hard-mode libraries (replayable; the daily stays under "Today's drive") ----------
const hardView = { saban: 'today', cignetti: 'today' }; // 'today' | 'survival' | 'library'
const libFilter = { saban: { q: '', year: '' }, cignetti: { q: '', year: '' } };
function renderLibrary(mode) {
  const pool = mode === 'saban' ? D.hard : D.cig, m = HARD_MODES[mode], f = libFilter[mode];
  $('#subline').textContent = `${m.label} · library · ${pool.length} drives`;
  const years = D.years.map(y => `<option value="${y}" ${f.year == y ? 'selected' : ''}>${y}</option>`).join('');
  app.innerHTML = `<div class="eyebrow" style="margin-bottom:8px">${esc(m.label)} library · ${mode === 'saban' ? 'brutal, but every one of these is winnable' : 'mildly out of the picture, every one attainable'} · replay any of them</div>
    <div class="filters"><input id="lq" type="search" placeholder="Search a coach or school" value="${esc(f.q)}" aria-label="Search"><select id="ly" aria-label="Season"><option value="">All seasons</option>${years}</select><button class="cta ghost" id="lrnd" style="flex:0 0 auto;width:auto">Random</button></div><div id="llist"></div>`;
  const draw = () => {
    const q = f.q.trim().toLowerCase();
    const list = pool.filter(s => (!f.year || s.year == f.year) && (!q || (s.coach + ' ' + s.dcoach + ' ' + T_(s.off).school + ' ' + T_(s.dfn).school).toLowerCase().includes(q))).sort((a, b) => b.wp0 - a.wp0);
    $('#llist').innerHTML = `<p class="note">${list.length} drive${list.length === 1 ? '' : 's'}, easiest first</p><div class="cards">${list.slice(0, 150).map(s => { const gl = gameLabel(s), done = store.practice[s.id]; return `<button class="sc-card" data-id="${s.id}"><div class="m">${esc(gl.when)} · ${pct(s.wp0)} to win</div><div class="t">${esc(T_(s.off).school)} vs ${esc(T_(s.dfn).school)}</div><div class="s"><b>${headline(s)}</b>, ${clock(s.secs)} left, ball at ${esc(spot(s.ytg, s))}, ${s.to} TO</div><div class="s">Coach: ${esc(s.coach)}</div>${done ? `<div class="done">PLAYED · YOU ${pct(done.wp)} vs ${pct(done.coachWp)} · replay</div>` : ''}</button>`; }).join('')}</div>${list.length > 150 ? '<p class="note">Showing 150. Narrow the search for more.</p>' : ''}`;
    $('#llist').querySelectorAll('[data-id]').forEach(b => b.onclick = () => { showIntro(D.scen[+b.dataset.id], 'practice'); window.scrollTo(0, 0); });
  };
  $('#lq').oninput = e => { f.q = e.target.value; draw(); };
  $('#ly').onchange = e => { f.year = e.target.value; draw(); };
  $('#lrnd').onclick = () => showIntro(pool[Math.floor(rand() * pool.length)], 'practice');
  draw();
}

// ---------- gifts: beat a Saban drive once, unlock a friend ----------
function giftEligible() { return G.mode === 'saban' && G.done && G.done.wp >= 0.5 && !G.retry; }
function giftHTML() {
  if (!giftEligible() || (window.Native && window.Native.isNative)) return '';
  const owner = webUnlockCode(); if (!owner) return '';
  const g = store.gift;
  return `<div class="card gift"><div class="who">You beat a Saban drive</div><div class="end">That's worth a membership for a friend: one gift code, both modes, free.</div>${g ? `<div class="end">Your gift code: <code class="code">${esc(g.code)}</code> <button class="mod" id="copyGift">Copy</button></div><div class="note">They paste it under "I already paid" on ncaa2mindrill.com.</div>` : `<div class="row"><button class="cta" id="giftBtn">Get my gift code</button></div><div class="fine" id="giftNote"></div>`}</div>`;
}
function wireGift() {
  const b = $('#giftBtn'); if (b) b.onclick = async () => { b.disabled = true; $('#giftNote').textContent = 'Asking the front office…'; try { const r = await unlockApi('/gift/issue', { owner: webUnlockCode() }); if (r && r.ok && r.gift) { store.gift = { code: r.gift, ts: Date.now() }; saveStore(); renderFinal(); } else { $('#giftNote').textContent = r && r.reason === 'bad_owner' ? 'Gift codes come with a paid unlock. Yours could not be confirmed.' : 'No code right now. Try again in a minute.'; b.disabled = false; } } catch (e) { $('#giftNote').textContent = 'Could not reach the service.'; b.disabled = false; } };
  const c = $('#copyGift'); if (c) c.onclick = () => navigator.clipboard?.writeText(`Free NCAA Two-Minute Drill membership (Saban + Cignetti mode). Paste this under "I already paid" at ncaa2mindrill.com/#saban: ${store.gift.code}`).then(() => toast('Copied with instructions'), () => toast(store.gift.code));
}

// ---------- practice ----------
let pf = { q: '', year: '', kind: '' };
function showPractice() {
  $('#subline').textContent = `${D.scen.length} real drives · FBS 2023–2025`;
  const years = D.years.map(y => `<option value="${y}" ${pf.year == y ? 'selected' : ''}>${y}</option>`).join('');
  app.innerHTML = `<div class="filters">
      <input id="pq" type="search" placeholder="Search a coach or school" value="${esc(pf.q)}" aria-label="Search a coach or school">
      <select id="py" aria-label="Season"><option value="">All seasons</option>${years}</select>
      <select id="pk" aria-label="Situation"><option value="">Any situation</option><option value="tied" ${pf.kind === 'tied' ? 'selected' : ''}>Tied</option><option value="fg" ${pf.kind === 'fg' ? 'selected' : ''}>Down 1–3</option><option value="td" ${pf.kind === 'td' ? 'selected' : ''}>Down 4–8</option>${premiumUnlocked() ? `<option value="two" ${pf.kind === 'two' ? 'selected' : ''}>Down 9+ (two scores)</option><option value="saban" ${pf.kind === 'saban' ? 'selected' : ''}>Saban-hard (≤${Math.round(HARD_WP * 100)}% to start)</option><option value="cignetti" ${pf.kind === 'cignetti' ? 'selected' : ''}>Cignetti-hard (${Math.round(HARD_WP * 100)}–${Math.round(CIG_WP * 100)}% to start)</option>` : ''}</select>${premiumUnlocked() ? '' : '<span class="note" style="align-self:center">Hard drives are in Saban and Cignetti mode.</span>'}
      <button class="cta ghost" id="rnd" style="flex:0 0 auto;width:auto">Random drive</button>
    </div><div id="plist"></div>`;
  const draw = () => {
    const q = pf.q.trim().toLowerCase();
    const list = D.scen.filter(s => {
      const d = s.ds - s.os;
      if (pf.year && s.year != pf.year) return false;
      if (pf.kind === 'tied' && d !== 0) return false;
      if (pf.kind === 'fg' && !(d >= 1 && d <= 3)) return false;
      if (pf.kind === 'td' && !(d >= 4 && d <= 8)) return false;
      if (pf.kind === 'two' && !(d >= 9)) return false;
      if (pf.kind === 'saban' && !isHard(s)) return false;
      if (pf.kind === 'cignetti' && !isCig(s)) return false;
      if (!pf.kind && d >= 9) return false;
      if (isHopeless(s)) return false; // nobody gets the unwinnable ones
      if (!premiumUnlocked() && (isHard(s) || isCig(s))) return false; // the hard drives are the paid part
      if (!q) return true;
      return (s.coach + ' ' + s.dcoach + ' ' + T_(s.off).school + ' ' + T_(s.dfn).school).toLowerCase().includes(q);
    }).sort((a, b) => b.date.localeCompare(a.date));
    $('#plist').innerHTML = `<p class="note">${list.length} drive${list.length === 1 ? '' : 's'}</p><div class="cards">${list.slice(0, 120).map(s => {
      const gl = gameLabel(s), done = store.practice[s.id];
      return `<button class="sc-card" data-id="${s.id}"><div class="m">${esc(gl.when)}</div><div class="t">${esc(T_(s.off).school)} vs ${esc(T_(s.dfn).school)}</div>
      <div class="s"><b>${headline(s)}</b>, ${clock(s.secs)} left, ball at ${esc(spot(s.ytg, s))}</div><div class="s">Coach: ${esc(s.coach)}</div>
      ${done ? `<div class="done">PLAYED · YOU ${pct(done.wp)} vs ${pct(done.coachWp)}</div>` : ''}</button>`;
    }).join('')}</div>${list.length > 120 ? '<p class="note">Showing the 120 most recent. Narrow the search to see more.</p>' : ''}`;
    $('#plist').querySelectorAll('[data-id]').forEach(b => b.onclick = () => { showIntro(D.scen[+b.dataset.id], 'practice'); window.scrollTo(0, 0); });
  };
  $('#pq').oninput = e => { pf.q = e.target.value; draw(); };
  $('#py').onchange = e => { pf.year = e.target.value; draw(); };
  $('#pk').onchange = e => { pf.kind = e.target.value; draw(); };
  $('#rnd').onclick = () => { const pool = (premiumUnlocked() ? D.scen : D.std.filter(s => !isHard(s) && !isCig(s))).filter(s => !isHopeless(s)); showIntro(pool[Math.floor(rand() * pool.length)], 'practice'); };
  draw();
}

// ---------- coaches ----------
let csort = { k: 'drives', dir: -1 };
function showCoaches() {
  $('#subline').textContent = 'FBS head coaches · 2023–2025';
  const by = {};
  for (const s of D.scen) {
    const c = (by[s.coach] ||= { name: s.coach, teams: new Set(), drives: 0, scores: 0, wins: 0, wp: 0, ids: [] });
    c.teams.add(T_(s.off).school); c.drives++; c.ids.push(s.id);
    if (s.result === 'TD' || s.result === 'FG') c.scores++;
    if (s.won) c.wins++;
    c.wp += s.cwp - s.wp0;
  }
  const rows = Object.values(by).filter(c => c.name !== 'Unknown');
  const val = (c, k) => k === 'name' ? c.name : k === 'rate' ? c.scores / c.drives : k === 'add' ? c.wp / c.drives : c[k];
  rows.sort((a, b) => { const x = val(a, csort.k), y = val(b, csort.k); return (x > y ? 1 : x < y ? -1 : 0) * csort.dir || b.drives - a.drives; });
  const th = (k, l, num) => `<th class="${num ? 'num' : ''}" data-k="${k}" aria-sort="${csort.k === k ? (csort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${l}${csort.k === k ? (csort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  app.innerHTML = `<p class="note">Every FBS head coach who faced a late, one-score drive in this game's pool (Q4, 2:30 or less, trailing by 16 or fewer or tied). "Added" is how much the real drive moved the coach's win chance on average. Click a coach to play their drives.</p>
  <div class="tablewrap"><table><thead><tr>${th('name', 'Coach')}<th>School</th>${th('drives', 'Drives', 1)}${th('rate', 'Scored', 1)}${th('wins', 'Won game', 1)}${th('add', 'Added', 1)}</tr></thead><tbody>
  ${rows.map(c => `<tr data-c="${esc(c.name)}"><td>${esc(c.name)}</td><td>${esc([...c.teams].join(', '))}</td><td class="num">${c.drives}</td><td class="num">${pct(c.scores / c.drives)}</td><td class="num">${c.wins}</td><td class="num">${c.wp >= 0 ? '+' : ''}${Math.round(c.wp / c.drives * 100)}</td></tr>`).join('')}
  </tbody></table></div>`;
  app.querySelectorAll('th[data-k]').forEach(t => t.onclick = () => { const k = t.dataset.k; csort = { k, dir: csort.k === k ? -csort.dir : (k === 'name' ? 1 : -1) }; showCoaches(); });
  app.querySelectorAll('tr[data-c]').forEach(r => r.onclick = () => { pf = { q: r.dataset.c, year: '', kind: '' }; setTab('practice'); });
}

// ---------- stats ----------
function showStats() {
  const days = Object.entries(store.daily).filter(([, v]) => v.done).map(([k, v]) => [+k, v]).sort((a, b) => a[0] - b[0]);
  const beat = days.filter(([, v]) => v.done.wp >= v.coachWp).length;
  let streak = 0, today = todayIndex() + 1;
  for (let i = today; store.daily[i]?.done; i--) streak++;
  const avg = days.length ? days.reduce((a, [, v]) => a + (v.done.wp - v.coachWp), 0) / days.length : 0;
  const sab = Object.values(store.saban || {}).filter(v => v.done), cig = Object.values(store.cignetti || {}).filter(v => v.done);
  const sabWon = sab.filter(v => v.done.wp >= 0.5).length, cigWon = cig.filter(v => v.done.wp >= 0.5).length;
  $('#statsBody').innerHTML = `<div><b>${days.length}</b><span>Played</span></div><div><b>${beat}</b><span>Beat the coach</span></div><div><b>${streak}</b><span>Day streak</span></div><div><b>${days.length ? (avg >= 0 ? '+' : '') + Math.round(avg * 100) : '–'}</b><span>Avg vs coach</span></div>` +
    `<div><b>${sab.length}</b><span>Saban drives</span></div><div><b>${sabWon}</b><span>Saban wins (50%+)</span></div><div><b>${cig.length}</b><span>Cignetti drives</span></div><div><b>${cigWon}</b><span>Cignetti wins (50%+)</span></div>` +
    `<div><b>${(store.trophies && store.trophies.saban || []).length}</b><span>Sabans earned</span></div><div><b>${(store.trophies && store.trophies.cignetti || []).length}</b><span>Cignettis earned</span></div>` +
    `<div><b>${survState('free').best || 0}</b><span>Survival best run</span></div><div><b>${survState('free').runs || 0}</b><span>Survival runs</span></div>` +
    `<div><b>${survState('cignetti').best || 0}</b><span>Cignetti survival best</span></div><div><b>${survState('saban').best || 0}</b><span>Saban survival best</span></div>` +
    `<div style="grid-column:span 2" class="note">A Saban is a perfect game: every call the best one, and you beat the coach. A Cignetti: no wrong calls, mostly right ones. Both rare on purpose.</div>`;
  $('#statsNote').textContent = days.length ? 'Saved in this browser only.' : 'Finish today\'s drive to start your record. Saved in this browser only.';
  $('#statsDlg').showModal();
}

// ---------- boot ----------
$('#tabDaily').onclick = () => setTab('daily');
$('#tabSaban').onclick = () => setTab('saban');
$('#tabCignetti').onclick = () => setTab('cignetti');
$('#tabSurvival').onclick = () => { survView = 'run'; setTab('survival'); };
$('#tabCoaches').onclick = () => setTab('coaches');
$('#helpBtn').onclick = () => $('#helpDlg').showModal();
$('#helpClose').onclick = () => $('#helpDlg').close();
$('#statsBtn').onclick = showStats;
const sndBtn = $('#soundBtn');
if (sndBtn) { const paint = () => { sndBtn.textContent = window.Sound && Sound.on ? '🔊' : '🔇'; sndBtn.setAttribute('aria-pressed', String(!!(window.Sound && Sound.on))); }; paint(); sndBtn.onclick = () => { if (!window.Sound) return; try { Sound.set(!Sound.on); } catch { /* audio unavailable */ } paint(); try { if (Sound.on) { Sound.play('toggle'); if (G && !G.done && G.st && /game/.test(app.firstElementChild?.className || '')) Sound.ambience(crowdLevel()); } else Sound.ambience(0); } catch { /* never break the button */ } }; window.addEventListener('storage', e => { if (e.key === 'cfb2md:sound') paint(); }); }
$('#statsClose').onclick = () => $('#statsDlg').close();

fetch('data.json').then(r => r.json()).then(d => {
  D = d;
  // ESPN text under-reports missed kicks and the onside sample is tiny, so keep both inside what college football actually shows
  XP = clamp(R('xp', XP), 0.9, 0.96); TWO = clamp(R('two', TWO), 0.38, 0.52); ONSIDE = clamp(R('onside', ONSIDE), 0.07, 0.13);
  for (const s of D.scen) s.kick = clamp(s.kick || 0, -0.12, 0.12);
  for (const k of ['pen_pre', 'pen_pass', 'pen_run']) if (D.pools[k]) for (const row of D.pools[k]) if (row[1] === 'Missing') row[1] = 'Penalty';
  for (const s of D.scen) s.wp0 = wpModel(s.os - s.ds, s.secs, s.ytg, s.down, s.dist, s.to, s.dto, s.elo);
  // hand-picked drives from the current season (s.feat) are pinned to dates in D.featured and kept out of the
  // rotations, so adding one never shifts what any other day plays
  D.std = D.scen.filter(s => !s.feat && s.os - s.ds >= -8);           // every one-score drive, in its fixed order
  // the free daily: one score down, 30-75% to win at the start. Winnable with a good drive, lost with a bad one.
  D.free = D.std.filter(s => s.wp0 >= 0.30 && s.wp0 <= 0.75 && !isHopeless(s));
  D.hard = D.scen.filter(s => !s.feat && isHard(s)).sort((a, b) => a.id - b.id);
  D.cig = D.scen.filter(s => !s.feat && isCig(s)).sort((a, b) => a.id - b.id);
  if (window.Native && window.Native.init) window.Native.init().then(() => { paintLocks(); if (isHardMode(tab)) setTab(tab); }).catch(() => {});
  let seen = false; try { seen = localStorage.getItem('cfb2md:seen') === '1'; localStorage.setItem('cfb2md:seen', '1'); } catch { seen = true; }
  beacon('/hit', { token: playerToken(), src: firstSource() });
  const back = location.search.includes('unlock=');
  const startTab = location.hash === '#saban' ? 'saban' : location.hash === '#cignetti' ? 'cignetti' : location.hash === '#survival' ? 'survival' : 'daily';
  if (back) claimFromUrl().then(() => setTab(startTab)); else setTab(startTab);
  if (!seen && !back) $('#helpDlg').showModal();
}).catch(() => { app.innerHTML = '<p class="note">Could not load the drive data. Reload the page to try again.</p>'; });
