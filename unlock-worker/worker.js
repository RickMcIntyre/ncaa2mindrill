/* Unlock service for ncaa2mindrill.com (Cloudflare Worker).
 *
 * The website sells the hard modes through a Stripe Payment Link. Stripe sends the player back to the site with the
 * Checkout session id; this worker confirms with Stripe that the session is paid and returns a signed unlock code.
 * Codes are HMAC-signed with UNLOCK_SECRET, so /verify can check a pasted code without storing anything, and /restore
 * finds a paid session by the email on the receipt.
 *
 * Routes (all GET, JSON, CORS-limited to the site):
 *   /claim?session_id=cs_…     -> { ok, code }        after a payment
 *   /verify?code=…             -> { ok, code }        a code from another device
 *   /restore?email=…           -> { ok, code } | { ok:false, reason:'not_found' }
 *   /t?ev=…&token=…[&team=…]   -> { ok }               a Tournament step, tallied by day (see T_EVENTS)
 *
 * Secrets (wrangler secret put …):  STRIPE_SECRET (a restricted key with Checkout Sessions: read), UNLOCK_SECRET (any
 * long random string). Vars: ALLOWED_ORIGIN (https://ncaa2mindrill.com), PRICE_MIN (99, cents).
 */
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(text))).slice(0, 22);
}
// code = <session tail>.<signature>; the tail keeps codes short and unique per payment
async function makeCode(env, sessionId) { const tail = sessionId.slice(-12); return `${tail}.${await hmac(env.UNLOCK_SECRET, 'unlock:' + tail)}`; }
async function codeValid(env, code) {
  const m = /^([A-Za-z0-9_]{6,20})\.([A-Za-z0-9_-]{22})$/.exec((code || '').trim()); if (!m) return false;
  return (await hmac(env.UNLOCK_SECRET, 'unlock:' + m[1])) === m[2];
}
async function stripe(env, path) {
  const r = await fetch('https://api.stripe.com/v1' + path, { headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET } });
  if (!r.ok) throw new Error('stripe ' + r.status);
  return r.json();
}
const paid = (s, env) => s && s.payment_status === 'paid' && (s.amount_total || 0) >= Number(env.PRICE_MIN || 99);

// ---- D1 on the free plan allows 5M rows read a day, so nothing on a hot path scans a growing table. Visits and finished
// drives are tallied as they arrive (day_src, firsts, play_days, lb_bins); /stats and the leaderboard read the tallies.
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, ts INTEGER)',
  'CREATE TABLE IF NOT EXISTS day_src (day TEXT, src TEXT, v INTEGER, u INTEGER, PRIMARY KEY (day, src))',   // visits, person-days
  'CREATE TABLE IF NOT EXISTS people (token TEXT PRIMARY KEY, day TEXT, src TEXT)',                       // a browser's first day
  'CREATE TABLE IF NOT EXISTS firsts (day TEXT, src TEXT, c INTEGER, PRIMARY KEY (day, src))',             // new browsers a day
  'CREATE TABLE IF NOT EXISTS play_days (day TEXT PRIMARY KEY, c INTEGER)',                               // finished drives a UTC day
  'CREATE TABLE IF NOT EXISTS lb_bins (day INTEGER, mode TEXT, b INTEGER, c INTEGER, PRIMARY KEY (day, mode, b))',
  'CREATE TABLE IF NOT EXISTS lb_done (day INTEGER, mode TEXT, PRIMARY KEY (day, mode))',                  // lb_bins built from results
];
// ---- Tournament tallies: each step of the funnel counted a UTC day, with how many browsers took it that day (t_seen
// remembers who already counted), and which team-seasons were picked and started. Small tables, read whole by /stats.
const T_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS t_days (day TEXT, ev TEXT, c INTEGER, u INTEGER, PRIMARY KEY (day, ev))',
  'CREATE TABLE IF NOT EXISTS t_seen (day TEXT, ev TEXT, token TEXT, PRIMARY KEY (day, ev, token))',
  'CREATE TABLE IF NOT EXISTS t_teams (day TEXT, ev TEXT, team TEXT, c INTEGER, PRIMARY KEY (day, ev, team))',
];
// open: the Tournament tab; pick: a team-season's seeding; paywall: the unlock screen from the Tournament;
// checkout: Stripe opened from it; paid: back from Stripe unlocked; start: a run; p0-p3: a round played (R1, QF, SF,
// title), w0-w3: won (w3 is a title)
const T_EVENTS = new Set(['open', 'pick', 'paywall', 'checkout', 'paid', 'start', 'p0', 'p1', 'p2', 'p3', 'w0', 'w1', 'w2', 'w3']);
let tReady = false;
async function tEnsure(env) {
  if (tReady) return;
  await env.DB.batch(T_SCHEMA.map(q => env.DB.prepare(q)));
  tReady = true;
}
let ready = false;
// once per isolate: make the tables, and the first time ever, fill the visit tallies from the visits already recorded
async function ensure(env) {
  if (ready) return;
  let done = null;
  try { done = await env.DB.prepare("SELECT v FROM kv WHERE k = 'rollups_v1'").first(); } catch (e) { /* no kv table yet */ }
  if (!done) {
    await env.DB.batch(SCHEMA.map(q => env.DB.prepare(q)));
    await env.DB.batch([   // replace, not add, so a second run (two isolates at once) lands on the same numbers
      env.DB.prepare("INSERT INTO day_src (day, src, v, u) SELECT day, COALESCE(src, 'direct'), SUM(n), COUNT(*) FROM hits WHERE 1 GROUP BY 1, 2 ON CONFLICT (day, src) DO UPDATE SET v = excluded.v, u = excluded.u"),
      env.DB.prepare("INSERT OR IGNORE INTO people (token, day, src) SELECT token, MIN(day), COALESCE(src, 'direct') FROM hits GROUP BY token"),
      env.DB.prepare('INSERT INTO firsts (day, src, c) SELECT day, src, COUNT(*) FROM people WHERE 1 GROUP BY 1, 2 ON CONFLICT (day, src) DO UPDATE SET c = excluded.c'),
      env.DB.prepare("INSERT INTO play_days (day, c) SELECT date(ts / 1000, 'unixepoch'), COUNT(*) FROM results WHERE 1 GROUP BY 1 ON CONFLICT (day) DO UPDATE SET c = excluded.c"),
      env.DB.prepare("INSERT OR IGNORE INTO kv (k, v, ts) VALUES ('rollups_v1', 'done', ?1)").bind(Date.now()),
    ]);
  }
  ready = true;
}

// Leaderboard buckets: 0.1% wide under 10% (where most finishes on a hard drive land), 1% wide above, and 100% on its
// own (a perfect finish beats everyone below it, not the others who also hit 100%): 191 in all.
// Win chances arrive with four decimals, so the bucket comes from basis points and SQL and JS agree on it.
const BP = 'CAST(ROUND(wp * 10000) AS INTEGER)';
const LB_B = `CASE WHEN ${BP} >= 10000 THEN 190 WHEN ${BP} < 1000 THEN ${BP} / 10 ELSE 100 + (${BP} - 1000) / 100 END`;
const lbBucket = wp => { const bp = Math.round(wp * 10000); return bp >= 10000 ? 190 : bp < 1000 ? Math.floor(bp / 10) : 100 + Math.floor((bp - 1000) / 100); };
const lbLo = b => b === 190 ? 1 : b < 100 ? b / 1000 : 0.1 + (b - 100) / 100;
const lbW = b => b === 190 ? 0 : b < 100 ? 0.001 : 0.01;
// a day and mode that started before the tallies existed is filled from its results once
async function lbEnsure(env, day, mode) {
  if (await env.DB.prepare('SELECT 1 AS x FROM lb_done WHERE day = ?1 AND mode = ?2').bind(day, mode).first()) return;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO lb_bins (day, mode, b, c) SELECT day, mode, ${LB_B}, COUNT(*) FROM results WHERE day = ?1 AND mode = ?2 GROUP BY 3 ON CONFLICT (day, mode, b) DO UPDATE SET c = excluded.c`).bind(day, mode),
    env.DB.prepare('INSERT OR IGNORE INTO lb_done (day, mode) VALUES (?1, ?2)').bind(day, mode),
  ]);
}
// leaderboard numbers for one day and mode: how many played, how many finished below `wp`, the median, a 10-bucket
// histogram. Within a bucket, below and the median are interpolated: off by a fraction of a percent at most.
async function lbStats(env, day, mode, wp) {
  await lbEnsure(env, day, mode);
  const rs = ((await env.DB.prepare('SELECT b, c FROM lb_bins WHERE day = ?1 AND mode = ?2 ORDER BY b').bind(day, mode).all()).results) || [];
  const n = rs.reduce((a, r) => a + r.c, 0);
  let below = 0, wins = 0, median = null, cum = 0;
  const bins = new Array(10).fill(0), k = Math.floor(n / 2);
  for (const { b, c } of rs) {
    const lo = lbLo(b), w = lbW(b);
    if (w ? lo + w <= wp : lo < wp) below += c; else if (w && lo < wp) below += c * (wp - lo) / w;
    if (b >= 140) wins += c;                                          // 140 is where 50% starts
    bins[b < 100 ? 0 : Math.min(9, 1 + Math.floor((b - 100) / 10))] += c;
    if (median == null && cum + c > k) median = Math.round((lo + w * (k - cum + 0.5) / c) * 10000) / 10000;
    cum += c;
  }
  return { ok: true, n, below: Math.round(below), wins, median, bins };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || 'https://ncaa2mindrill.com').split(',').map(s => s.trim());
    const cors = { 'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0], 'Vary': 'Origin', 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors });
    try {
      if (url.pathname === '/claim') {
        const sid = url.searchParams.get('session_id') || '';
        if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) return json({ ok: false, reason: 'bad_session' }, 400);
        const s = await stripe(env, '/checkout/sessions/' + sid);
        if (!paid(s, env)) return json({ ok: false, reason: 'unpaid' });
        return json({ ok: true, code: await makeCode(env, sid) });
      }
      if (url.pathname === '/verify') {
        const code = url.searchParams.get('code') || '';
        return json((await codeValid(env, code)) ? { ok: true, code: code.trim() } : { ok: false, reason: 'invalid' });
      }
      if (url.pathname === '/restore') {
        const email = (url.searchParams.get('email') || '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, reason: 'bad_email' }, 400);
        // Checkout sessions can be searched by the customer's email (last 90 days are indexed; older ones we find via customers)
        const found = await stripe(env, '/checkout/sessions?limit=100&customer_details[email]=' + encodeURIComponent(email));
        const hit = (found.data || []).find(s => paid(s, env));
        if (hit) return json({ ok: true, code: await makeCode(env, hit.id) });
        return json({ ok: false, reason: 'not_found' });
      }
      // ---- gifts: a paid member who beat a Saban drive gets one code that unlocks a friend
      if (url.pathname === '/gift/issue' && env.DB) {
        const owner = (url.searchParams.get('owner') || '').trim().slice(0, 80);
        let good = await codeValid(env, owner);
        if (!good && /^cs_(live|test)_[A-Za-z0-9]+$/.test(owner)) { // a raw Stripe session: confirm it if we can, trust it if we can't
          try { const s = await stripe(env, '/checkout/sessions/' + owner); good = paid(s, env); } catch (e) { good = /stripe 401/.test(String(e && e.message)); }
        }
        if (!good) return json({ ok: false, reason: 'bad_owner' });
        const existing = await env.DB.prepare('SELECT gift FROM gifts WHERE owner = ?1').bind(owner).first();
        if (existing) return json({ ok: true, gift: existing.gift });
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', bytes = crypto.getRandomValues(new Uint8Array(8));
        const gift = 'GIFT-' + Array.from(bytes, b => alphabet[b % alphabet.length]).join('').replace(/(.{4})(.{4})/, '$1-$2');
        await env.DB.prepare('INSERT INTO gifts (gift, owner, ts) VALUES (?1, ?2, ?3)').bind(gift, owner, Date.now()).run();
        return json({ ok: true, gift });
      }
      if (url.pathname === '/gift/redeem' && env.DB) {
        const gift = (url.searchParams.get('code') || '').trim().toUpperCase().slice(0, 20), token = (url.searchParams.get('token') || '').slice(0, 40);
        if (!/^GIFT-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(gift)) return json({ ok: false, reason: 'invalid' });
        const row = await env.DB.prepare('SELECT gift, redeemed_by FROM gifts WHERE gift = ?1').bind(gift).first();
        if (!row) return json({ ok: false, reason: 'invalid' });
        if (row.redeemed_by && row.redeemed_by !== token) return json({ ok: false, reason: 'redeemed' });
        if (!row.redeemed_by) await env.DB.prepare('UPDATE gifts SET redeemed_by = ?2, redeemed_ts = ?3 WHERE gift = ?1').bind(gift, token || 'unknown', Date.now()).run();
        return json({ ok: true, code: await makeCode(env, 'gift' + gift.replace(/[^A-Z2-9]/g, '')) });
      }
      // ---- traffic tally (D1). One row per browser per day, counted up; nothing personal is stored.
      // src is where the browser first came from (utm_source/utm_campaign, or "direct"), so paid campaigns can be judged
      if (url.pathname === '/hit' && env.DB) {
        const token = (url.searchParams.get('token') || '').slice(0, 40), day = new Date().toISOString().slice(0, 10);
        const src = (url.searchParams.get('src') || 'direct').replace(/[^\w./-]/g, '').slice(0, 48) || 'direct';
        if (token.length < 8) return json({ ok: false }, 400);
        await ensure(env);
        const r = await env.DB.prepare('INSERT INTO hits (day, token, n, ts, src) VALUES (?1, ?2, 1, ?3, ?4) ON CONFLICT(day, token) DO UPDATE SET n = n + 1, ts = ?3 RETURNING n, src').bind(day, token, Date.now(), src).first();
        const fresh = !r || r.n === 1;                                   // this browser's first visit today
        const tally = [env.DB.prepare('INSERT INTO day_src (day, src, v, u) VALUES (?1, ?2, 1, ?3) ON CONFLICT (day, src) DO UPDATE SET v = v + 1, u = u + ?3').bind(day, (r && r.src) || src, fresh ? 1 : 0)];
        if (fresh) tally.push(   // its first visit ever: count it under today and its source, then remember it
          env.DB.prepare('INSERT INTO firsts (day, src, c) SELECT ?1, ?2, 1 WHERE NOT EXISTS (SELECT 1 FROM people WHERE token = ?3) ON CONFLICT (day, src) DO UPDATE SET c = c + 1').bind(day, src, token),
          env.DB.prepare('INSERT OR IGNORE INTO people (token, day, src) VALUES (?3, ?1, ?2)').bind(day, src, token));
        await env.DB.batch(tally);
        return json({ ok: true });
      }
      if (url.pathname === '/t' && env.DB) {
        const ev = url.searchParams.get('ev') || '', token = (url.searchParams.get('token') || '').slice(0, 40);
        const team = (url.searchParams.get('team') || '').trim();
        if (!T_EVENTS.has(ev) || token.length < 8) return json({ ok: false, reason: 'bad_input' }, 400);
        await tEnsure(env);
        const day = new Date().toISOString().slice(0, 10);
        const evs = [ev]; if (/^p[0-3]$/.test(ev) && url.searchParams.get('won') === '1') evs.push('w' + ev[1]);
        const ops = [];
        for (const e of evs) {
          const fresh = await env.DB.prepare('INSERT OR IGNORE INTO t_seen (day, ev, token) VALUES (?1, ?2, ?3)').bind(day, e, token).run();
          ops.push(env.DB.prepare('INSERT INTO t_days (day, ev, c, u) VALUES (?1, ?2, 1, ?3) ON CONFLICT (day, ev) DO UPDATE SET c = c + 1, u = u + ?3').bind(day, e, fresh.meta && fresh.meta.changes ? 1 : 0));
        }
        // "2025 Miami (OH)": a season and a school name, nothing else
        if ((ev === 'pick' || ev === 'start') && /^20\d\d [\p{L}0-9 .&()'-]{2,40}$/u.test(team))
          ops.push(env.DB.prepare('INSERT INTO t_teams (day, ev, team, c) VALUES (?1, ?2, ?3, 1) ON CONFLICT (day, ev, team) DO UPDATE SET c = c + 1').bind(day, ev, team));
        await env.DB.batch(ops);
        return json({ ok: true });
      }
      if (url.pathname === '/unlocked' && env.DB) {
        const code = (url.searchParams.get('code') || '').slice(0, 80), src = (url.searchParams.get('src') || 'web').slice(0, 12);
        const from = (url.searchParams.get('from') || 'direct').replace(/[^\w./-]/g, '').slice(0, 48) || 'direct';
        if (code.length < 8) return json({ ok: false }, 400);
        await env.DB.prepare('INSERT OR IGNORE INTO unlocks (code, src, ts, from_src) VALUES (?1, ?2, ?3, ?4)').bind(code, src, Date.now(), from).run();
        return json({ ok: true });
      }
      if (url.pathname === '/stats' && env.DB) {
        await ensure(env);
        const hit = await env.DB.prepare("SELECT v, ts FROM kv WHERE k = 'stats'").first();
        if (hit && Date.now() - hit.ts < 5 * 60e3) return json(JSON.parse(hit.v));   // however often the page is opened
        const today = new Date().toISOString().slice(0, 10), week = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
        const month = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
        const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).first()) || {};
        const all = async (sql, ...a) => ((await env.DB.prepare(sql).bind(...a).all()).results) || [];
        // "people" is distinct browsers today; for the week and all time it's browsers first seen in that window
        const visits = {
          today: await q('SELECT COALESCE(SUM(v),0) AS v, COALESCE(SUM(u),0) AS u FROM day_src WHERE day = ?1', today),
          week: { v: (await q('SELECT COALESCE(SUM(v),0) AS v FROM day_src WHERE day >= ?1', week)).v, u: (await q('SELECT COALESCE(SUM(c),0) AS c FROM firsts WHERE day >= ?1', week)).c },
          all: { v: (await q('SELECT COALESCE(SUM(v),0) AS v FROM day_src')).v, u: (await q('SELECT COALESCE(SUM(c),0) AS c FROM firsts')).c },
        };
        const byDay = await all('SELECT day, SUM(v) AS v, SUM(u) AS u FROM day_src WHERE day >= ?1 GROUP BY day ORDER BY day', month);
        const unlocks = { today: (await q('SELECT COUNT(*) AS c FROM unlocks WHERE ts >= ?1', Date.parse(today))).c || 0, all: (await q('SELECT COUNT(*) AS c FROM unlocks')).c || 0 };
        const plays = { today: (await q('SELECT COALESCE(SUM(c),0) AS c FROM play_days WHERE day = ?1', today)).c, all: (await q('SELECT COALESCE(SUM(c),0) AS c FROM play_days')).c };
        // where the last 30 days of visits came from, how many new browsers each source brought, and which turned into unlocks
        const fresh = Object.fromEntries((await all('SELECT src, SUM(c) AS c FROM firsts WHERE day >= ?1 GROUP BY src', month)).map(r => [r.src, r.c]));
        const bySrc = (await all('SELECT src, SUM(v) AS v FROM day_src WHERE day >= ?1 GROUP BY src ORDER BY v DESC LIMIT 25', month)).map(r => ({ src: r.src, v: r.v, u: fresh[r.src] || 0 }));
        const unlocksBySrc = await all("SELECT COALESCE(from_src, 'direct') AS src, COUNT(*) AS c FROM unlocks GROUP BY 1");
        let stripe_paid = null, stripe_error = null;
        try { // confirmed payments straight from Stripe, when the restricted key is present
          const s = await stripe(env, '/checkout/sessions?limit=100&status=complete');
          stripe_paid = (s.data || []).filter(x => x.payment_status === 'paid').length; if (s.has_more) stripe_paid = stripe_paid + '+';
        } catch (e) { stripe_error = String(e && e.message || e); }
        // the Tournament funnel: each step today, over 7 days and all time (c: times, u: browsers, counted once a day)
        await tEnsure(env);
        const tsum = async (where, ...a) => Object.fromEntries((await all(`SELECT ev, SUM(c) AS c, SUM(u) AS u FROM t_days ${where} GROUP BY ev`, ...a)).map(r => [r.ev, { c: r.c, u: r.u }]));
        const tourney = {
          today: await tsum('WHERE day = ?1', today), week: await tsum('WHERE day >= ?1', week), all: await tsum(''),
          teams: await all("SELECT team, SUM(CASE WHEN ev = 'pick' THEN c ELSE 0 END) AS picks, SUM(CASE WHEN ev = 'start' THEN c ELSE 0 END) AS starts FROM t_teams WHERE day >= ?1 GROUP BY team ORDER BY picks DESC, starts DESC LIMIT 12", week),
        };
        const out = { ok: true, today, asOf: Date.now(), visits, byDay, unlocks, plays, stripe_paid, stripe_error, bySrc, unlocksBySrc, tourney };
        await env.DB.prepare("INSERT INTO kv (k, v, ts) VALUES ('stats', ?1, ?2) ON CONFLICT (k) DO UPDATE SET v = excluded.v, ts = excluded.ts").bind(JSON.stringify(out), out.asOf).run();
        return json(out);
      }
      // ---- daily leaderboard (D1). One row per finished daily drive; the site submits anonymously with a per-browser token.
      if (url.pathname === '/lb/submit' && env.DB) {
        const day = parseInt(url.searchParams.get('day') || '', 10), mode = url.searchParams.get('mode') || '', wp = parseFloat(url.searchParams.get('wp') || '');
        const token = (url.searchParams.get('token') || '').slice(0, 40);
        if (!(day > 0) || !['daily', 'saban', 'cignetti'].includes(mode) || !(wp >= 0 && wp <= 1) || token.length < 8) return json({ ok: false, reason: 'bad_input' }, 400);
        await ensure(env);
        const now = Date.now(), ins = await env.DB.prepare('INSERT OR IGNORE INTO results (day, mode, wp, token, ts) VALUES (?1, ?2, ?3, ?4, ?5)').bind(day, mode, wp, token, now).run();
        if (ins.meta && ins.meta.changes) {   // a first finish for this browser: the day's tallies move by one
          const filled = await env.DB.prepare('SELECT 1 AS x FROM lb_done WHERE day = ?1 AND mode = ?2').bind(day, mode).first();
          const bump = [env.DB.prepare('INSERT INTO play_days (day, c) VALUES (?1, 1) ON CONFLICT (day) DO UPDATE SET c = c + 1').bind(new Date(now).toISOString().slice(0, 10))];
          // not filled yet: lbStats fills it from results, this finish included
          if (filled) bump.push(env.DB.prepare('INSERT INTO lb_bins (day, mode, b, c) VALUES (?1, ?2, ?3, 1) ON CONFLICT (day, mode, b) DO UPDATE SET c = c + 1').bind(day, mode, lbBucket(wp)));
          await env.DB.batch(bump);
        }
        return json(await lbStats(env, day, mode, wp));
      }
      if (url.pathname === '/lb/stats' && env.DB) {
        const day = parseInt(url.searchParams.get('day') || '', 10), mode = url.searchParams.get('mode') || 'daily', wp = parseFloat(url.searchParams.get('wp') || '-1');
        if (!(day > 0) || !['daily', 'saban', 'cignetti'].includes(mode)) return json({ ok: false, reason: 'bad_input' }, 400);
        await ensure(env);
        return json(await lbStats(env, day, mode, wp));
      }
      return json({ ok: true, service: 'ncaa2mindrill unlock' });
    } catch (e) {
      return json({ ok: false, reason: 'error', detail: String(e && e.message || e) }, 502);
    }
  },
};
