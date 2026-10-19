/* Play animation for NCAA Two-Minute Drill.
 *
 * The outcome of a snap is decided before the animation starts (by the game engine); this file shows it the way
 * it would have looked. Field coordinates are the SVG's: 10 px per yard, offense moves +x, the line of scrimmage
 * is `los`, the field is 533 px across (53⅓ yards).
 *
 * Motion: every player has a top speed and an acceleration budget by position (yards/s and yards/s², from the
 * same tracking-derived envelope the NFL game uses, scaled to px), and has to slow down to make a sharp cut.
 * The players who decide the play (passer, target, ball carrier, tackler, free rusher) follow planned paths;
 * everyone else steers: linemen hold and get pushed back as the pocket collapses, corners mirror their receiver
 * with a cushion, safeties play their shell, linebackers drop then pursue, and once the ball is caught the whole
 * defense converges on where the carrier will be tackled — the real spot of the gain. When the play-by-play says
 * where a pass was caught, the throw goes to that depth and the rest is run after catch.
 */
(function () {
  'use strict';
  // top speed (px/s = yd/s * 10) and acceleration (px/s^2) by position
  const TOP = { WR: 96, CB: 96, RB: 95, S: 93, LB: 86, TE: 85, QB: 78, DL: 70, OL: 63, NB: 95 };
  const ACC = { WR: 200, CB: 195, RB: 195, S: 185, LB: 170, TE: 165, QB: 150, DL: 130, OL: 110, NB: 190 };
  const MID = 266, TOPY = 14, BOTY = 519;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rnd = (a, b) => a + Math.random() * (b - a);

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
    constructor(id, pos, x, y, team, num) { this.id = id; this.pos = pos; this.x = x; this.y = y; this.vx = 0; this.vy = 0; this.team = team; this.num = num; this.plan = null; this.down = false; this.el = null; this.speedMul = 1; }
    get top() { return (TOP[this.pos] || 85) * this.speedMul; }
    get acc() { return ACC[this.pos] || 160; }
    // steer toward a point; slow into it when `arrive`; `cap` limits speed (used to slow into a cut)
    seek(tx, ty, dt, speedMul = 1, arrive = true, cap = Infinity) {
      const dx = tx - this.x, dy = ty - this.y, d = Math.hypot(dx, dy);
      let want = Math.min(this.top * speedMul, cap);
      if (arrive && d < 40) want *= clamp(d / 40, 0, 1);
      const ux = d > 0.01 ? dx / d : 0, uy = d > 0.01 ? dy / d : 0;
      const ax = ux * want - this.vx, ay = uy * want - this.vy, am = Math.hypot(ax, ay), lim = this.acc * dt;
      if (am > lim) { this.vx += ax / am * lim; this.vy += ay / am * lim; } else { this.vx += ax; this.vy += ay; }
      this.x += this.vx * dt; this.y += this.vy * dt;
      return d;
    }
    stop(dt) { const k = Math.exp(-dt * 9); this.vx *= k; this.vy *= k; this.x += this.vx * dt; this.y += this.vy * dt; }
    // follow a polyline plan, braking before sharp cuts; returns true when finished
    follow(dt, speedMul = 1) {
      if (!this.plan || this.plan.i >= this.plan.pts.length) return true;
      const pts = this.plan.pts, i = this.plan.i, p = pts[i], last = i === pts.length - 1;
      let cap = Infinity;
      if (!last) { // how sharp is the next cut? a 90-degree cut means slowing to ~40%
        const a = Math.atan2(p.y - this.y, p.x - this.x), b = Math.atan2(pts[i + 1].y - p.y, pts[i + 1].x - p.x);
        let turn = Math.abs(a - b); if (turn > Math.PI) turn = 2 * Math.PI - turn;
        const d = Math.hypot(p.x - this.x, p.y - this.y);
        const cutSpeed = this.top * (1 - 0.65 * turn / Math.PI);
        if (d < 45) cap = cutSpeed + (this.top - cutSpeed) * (d / 45);
      }
      const d = this.seek(p.x, p.y, dt, speedMul, last && !this.plan.through, cap);
      if (d < (last ? 6 : 10)) this.plan.i++;
      return this.plan.i >= this.plan.pts.length;
    }
  }

  function makeWorld(spec) {
    const { los, recs, qb, rb } = spec;
    const A = [];
    const add = (id, pos, x, y, team, num) => { const a = new Actor(id, pos, x, y, team, num); A.push(a); return a; };
    const W = { A, los, t: 0, ball: { x: los - 18, y: MID, h: 0, carrier: null, flying: null, loose: false }, pops: [], spec };
    W.ol = [-60, -30, 0, 30, 60].map((dy, i) => { const o = add('OL' + i, 'OL', los - 18, MID + dy, 'off', ''); o.x0 = o.x; o.y0 = o.y; return o; });
    W.qb = add('QB', 'QB', los - 70, MID, 'off', qb.num);
    W.rb = add('RB', 'RB', los - 72, 310, 'off', rb.num);
    W.recs = recs.map(r => { const a = add(r.slot, r.pos === 'RB' ? 'RB' : r.pos, los - r.dx, r.y, 'off', r.num); a.slot = r.slot; a.route = r.route; a.sideDir = r.sideDir; return a; });
    const rbRec = W.recs.find(a => a.slot === 'RB'); if (rbRec) { A.splice(A.indexOf(W.rb), 1); W.rb = rbRec; }
    // defense, aligned to the look the offense saw
    const look = spec.look || 'base';
    const dl = [[18, 236], [18, 266], [18, 296], [18, 206]];
    const lb = look === 'blitz' ? [[26, 225], [26, 305]] : look === 'loaded' ? [[40, 230], [40, 300]] : look === 'prevent' ? [[80, 236], [80, 296]] : [[60, 230], [60, 300]];
    const nb = look === 'loaded' ? [42, 170] : look === 'prevent' ? [95, 150] : [55, 150];
    const cb = look === 'prevent' ? [[90, 70], [90, 460]] : look === 'light' ? [[55, 60], [55, 470]] : [[40, 60], [40, 470]];
    const s = look === 'loaded' ? [[48, 350], [150, 230]] : look === 'prevent' ? [[230, 170], [230, 360]] : look === 'blitz' ? [[130, 180], [130, 350]] : [[150, 190], [150, 350]];
    W.dl = dl.map(([dx, y], i) => add('DL' + i, 'DL', los + dx, y, 'def', ''));
    W.lb = lb.map(([dx, y], i) => add('LB' + i, 'LB', los + dx, y, 'def', ''));
    W.nb = add('NB', 'NB', los + nb[0], nb[1], 'def', '');
    W.cb = cb.map(([dx, y], i) => add('CB' + i, 'CB', los + dx, y, 'def', ''));
    W.s = s.map(([dx, y], i) => add('S' + i, 'S', los + dx, y, 'def', ''));
    for (const d of [...W.dl, ...W.lb, W.nb, ...W.cb, ...W.s]) { d.x0 = d.x; d.y0 = d.y; }
    // real defenders by role, so the numbers on the field match the names in the narration
    const pool = (spec.dlineup || []).slice();
    const take = role => { const i = pool.findIndex(x => x.role === role); return i >= 0 ? pool.splice(i, 1)[0] : null; };
    const any = () => pool.length ? pool.shift() : null;
    W.dl.forEach(d => { const x = take('DL') || take('LB') || any(); if (x) d.num = x.num; });
    W.lb.forEach(d => { const x = take('LB') || any(); if (x) d.num = x.num; });
    [...W.cb, W.nb, ...W.s].forEach(d => { const x = take('DB') || any(); if (x) d.num = x.num; });
    W.whoNum = spec.whoNum || null;
    W.sfx = name => { if (W.live && window.Sound) window.Sound.fx(name); };
    // coverage: corners on the outside receivers, nickel on the slot, a backer or safety on the tight end
    const byY = [...W.recs].filter(a => a.pos !== 'RB').sort((a, b) => a.y - b.y);
    W.cover = new Map();
    if (byY[0]) W.cover.set(W.cb[0], byY[0]);
    if (byY[byY.length - 1]) W.cover.set(W.cb[1], byY[byY.length - 1]);
    const inside = byY.slice(1, -1);
    if (inside[0]) W.cover.set(W.nb, inside[0]);
    if (inside[1]) W.cover.set(look === 'loaded' ? W.s[0] : W.lb[1], inside[1]);
    W.look = look;
    trickFormation(W, spec);
    return W;
  }
  // Trick plays change the formation before the snap: a wildcat or Philly Special splits the quarterback out and
  // puts the back under center, a jet sweep starts a receiver in motion, and the fake kicks line up as kicks.
  function trickFormation(W, spec) {
    const T = spec.trick; if (!T) return;
    const los = W.los, side = spec.side || 1, q = W.qb, rb = W.rb;
    if (T === 't_wildcat' || T === 't_philly') {
      const P = T === 't_philly' ? (W.recs.find(a => a.slot === spec.passerSlot) || W.recs.find(a => a.pos !== 'RB')) : null;
      const s = P ? (Math.sign(P.y - MID) || 1) : -1;
      q.x = los - 12; q.y = s > 0 ? BOTY - 22 : TOPY + 22; W.qbWide = true;
      rb.x = los - 70; rb.y = MID; W.snapTo = rb;
      W.phillySide = s;
    }
    if (T === 't_jet') {
      const far = W.recs.filter(a => a.pos !== 'RB' && Math.sign(a.y - MID) === -side).sort((a, b) => Math.abs(b.y - MID) - Math.abs(a.y - MID))[0] || W.recs.find(a => a.pos !== 'RB');
      if (far) { const meet = { x: los - 64, y: MID - side * 26 }; W.jet = far; far.manual = true; far.plan = { pts: [{ x: los - 52, y: MID - side * 70 }, meet, { x: los - 66, y: MID + side * 20 }], i: 0, through: true }; W.snapAt = clamp(0.6 + dist(far, meet) / 80, 1.1, 2.6); }
    }
    if (T === 't_fakefg') {
      W.ol.forEach((o, i) => { o.y = MID + (i - 2) * 24; o.y0 = o.y; });
      for (const a of W.recs) if (a !== rb) { a.x = los - 16; a.y = clamp(MID + (a.y - MID) * 0.5, TOPY + 40, BOTY - 40); a.route = 'block'; }
      q.x = los - 70; q.y = MID; rb.x = los - 96; rb.y = MID + 18; W.snapTo = null;
    }
    if (T === 't_fakepunt') {
      W.ol.forEach((o, i) => { o.y = MID + (i - 2) * 26; o.y0 = o.y; });
      for (const a of W.recs) if (a !== rb) { const wide = Math.abs(a.y - MID) > 150; a.x = los - (wide ? 8 : 16); if (!wide) a.y = clamp(MID + (a.y - MID) * 0.55, TOPY + 50, BOTY - 50); a.route = wide ? 'go' : 'block'; }
      q.x = los - 140; q.y = MID; rb.x = los - 62; rb.y = MID + 26; W.snapTo = null;
    }
    for (const a of W.recs) if (a.route === 'block' && !a.plan) { a.plan = { pts: [], i: 0 }; a.blocking = true; }
  }

  // Build the script of the play: who does what and when. Times are seconds from the start of the animation.
  function script(W) {
    const S = W.spec, los = W.los, X = ytg => 100 + (100 - ytg) * 10;
    const finalX = S.td ? Math.max(X(S.finalYtg), 1115) : X(S.finalYtg);
    const sc = { finalX, snapAt: W.snapAt || 0.5 };
    for (const a of W.recs) {
      if (a === W.jet) continue; // already in motion
      const rt = S.routes[a.route];
      a.plan = { pts: rt && rt.id ? routePoints(a.x, a.y, rt.p(a.sideDir, a.y > MID ? -1 : 1)) : [], i: 0, through: ['go', 'seam', 'fade', 'wheel'].includes(a.route) };
      a.blocking = !rt || !rt.id;
      if (a.plan.through && a.plan.pts.length) { const l = a.plan.pts[a.plan.pts.length - 1]; a.plan.pts.push({ x: l.x + 400, y: l.y }); }
      for (const p of a.plan.pts) p.x = Math.min(p.x, 1180); // routes stop at the back of the end zone
    }
    if (S.kind === 'flag') { sc.flagAt = 0.9; sc.endAt = 2.3; return sc; }
    if (S.kind === 'pass') {
      const tgt = W.recs.find(a => a.slot === S.targetSlot) || (S.targetSlot === 'QB' ? W.qb : W.rb);
      sc.target = tgt;
      // throw when the target reaches the depth the pass was really caught at; otherwise by concept depth
      sc.airX = S.air != null && S.complete ? los + S.air * 10 : null;
      const depth = S.hail ? 2.4 : S.depth === 'deep' ? 2.0 : S.rbTarget ? 0.9 : S.depth === 'short' ? 1.05 : 1.5;
      sc.throwAt = sc.snapAt + depth * (S.pa ? 1.15 : 1) * (S.hurried ? 0.8 : 1);
      sc.throwMin = sc.snapAt + 0.55;
      if (S.sack) { sc.throwAt = 99; sc.airX = null; sc.sackAt = sc.snapAt + (S.strip ? 2.0 : 1.85); }
      if (S.scramble) { sc.throwAt = 99; sc.airX = null; sc.scrambleAt = sc.snapAt + 1.5; }
      if (S.hurried && !S.sack) sc.pressureAt = sc.snapAt + 0.4;
    } else if (S.kind === 'run') {
      // the concept sets how the back gets to the hole; the aim point (if you tapped one) is the hole itself
      const type = S.runType || (S.outside ? 'r_out' : 'r_in');
      sc.toss = type === 'r_toss'; sc.draw = type === 'r_draw'; sc.counter = type === 'r_counter';
      sc.handAt = sc.snapAt + (S.qbRun && !S.scramble ? 0 : sc.draw ? 0.95 : sc.toss ? 0.3 : 0.35);
      const carrier = S.qbRun ? W.qb : W.rb;
      sc.carrier = carrier;
      const side = S.side || (carrier.y >= MID ? 1 : -1);
      const lane = S.lane || (S.outside ? 'out' : 'in');
      const laneY = lane === 'in' ? MID + side * rnd(8, 35) : lane === 'tackle' ? MID + side * rnd(50, 80) : MID + side * rnd(140, 190);
      const hole = S.aim ? { x: Math.max(S.aim.x, los + 4), y: S.aim.y } : { x: los + (lane === 'out' ? 12 : 22), y: laneY };
      sc.hole = hole; sc.side = side;
      const pts = [];
      if (S.sneak) pts.push({ x: finalX, y: MID + rnd(-8, 8) });
      else {
        if (sc.counter) { pts.push({ x: los - 38, y: carrier.y - side * 45 }); pts.push({ x: los - 14, y: MID + side * 15 }); }
        else if (sc.toss) { pts.push({ x: los - 40, y: MID + side * 95 }); }
        else if (lane === 'out') { pts.push({ x: los - 28, y: MID + side * 110 }); }
        else if (sc.draw) { pts.push({ x: los - 30, y: MID + side * 10 }); }
        else { pts.push({ x: los - 10, y: hole.y + (carrier.y > hole.y ? 10 : -10) }); }
        pts.push({ x: hole.x, y: hole.y });
        pts.push({ x: finalX, y: clamp(hole.y + side * rnd(-20, 60), TOPY + 18, BOTY - 18) });
      }
      if (S.yards <= -2 && !S.sneak) { pts.length = 0; pts.push({ x: los - 12, y: carrier.y + side * 20 }); pts.push({ x: finalX, y: carrier.y + side * 35 }); sc.tfl = true; }
      if (S.oob) pts[pts.length - 1].y = pts[pts.length - 1].y > MID ? BOTY - 4 : TOPY + 4;
      sc.runPts = pts;
    } else if (S.kind === 'spike') { sc.spikeAt = sc.snapAt + 0.25; }
    else if (S.kind === 'kneel') { sc.kneelAt = sc.snapAt + 0.6; }
    else if (S.kind === 'fg') { sc.kickAt = sc.snapAt + 0.9; }
    if (S.trick) trickScript(W, sc);
    return sc;
  }
  // The choreography of each trick: who has the ball when, and when the real throw or carry starts.
  function trickScript(W, sc) {
    const S = W.spec, los = W.los, T = S.trick, q = W.qb, rb = W.rb, side = S.side || 1;
    sc.trick = T; sc.airX = null;
    if (S.kind === 'pass') {
      const dev = { t_flea: 1.9, t_hbpass: 1.6, t_philly: 1.9, t_hook: 0 }[T] || 0;
      sc.passer = T === 't_hbpass' ? rb : T === 't_philly' ? (W.recs.find(a => a.slot === S.passerSlot) || W.recs.find(a => a.pos !== 'RB') || q) : q;
      sc.throwAt = sc.snapAt + dev + (T === 't_hook' ? 1.1 : 0.7);
      if (S.sack) { sc.throwAt = 99; sc.sackAt = sc.snapAt + dev + (T === 't_hook' ? 1.6 : 0.75); }
      if (S.blown) { sc.throwAt = 99; sc.sackAt = sc.snapAt + 0.95; } // nobody bit: met in the backfield before the trick develops
      if (S.scramble) { sc.throwAt = 99; sc.scrambleAt = sc.snapAt + dev + 0.5; }
      if (T === 't_flea' || T === 't_hbpass' || T === 't_hook' || T === 't_philly') rb.manual = true;
      if (T === 't_philly') {
        const P = sc.passer, s = W.phillySide || 1; sc.side = s; P.manual = true; P.plan = { pts: [{ x: los - 72, y: MID + s * 36 }], i: 0 };
        q.plan = { pts: [{ x: los + 40, y: q.y - s * 4 }, { x: los + 150, y: q.y - s * 40 }], i: 0 }; q.manual = true;
      }
      if (T === 't_hook' && !W.recs.includes(rb)) W.recs.push(rb);
    } else {
      sc.passSet = ['t_statue', 't_fakefg', 't_fakepunt'].includes(T);
      if (T === 't_reverse') {
        sc.handAt = sc.snapAt + 0.35; sc.exchangeAt = sc.snapAt + 1.2; sc.runPts = [{ x: los - 34, y: MID + side * 150 }]; sc.tfl = false; rb.manual = true;
        const w = W.recs.filter(a => a.pos !== 'RB' && Math.sign(a.y - MID) === side).sort((a, b) => Math.abs(b.y - MID) - Math.abs(a.y - MID))[0] || W.recs.find(a => a.pos !== 'RB');
        W.rev = w; w.manual = true; w.plan = { pts: [{ x: los - 48, y: MID + side * 100 }], i: 0 };
      }
      if (T === 't_jet' && W.jet) { sc.carrier = W.jet; sc.handAt = sc.snapAt + 0.12; sc.trickPop = 'JET SWEEP!'; if (S.yards <= -2) sc.runPts = [{ x: los - 30, y: MID + side * 90 }, { x: sc.finalX, y: MID + side * 120 }]; }
      if (T === 't_wildcat') { sc.handAt = sc.snapAt; }
      if (T === 't_statue') { sc.handAt = sc.snapAt + 1.0; sc.trickPop = 'STATUE OF LIBERTY!'; }
      if (T === 't_fakefg') { sc.handAt = sc.snapAt + 0.75; sc.longSnap = 0.3; sc.trickPop = 'FAKE!'; }
      if (T === 't_fakepunt') { sc.handAt = sc.snapAt + 0.85; sc.longSnap = 0.5; sc.trickPop = 'FAKE PUNT!'; }
    }
  }
  // per-frame movement the trick needs before the real throw happens
  function trickPass(W, sc, dt) {
    const S = W.spec, t = W.t, b = W.ball, q = W.qb, rb = W.rb, los = W.los, after = t - sc.snapAt, side = sc.side || 1, T = S.trick;
    if (T === 't_flea') {
      if (!sc.handed) { rb.seek(los - 58, MID + 22, dt, 0.8); q.seek(los - 76, MID + 6, dt, 0.6);
        if (after >= 0.35) { sc.handed = true; b.carrier = rb; rb.plan = { pts: [{ x: los - 14, y: MID + 30 }], i: 0 }; sc.bite = { from: t, to: t + 1.1 }; } }
      else if (!sc.pitched) { if (rb.plan) rb.follow(dt, 0.85); q.seek(los - 118, MID, dt, 0.9);
        if (after >= 1.15) { sc.pitched = true; rb.plan = null; b.carrier = null; b.flying = { from: { x: rb.x, y: rb.y }, to: { x: q.x + 6, y: q.y }, t0: t, dur: 0.38, h: 22, onLand: () => { b.carrier = q; } }; W.pops.push({ t, text: 'FLEA FLICKER!', good: true }); } }
      else { rb.seek(los - 30, MID + 45, dt, 0.5); if (b.carrier === q && !q.down && !q.plan) q.seek(los - 118, MID, dt, 0.7); }
      return;
    }
    if (T === 't_hbpass') {
      if (!sc.tossed) { rb.seek(los - 42, MID + side * 95, dt, 0.9, false); q.seek(los - 72, MID + side * 10, dt, 0.5);
        if (after >= 0.3) { sc.tossed = true; b.carrier = null; b.flying = { from: { x: q.x, y: q.y }, to: { x: rb.x + 12, y: rb.y + side * 6 }, t0: t, dur: 0.32, h: 14, onLand: () => { b.carrier = rb; rb.plan = { pts: [{ x: los - 34, y: MID + side * 150 }], i: 0 }; } }; sc.bite = { from: t, to: t + 1.3 }; } }
      else { if (rb.plan && b.carrier === rb && !rb.down && rb.follow(dt, 0.9)) { rb.plan = null; sc.throwAt = Math.min(sc.throwAt, t + 0.35); } q.seek(los - 90, MID - side * 25, dt, 0.5); }
      return;
    }
    if (T === 't_philly') {
      const P = sc.passer;
      if (!sc.pitched) { rb.seek(los - 62, MID - side * 55, dt, 0.65); if (P.plan) P.follow(dt, 0.95);
        if (after >= 1.0) { sc.pitched = true; b.carrier = null; P.plan = null; b.flying = { from: { x: rb.x, y: rb.y }, to: { x: P.x + 6, y: P.y }, t0: t, dur: 0.3, h: 14, onLand: () => { b.carrier = P; sc.throwAt = Math.min(sc.throwAt, W.t + 0.7); } }; sc.bite = { from: t - 0.5, to: t + 0.6 }; } }
      else { if (b.carrier === P && !P.down) P.seek(los - 62, MID + side * 30, dt, 0.8); rb.seek(los - 50, MID - side * 70, dt, 0.4); }
      if (q.plan && !q.carrying && !q.down) q.follow(dt, 0.95); // the quarterback runs his route
      return;
    }
    if (T === 't_hook') {
      const tg = sc.target;
      if (!sc.thrown) { rb.seek(tg.x - 40, tg.y + (tg.y > MID ? -28 : 28), dt, 0.9, false); if (!b.flying && b.carrier === q && !q.down && !q.plan) q.seek(los - 105, MID, dt, 0.85); }
      else if (!sc.lateraled) rb.seek(tg.x - 30, tg.y + (tg.y > MID ? -24 : 24), dt, 1, false);
    }
  }
  function trickRun(W, sc, dt) {
    const S = W.spec, t = W.t, q = W.qb, rb = W.rb, los = W.los, side = sc.side, T = S.trick;
    if (!sc.handed) {
      if (T === 't_reverse') { rb.seek(q.x + 10, q.y + 25, dt, 0.6); q.seek(los - 72, MID, dt, 0.5); }
      else if (T === 't_jet') { if (W.jet && W.jet.plan) W.jet.follow(dt, 0.9); }
      else if (T === 't_statue') { rb.seek(los - 84, MID + side * 10, dt, 0.55); q.seek(los - 108, MID, dt, 0.85); }
      else if (T === 't_fakefg') { rb.seek(los - 84, MID + 10, dt, 0.5); }
      return;
    }
    if (T === 't_reverse') {
      if (!sc.exchanged) {
        if (W.rev.plan) W.rev.follow(dt, 0.95);
        if (t >= sc.exchangeAt) {
          sc.exchanged = true; const w = W.rev, fs = -side; rb.carrying = false; rb.plan = null; sc.carrier = w; W.ball.carrier = w; w.carrying = true; w.manual = false;
          const pts = S.yards <= -2 ? [{ x: los - 22, y: MID + fs * 120 }, { x: sc.finalX, y: MID + fs * 140 }] : [{ x: los - 30, y: MID + fs * 125 }, { x: los + 12, y: MID + fs * 165 }, { x: sc.finalX, y: clamp(MID + fs * rnd(120, 190), TOPY + 18, BOTY - 18) }];
          if (S.oob) pts[pts.length - 1].y = fs > 0 ? BOTY - 4 : TOPY + 4;
          w.plan = { pts, i: 0 }; assignTackler(W, sc, w); W.pops.push({ t, text: 'REVERSE!', good: true });
        }
      } else rb.seek(los - 20, MID + side * 120, dt, 0.5);
    }
  }

  // a long carry still has to fit the clip: speed the carrier up so his path takes at most ~3.2 s
  function pace(a) {
    if (!a.plan) return;
    let len = 0, px = a.x, py = a.y;
    for (const p of a.plan.pts.slice(a.plan.i)) { len += Math.hypot(p.x - px, p.y - py); px = p.x; py = p.y; }
    const base = TOP[a.pos] || 85;
    a.speedMul = clamp(len / (3.2 * base), 1, 1.9);
  }
  // once someone has the ball, pick the tackler and set his effort so he meets the carrier at the real spot
  function assignTackler(W, sc, carrier) {
    pace(carrier);
    const dest = carrier.plan && carrier.plan.pts[carrier.plan.pts.length - 1] || carrier;
    const eta = Math.max(0.3, dist(carrier, dest) / (carrier.top * 0.95));
    let best = null, bestNeed = Infinity;
    for (const d of [...W.cb, ...W.s, W.nb, ...W.lb, ...W.dl]) {
      if (d === W.ball.carrier) continue;
      const need = dist(d, dest) / eta / (TOP[d.pos] || 85);
      if (need < bestNeed) { bestNeed = need; best = d; }
    }
    if (best) { best.tackler = true; best.speedMul = clamp(bestNeed * 1.05, 0.55, 1.3); sc.tackler = best; if (W.whoNum) swapNum(W, best, W.whoNum); }
  }
  // the defender credited in the narration takes the dot that makes the play
  function swapNum(W, actor, num) {
    if (!num || actor.num === num) return;
    const other = W.A.find(a => a.team === 'def' && a.num === num);
    if (other) other.num = actor.num;
    actor.num = num;
  }

  function step(W, sc, dt) {
    const S = W.spec, los = W.los, t = W.t, b = W.ball;
    const after = t - sc.snapAt;
    const X = ytg => 100 + (100 - ytg) * 10;
    if (S.kind === 'flag') { if (t >= sc.flagAt && !sc.flagged) { sc.flagged = true; W.pops.push({ t, text: 'FLAG', flag: true, sub: S.flag.kind.toUpperCase() + ' · ' + (S.flag.onDefense ? 'DEFENSE' : 'OFFENSE') }); } return; }
    if (after < 0) { // pre-snap: a blitz look creeps, prevent backs up, a jet-sweep receiver goes in motion
      if (W.look === 'blitz') for (const l of W.lb) l.seek(l.x0 - 8 * after, l.y0, dt, 0.3);
      if (W.jet && W.jet.plan) W.jet.follow(dt, 0.9);
      return;
    }
    const q = W.qb, P = sc.passer || q; // whoever throws it (the back on a halfback pass, the tight end on the Philly Special)
    if (!sc.snapped) {
      sc.snapped = true;
      if (sc.longSnap) { b.carrier = null; b.flying = { from: { x: los - 18, y: MID }, to: { x: q.x + 8, y: q.y }, t0: t, dur: sc.longSnap, h: 10, onLand: () => { b.carrier = q; } }; }
      if (S.trick === 't_wildcat') W.pops.push({ t, text: 'WILDCAT!', good: true });
    }
    const isRun = S.kind === 'run';
    const fire = isRun && !((sc.draw || sc.passSet) && !sc.handed); // a draw (or a fake) shows pass protection until the handoff
    // --- line play: pass sets back and the pocket collapses; run fires out ---
    for (const o of W.ol) {
      const tx = fire ? o.x0 + 14 : o.x0 - 8 - Math.min(after, 2.5) * 10;
      o.seek(tx, o.y0 + (fire ? (o.y0 > MID ? 6 : -6) : 0), dt, 0.6);
    }
    for (const d of W.dl) {
      if (d === sc.freeRusher) { d.seek(P.x, P.y, dt, 1.05, false); continue; }
      if (d.tackler) continue;
      const o = W.ol.reduce((best, x) => dist(x, d) < dist(best, d) ? x : best, W.ol[0]);
      d.seek(o.x + 15, o.y + (d.y0 - o.y0) * 0.4 + Math.sin(t * 7 + d.y0) * 3, dt, 0.75);
    }
    // --- quarterback ---
    const tdText = () => S.twoPt ? 'TWO POINTS!' : S.yards >= 40 ? 'HOUSE CALL!' : 'TOUCHDOWN!';
    if (S.kind === 'pass') {
      if (sc.trick) { if (!sc.sacked) trickPass(W, sc, dt); }
      else if (!b.flying && b.carrier === q && !q.down && !q.plan) {
        const drop = S.pa ? (after < 0.5 ? { x: los - 78, y: MID + 12 } : { x: los - 118, y: MID })
          : { x: los - (S.rbTarget ? 95 : 118) + (after > 1.8 ? 10 : 0), y: MID + (S.roll ? (sc.target ? Math.sign(sc.target.y - MID) * 160 : 120) : 0) };
        if (S.roll && after > 0.6) drop.x = los - 55;
        if (sc.pressureAt && t > sc.pressureAt + 0.8) { drop.x += 20; drop.y += 25; } // climbs the pocket under pressure
        q.seek(drop.x, drop.y, dt, 0.85);
      }
      if ((sc.sackAt || sc.pressureAt) && t >= (sc.sackAt ? sc.sackAt - 0.9 : sc.pressureAt) && !sc.freeRusher) { sc.freeRusher = W.look === 'blitz' ? W.lb[0] : W.dl[Math.random() < 0.5 ? 0 : 3]; if (sc.sackAt && W.whoNum) swapNum(W, sc.freeRusher, W.whoNum); }
      if (sc.sackAt && t >= sc.sackAt && !P.down && !sc.sacked) {
        const V = b.carrier && b.carrier.team === 'off' ? b.carrier : P; // whoever has it goes down (a blown-up trick catches the back)
        sc.sacked = true; V.down = true; W.sfx('bighit'); V.x = X(S.finalYtg); V.vx = V.vy = 0; V.plan = null; b.flying = null; b.carrier = S.strip ? null : V;
        if (sc.freeRusher) { sc.freeRusher.down = true; sc.freeRusher.x = V.x + 10; sc.freeRusher.y = V.y + 6; }
        if (S.strip) { b.loose = true; b.x = V.x - 14; b.y = V.y + 12; sc.recoverAt = t + 0.5; }
        sc.endAt = t + (S.strip ? 1.3 : 0.9);
        W.pops.push({ t, text: S.blown ? (S.strip ? 'BLOWN UP, BALL OUT!' : 'BLOWN UP!') : S.strip ? 'STRIP SACK!' : 'SACKED!', bad: true });
      }
      if (sc.scrambleAt && t >= sc.scrambleAt && !q.plan && b.carrier === q) {
        q.plan = { pts: [{ x: los - 40, y: q.y + (Math.random() < 0.5 ? -1 : 1) * 90 }, { x: sc.finalX, y: clamp(q.y + rnd(-120, 120), TOPY + 18, BOTY - 18) }], i: 0 };
        if (S.oob) q.plan.pts[1].y = q.plan.pts[1].y > MID ? BOTY - 4 : TOPY + 4;
        q.carrying = true; W.pops.push({ t, text: 'SCRAMBLE!', good: true }); assignTackler(W, sc, q);
      }
      if (q.plan && !q.down && q.carrying) { if (q.follow(dt, 1)) { q.down = true; if (!S.td && !S.oob) W.sfx('hit'); sc.endAt = t + 0.8; if (S.td) W.pops.push({ t, text: tdText(), good: true }); else if (S.twoPt) W.pops.push({ t, text: 'NO GOOD', bad: true }); else if (S.first) W.pops.push({ t, text: 'FIRST DOWN', good: true }); } }
      if (sc.recoverAt && t >= sc.recoverAt && b.loose) { b.loose = false; b.drop = false; const d = sc.freeRusher || W.lb[0]; b.carrier = d; d.x = b.x; d.y = b.y; }
      // hook and ladder: the catch was the first half; the pitch to the trailing back is the play
      if (sc.lateralAt && t >= sc.lateralAt && !sc.lateraled) {
        sc.lateraled = true; const tg = sc.target, rb = W.rb; tg.carrying = false; tg.plan = null; b.carrier = null;
        const to = S.lateralLost ? { x: rb.x - 24, y: rb.y + 10 } : { x: rb.x + 8, y: rb.y };
        b.flying = { from: { x: tg.x, y: tg.y }, to, t0: t, dur: 0.3, h: 16, onLand: () => {
          if (S.lateralLost) { b.loose = true; b.drop = true; b.vx = 25; b.vy = 0; sc.recoverAt = W.t + 0.5; sc.endAt = W.t + 1.5; W.pops.push({ t: W.t, text: 'LATERAL ON THE GROUND!', bad: true }); return; }
          b.carrier = rb; rb.carrying = true; rb.manual = false; rb.x = b.x; rb.y = b.y;
          const fy = S.oob ? (rb.y > MID ? BOTY - 4 : TOPY + 4) : clamp(rb.y + rnd(-40, 40), TOPY + 16, BOTY - 16);
          rb.plan = { pts: [{ x: sc.finalX, y: fy }], i: 0 }; assignTackler(W, sc, rb);
          sc.endAt = W.t + clamp(Math.abs(sc.finalX - b.x) / 90 + 0.9, 1.0, 3.2);
        } };
        W.pops.push({ t, text: 'HOOK AND LADDER!', good: true });
      }
      const tg = sc.target;
      const ready = sc.airX != null ? (t >= sc.throwMin && (tg.x >= sc.airX - 6 || (tg.plan && tg.plan.i >= tg.plan.pts.length) || t >= sc.throwAt + 1.2)) : t >= sc.throwAt;
      if (!sc.thrown && ready && b.carrier === P && !P.down && !P.plan) {
        sc.thrown = true;
        const lead = { x: tg.x + tg.vx * 0.5, y: tg.y + tg.vy * 0.5 };
        if (sc.airX != null) lead.x = Math.max(lead.x, sc.airX);
        if (S.hail) { lead.x = Math.min(1095, X(S.finalYtg) + 10); lead.y = MID + rnd(-60, 60); }
        if (!S.complete && !S.int) { lead.x += rnd(-10, 25); lead.y += rnd(-18, 18); } // an incompletion is off the mark or contested
        lead.x = clamp(lead.x, 110, S.td ? 1150 : 1095); lead.y = clamp(lead.y, TOPY + 6, BOTY - 6);
        const d = dist(P, lead); const flight = clamp(d / 440 + 0.25, 0.35, 1.5);
        b.flying = { from: { x: P.x, y: P.y }, to: lead, t0: t, dur: flight, h: clamp(d / 6, 10, 70) * (S.depth === 'deep' || S.hail ? 1.2 : 0.7) };
        b.carrier = null;
        if (S.trick === 't_hbpass') W.pops.push({ t, text: 'HALFBACK PASS!', good: true });
        if (S.trick === 't_philly') W.pops.push({ t, text: 'PHILLY SPECIAL!', good: true });
        if (S.int) { const pick = [...W.cb, ...W.s, W.nb, ...W.lb].reduce((best, x) => dist(x, lead) < dist(best, lead) ? x : best, W.s[0]); sc.picker = pick; pick.intercept = lead; if (W.whoNum) swapNum(W, pick, W.whoNum); }
        else if (S.pbu || (!S.complete && !S.dropped && Math.random() < 0.5)) { const db = [...W.cb, ...W.s, W.nb].reduce((best, x) => dist(x, lead) < dist(best, lead) ? x : best, W.cb[0]); db.intercept = lead; db.breakup = true; sc.breaker = db; if (S.pbu && W.whoNum) swapNum(W, db, W.whoNum); }
      }
    }
    // --- ball in the air ---
    if (b.flying) {
      const f = b.flying, s = clamp((t - f.t0) / f.dur, 0, 1);
      b.x = f.from.x + (f.to.x - f.from.x) * s; b.y = f.from.y + (f.to.y - f.from.y) * s; b.h = Math.sin(s * Math.PI) * f.h;
      if (s >= 1) {
        b.flying = null; b.h = 0;
        if (f.onLand) f.onLand(); // a pitch, a long snap, a lateral: the trick says what happens next
        else if (isRun) { const c = sc.carrier; b.carrier = c; c.carrying = true; } // the toss arrives
        else if (S.kind === 'fg') { sc.endAt = t + 0.9; W.pops.push({ t, text: S.made ? 'GOOD!' : 'NO GOOD', bad: !S.made, good: S.made }); }
        else if (S.int) {
          const p = sc.picker; p.x = b.x; p.y = b.y; b.carrier = p; p.returning = true; p.intercept = null; W.sfx('catch');
          p.plan = { pts: [{ x: S.intTd ? 60 : Math.max(110, b.x - 120), y: clamp(p.y + rnd(-80, 80), TOPY + 20, BOTY - 20) }], i: 0 };
          W.pops.push({ t, text: S.intTd ? 'PICK SIX!' : 'INTERCEPTED!', bad: true });
          sc.endAt = t + (S.intTd ? 2.4 : 1.5);
        } else if (S.complete) {
          const tg = sc.target; tg.x = b.x; tg.y = b.y; b.carrier = tg; tg.carrying = true; W.sfx('catch');
          if (S.trick === 't_hook') { // turn and pitch it
            tg.plan = { pts: [{ x: tg.x + 18, y: tg.y + (tg.y > MID ? 10 : -10) }], i: 0 }; sc.lateralAt = t + 0.35; sc.endAt = t + 4;
          } else {
          const fy = S.oob ? (tg.y > MID ? BOTY - 4 : TOPY + 4) : clamp(tg.y + rnd(-50, 50), TOPY + 16, BOTY - 16);
          tg.plan = { pts: [{ x: sc.finalX, y: fy }], i: 0 };
          const yac = sc.finalX - b.x;
          if (S.hail) W.pops.push({ t, text: 'HE CAUGHT IT!', good: true });
          else if (S.depth === 'deep' && S.yards >= 25 && Math.random() < 0.5) W.pops.push({ t, text: 'MOSSED HIM!', good: true });
          else if (S.contested) W.pops.push({ t, text: 'CONTESTED CATCH!', good: true });
          sc.yacPop = yac > 100 ? t + 0.5 : null;
          assignTackler(W, sc, tg);
          sc.endAt = t + clamp(Math.abs(yac) / 90 + 0.9, 1.0, 3.2);
          }
        } else {
          b.loose = true; b.drop = true; b.vx = rnd(-30, 30); b.vy = rnd(-20, 20);
          if (sc.breaker) { b.vx = 40; b.vy = (b.y > MID ? 1 : -1) * 50; b.h = 20; }
          W.pops.push({ t, text: S.hail ? 'KNOCKED DOWN' : S.dropped ? 'DROPPED!' : sc.breaker ? 'BROKEN UP!' : S.hurried ? 'THROWN AWAY' : 'INCOMPLETE', bad: true });
          sc.endAt = t + 0.9;
        }
      }
    } else if (b.loose && b.drop) { b.x += (b.vx || 0) * dt; b.y += (b.vy || 0) * dt; b.vx *= 0.9; b.vy *= 0.9; b.h = Math.max(0, (b.h || 0) - 60 * dt); }
    if (sc.yacPop && t >= sc.yacPop) { sc.yacPop = null; W.pops.push({ t, text: Math.random() < 0.5 ? 'JUKED HIM!' : 'BROKE A TACKLE!', good: true }); }
    // --- run game ---
    if (isRun) {
      const c = sc.carrier;
      if (!sc.handed && t >= sc.handAt) {
        sc.handed = true; c.plan = { pts: sc.runPts, i: 0 }; assignTackler(W, sc, c);
        if (sc.toss) { b.carrier = null; b.flying = { from: { x: q.x, y: q.y }, to: { x: c.x + 12, y: c.y + sc.side * 6 }, t0: t, dur: 0.32, h: 14 }; }
        else { b.flying = null; b.carrier = c; c.carrying = true; }
        if (sc.tfl) { const lb = W.lb[sc.side > 0 ? 1 : 0]; lb.tackler = true; lb.speedMul = 1.2; sc.tackler = lb; }
        if (sc.trickPop) W.pops.push({ t, text: sc.trickPop, good: true });
      }
      if (!sc.handed && !sc.trick) { // before the exchange: the back sets up the concept, the QB sells it
        if (c !== q) {
          if (sc.toss) c.seek(los - 40, MID + sc.side * 95, dt, 0.9, false);
          else if (sc.draw) c.seek(los - 78, MID + sc.side * 14, dt, 0.5);
          else if (sc.counter) c.seek(los - 60, c.y - sc.side * 20, dt, 0.7);
          else c.seek(q.x + 10, q.y + 25, dt, 0.6);
          if (sc.draw) q.seek(los - 100, MID, dt, 0.85); else q.seek(los - 72, MID + (sc.toss ? sc.side * 10 : 0), dt, 0.5);
        } else q.seek(los - 72, MID, dt, 0.5);
      }
      if (sc.trick) trickRun(W, sc, dt);
      if (sc.handed && c.plan && !c.down) {
        const fin = c.follow(dt, 1);
        if (fin && !(sc.exchangeAt && !sc.exchanged)) { c.down = true; if (!S.td && !S.oob) W.sfx(S.yards <= -2 || S.fumble ? 'bighit' : 'hit'); sc.endAt = sc.endAt || t + (S.fumble ? 1.2 : 0.7);
          if (S.fumble) { b.loose = true; b.carrier = null; b.x = c.x + 8; b.y = c.y + 6; sc.recoverAt = t + 0.45; W.pops.push({ t, text: 'FUMBLE!', bad: true }); }
          else if (S.td) W.pops.push({ t, text: tdText(), good: true });
          else if (S.twoPt) W.pops.push({ t, text: 'NO GOOD', bad: true });
          else if (S.yards <= -2) W.pops.push({ t, text: S.blown ? 'BLOWN UP!' : 'TACKLE FOR LOSS!', bad: true });
          else if (S.oob) W.pops.push({ t, text: 'PUSHED OUT', good: false });
          else if (S.yards >= 12) W.pops.push({ t, text: Math.random() < 0.5 ? 'JUKED HIM!' : 'TRUCKED HIM!', good: true });
          else if (S.first) W.pops.push({ t, text: 'FIRST DOWN', good: true });
        }
      }
      if (sc.recoverAt && t >= sc.recoverAt && b.loose) { b.loose = false; const d = [...W.lb, ...W.s].reduce((best, x) => dist(x, b) < dist(best, b) ? x : best, W.lb[0]); d.x = b.x; d.y = b.y; b.carrier = d; }
      if (c !== q && sc.handed && !q.down) { if (W.qbWide) q.seek(q.x + 30, q.y, dt, 0.4); else if (!sc.passSet) q.seek(los - 95, MID + 20, dt, 0.5); }
    }
    if (S.kind === 'spike' && t >= sc.spikeAt && !sc.spiked) { sc.spiked = true; b.carrier = null; b.loose = true; b.x = q.x + 6; b.y = q.y + 8; sc.endAt = t + 0.6; W.pops.push({ t, text: 'SPIKE · CLOCK STOPPED', good: true }); }
    if (S.kind === 'kneel' && t >= sc.kneelAt && !sc.knelt) { sc.knelt = true; q.down = true; sc.endAt = t + 0.6; }
    if (S.kind === 'fg' && t >= sc.kickAt && !sc.kicked) {
      sc.kicked = true; b.carrier = null; W.sfx('kick');
      const to = S.made ? { x: 1190, y: MID + rnd(-40, 40) } : { x: 1190, y: MID + (Math.random() < 0.5 ? -1 : 1) * rnd(110, 150) };
      b.flying = { from: { x: los - 70, y: MID }, to, t0: t, dur: clamp((1190 - los) / 600 + 0.6, 1.0, 2.2), h: 90 };
    }
    // --- receivers run routes, block, or carry ---
    for (const a of W.recs) {
      if (isRun && a === sc.carrier) continue;
      if (a === b.carrier && a.plan && a.carrying) {
        if (!a.down) { if (a.follow(dt, 1)) { a.down = true; if (!S.td && !S.oob) W.sfx('hit'); if (S.td) W.pops.push({ t, text: tdText(), good: true }); else if (S.twoPt) W.pops.push({ t, text: 'NO GOOD', bad: true }); else if (S.oob) W.pops.push({ t, text: 'OUT OF BOUNDS', good: false }); else if (S.first) W.pops.push({ t, text: 'FIRST DOWN', good: true }); if (sc.tackler && !S.td && !S.oob) { sc.tackler.down = true; } } }
        else a.stop(dt);
        continue;
      }
      if (a.manual) { if (a.down) a.stop(dt); continue; } // the trick moves this one
      if (isRun && a.pos === 'RB' && a !== sc.carrier && sc.hole && !sc.trick && after > 0.15) { a.seek(sc.hole.x + 30, sc.hole.y + (a.y > sc.hole.y ? 10 : -10), dt, 0.95); continue; } // the fullback leads through the hole
      if (a.blocking) { a.seek(a.x - 6, a.y, dt, 0.4); continue; }
      if (isRun && after > 0.3) { a.seek(a.x + 40, a.y, dt, 0.5); continue; } // stalk blocks downfield
      if (sc.thrown || (sc.sackAt && t > sc.sackAt) || P.down || q.carrying) { if (a.plan && a.plan.i < a.plan.pts.length && !sc.thrown && !P.down) a.follow(dt, 0.9); else a.stop(dt); continue; }
      a.follow(dt, S.kind === 'pass' ? 1 : 0.6);
    }
    // --- defense: coverage, pursuit, return ---
    const live = b.carrier && b.carrier.team === 'off' && b.carrier.carrying && !b.carrier.down ? b.carrier : null;
    for (const d of [...W.cb, ...W.s, W.nb, ...W.lb]) {
      if (d === b.carrier) { if (d.plan && !d.down) { if (d.follow(dt, 1)) d.down = true; } else d.stop(dt); continue; }
      if (d.down) { d.stop(dt); continue; }
      if (d.intercept && b.flying) { d.seek(d.intercept.x, d.intercept.y, dt, 1.25, false); continue; }
      if (d === sc.freeRusher) { if (!P.down) d.seek(P.x, P.y, dt, 1.05, false); else d.stop(dt); continue; }
      // the fake sells: backers (and a dropped-down safety) chase the back until the ball goes somewhere else
      if (sc.bite && t >= sc.bite.from && t < sc.bite.to && !sc.thrown && (d.pos === 'LB' || (W.look === 'loaded' && d === W.s[0]))) { d.seek(W.rb.x + 12, W.rb.y, dt, 0.95, false); continue; }
      if (live) {
        const dest = live.plan && live.plan.pts[live.plan.pts.length - 1] || live;
        if (d.tackler) { const r = d.seek(dest.x + 6, dest.y, dt, 1, true); if (live.down && r < 18) d.stop(dt); continue; }
        const lead = { x: dest.x + (d.x > dest.x ? 18 : -18), y: dest.y + (d.y > dest.y ? 14 : -14) };
        const r = d.seek(lead.x, lead.y, dt, 0.92, true);
        if (live.down && r < 18) d.stop(dt);
        continue;
      }
      if (b.carrier && b.carrier.team === 'def') { d.seek(d.x - 30, d.y, dt, 0.5); continue; }
      if (sc.thrown || b.loose) { d.seek(b.x + (d.x > b.x ? 20 : -20), b.y + (d.y > b.y ? 15 : -15), dt, 0.8); continue; }
      if (isRun && sc.handed) { const c = sc.carrier; d.seek(c.x + 20, c.y, dt, d.pos === 'S' ? 0.8 : 1, false); continue; }
      const cov = W.cover.get(d);
      if (cov) { // man: mirror with a cushion, trailing slightly (nobody backs out of the end zone)
        const cushion = d.pos === 'LB' ? 30 : W.look === 'prevent' ? 60 : 28;
        d.seek(Math.min(1185, cov.x + cushion + Math.max(0, cov.vx) * 0.15), cov.y + cov.vy * 0.1, dt, 1, false);
      } else if (d.pos === 'S') { // shell: deep halves, drifting with the quarterback's eyes
        const depth = W.look === 'prevent' ? 250 : W.look === 'loaded' && d === W.s[0] ? 50 : 150 + Math.min(after * 30, 70);
        d.seek(Math.min(1185, los + depth), d.y0 + (q.y - MID) * 0.25 + (MID - d.y0) * 0.03, dt, 0.55);
      } else { d.seek(Math.min(1185, los + (W.look === 'blitz' ? 10 : 50)), d.y0 + (q.y - MID) * 0.3, dt, W.look === 'blitz' ? 1 : 0.5, false); }
    }
    if (b.carrier && !b.flying) { b.x = b.carrier.x + 9; b.y = b.carrier.y - 4; }
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
        `<text y="1" fill="${isOff ? offAlt : defColor}" font-family="Saira Condensed, sans-serif" font-weight="700" font-size="${isOff ? 16 : 11}" text-anchor="middle" dominant-baseline="middle">${a.num || ''}</text>`;
      g.appendChild(e); a.el = e; a.numEl = e.querySelector('text');
    }
    const ball = document.createElementNS(ns, 'g'); ball.setAttribute('id', 'liveball');
    ball.innerHTML = `<ellipse id="shadow" rx="12" ry="5" fill="#000" opacity=".25"/><g id="bb"><ellipse rx="13" ry="8" fill="#7a3f1d" stroke="#fff" stroke-width="2"/><line x1="-4" x2="4" y1="0" y2="0" stroke="#fff" stroke-width="2"/></g>`;
    g.appendChild(ball); W.ballEl = ball;
    if (W.spec.kind === 'flag' || (W.spec.flag && !W.spec.flag.pre)) {
      const f = document.createElementNS(ns, 'g'); f.setAttribute('id', 'flagmark'); f.setAttribute('opacity', '0');
      f.innerHTML = `<rect x="-9" y="-9" width="18" height="18" fill="#ffe14d" stroke="#000" stroke-width="1.5" transform="rotate(20)"/>`;
      f.setAttribute('transform', `translate(${W.los + 10} ${MID + 40})`); g.appendChild(f); W.flagEl = f;
    }
    svg.appendChild(g);
    W.g = g;
  }
  function draw(W) {
    for (const a of W.A) { a.el.setAttribute('transform', `translate(${a.x.toFixed(1)} ${a.y.toFixed(1)})${a.down ? ' rotate(75)' : ''}`); if (a.numEl && a.numEl.textContent !== (a.num || '')) a.numEl.textContent = a.num || ''; }
    const b = W.ball, sc = 1 + b.h / 90;
    W.ballEl.setAttribute('transform', `translate(${b.x.toFixed(1)} ${b.y.toFixed(1)})`);
    W.ballEl.querySelector('#bb').setAttribute('transform', `translate(0 ${-b.h * 1.4}) scale(${sc})`);
    W.ballEl.querySelector('#shadow').setAttribute('opacity', b.h > 2 ? .18 : 0);
  }
  // once in a while the popup says what everyone in the stands said
  const ALT = { 'BLOWN UP!': ['THEY HAD IT SNIFFED OUT', 'NOBODY BIT'], 'TWO POINTS!': ['GOOD. TWO.', 'CONVERTED!'], 'SACKED!': ['FOLDED!', 'DOWN GOES THE QB'], 'INTERCEPTED!': ["THAT'S THEIRS NOW", 'PICKED!'], 'FUMBLE!': ['BUTTERFINGERS', 'BALL ON THE GROUND'], 'DROPPED!': ['HANDS.', 'IT HIT HIS HANDS'], 'INCOMPLETE': ['NOPE', 'NOT TODAY'], 'TACKLE FOR LOSS!': ['WRONG WAY', 'STUFFED'], 'JUKED HIM!': ['ANKLES', 'SEE YA'], 'TRUCKED HIM!': ['RUN HIM OVER', 'HE SAW HIM. DIDN\'T MATTER.'], 'MOSSED HIM!': ['GOT UP AND GOT IT', 'HIGH POINT'], 'HOUSE CALL!': ['GONE', 'NOBODY HOME'], 'NO GOOD': ['WIDE', 'DOINK-ADJACENT'] };
  function popup(box, p) {
    const el = document.createElement('div');
    el.className = 'pop ' + (p.good ? 'good' : p.bad ? 'bad' : '') + (p.flag ? ' flag' : '');
    let text = p.text;
    if (ALT[text] && Math.random() < 0.28) text = ALT[text][Math.floor(Math.random() * ALT[text].length)];
    el.innerHTML = p.sub ? `${text}<small>${p.sub}</small>` : text;
    box.appendChild(el);
    setTimeout(() => el.remove(), p.flag ? 2200 : 1500);
  }

  // Play a snap. box: the .fieldbox element holding the field svg. Resolves when the animation ends or is skipped.
  // spec.clock = {from, to, el} optionally ticks a clock element from `from` to `to` seconds while the play runs.
  function play(box, spec) {
    return new Promise(resolve => {
      const svg = box.querySelector('svg');
      const old = svg.querySelector('#formation'); if (old) old.remove();
      const oldBall = svg.querySelector('#ball'); if (oldBall) oldBall.remove();
      const W = makeWorld(spec); W.live = true;
      const sc = script(W);
      W.ball.carrier = 'snapTo' in W ? W.snapTo : W.qb;
      mount(svg, W); draw(W);
      let last = null, raf = 0, finished = false;
      const hint = document.createElement('div'); hint.className = 'skiphint'; hint.textContent = 'Tap the field to skip'; box.appendChild(hint);
      const end = () => { if (finished) return; finished = true; cancelAnimationFrame(raf); box.onclick = null; hint.remove(); resolve(); };
      box.onclick = () => end();
      if (reduced) { setTimeout(end, 50); return; }
      const popped = new Set();
      const frame = ts => {
        if (finished) return;
        if (last == null) last = ts;
        let dt = Math.min((ts - last) / 1000, 0.1) * 1.35; last = ts; // real players are fast but a 3-second route watches slow: run the clock a bit quick
        W.t += dt;
        const sub = dt > 0.04 ? 4 : 2;
        for (let k = 0; k < sub; k++) step(W, sc, dt / sub);
        draw(W);
        if (W.flagEl && (sc.flagged || (sc.endAt && W.t >= sc.endAt - 0.6))) { W.flagEl.setAttribute('opacity', '1'); if (!sc.liveFlagPop && spec.flag && !spec.flag.pre) { sc.liveFlagPop = true; W.pops.push({ t: W.t, text: 'FLAG', flag: true, sub: spec.flag.kind.toUpperCase() + ' · ' + (spec.flag.onDefense ? 'DEFENSE' : 'OFFENSE') }); sc.endAt = W.t + 1.6; } }
        if (spec.clock && spec.clock.el && sc.endAt) { const s = clamp((W.t - sc.snapAt) / Math.max(0.1, sc.endAt - sc.snapAt), 0, 1); const T = Math.round(spec.clock.from + (spec.clock.to - spec.clock.from) * s); spec.clock.el.textContent = `${Math.floor(T / 60)}:${String(T % 60).padStart(2, '0')}`; }
        for (const p of W.pops) if (!popped.has(p)) { popped.add(p); popup(box, p); if (window.Sound) window.Sound.popup(p.text, spec.sound || {}); }
        if (sc.endAt && W.t >= sc.endAt) { if (window.Sound && spec.kind !== 'fg') window.Sound.fx('deadball'); end(); return; }
        if (W.t > 9) { end(); return; }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    });
  }

  // Headless run of a play (no drawing, no rAF): used by tests to check that every play type resolves
  function simulate(spec, maxT = 9) {
    const W = makeWorld(spec); const sc = script(W); W.ball.carrier = 'snapTo' in W ? W.snapTo : W.qb;
    const dt = 1 / 60; let n = 0;
    while (!(sc.endAt && W.t >= sc.endAt) && W.t < maxT) { W.t += dt; step(W, sc, dt); n++; }
    const bad = W.A.filter(a => !Number.isFinite(a.x) || !Number.isFinite(a.y) || a.x < -50 || a.x > 1250 || a.y < -50 || a.y > 583).map(a => a.id);
    return { t: +W.t.toFixed(2), ended: !!(sc.endAt && W.t >= sc.endAt), pops: W.pops.map(p => p.text), ball: { x: Math.round(W.ball.x), y: Math.round(W.ball.y) }, carrier: W.ball.carrier ? W.ball.carrier.id : null, outOfBounds: bad };
  }
  window.PlayAnim = { play, simulate };
})();
