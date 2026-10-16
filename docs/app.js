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
const fgProb = ytg => { const d = ytg + 17; return d > 67 ? 0 : sig(D.fg[0] + D.fg[1] * d); };
const XP = 0.97, TWO = 0.45, ONSIDE = 0.10;

// ---------- calls ----------
const CALLS = {
  r_in:   { grp: 'Run', label: 'Inside run', sub: 'RB between the tackles', dur: 5 },
  r_out:  { grp: 'Run', label: 'Outside run', sub: 'RB to the edge', dur: 6 },
  r_qb:   { grp: 'Run', label: 'QB keeper', sub: 'Designed QB run', dur: 5 },
  r_sneak:{ grp: 'Run', label: 'QB sneak', sub: 'Short yardage push', dur: 3 },
  p_short_side: { grp: 'Pass', label: 'Quick out', sub: 'Short, toward the sideline', dur: 5, depth: 'short', side: 'side', pick: true },
  p_short_mid:  { grp: 'Pass', label: 'Slant / dig', sub: 'Short, over the middle', dur: 5, depth: 'short', side: 'mid', pick: true },
  p_deep_side:  { grp: 'Pass', label: 'Go / fade', sub: 'Deep, toward the sideline', dur: 7, depth: 'deep', side: 'side', pick: true },
  p_deep_mid:   { grp: 'Pass', label: 'Post / seam', sub: 'Deep, down the middle', dur: 7, depth: 'deep', side: 'mid', pick: true },
  p_rb:   { grp: 'Pass', label: 'Check-down', sub: 'Dump it to the back', dur: 5 },
  hail:   { grp: 'Pass', label: 'Hail Mary', sub: 'Everyone to the end zone', dur: 9 },
  spike:  { grp: 'Clock & kicks', label: 'Spike it', sub: 'Stop the clock, lose a down', dur: 1 },
  kneel:  { grp: 'Clock & kicks', label: 'Kneel', sub: 'Run the clock', dur: 2 },
  fg:     { grp: 'Clock & kicks', label: 'Field goal', sub: '', dur: 5 },
  punt:   { grp: 'Clock & kicks', label: 'Punt', sub: 'Flip the field', dur: 7 },
};
function available(st, id) {
  switch (id) {
    case 'r_sneak': return st.dist <= 2;
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
function outcomes(st, id, tgt) {
  const S = st.sc, L = S.lineup, z = zoneOf(st.ytg), dg = st.down >= 3 ? 'L' : 'E', sy = st.dist <= 2 ? 'S' : 'N';
  const out = [];
  const addPool = (key, rows, adv, mass) => { const w = tilted(key, rows, adv); rows.forEach((r, i) => out.push({ p: mass * w[i], y: r[0], f: r[1], src: r })); };
  const lgSack = D.rates.sack, lgInt = D.rates.int;
  if (id === 'r_in' || id === 'r_out' || id === 'r_qb' || id === 'r_sneak') {
    const adv = S.orat.or + S.drat.dr + (id === 'r_qb' || id === 'r_sneak' ? (L.qb.adj || 0) * .3 : (L.rb.adj || 0) * .6);
    const fum = D.rates.fumble;
    const [k, rows] = id === 'r_sneak' ? pool('r_sneak') : id === 'r_qb' ? pool('r_qb_' + z) : pool(`${id}_${z}${sy}`, `${id}_${z}N`);
    addPool(k, rows, adv, 1 - fum);
    out.push({ p: fum, y: 1, f: 8, src: null, fumble: true });
    return out;
  }
  if (id.startsWith('p_')) {
    const c = CALLS[id];
    const rec = tgt ?? (id === 'p_rb' ? L.rec.find(r => r.pos === 'RB') : null);
    const adv = S.orat.op + S.drat.dp + (rec ? rec.adj * .6 : 0);
    const depthF = id === 'p_rb' ? .55 : c.depth === 'deep' ? 1.35 : .85;
    const intF = id === 'p_rb' ? .45 : c.depth === 'deep' ? 1.9 : c.side === 'mid' ? 1.05 : .75;
    const pSack = clamp((dg === 'L' ? D.rates.sackL : lgSack) * depthF * Math.sqrt((L.qb.sack || lgSack) / lgSack) * (1 + S.drat.dp), .01, .2);
    const pInt = clamp(lgInt * intF * Math.sqrt((L.qb.int || lgInt) / lgInt) * (1 + 2 * S.drat.dp), .004, .12) * (1 - pSack);
    const [sk, srows] = pool('sack_' + z, 'sack_o');
    addPool(sk, srows, 0, pSack);
    const ints = D.pools.int;
    const dtd = ints.filter(r => r[1] & 32).length / ints.length;
    out.push({ p: pInt * (1 - dtd), y: 0, f: 8, src: null, int: true });
    out.push({ p: pInt * dtd, y: 0, f: 8 | 32, src: null, int: true });
    const [k, rows] = id === 'p_rb' ? pool('p_rb_' + z, 'p_rb_o') :
      pool(`p_${c.depth}_${c.side}_${z}${dg}`, `p_${c.depth}_side_${z}${dg}`, `p_${c.depth}_${c.side}_o${dg}`, `p_short_${c.side}_${z}${dg}`);
    addPool(k, rows, adv, 1 - pSack - pInt);
    return out;
  }
  if (id === 'hail') {
    const td = st.ytg <= 45 ? .09 : st.ytg <= 55 ? .06 : .03;
    return [{ p: td, y: st.ytg, f: 3, src: null }, { p: .2, y: 0, f: 8, src: null, int: true }, { p: .05, y: Math.max(1, st.ytg - 6), f: 1, src: null },
      { p: 1 - td - .25, y: 0, f: 0, src: null }];
  }
  if (id === 'spike') return [{ p: 1, y: 0, f: 0, src: null, spike: true }];
  if (id === 'kneel') return [{ p: 1, y: -1, f: 0, src: null, kneel: true }];
  if (id === 'fg') { const p = fgProb(st.ytg); return [{ p, fg: true, made: true, y: 0, f: 0 }, { p: 1 - p, fg: true, made: false, y: 0, f: 0 }]; }
  if (id === 'punt') return [{ p: 1, punt: true, y: 0, f: 0 }];
  return [];
}

// Apply an outcome. Returns {st (new state), end (terminal info or null), first, yards, ...}
function apply(st, id, o) {
  const c = CALLS[id];
  const n = { ...st, snaps: st.snaps + 1 };
  n.T = Math.max(0, st.T - c.dur);
  const r = { yards: 0, first: false, end: null, td: false, stop: false };
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
  const incomplete = id.startsWith('p_') || id === 'hail' ? !(o.f & 1) && !(o.f & 16) : false;
  const oob = !!(o.f & 4);
  if (y >= st.dist) { r.first = true; n.down = 1; n.dist = Math.min(10, ny); }
  else { n.down = st.down + 1; n.dist = st.dist - y; }
  if (o.kneel) { n.pending = 40; }
  else if (incomplete) { n.pending = 0; r.stop = true; }
  else if (oob) { n.pending = n.T <= 120 ? 0 : 10; r.stop = true; }
  else if (r.first) { n.pending = n.T <= 120 ? 8 : 18; }
  else n.pending = 18;
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
function expected(st, id, tgt) {
  let ev = 0;
  for (const o of outcomes(st, id, tgt)) {
    if (o.p <= 0) continue;
    const { n, r } = apply(st, id, o);
    ev += o.p * (r.end ? endValue(n, r.end) : contValue(n));
  }
  return ev;
}
// All options at a state, each pass concept evaluated with its best target
function scoreOptions(st) {
  const L = st.sc.lineup, rows = [];
  for (const id of Object.keys(CALLS)) {
    if (!available(st, id)) continue;
    if (CALLS[id].pick) {
      for (const rc of L.rec.filter(r => r.pos !== 'RB')) rows.push({ id, tgt: rc, ev: expected(st, id, rc), label: `${CALLS[id].label} to ${short(rc.name)}` });
    } else rows.push({ id, ev: expected(st, id), label: CALLS[id].label });
  }
  return rows.sort((a, b) => b.ev - a.ev);
}

// ---------- helpers ----------
const short = n => { const p = String(n).split(' '); return p.length > 1 ? `${p[0][0]}. ${p.slice(1).filter(x => !/^(Jr\.?|Sr\.?|II|III|IV)$/.test(x)).join(' ') || p[1]}` : n; };
const T_ = id => D.teams[id];
const clock = t => `${Math.floor(t / 60)}:${String(Math.max(0, Math.round(t % 60))).padStart(2, '0')}`;
const pct = x => `${Math.round(x * 100)}%`;
const ord = d => ['', '1st', '2nd', '3rd', '4th'][d] || `${d}th`;
function spot(ytg, sc) { if (ytg === 50) return 'midfield'; return ytg > 50 ? `${T_(sc.off).abbr} ${100 - ytg}` : `${T_(sc.dfn).abbr} ${ytg}`; }
function downText(st) { return `${ord(st.down)} & ${st.dist >= st.ytg ? 'goal' : st.dist}`; }
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
function dailyScenario() { const i = todayIndex(); return { no: i + 1, sc: D.scen[((i % D.scen.length) + D.scen.length) % D.scen.length] }; }

// ---------- game state ----------
let G = null; // current game
function newGame(sc, mode, no) {
  G = {
    mode, no, sc, log: [], grades: [],
    st: { sc, s: sc.os - sc.ds, os: sc.os, ds: sc.ds, T: sc.secs, ytg: sc.ytg, down: sc.down, dist: sc.dist, to: sc.to, dto: sc.dto, elo: sc.elo, pending: 0, snaps: 0 },
    useTO: false, picking: null, last: null, busy: false, done: null,
  };
  G.wp0 = wpModel(G.st.s, G.st.T, G.st.ytg, G.st.down, G.st.dist, G.st.to, G.st.dto, G.st.elo);
}

// ---------- rendering: field ----------
function fieldSVG(st, sc, anim) {
  const off = T_(sc.off), def = T_(sc.dfn);
  const X = ytg => 100 + (100 - ytg) * 10; // our team drives left to right
  let s = `<svg viewBox="0 0 1200 533" role="img" aria-label="Field: ball on the ${esc(spot(st.ytg, sc))}">`;
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
    const dot = (x, y, num, fill, stroke, r = 15) => `<g><circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="3"/><text x="${x}" y="${y + 1}" fill="${stroke}" font-family="Saira Condensed, sans-serif" font-weight="700" font-size="16" text-anchor="middle" dominant-baseline="middle">${esc(num)}</text></g>`;
    {
      [-60, -30, 0, 30, 60].forEach(dy => { s += dot(los - 18, 266 + dy, '', col, alt, 13); });
      const wr = L.rec.filter(r => r.pos === 'WR'), te = L.rec.find(r => r.pos === 'TE');
      if (wr[0]) s += dot(los - 18, 60, wr[0].num, col, alt);
      if (wr[1]) s += dot(los - 30, 470, wr[1].num, col, alt);
      if (wr[2]) s += dot(los - 30, 150, wr[2].num, col, alt);
      if (te) s += dot(los - 22, 356, te.num, col, alt);
      s += dot(los - 70, 266, L.qb.num, col, alt);
      s += dot(los - 72, 310, L.rb.num, col, alt);
      const dc = def.color, da = def.alt;
      [[18, 236], [18, 266], [18, 296], [18, 206], [60, 230], [60, 300], [55, 150], [40, 60], [40, 470], [150, 190], [150, 350]]
        .forEach(([dx, y]) => { s += `<circle cx="${los + dx}" cy="${y}" r="11" fill="${da}" stroke="${dc}" stroke-width="4" opacity=".9"/>`; });
    }
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
  const chip = (num, name, pos) => `<span class="pl"><span class="n" style="background:${off.color};color:${off.alt}">${esc(num || '–')}</span>${esc(short(name))} <span class="ps">${pos}</span></span>`;
  return `<div class="lineup">${chip(L.qb.num, L.qb.name, 'QB')}${chip(L.rb.num, L.rb.name, 'RB')}${L.rec.filter(r => r.pos !== 'RB').map(r => chip(r.num, r.name, r.pos)).join('')}</div>`;
}

// ---------- screens ----------
let tab = 'daily';
function setTab(t) {
  tab = t;
  for (const [id, k] of [['tabDaily', 'daily'], ['tabPractice', 'practice'], ['tabCoaches', 'coaches']]) $('#' + id).setAttribute('aria-pressed', String(k === t));
  if (t === 'daily') showDaily();
  else if (t === 'practice') showPractice();
  else showCoaches();
  window.scrollTo(0, 0);
}

function showDaily() {
  const { no, sc } = dailyScenario();
  const prev = store.daily[no];
  $('#subline').textContent = `No. ${no} · ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  if (prev && prev.done) { newGame(sc, 'daily', no); G.done = prev.done; G.grades = prev.grades || []; G.log = prev.log || []; renderFinal(); return; }
  showIntro(sc, 'daily', no);
}

function showIntro(sc, mode, no) {
  const off = T_(sc.off), def = T_(sc.dfn), gl = gameLabel(sc);
  const st = { s: sc.os - sc.ds };
  if (mode === 'practice') $('#subline').textContent = `Practice · ${gl.when}`;
  app.innerHTML = `<section class="intro">
    <div class="eyebrow">${mode === 'daily' ? "Today's drive" : 'Practice drive'} · ${esc(gl.when)}</div>
    <div class="eyebrow" style="color:var(--chalk)">${esc(gl.title)}</div>
    <h2 class="headline">${headline(sc)}<small>${clock(sc.secs)} left in the game</small></h2>
    ${bug({ ...st, os: sc.os, ds: sc.ds, T: sc.secs, to: sc.to, dto: sc.dto }, sc)}
    <div class="pitch">Your ball, ${downText(sc)} at the ${esc(spot(sc.ytg, sc))}. You're calling it for <b>${esc(off.school)}</b>.<br>Can you do better than <b>${esc(sc.coach)}</b> did?</div>
    <button class="cta" id="go">Take the field</button>
    <div class="fine">Real score, clock, ball, timeouts and skill players from that game. ${esc(def.school)} coached by ${esc(sc.dcoach)}.</div>
  </section>`;
  $('#go').onclick = () => { newGame(sc, mode, no); renderPlay(); };
}

function renderPlay() {
  const st = G.st, sc = G.sc;
  const sitBits = [`<b>${downText(st)}</b>`, `ball on the ${esc(spot(st.ytg, sc))}`];
  if (st.pending > 0) sitBits.push(`<b style="color:var(--amber)">clock running</b>`); else sitBits.push('clock stopped');
  app.innerHTML = `<div class="game">
    <div>
      ${bug(st, sc)}
      <div class="sit">${sitBits.join(' · ')}</div>
      <div class="fieldbox" id="field">${fieldSVG(st, sc, G.anim)}</div>
      ${lineupHTML(sc)}
      ${logHTML()}
    </div>
    <div class="side" id="side"></div>
  </div>`;
  renderSide();
  if (G.anim) { const a = G.anim; requestAnimationFrame(() => requestAnimationFrame(() => { const b = $('#ball'); if (b) b.style.transform = `translate(${100 + (100 - a.to) * 10}px, ${a.y}px)`; })); }
}

function logHTML() {
  if (!G.log.length) return '';
  return `<details class="log" open><summary>Play-by-play</summary><ol>${G.log.map(l => `<li><span>${esc(l.sit)}</span> — ${esc(l.text)}</li>`).join('')}</ol></details>`;
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
    ${L.real ? `<div class="real">Real snap behind this result: <q>${esc(L.real)}</q></div>` : ''}
    <details class="opts"><summary>How every option scored</summary><div>${opts}</div><p class="note">Expected win chance after the snap, using every real play in each option's pool.</p></details>
  </div>`;
}

function renderSide() {
  const side = $('#side'), st = G.st, sc = G.sc;
  if (G.done) return;
  let h = resultHTML();
  if (G.picking) {
    const c = CALLS[G.picking];
    const recs = sc.lineup.rec.filter(r => r.pos !== 'RB');
    h += `<div class="grp"><div class="h">${esc(c.label)} <span>${esc(c.sub)}</span></div>
      <button class="back" id="back">◀ Back</button>
      <div class="note">Pick the target. Season numbers shown are per target.</div>
      <div class="calls">${recs.map((r, i) => `<button class="call" data-tgt="${i}"><b>${esc(r.num ? '#' + r.num + ' ' : '')}${esc(short(r.name))}</b><small>${r.pos} · ${Math.round(r.c * 100)}% caught · ${r.yds.toFixed(1)} yds/target · ${r.n} targets</small></button>`).join('')}</div></div>`;
    side.innerHTML = h;
    $('#back').onclick = () => { G.picking = null; renderSide(); };
    side.querySelectorAll('[data-tgt]').forEach(b => b.onclick = () => runPlay(G.picking, recs[+b.dataset.tgt]));
    return;
  }
  h += `<div class="h">Your call <span>${downText(st)} · ${esc(spot(st.ytg, sc))}</span></div>`;
  if (st.pending > 0 && st.to > 0) {
    h += `<div class="toggle"><span>Clock is running. About ${st.pending}s will come off before the snap.</span><button id="toBtn" aria-pressed="${G.useTO}">${G.useTO ? 'Timeout called' : `Timeout (${st.to} left)`}</button></div>`;
  } else if (st.pending > 0) {
    h += `<div class="toggle"><span>Clock is running and you're out of timeouts. About ${st.pending}s will come off.</span></div>`;
  }
  const groups = {};
  for (const [id, c] of Object.entries(CALLS)) (groups[c.grp] ||= []).push(id);
  for (const [g, ids] of Object.entries(groups)) {
    h += `<div class="grp"><div class="gl">${g}</div><div class="calls">`;
    for (const id of ids) {
      const c = CALLS[id], ok = available(st, id);
      if (!ok && (id === 'r_sneak' || id === 'hail' || id === 'kneel' || id === 'punt')) continue;
      let sub = c.sub;
      if (id === 'fg') sub = ok ? `${st.ytg + 17}-yard try · ${pct(fgProb(st.ytg))} make rate` : 'Out of range';
      if (id === 'r_in' || id === 'r_out') sub += ` · ${short(sc.lineup.rb.name)}`;
      if (id === 'p_rb') { const rb = sc.lineup.rec.find(r => r.pos === 'RB'); sub += rb ? ` · ${short(rb.name)}` : ''; }
      h += `<button class="call" data-call="${id}" ${ok ? '' : 'disabled'}><b>${esc(c.label)}</b><small>${esc(sub)}</small></button>`;
    }
    h += `</div></div>`;
  }
  side.innerHTML = h;
  const tb = $('#toBtn'); if (tb) tb.onclick = () => { G.useTO = !G.useTO; renderSide(); };
  side.querySelectorAll('[data-call]').forEach(b => b.onclick = () => {
    const id = b.dataset.call;
    if (CALLS[id].pick) { G.picking = id; renderSide(); return; }
    runPlay(id, id === 'p_rb' ? sc.lineup.rec.find(r => r.pos === 'RB') : null);
  });
}

// What did the real coach call on the opening snap?
function coachOpening(sc) {
  const r = sc.real.find(p => p.c && !['timeout', 'penalty', 'other'].includes(p.c));
  return r ? r.c : null;
}

function narrate(id, o, r, tgt, sc) {
  const L = sc.lineup, qb = short(L.qb.name), rb = short(L.rb.name), c = CALLS[id];
  const to = tgt ? short(tgt.name) : 'the back';
  const yds = n => `${Math.abs(n)} yard${Math.abs(n) === 1 ? '' : 's'}`;
  if (o.fg) return o.made ? `Field goal is good from ${G.prevYtg + 17}.` : `The ${G.prevYtg + 17}-yard try is no good.`;
  if (o.punt) return 'Punt away.';
  if (o.spike) return `${qb} spikes it. Clock stopped.`;
  if (o.kneel) return `${qb} takes a knee.`;
  if (o.f & 16) return `${qb} is sacked for a loss of ${yds(o.y)}.`;
  if (o.int) return (o.f & 32) ? `${qb} is picked off and it's returned for a touchdown.` : `${qb}'s pass for ${to} is intercepted.`;
  if (o.fumble) return `${rb} fumbles and the defense recovers.`;
  const tail = (r.td ? ' Touchdown!' : '') + (r.oob ? ' Out of bounds.' : '') + (r.first && !r.td ? ' First down.' : '');
  if (id === 'hail') return (o.f & 1) ? `${qb} heaves it and ${to} hauls it in for ${yds(r.yards)}.${tail}` : `${qb}'s Hail Mary falls incomplete.`;
  if (id.startsWith('p_')) {
    if (!(o.f & 1)) return `${qb}'s pass for ${to} is incomplete.`;
    const where = c.depth ? `${c.depth} ${c.side === 'mid' ? 'over the middle' : 'to the sideline'}` : 'underneath';
    return `${qb} finds ${to} ${where} for ${o.y >= 0 ? yds(r.yards) : 'a loss of ' + yds(o.y)}.${tail}`;
  }
  const runner = id === 'r_qb' || id === 'r_sneak' ? qb : rb;
  const how = { r_in: 'up the middle', r_out: 'to the outside', r_qb: 'on a keeper', r_sneak: 'on a sneak' }[id];
  return `${runner} runs ${how} for ${r.yards < 0 ? 'a loss of ' + yds(r.yards) : r.yards === 0 ? 'no gain' : yds(r.yards)}.${tail}`;
}

function runPlay(id, tgt) {
  if (G.busy) return;
  const sc = G.sc;
  let st = { ...G.st };
  // clock between snaps
  if (st.pending > 0) {
    if (G.useTO && st.to > 0) { st.to -= 1; G.log.push({ sit: clock(st.T), text: `${T_(sc.off).abbr} timeout` }); }
    else st.T = Math.max(0, st.T - (id === 'spike' ? Math.min(st.pending, 8) : st.pending));
  }
  G.useTO = false; st.pending = 0;
  if (st.T <= 0) { G.st = st; finish({ kind: 'time' }, st); return; }
  const opts = scoreOptions(st);
  const wpBefore = contValue(st);
  // sample an outcome
  const dist = outcomes(st, id, tgt);
  let u = rand() * dist.reduce((a, o) => a + o.p, 0), o = dist[dist.length - 1];
  for (const d of dist) { u -= d.p; if (u <= 0) { o = d; break; } }
  G.prevYtg = st.ytg;
  const { n, r } = apply(st, id, o);
  const text = narrate(id, o, r, tgt, sc);
  const sit = `${downText(st)} ${spot(st.ytg, sc)} ${clock(st.T)}`;
  G.log.push({ sit, text });
  const ev = expected(st, id, tgt);
  const best = opts[0]?.ev ?? ev;
  const gap = best - ev;
  const grade = gap <= 0.005 ? { cls: '', text: '✓ The best call on the board.', e: '🟩' }
    : gap <= 0.02 ? { cls: '', text: `Strong call, within ${Math.max(1, Math.round(gap * 100))} point${Math.round(gap * 100) > 1 ? 's' : ''} of the best (${esc(opts[0].label)}).`, e: '🟩' }
    : gap <= 0.05 ? { cls: 'mid', text: `Playable. ${esc(opts[0].label)} was worth ${Math.round(gap * 100)} more points of win chance.`, e: '🟨' }
    : { cls: 'low', text: `Costly. ${esc(opts[0].label)} was worth ${Math.round(gap * 100)} more points of win chance.`, e: '🟥' };
  G.grades.push(grade.e);
  const coachCall = G.st.snaps === 0 ? coachOpening(sc) : null;
  const wpAfter = r.end ? endValue(n, r.end) : contValue(n);
  let badge = r.td ? 'TD' : o.fg ? (o.made ? 'FG' : 'NO') : (o.f & 8) ? 'TO' : o.spike ? 'SPK' : (r.incomplete ? 'INC' : (r.yards > 0 ? '+' : '') + r.yards);
  let title = r.td ? 'Touchdown' : o.fg ? (o.made ? 'Field goal good' : 'Field goal missed') : o.int ? 'Intercepted' : o.fumble ? 'Fumble' : (o.f & 16) ? 'Sacked' : o.spike ? 'Spiked' : r.incomplete ? 'Incomplete' : r.first ? 'First down' : (r.end?.why || (r.yards === 0 ? 'No gain' : r.yards < 0 ? `Loss of ${-r.yards}` : `${r.yards} yard${r.yards === 1 ? '' : 's'}`));
  if (r.end?.kind === 'opp' && !o.int && !o.fumble && !o.fg) title = r.end.why;
  if (!r.end && !o.spike) title += n.pending > 0 ? ', clock running' : ', clock stopped';
  const g = o.src ? D.games[o.src[3]] : null;
  G.last = {
    id, tgt, opts, coachCall, grade, wpBefore, wpAfter, text, title, badge,
    good: r.td || (o.fg && o.made) || r.first, bad: !!(o.f & 8) || (o.fg && !o.made) || (o.f & 16),
    real: o.src && o.src[4] ? `${o.src[4]} (${T_(g[4]).school} ${g[5] ? 'vs' : 'at'} ${T_(g[3]).school}, ${g[0]})` : null,
  };
  const isPass = id.startsWith('p_') || id === 'hail';
  G.anim = (o.fg || o.punt || o.spike) ? null : { from: st.ytg, to: clamp(n.ytg || (st.ytg - r.yards), 0, 100), pass: isPass && !(o.f & 16), high: CALLS[id].depth === 'deep' || id === 'hail', y: isPass && (o.f & 1) ? (CALLS[id].side === 'mid' ? 266 : 120) : 266 };
  if (isPass && !(o.f & 1) && !(o.f & 16)) G.anim.to = st.ytg;
  G.st = n; G.picking = null;
  if (r.end) {
    G.busy = true; renderPlay();
    setTimeout(() => { G.busy = false; finish(r.end, n); }, 1400);
  } else renderPlay();
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
    { label: 'Go for two', sub: `${pct(TWO)} conversion · win chance ${pct(two)}`, go: () => { const ok = rand() < TWO; n.os += ok ? 2 : 0; n.s += ok ? 2 : 0; G.log.push({ sit: '2PT', text: ok ? 'Two-point try is good.' : 'Two-point try fails.' }); kickChoice(n, ok ? 'Two-point conversion good.' : 'Two-point try failed.'); } },
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
  if (G.mode === 'daily') { store.daily[G.no] = { done: G.done, grades: G.grades, log: G.log, coachWp: G.sc.cwp, sid: G.sc.id }; }
  else { store.practice[G.sc.id] = { wp, coachWp: G.sc.cwp }; }
  saveStore();
  renderFinal();
}

function resultWord(sc) {
  const m = { TD: 'Touchdown', FG: 'Field goal', INT: 'Interception', DOWNS: 'Turnover on downs', PUNT: 'Punt', FUMBLE: 'Fumble lost', 'MISSED FG': 'Missed field goal', 'END OF GAME': 'Ran out the clock', 'INT TD': 'Pick six', 'END OF 4TH QUARTER': 'Clock ran out' };
  return m[sc.result] || sc.result;
}
function renderFinal() {
  const sc = G.sc, d = G.done, gl = gameLabel(sc), off = T_(sc.off), def = T_(sc.dfn);
  const diff = d.wp - sc.cwp;
  const verdict = Math.abs(diff) < 0.02 ? `Dead even with ${sc.coach}` : diff > 0 ? `You beat ${sc.coach}` : `${sc.coach} wins this one`;
  const you = d.wp >= sc.cwp;
  const real = sc.real.map(p => `<li><span>${p.d ? `${ord(p.d)}&${p.dist}` : '—'} ${p.s != null ? clock(p.s) : ''}</span>${esc(p.t)}</li>`).join('');
  app.innerHTML = `<section class="final">
    <div class="eyebrow" style="text-align:center">${esc(gl.when)} · ${esc(gl.title)}</div>
    <h2 class="verdict">${esc(verdict)}</h2>
    <div class="grid-emoji" aria-label="Your play grades">${G.grades.join('')}</div>
    <div class="vs">
      <div class="${you ? 'winner' : ''}"><div class="who">You</div><div class="big">${pct(d.wp)}<small>win chance</small></div><div class="end">${esc(d.desc)}</div><div class="note">Score ${off.abbr} ${d.os}, ${def.abbr} ${d.ds} · ${d.snaps} snaps</div></div>
      <div class="${you ? '' : 'winner'}"><div class="who">${esc(sc.coach)}</div><div class="big">${pct(sc.cwp)}<small>win chance</small></div><div class="end">${esc(resultWord(sc))}. ${sc.won ? 'Won' : 'Lost'} ${sc.final[0]}–${sc.final[1]}.</div><div class="note">Win chance at the end of the real drive, same model as yours.</div></div>
    </div>
    <div class="row">
      ${G.mode === 'daily' ? '<button class="cta" id="share">Copy result</button>' : '<button class="cta" id="again">Replay this drive</button>'}
      <button class="cta ghost" id="more">Play another drive</button>
    </div>
    <div class="realdrive"><div class="h">What ${esc(sc.coach)} actually called</div><ol>${real}</ol></div>
    ${G.log.length ? `<div class="realdrive"><div class="h">Your drive</div><ol>${G.log.map(l => `<li><span>${esc(l.sit)}</span>${esc(l.text)}</li>`).join('')}</ol></div>` : ''}
  </section>`;
  const sh = $('#share');
  if (sh) sh.onclick = () => {
    const txt = `NCAA Two-Minute Drill #${G.no}\n${gl.title} (${sc.year})\n${G.grades.join('')}\nMe: ${pct(d.wp)} · ${sc.coach}: ${pct(sc.cwp)}\nncaa2mindrill.com`;
    navigator.clipboard?.writeText(txt).then(() => toast('Copied'), () => toast(txt));
  };
  const ag = $('#again'); if (ag) ag.onclick = () => { newGame(sc, G.mode, G.no); renderPlay(); };
  $('#more').onclick = () => setTab('practice');
}

// ---------- practice ----------
let pf = { q: '', year: '', kind: '' };
function showPractice() {
  $('#subline').textContent = `${D.scen.length} real drives · FBS 2023–2025`;
  const years = D.years.map(y => `<option value="${y}" ${pf.year == y ? 'selected' : ''}>${y}</option>`).join('');
  app.innerHTML = `<div class="filters">
      <input id="pq" type="search" placeholder="Search a coach or school" value="${esc(pf.q)}" aria-label="Search a coach or school">
      <select id="py" aria-label="Season"><option value="">All seasons</option>${years}</select>
      <select id="pk" aria-label="Situation"><option value="">Any situation</option><option value="tied" ${pf.kind === 'tied' ? 'selected' : ''}>Tied</option><option value="fg" ${pf.kind === 'fg' ? 'selected' : ''}>Down 1–3</option><option value="td" ${pf.kind === 'td' ? 'selected' : ''}>Down 4–8</option></select>
      <button class="cta ghost" id="rnd" style="flex:0 0 auto;width:auto">Random drive</button>
    </div><div id="plist"></div>`;
  const draw = () => {
    const q = pf.q.trim().toLowerCase();
    const list = D.scen.filter(s => {
      const d = s.ds - s.os;
      if (pf.year && s.year != pf.year) return false;
      if (pf.kind === 'tied' && d !== 0) return false;
      if (pf.kind === 'fg' && !(d >= 1 && d <= 3)) return false;
      if (pf.kind === 'td' && !(d >= 4)) return false;
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
  $('#rnd').onclick = () => showIntro(D.scen[Math.floor(rand() * D.scen.length)], 'practice');
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
  app.innerHTML = `<p class="note">Every FBS head coach who faced a late, one-score drive in this game's pool (Q4, 2:30 or less, trailing by 8 or fewer or tied). "Added" is how much the real drive moved the coach's win chance on average. Click a coach to play their drives.</p>
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
  $('#statsBody').innerHTML = `<div><b>${days.length}</b><span>Played</span></div><div><b>${beat}</b><span>Beat the coach</span></div><div><b>${streak}</b><span>Day streak</span></div><div><b>${days.length ? (avg >= 0 ? '+' : '') + Math.round(avg * 100) : '–'}</b><span>Avg vs coach</span></div>`;
  $('#statsNote').textContent = days.length ? 'Saved in this browser only.' : 'Finish today\'s drive to start your record. Saved in this browser only.';
  $('#statsDlg').showModal();
}

// ---------- boot ----------
$('#tabDaily').onclick = () => setTab('daily');
$('#tabPractice').onclick = () => setTab('practice');
$('#tabCoaches').onclick = () => setTab('coaches');
$('#helpBtn').onclick = () => $('#helpDlg').showModal();
$('#helpClose').onclick = () => $('#helpDlg').close();
$('#statsBtn').onclick = showStats;
$('#statsClose').onclick = () => $('#statsDlg').close();

fetch('data.json').then(r => r.json()).then(d => {
  D = d;
  for (const s of D.scen) s.wp0 = wpModel(s.os - s.ds, s.secs, s.ytg, s.down, s.dist, s.to, s.dto, s.elo);
  let seen = false; try { seen = localStorage.getItem('cfb2md:seen') === '1'; localStorage.setItem('cfb2md:seen', '1'); } catch { seen = true; }
  setTab('daily');
  if (!seen) $('#helpDlg').showModal();
}).catch(() => { app.innerHTML = '<p class="note">Could not load the drive data. Reload the page to try again.</p>'; });
