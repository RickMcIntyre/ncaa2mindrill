// Copies the website (../docs) into www/ for the native build, so the site stays the single source of truth.
const fs = require('fs'), path = require('path');
const src = path.join(__dirname, '..', 'docs'), dst = path.join(__dirname, 'www');
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src)) {
  if (f === 'CNAME' || f === 'app') continue;
  const s = path.join(src, f);
  if (fs.statSync(s).isDirectory()) fs.cpSync(s, path.join(dst, f), { recursive: true }); else fs.copyFileSync(s, path.join(dst, f));
}
console.log('copied web to www/');
