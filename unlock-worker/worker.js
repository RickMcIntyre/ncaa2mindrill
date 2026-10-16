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
      return json({ ok: true, service: 'ncaa2mindrill unlock' });
    } catch (e) {
      return json({ ok: false, reason: 'error', detail: String(e && e.message || e) }, 502);
    }
  },
};
