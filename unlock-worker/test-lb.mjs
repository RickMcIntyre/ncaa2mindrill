// node test-lb.mjs — exercises the leaderboard routes against an in-memory stand-in for D1
import worker from './worker.js';
const rows = [];
const DB = { prepare(sql) { let args = []; const st = { bind(...a) { args = a; return st; },
  async run() { if (sql.startsWith('INSERT')) { const [day, mode, wp, token] = args; if (!rows.find(r => r.day === day && r.mode === mode && r.token === token)) rows.push({ day, mode, wp, token }); } return {}; },
  async first() { const [day, mode, x] = args; const rs = rows.filter(r => r.day === day && r.mode === mode).sort((a, b) => a.wp - b.wp);
    if (sql.includes('COUNT(*) AS n')) return { n: rs.length, below: rs.filter(r => r.wp < x).length, wins: rs.filter(r => r.wp >= .5).length };
    if (sql.includes('OFFSET')) return rs[x] || null; return null; },
  async all() { const [day, mode] = args; const rs = rows.filter(r => r.day === day && r.mode === mode); const m = {}; for (const r of rs) { const b = Math.min(9, Math.floor(r.wp * 10)); m[b] = (m[b] || 0) + 1; } return { results: Object.entries(m).map(([b, c]) => ({ b: +b, c })) }; } }; return st; } };
const env = { DB, UNLOCK_SECRET: 's', STRIPE_SECRET: 'k', ALLOWED_ORIGIN: 'https://ncaa2mindrill.com' };
const call = async p => { const r = await worker.fetch(new Request('https://w.test' + p, { headers: { Origin: 'https://ncaa2mindrill.com' } }), env); return [r.status, await r.json()]; };
for (let i = 0; i < 12; i++) await call(`/lb/submit?day=2&mode=daily&wp=${(i / 12).toFixed(2)}&token=tok${i}xxxxxx`);
console.log('dup submit keeps n at', (await call('/lb/submit?day=2&mode=daily&wp=0.9&token=tok1xxxxxx'))[1].n);
console.log('stats', JSON.stringify(await call('/lb/stats?day=2&mode=daily&wp=0.55')));
console.log('bad', JSON.stringify(await call('/lb/submit?day=2&mode=x&wp=0.5&token=short')));
