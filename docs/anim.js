/* Play animation for NCAA Two-Minute Drill.
 *
 * The outcome of a snap is decided before the animation starts (by the game engine); this file just shows it.
 * Field coordinates are the SVG's: 10 px per yard, offense moves +x, the line of scrimmage is `los`, the field is
 * 533 px across. The players who decide the play (passer, target, ball carrier, tackler, free rusher) follow
 * planned paths; everyone else steers: linemen hold, rushers push, corners mirror their receiver with a cushion,
 * safeties drift with the ball, linebackers drop then pursue. Speeds are per-position top speeds in px/s
 * (a yard is 10 px): a receiver at full tilt covers about 9.5 yards a second.
 */
(function () {
  'use strict';
  const TOP = { WR: 95, CB: 94, RB: 93, S: 92, LB: 85, TE: 84, QB: 77, DL: 70, OL: 60, NB: 92 };
  const ACC = { WR: 190, CB: 185, RB: 185, S: 180, LB: 165, TE: 160, QB: 150, DL: 130, OL: 110, NB: 180 };
  const MID = 266, TOPY = 14, BOTY = 519;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Parse the route mini-language used by ROUTES (relative l / q / m commands) into waypoints from (x0, y0)
  function routePoints(x0, y0, p) {
    const t = p.trim().split(/\s+/); const pts = []; let x = x0, y = y0, i = 0;
    while (i < t.length) {
      const c = t[i++];
      if (c === 'l') { x += +t[i++]; y += +t[i++]; pts.push({ x, y }); }
      else if (c === 'm') { x += +t[i++]; y += +t[i++]; }
      else if (c === 'q') {
        const cx = x + +t[i++], cy = y + +t[i++], ex = x + +t[i++], ey = y + +t[i++];
        for (let k = 1; k <= 6; k++) { const s = k / 6; pts.push({ x: (1 - s) ** 2 * x + 2 * (1 - s) * s * cx + s * s * ex, y: (1 - s) ** 2 * y + 2 * (1 - s) * s * cy + s * s * ey }); }
        x = ex; y = ey;
      } else i++;
    }
    return pts;
  }

  class Actor {
    constructor(id, pos, x, y, team, num) { this.id = id; this.pos = pos; this.x = x; this.y = y; this.vx = 0; this.vy = 0; this.team = team; this.num = num; this.plan = null; this.target = null; this.hold = false; this.down = false; this.el = null; }
    get top() { return TOP[this.pos] || 85; }
    get acc() { return ACC[this.pos] || 160; }
    // steer toward a point; slow into it when `arrive`
    seek(tx, ty, dt, speedMul = 1, arrive = true) {
      const dx = tx - this.x, dy = ty - this.y, d = Math.hypot(dx, dy);
      let want = this.top * speedMul;
      if (arrive && d < 40) want *= clamp(d / 40, 0, 1);
      const ux = d > 0.01 ? dx / d : 0, uy = d > 0.01 ? dy / d : 0;
      const ax = ux * want - this.vx, ay = uy * want - this.vy, am = Math.hypot(ax, ay), lim = this.acc * dt;
      if (am > lim) { this.vx += ax / am * lim; this.vy += ay / am * lim; } else { this.vx += ax; this.vy += ay; }
      this.x += this.vx * dt; this.y += this.vy * dt;
      return d;
    }
    stop(dt) { const k = Math.exp(-dt * 9); this.vx *= k; this.vy *= k; this.x += this.vx * dt; this.y += this.vy * dt; }
    // follow a polyline plan; returns true when finished
    follow(dt, speedMul = 1) {
      if (!this.plan || this.plan.i >= this.plan.pts.length) return true;
      const p = this.plan.pts[this.plan.i];
      const last = this.plan.i === this.plan.pts.length - 1;
      const d = this.seek(p.x, p.y, dt, speedMul, last && !this.plan.through);
      if (d < (last ? 6 : 12)) this.plan.i++;
      return this.plan.i >= this.plan.pts.length;
    }
  }

  function makeWorld(spec) {
    const { los, off, def, recs, qb, rb, ol } = spec;
    const A = [];
    const add = (id, pos, x, y, team, num) => { const a = new Actor(id, pos, x, y, team, num); A.push(a); return a; };
    const W = { A, los, t: 0, ball: { x: los - 70, y: MID, h: 0, carrier: null, flying: null, loose: false }, pops: [], done: false, spec };
    W.ol = [-60, -30, 0, 30, 60].map((dy, i) => add('OL' + i, 'OL', los - 18, MID + dy, 'off', ''));
    W.qb = add('QB', 'QB', los - 70, MID, 'off', qb.num);
    W.rb = add('RB', 'RB', los - 72, 310, 'off', rb.num);
    W.recs = recs.map(r => { const a = add(r.slot, r.pos === 'RB' ? 'RB' : r.pos, los - r.dx, r.y, 'off', r.num); a.slot = r.slot; a.route = r.route; a.sideDir = r.sideDir; return a; });
    // RB from the lineup doubles as the receiving back when the lineup has an RB receiver
    const rbRec = W.recs.find(a => a.slot === 'RB'); if (rbRec) { A.splice(A.indexOf(W.rb), 1); W.rb = rbRec; }
    W.dl = [[18, 236], [18, 266], [18, 296], [18, 206]].map(([dx, y], i) => add('DL' + i, 'DL', los + dx, y, 'def', ''));
    W.lb = [[60, 230], [60, 300]].map(([dx, y], i) => add('LB' + i, 'LB', los + dx, y, 'def', ''));
    W.nb = add('NB', 'NB', los + 55, 150, 'def', '');
    W.cb = [[40, 60], [40, 470]].map(([dx, y], i) => add('CB' + i, 'CB', los + dx, y, 'def', ''));
    W.s = [[150, 190], [150, 350]].map(([dx, y], i) => add('S' + i, 'S', los + dx, y, 'def', ''));
    // coverage assignments: corners on the outside receivers, nickel on the slot, safeties over the top
    const byY = [...W.recs].filter(a => a.pos !== 'RB').sort((a, b) => a.y - b.y);
    W.cover = new Map();
    if (byY[0]) W.cover.set(W.cb[0], byY[0]);
    if (byY[byY.length - 1]) W.cover.set(W.cb[1], byY[byY.length - 1]);
    const inside = byY.slice(1, -1);
    if (inside[0]) W.cover.set(W.nb, inside[0]);
    if (inside[1]) W.cover.set(W.lb[1], inside[1]);
    return W;
  }

  // Build the script of the play: who does what and when. Everything is in seconds from the snap.
  function script(W) {
    const S = W.spec, los = W.los, X = ytg => 100 + (100 - ytg) * 10;
    const finalX = X(S.finalYtg);
    const sc = { finalX, snapAt: 0.45 };
    for (const a of W.recs) {
      const rt = S.routes[a.route];
      a.plan = { pts: rt && rt.id ? routePoints(a.x, a.y, rt.p(a.sideDir, a.y > MID ? -1 : 1)) : [], i: 0, through: a.route === 'go' || a.route === 'seam' || a.route === 'fade' || a.route === 'wheel' };
      a.blocking = !rt || !rt.id;
      if (a.plan.through && a.plan.pts.length) { const l = a.plan.pts[a.plan.pts.length - 1]; a.plan.pts.push({ x: l.x + 400, y: l.y }); }
    }
    if (S.kind === 'pass') {
      const tgt = W.recs.find(a => a.slot === S.targetSlot) || W.rb;
      sc.target = tgt;
      const depth = S.depth === 'deep' ? 2.1 : S.depth === 'short' ? 1.05 : S.rbTarget ? 0.9 : 1.5;
      sc.throwAt = sc.snapAt + depth * (S.pa ? 1.15 : 1);
      if (S.sack) { sc.throwAt = 99; sc.sackAt = sc.snapAt + (S.strip ? 2.0 : 1.9); }
      if (S.hail) { sc.throwAt = sc.snapAt + 2.4; }
    } else if (S.kind === 'run') {
      sc.handAt = sc.snapAt + (S.qbRun ? 0 : 0.35);
      const carrier = S.qbRun ? W.qb : W.rb;
      sc.carrier = carrier;
      const side = S.outside ? (carrier.y >= MID ? 1 : -1) : 0;
      const pts = [];
      if (S.sneak) pts.push({ x: finalX, y: MID });
      else if (S.outside) { pts.push({ x: los - 25, y: MID + side * 120 }); pts.push({ x: los + 15, y: MID + side * 150 }); pts.push({ x: finalX, y: clamp(MID + side * 180, TOPY + 20, BOTY - 20) }); }
      else { pts.push({ x: los - 8, y: MID + (carrier.y > MID ? 12 : -12) }); pts.push({ x: los + 25, y: MID + (Math.random() - 0.5) * 60 }); pts.push({ x: finalX, y: clamp(MID + (Math.random() - 0.5) * 160, TOPY + 20, BOTY - 20) }); }
      if (S.oob) pts[pts.length - 1].y = pts[pts.length - 1].y > MID ? BOTY - 4 : TOPY + 4;
      if (S.td) pts[pts.length - 1].x = Math.max(finalX, 1110);
      sc.runPts = pts;
    } else if (S.kind === 'spike') { sc.spikeAt = sc.snapAt + 0.25; }
    else if (S.kind === 'kneel') { sc.kneelAt = sc.snapAt + 0.6; }
    else if (S.kind === 'fg') { sc.kickAt = sc.snapAt + 0.9; }
    return sc;
  }

  function step(W, sc, dt) {
    const S = W.spec, los = W.los, t = W.t, b = W.ball;
    const after = t - sc.snapAt;
    const X = ytg => 100 + (100 - ytg) * 10;
    if (after < 0) return; // pre-snap: everyone set
    // --- offense line and pass rush ---
    for (const o of W.ol) { if (!o.hold) { o.hold = true; } o.seek(o.x0 ?? (o.x0 = o.x - 10), o.y, dt, 0.5); }
    for (const d of W.dl) {
      if (d === sc.freeRusher && sc.sackAt) { const q = W.qb; d.seek(q.x, q.y, dt, 1, false); continue; }
      const o = W.ol.reduce((best, x) => dist(x, d) < dist(best, d) ? x : best, W.ol[0]);
      const tx = o.x + 14, ty = o.y + (d.y - o.y) * 0.3 + Math.sin(t * 7 + d.y) * 3;
      d.seek(tx, ty, dt, 0.7);
    }
    const carrier = b.carrier;
    // --- quarterback ---
    const q = W.qb;
    if (S.kind === 'pass') {
      if (!b.flying && b.carrier === q && !q.down) {
        const drop = S.pa ? (after < 0.5 ? { x: los - 78, y: MID + 10 } : { x: los - 115, y: MID }) : { x: los - (S.rbTarget ? 95 : 115), y: MID + (S.roll ? (sc.target ? Math.sign(sc.target.y - MID) * 150 : 120) : 0) };
        if (S.roll && after > 0.6) drop.x = los - 60;
        q.seek(drop.x, drop.y, dt, 0.8);
      }
      if (sc.sackAt && t >= sc.sackAt - 0.9 && !sc.freeRusher) {
        sc.freeRusher = W.dl[1]; // one rusher comes free
      }
      if (sc.sackAt && t >= sc.sackAt && !q.down) {
        q.down = true; q.x = X(S.finalYtg); q.vx = q.vy = 0; b.carrier = S.strip ? null : q;
        if (S.strip) { b.loose = true; b.x = q.x - 12; b.y = q.y + 10; sc.recoverAt = t + 0.5; }
        sc.endAt = t + (S.strip ? 1.2 : 0.8);
        W.pops.push({ t, text: S.strip ? 'STRIP SACK!' : 'SACKED!', bad: true });
      }
      if (sc.recoverAt && t >= sc.recoverAt && b.loose) { b.loose = false; const d = sc.freeRusher; b.carrier = d; d.x = b.x; d.y = b.y; }
      if (!sc.thrown && t >= sc.throwAt) {
        sc.thrown = true;
        const tg = sc.target;
        const lead = { x: tg.x + tg.vx * 0.55, y: tg.y + tg.vy * 0.55 };
        if (S.hail) { lead.x = Math.min(1095, X(S.finalYtg) + 10); lead.y = MID + (Math.random() - 0.5) * 120; }
        const d = dist(q, lead); const flight = clamp(d / 430 + 0.25, 0.35, 1.5);
        b.flying = { from: { x: q.x, y: q.y }, to: lead, t0: t, dur: flight, h: clamp(d / 6, 10, 70) * (S.depth === 'deep' || S.hail ? 1.2 : 0.7) };
        b.carrier = null;
        if (S.int) { // the nearest defender breaks on it and gets there first
          const pick = [...W.cb, ...W.s, W.nb, ...W.lb].reduce((best, x) => dist(x, lead) < dist(best, lead) ? x : best, W.s[0]);
          sc.picker = pick; pick.intercept = lead;
        }
      }
    }
    // --- ball in the air ---
    if (b.flying) {
      const f = b.flying, s = clamp((t - f.t0) / f.dur, 0, 1);
      b.x = f.from.x + (f.to.x - f.from.x) * s; b.y = f.from.y + (f.to.y - f.from.y) * s; b.h = Math.sin(s * Math.PI) * f.h;
      if (s >= 1) {
        b.flying = null; b.h = 0;
        if (S.kind === 'fg') { sc.endAt = t + 0.9; W.pops.push({ t, text: S.made ? 'GOOD!' : 'NO GOOD', bad: !S.made }); }
        else if (S.int) {
          const p = sc.picker; p.x = b.x; p.y = b.y; b.carrier = p; p.returning = true;
          const back = S.intTd ? 60 : X(S.finalYtg) ; p.plan = { pts: [{ x: S.intTd ? 60 : Math.max(110, b.x - 120), y: clamp(p.y + (Math.random() - 0.5) * 120, TOPY + 20, BOTY - 20) }], i: 0 };
          W.pops.push({ t, text: S.intTd ? 'PICK SIX!' : 'INTERCEPTED!', bad: true });
          sc.endAt = t + (S.intTd ? 2.4 : 1.4);
        } else if (S.complete) {
          const tg = sc.target; tg.x = b.x; tg.y = b.y; b.carrier = tg; tg.carrying = true;
          const fx = S.td ? Math.max(X(S.finalYtg), 1115) : X(S.finalYtg);
          const fy = S.oob ? (tg.y > MID ? BOTY - 4 : TOPY + 4) : clamp(tg.y + (Math.random() - 0.5) * 80, TOPY + 16, BOTY - 16);
          tg.plan = { pts: [{ x: fx, y: fy }], i: 0 };
          const yac = fx - b.x;
          if (S.hail) W.pops.push({ t, text: 'HE CAUGHT IT!', good: true });
          else if (S.depth === 'deep' && S.yards >= 25 && Math.random() < 0.5) W.pops.push({ t, text: 'MOSSED HIM!', good: true });
          else if (S.contested) W.pops.push({ t, text: 'CONTESTED CATCH!', good: true });
          sc.yacPop = yac > 100 ? t + 0.5 : null;
          sc.endAt = t + clamp(Math.abs(yac) / 90 + 0.9, 1.0, 3.2);
        } else {
          b.loose = true; b.drop = true;
          W.pops.push({ t, text: S.hail ? 'KNOCKED DOWN' : S.dropped ? 'DROPPED!' : S.pbu ? 'BROKEN UP!' : 'INCOMPLETE', bad: true });
          sc.endAt = t + 0.9;
        }
      }
    }
    if (sc.yacPop && t >= sc.yacPop) { sc.yacPop = null; W.pops.push({ t, text: Math.random() < 0.5 ? 'JUKED HIM!' : 'BROKE A TACKLE!', good: true }); }
    // --- run game ---
    if (S.kind === 'run') {
      const c = sc.carrier;
      if (!sc.handed && t >= sc.handAt) { sc.handed = true; b.carrier = c; c.carrying = true; c.plan = { pts: sc.runPts, i: 0 }; }
      if (!sc.handed) { if (c !== q) c.seek(q.x + 10, q.y + 25, dt, 0.6); }
      if (sc.handed && c.plan && !c.down) {
        const fin = c.follow(dt, 1);
        if (fin) { c.down = true; sc.endAt = sc.endAt || t + (S.fumble ? 1.2 : 0.7);
          if (S.fumble) { b.loose = true; b.carrier = null; b.x = c.x + 8; b.y = c.y + 6; sc.recoverAt = t + 0.45; W.pops.push({ t, text: 'FUMBLE!', bad: true }); }
          else if (S.td) W.pops.push({ t, text: S.yards >= 40 ? 'HOUSE CALL!' : 'TOUCHDOWN!', good: true });
          else if (S.yards <= -2) W.pops.push({ t, text: 'TACKLE FOR LOSS!', bad: true });
          else if (S.yards >= 12) W.pops.push({ t, text: Math.random() < 0.5 ? 'JUKED HIM!' : 'TRUCKED HIM!', good: true });
          else if (S.first) W.pops.push({ t, text: 'FIRST DOWN', good: true });
        }
        if (sc.tflPop === undefined && S.yards <= -2) sc.tflPop = null;
      }
      if (sc.recoverAt && t >= sc.recoverAt && b.loose) { b.loose = false; const d = [...W.lb, ...W.s].reduce((best, x) => dist(x, b) < dist(best, b) ? x : best, W.lb[0]); d.x = b.x; d.y = b.y; b.carrier = d; }
      if (c === q) { /* keeper: QB runs */ } else if (!q.down) { if (sc.handed) q.seek(los - 90, MID + 20, dt, 0.5); }
    }
    if (S.kind === 'spike' && t >= sc.spikeAt && !sc.spiked) { sc.spiked = true; b.carrier = null; b.loose = true; b.x = q.x + 6; b.y = q.y + 8; sc.endAt = t + 0.6; W.pops.push({ t, text: 'SPIKE · CLOCK STOPPED', good: true }); }
    if (S.kind === 'kneel' && t >= sc.kneelAt && !sc.knelt) { sc.knelt = true; q.down = true; sc.endAt = t + 0.6; }
    if (S.kind === 'fg' && t >= sc.kickAt && !sc.kicked) {
      sc.kicked = true; b.carrier = null;
      const to = S.made ? { x: 1190, y: MID } : { x: 1190, y: MID + (Math.random() < 0.5 ? -130 : 130) };
      b.flying = { from: { x: los - 70, y: MID }, to, t0: t, dur: clamp((1190 - los) / 600 + 0.6, 1.0, 2.2), h: 90 };
    }
    // --- carriers run their plans; receivers run routes ---
    for (const a of W.recs) {
      if (S.kind === 'run' && a === sc.carrier) continue; // the back is driven by the run logic above
      if (a === b.carrier && a.plan) { if (!a.down) { const fin = a.follow(dt, 1); if (fin) { a.down = true; if (S.td) W.pops.push({ t, text: S.yards >= 40 ? 'HOUSE CALL!' : 'TOUCHDOWN!', good: true }); else if (S.first && !S.oob) W.pops.push({ t, text: 'FIRST DOWN', good: true }); else if (S.oob) W.pops.push({ t, text: 'OUT OF BOUNDS', good: false }); } } else a.stop(dt); continue; }
      if (S.kind === 'run' && a === sc.carrier) continue;
      if (a.blocking) { a.seek(a.x - 6, a.y, dt, 0.4); continue; }
      if (S.kind === 'run' && after > 0.3) { a.seek(a.x + 40, a.y, dt, 0.5); continue; } // run blocking downfield
      if (sc.thrown || sc.sackAt && t > sc.sackAt) { if (a.plan && a.plan.i < a.plan.pts.length && !sc.thrown) a.follow(dt, 0.9); else a.stop(dt); continue; }
      a.follow(dt, S.kind === 'pass' ? 1 : 0.6);
    }
    if (S.kind === 'pass' && sc.target === W.rb && W.rb.plan && !sc.thrown && !W.rb.carrying) { /* back releases */ }
    // --- defense: coverage, pursuit, return ---
    const live = b.carrier && b.carrier.team === 'off' && b.carrier.carrying && !b.carrier.down ? b.carrier : null;
    for (const d of [...W.cb, ...W.s, W.nb, ...W.lb]) {
      if (d === b.carrier) { if (d.plan && !d.down) { const fin = d.follow(dt, 1); if (fin) d.down = true; } else d.stop(dt); continue; }
      if (d.intercept && b.flying) { d.seek(d.intercept.x, d.intercept.y, dt, 1.25, false); continue; }
      if (d === sc.freeRusher) { d.seek(q.x, q.y, dt, 1, false); continue; }
      if (live) { // pursue the ball carrier, meet him at his destination
        const dest = live.plan && live.plan.pts[live.plan.pts.length - 1] || live;
        const lead = { x: dest.x + (d.x > dest.x ? 14 : -14), y: dest.y + (d.y > dest.y ? 12 : -12) };
        const r = d.seek(lead.x, lead.y, dt, 1, true);
        if (live.down && r < 18) d.stop(dt);
        continue;
      }
      if (b.carrier && b.carrier.team === 'def') { d.seek(d.x - 30, d.y, dt, 0.5); continue; }
      if (sc.thrown || b.loose) { d.seek(b.x + (d.x > b.x ? 20 : -20), b.y + (d.y > b.y ? 15 : -15), dt, 0.8); continue; }
      if (S.kind === 'run' && sc.handed) { const c = sc.carrier; d.seek(c.x + 20, c.y, dt, d.pos === 'S' ? 0.8 : 1, false); continue; }
      const cov = W.cover.get(d);
      if (cov) { // mirror with a cushion, trailing slightly
        const cushion = d.pos === 'LB' ? 30 : 28;
        d.seek(cov.x + cushion + Math.max(0, cov.vx) * 0.15, cov.y + (cov.vy) * 0.1, dt, 1, false);
      } else if (d.pos === 'S') { d.seek(los + 150 + Math.min(after * 25, 60), d.y + (MID - d.y) * 0.02, dt, 0.5); }
      else { d.seek(los + 45, d.y, dt, 0.5); }
    }
    // ball rides with the carrier
    if (b.carrier && !b.flying) { b.x = b.carrier.x + 9; b.y = b.carrier.y - 4; }
    if (b.loose && b.drop) { b.x += 0; }
  }

  // ---------- rendering ----------
  function mount(svg, W) {
    const ns = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(ns, 'g'); g.setAttribute('id', 'actors');
    const { offColor, offAlt, defColor, defAlt } = W.spec;
    for (const a of W.A) {
      const e = document.createElementNS(ns, 'g');
      const isOff = a.team === 'off';
      const r = isOff && a.pos !== 'OL' ? 15 : isOff ? 13 : 11;
      e.innerHTML = `<circle r="${r}" fill="${isOff ? offColor : defAlt}" stroke="${isOff ? offAlt : defColor}" stroke-width="${isOff ? 3 : 4}" opacity="${isOff ? 1 : .92}"/>` +
        (a.num ? `<text y="1" fill="${offAlt}" font-family="Saira Condensed, sans-serif" font-weight="700" font-size="16" text-anchor="middle" dominant-baseline="middle">${a.num}</text>` : '');
      g.appendChild(e); a.el = e;
    }
    const ball = document.createElementNS(ns, 'g'); ball.setAttribute('id', 'liveball');
    ball.innerHTML = `<ellipse id="shadow" rx="12" ry="5" fill="#000" opacity=".25"/><g id="bb"><ellipse rx="13" ry="8" fill="#7a3f1d" stroke="#fff" stroke-width="2"/><line x1="-4" x2="4" y1="0" y2="0" stroke="#fff" stroke-width="2"/></g>`;
    g.appendChild(ball); W.ballEl = ball;
    svg.appendChild(g);
    W.g = g;
  }
  function draw(W) {
    for (const a of W.A) a.el.setAttribute('transform', `translate(${a.x.toFixed(1)} ${a.y.toFixed(1)})${a.down ? ' rotate(75)' : ''}`);
    const b = W.ball, sc = 1 + b.h / 90;
    W.ballEl.setAttribute('transform', `translate(${b.x.toFixed(1)} ${b.y.toFixed(1)})`);
    W.ballEl.querySelector('#bb').setAttribute('transform', `translate(0 ${-b.h * 1.4}) scale(${sc})`);
    W.ballEl.querySelector('#shadow').setAttribute('opacity', b.h > 2 ? .18 : 0);
  }

  function popup(box, p) {
    const el = document.createElement('div');
    el.className = 'pop ' + (p.good ? 'good' : p.bad ? 'bad' : '');
    el.textContent = p.text;
    box.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }

  // Play a snap. box: the .fieldbox element holding the field svg. Resolves when the animation ends or is skipped.
  function play(box, spec) {
    return new Promise(resolve => {
      const svg = box.querySelector('svg');
      const old = svg.querySelector('#formation'); if (old) old.remove();
      const oldBall = svg.querySelector('#ball'); if (oldBall) oldBall.remove();
      const W = makeWorld(spec);
      const sc = script(W);
      W.ball.carrier = W.qb; // under center / shotgun: ball starts with the center but we keep it simple
      W.ball.x = W.los - 18; W.ball.y = MID;
      mount(svg, W); draw(W);
      let last = null, raf = 0, finished = false;
      const end = () => { if (finished) return; finished = true; cancelAnimationFrame(raf); box.onclick = null; resolve(); };
      const hint = document.createElement('div'); hint.className = 'skiphint'; hint.textContent = 'Tap the field to skip'; box.appendChild(hint);
      box.onclick = () => { hint.remove(); end(); };
      if (reduced) { hint.remove(); setTimeout(end, 50); return; }
      const popped = new Set();
      const frame = ts => {
        if (finished) return;
        if (last == null) last = ts;
        // real players are fast but a 3-second route watches slow on a phone: run the clock a bit quick
        let dt = Math.min((ts - last) / 1000, 0.1) * 1.35; last = ts;
        W.t += dt;
        if (W.t < sc.snapAt) { /* set */ }
        else { if (!sc.snapPopped) { sc.snapPopped = true; } }
        const sub = dt > 0.04 ? 4 : 2;
        for (let k = 0; k < sub; k++) step(W, sc, dt / sub);
        draw(W);
        for (const p of W.pops) if (!popped.has(p)) { popped.add(p); popup(box, p); }
        if (sc.endAt && W.t >= sc.endAt) { hint.remove(); end(); return; }
        if (W.t > 9) { hint.remove(); end(); return; }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    });
  }

  window.PlayAnim = { play };
})();
