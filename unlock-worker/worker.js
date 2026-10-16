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

// leaderboard numbers for one day and mode: how many played, how many finished below `wp`, the median, a 10-bucket histogram
async function lbStats(env, day, mode, wp) {
  const tot = await env.DB.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN wp < ?3 THEN 1 ELSE 0 END) AS below, SUM(CASE WHEN wp >= 0.5 THEN 1 ELSE 0 END) AS wins FROM results WHERE day = ?1 AND mode = ?2').bind(day, mode, wp).first();
  const hist = await env.DB.prepare('SELECT CAST(MIN(wp * 10, 9) AS INTEGER) AS b, COUNT(*) AS c FROM results WHERE day = ?1 AND mode = ?2 GROUP BY b').bind(day, mode).all();
  const n = tot && tot.n || 0;
  const med = n ? await env.DB.prepare('SELECT wp FROM results WHERE day = ?1 AND mode = ?2 ORDER BY wp LIMIT 1 OFFSET ?3').bind(day, mode, Math.floor(n / 2)).first() : null;
  const bins = new Array(10).fill(0); for (const r of (hist && hist.results) || []) bins[r.b] = r.c;
  return { ok: true, n, below: tot && tot.below || 0, wins: tot && tot.wins || 0, median: med ? med.wp : null, bins };
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
        await env.DB.prepare('INSERT INTO hits (day, token, n, ts, src) VALUES (?1, ?2, 1, ?3, ?4) ON CONFLICT(day, token) DO UPDATE SET n = n + 1, ts = ?3').bind(day, token, Date.now(), src).run();
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
        const today = new Date().toISOString().slice(0, 10), week = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
        const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).first()) || {};
        const visits = {
          today: await q('SELECT COALESCE(SUM(n),0) AS v, COUNT(*) AS u FROM hits WHERE day = ?1', today),
          week: await q('SELECT COALESCE(SUM(n),0) AS v, COUNT(DISTINCT token) AS u FROM hits WHERE day >= ?1', week),
          all: await q('SELECT COALESCE(SUM(n),0) AS v, COUNT(DISTINCT token) AS u FROM hits'),
        };
        const byDay = await env.DB.prepare('SELECT day, SUM(n) AS v, COUNT(*) AS u FROM hits WHERE day >= ?1 GROUP BY day ORDER BY day').bind(new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10)).all();
        const unlocks = { today: (await q('SELECT COUNT(*) AS c FROM unlocks WHERE ts >= ?1', Date.parse(today))).c || 0, all: (await q('SELECT COUNT(*) AS c FROM unlocks')).c || 0 };
        const plays = { today: (await q('SELECT COUNT(*) AS c FROM results WHERE ts >= ?1', Date.parse(today))).c || 0, all: (await q('SELECT COUNT(*) AS c FROM results')).c || 0 };
        // where the last 30 days of visitors came from, and which sources turned into unlocks
        const month = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
        const bySrc = await env.DB.prepare("SELECT COALESCE(src, 'direct') AS src, SUM(n) AS v, COUNT(DISTINCT token) AS u FROM hits WHERE day >= ?1 GROUP BY 1 ORDER BY v DESC LIMIT 25").bind(month).all();
        const unlocksBySrc = await env.DB.prepare("SELECT COALESCE(from_src, 'direct') AS src, COUNT(*) AS c FROM unlocks GROUP BY 1").all();
        let stripe_paid = null, stripe_error = null;
        try { // confirmed payments straight from Stripe, when the restricted key is present
          const s = await stripe(env, '/checkout/sessions?limit=100&status=complete');
          stripe_paid = (s.data || []).filter(x => x.payment_status === 'paid').length; if (s.has_more) stripe_paid = stripe_paid + '+';
        } catch (e) { stripe_error = String(e && e.message || e); }
        return json({ ok: true, today, visits, byDay: (byDay && byDay.results) || [], unlocks, plays, stripe_paid, stripe_error, bySrc: (bySrc && bySrc.results) || [], unlocksBySrc: (unlocksBySrc && unlocksBySrc.results) || [] });
      }
      // ---- daily leaderboard (D1). One row per finished daily drive; the site submits anonymously with a per-browser token.
      if (url.pathname === '/lb/submit' && env.DB) {
        const day = parseInt(url.searchParams.get('day') || '', 10), mode = url.searchParams.get('mode') || '', wp = parseFloat(url.searchParams.get('wp') || '');
        const token = (url.searchParams.get('token') || '').slice(0, 40);
        if (!(day > 0) || !['daily', 'saban', 'cignetti'].includes(mode) || !(wp >= 0 && wp <= 1) || token.length < 8) return json({ ok: false, reason: 'bad_input' }, 400);
        await env.DB.prepare('INSERT OR IGNORE INTO results (day, mode, wp, token, ts) VALUES (?1, ?2, ?3, ?4, ?5)').bind(day, mode, wp, token, Date.now()).run();
        return json(await lbStats(env, day, mode, wp));
      }
      if (url.pathname === '/lb/stats' && env.DB) {
        const day = parseInt(url.searchParams.get('day') || '', 10), mode = url.searchParams.get('mode') || 'daily', wp = parseFloat(url.searchParams.get('wp') || '-1');
        if (!(day > 0)) return json({ ok: false, reason: 'bad_input' }, 400);
        return json(await lbStats(env, day, mode, wp));
      }
      return json({ ok: true, service: 'ncaa2mindrill unlock' });
    } catch (e) {
      return json({ ok: false, reason: 'error', detail: String(e && e.message || e) }, 502);
    }
  },
};
