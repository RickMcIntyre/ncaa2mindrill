/* Stadium sound, synthesized with WebAudio so there are no files to load. Off until the player turns it on; the
 * choice is remembered in this browser.
 *
 * Everything runs through a stadium: a generated reverb tail, a compressor, and a crowd bed that rises as the clock
 * runs down in a close game. The crowd is partisan: it roars when the home team does something good and groans when
 * it doesn't, so the same 40-yard catch sounds different at home than on the road (where you get the visiting section
 * and a quiet stadium). Sounds are timed to the animation: the QB's cadence and the pads at the snap, a leather pop on
 * the catch, a hit when the ball carrier goes down, the crowd when the popup lands, the whistle when the play is dead,
 * and the band's "Charge!" on a touchdown.
 *
 * API (all no-ops while sound is off):
 *   Sound.on / Sound.set(bool)        the toggle
 *   Sound.play(name, ctx)             snap, whistle, timeout, final, and a few others
 *   Sound.popup(text, ctx)            react to an animation popup ("TOUCHDOWN!", "SACKED!", ...)
 *   Sound.fx(name)                    hit, bighit, catch, kick, deadball
 *   Sound.result(outcome, ctx)        fallback reaction when the animation was skipped
 *   Sound.ambience(level)             crowd bed 0..1 (0 fades it out)
 *   Sound.beginPlay() / Sound.reacted whether this snap already got its crowd reaction
 * ctx = { home: bool (the offense is the home team), neutral: bool }
 */
(function () {
  'use strict';
  const KEY = 'cfb2md:sound';
  let on = false;
  try { on = localStorage.getItem(KEY) === '1'; } catch { on = false; }
  let A = null;   // audio graph, built on first use

  function graph() {
    if (A) { if (A.c.state === 'suspended') A.c.resume().catch(() => {}); return A; }
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return null;
    const c = new C();
    const master = c.createGain(); master.gain.value = 0.9;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.25;
    master.connect(comp); comp.connect(c.destination);
    // stadium reverb: a generated impulse response, open-air (long, dark, a few early slaps off the stands)
    const len = Math.floor(c.sampleRate * 2.6), ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch); let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / c.sampleRate, w = Math.random() * 2 - 1;
        lp = lp * 0.82 + w * 0.18;                                  // darker tail
        d[i] = lp * Math.exp(-t * 2.4) * (t < 0.012 ? 0 : 1);
      }
      for (const [ms, g] of [[38, .5], [71, .35], [113, .25], [160, .18]]) { const k = Math.floor(c.sampleRate * (ms + ch * 7) / 1000); if (k < len) d[k] += g; }
    }
    const verb = c.createConvolver(); verb.buffer = ir;
    const wet = c.createGain(); wet.gain.value = 0.32; verb.connect(wet); wet.connect(master);
    // one long stereo noise buffer, reused by every noisy sound (random start offsets keep it from repeating)
    const nlen = c.sampleRate * 4, noise = c.createBuffer(2, nlen, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = noise.getChannelData(ch); for (let i = 0; i < nlen; i++) d[i] = Math.random() * 2 - 1; }
    // applause: a few hundred hand claps rendered once
    const alen = Math.floor(c.sampleRate * 3), clap = c.createBuffer(2, alen, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = clap.getChannelData(ch);
      for (let k = 0; k < 520; k++) {
        const at = Math.floor(Math.random() * (alen - 2000)), dur = Math.floor(c.sampleRate * (0.006 + Math.random() * 0.01)), g = 0.25 + Math.random() * 0.75;
        let prev = 0;
        for (let i = 0; i < dur; i++) { const w = Math.random() * 2 - 1, hp = w - prev; prev = w; d[at + i] += hp * g * Math.exp(-i / (dur * 0.35)); }
      }
    }
    A = { c, master, verb, noise, clap, bed: null, bufs: null };
    renderCrowd();                            // the voiced crowd renders in the background; noise stands in until it lands
    return A;
  }
  const T = () => A.c.currentTime;

  // a voice: gain node routed dry to the master (panned) and wet to the stadium
  function out(gain, wet = 0.3, pan = 0) {
    const g = A.c.createGain(); g.gain.value = gain;
    let node = g;
    if (A.c.createStereoPanner && pan) { const p = A.c.createStereoPanner(); p.pan.value = pan; g.connect(p); node = p; }
    node.connect(A.master);
    if (wet > 0) { const s = A.c.createGain(); s.gain.value = wet; node.connect(s); s.connect(A.verb); }
    return g;
  }
  function env(param, t0, attack, peak, hold, release, floor = 0.0001) {
    param.cancelScheduledValues(t0); param.setValueAtTime(floor, t0);
    param.linearRampToValueAtTime(peak, t0 + attack);
    param.setValueAtTime(peak, t0 + attack + hold);
    param.exponentialRampToValueAtTime(floor, t0 + attack + hold + release);
  }
  function noiseSrc(t0, dur) {
    const s = A.c.createBufferSource(); s.buffer = A.noise; s.loop = true;   // loop so long roars never run off the end
    s.start(t0, Math.random() * 3, dur + 0.1); return s;
  }
  function filt(type, f, Q = 1) { const b = A.c.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = Q; return b; }


  // ---------- crowd voices ----------
  // A crowd is thousands of voices, not noise. Render a few seconds of synthesized fans (each with its own pitch,
  // vowel, contour and seat) into buffers with OfflineAudioContext, normalize them, and play those. Until a render
  // lands, the old filtered-noise versions stand in. "Hype" is the crowd's memory: big plays raise it, it decays
  // over ~40 seconds, and the bed under everything follows situation + hype.
  let hype = 0, hypeAt = 0, lastLevel = 0;
  const HYPE = { td: .55, turnover: .5, good: .4, big: .35, bad: .25, trick: .2, first: .15, flag: .1, inc: .05, spike: .05 };
  const hypeNow = () => A ? hype * Math.exp(-Math.max(0, T() - hypeAt) / 40) : 0;
  function bumpHype(x) { if (!x) return; hype = Math.min(1, hypeNow() + x); hypeAt = T(); ambience(lastLevel); }
  // one fan: a sawtooth through two moving formants, with a pitch contour and its own envelope and seat (pan)
  function fan(off, t0, f0, dur, vfrom, vto, contour, gain, pan) {
    const o = off.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(Math.max(50, f0 * contour[0]), t0);
    for (let i = 1; i < contour.length; i++) o.frequency.linearRampToValueAtTime(Math.max(50, f0 * contour[i]), t0 + dur * i / (contour.length - 1));
    const amp = off.createGain(); env(amp.gain, t0, 0.02 + Math.random() * 0.06, gain, dur * 0.45, dur * 0.55);
    let dest = amp;
    if (off.createStereoPanner) { const p2 = off.createStereoPanner(); p2.pan.value = pan; amp.connect(p2); dest = p2; }
    dest.connect(off.destination);
    for (let k = 0; k < 2; k++) {
      const b = off.createBiquadFilter(); b.type = 'bandpass'; b.Q.value = 5 - k * 2;
      b.frequency.setValueAtTime(vfrom[k], t0); b.frequency.linearRampToValueAtTime(vto[k], t0 + dur);
      const m = off.createGain(); m.gain.value = k ? 0.5 : 1;
      o.connect(b); b.connect(m); m.connect(amp);
    }
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  const rf = () => 100 * Math.pow(2, Math.random() * 1.8);   // 100-350 Hz: men, women, kids
  function renderBuf(name, secs, plan) {
    const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OC) return Promise.resolve();
    const off = new OC(2, Math.ceil(A.c.sampleRate * secs), A.c.sampleRate);
    plan(off, secs);
    return off.startRendering().then(buf => {
      let peak = 0;                                   // normalize, so mixing is by gain alone
      for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; } }
      if (peak > 0) for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch), k = 0.85 / peak; for (let i = 0; i < d.length; i++) d[i] *= k; }
      (A.bufs = A.bufs || {})[name] = buf;
    }).catch(() => {});
  }
  function renderCrowd() {
    if (!A || A.rendering) return; A.rendering = true;
    renderBuf('murmur', 8, off => {                   // 150 people talking: short quiet syllable runs, loopable
      for (let v = 0; v < 150; v++) {
        const f0 = rf(), pan = Math.random() * 1.6 - 0.8; let t = Math.random() * 7.2;
        const n = 2 + Math.floor(Math.random() * 4);
        for (let k = 0; k < n && t < 7.5; k++) { const d = 0.07 + Math.random() * 0.15, vw = [350 + Math.random() * 500, 900 + Math.random() * 900]; fan(off, t, f0 * (0.9 + Math.random() * 0.2), d, vw, vw, [1, 1.06, 0.94], 0.05 + Math.random() * 0.05, pan); t += d + 0.04 + Math.random() * 0.2; }
      }
    })
    .then(() => renderBuf('roar', 5, off => {         // 240 fans shouting, bunched at the front, plus long whoos
      for (let v = 0; v < 240; v++) {
        const t0 = Math.pow(Math.random(), 1.6) * 1.5, dur = 0.5 + Math.random() * 1.1, yeah = Math.random() < 0.7;
        fan(off, t0, rf(), dur, yeah ? [620, 1750] : [780, 1250], yeah ? [800, 1250] : [700, 1100], [0.92, 1.18, 1.06, 0.86], 0.5 + Math.random() * 0.5, Math.random() * 1.8 - 0.9);
      }
      for (let v = 0; v < 50; v++) { const t0 = 0.3 + Math.random() * 1.8; fan(off, t0, rf() * 2.2, 0.7 + Math.random() * 0.9, [450, 950], [500, 1050], [0.85, 1.3, 1.15], 0.35, Math.random() * 1.8 - 0.9); }
    }))
    .then(() => renderBuf('groan', 2.6, off => {      // "awww", pitch falling
      for (let v = 0; v < 170; v++) fan(off, Math.pow(Math.random(), 1.4) * 0.5, rf(), 0.7 + Math.random() * 0.9, [700, 1150], [520, 850], [1.04, 0.97, 0.8], 0.6 + Math.random() * 0.4, Math.random() * 1.8 - 0.9);
    }))
    .then(() => renderBuf('ooh', 2.2, off => {        // "ooh", rising: anticipation
      for (let v = 0; v < 150; v++) fan(off, Math.pow(Math.random(), 1.4) * 0.4, rf(), 0.55 + Math.random() * 0.7, [330, 780], [430, 980], [0.92, 1.12, 1.0], 0.6 + Math.random() * 0.4, Math.random() * 1.8 - 0.9);
    }))
    .then(() => { if (A.bed && A.bed.kind === 'noise') ambience(lastLevel); });   // swap the jet for people mid-game
  }
  function playBuf(buf, t0, { gain = 0.2, pan = 0, rate = 1, attack = 0.08, dur, release = 0.5 } = {}) {
    const total = Math.min(dur || buf.duration / rate, buf.duration / rate);
    const s = A.c.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate;
    const g = out(0, 0.5, pan);
    env(g.gain, t0, attack, gain, Math.max(0.05, total - attack - release), release);
    s.connect(g); s.start(t0); s.stop(t0 + total + 0.15);
  }

  // ---------- the crowd ----------
  // a roar: noise through three broad "voice" bands, swelling in and fading out, with applause and a few "whoo"s
  function cheer(size, t0 = T(), pan = 0) {
    if (size <= 0) return;
    const dur = 1.0 + 2.6 * size, peak = 0.07 + 0.3 * size;
    if (A.bufs && A.bufs.roar) {                       // the voiced crowd
      playBuf(A.bufs.roar, t0, { gain: 0.12 + 0.45 * size, pan, rate: 0.95 + Math.random() * 0.1, dur: Math.min(5, dur), attack: 0.12 + 0.25 * size, release: 0.8 + 0.6 * size });
      const cl = A.c.createBufferSource(); cl.buffer = A.clap; cl.loop = true; const cg = out(0, 0.4, pan);
      env(cg.gain, t0 + 0.15, 0.3, 0.1 * size, dur * 0.3, dur * 0.6); cl.connect(cg); cl.start(t0 + 0.15, Math.random() * 0.5, dur);
      return;
    }
    const g = out(1, 0.5, pan), amp = A.c.createGain(); amp.connect(g);
    env(amp.gain, t0, 0.18 + 0.2 * size, peak, dur * 0.35, dur * 0.65);
    const src = noiseSrc(t0, dur + 0.5);
    for (const [f, q, k] of [[420, 0.9, 1], [1150, 1.1, 0.8], [2600, 1.4, 0.45]]) { const b = filt('bandpass', f, q), m = A.c.createGain(); m.gain.value = k; src.connect(b); b.connect(m); m.connect(amp); }
    const cl = A.c.createBufferSource(); cl.buffer = A.clap; cl.loop = true; const cg = out(0, 0.4, pan);
    env(cg.gain, t0 + 0.15, 0.3, 0.12 * size, dur * 0.3, dur * 0.6); cl.connect(cg); cl.start(t0 + 0.15, Math.random() * 0.5, dur);
    const whoos = Math.round(2 + 7 * size);
    for (let i = 0; i < whoos; i++) {                                   // individual fans: a rising-falling "whooo"
      const s0 = t0 + 0.1 + Math.random() * dur * 0.5, d = 0.35 + Math.random() * 0.6, f0 = 700 + Math.random() * 700;
      const o = A.c.createOscillator(), vg = out(0, 0.6, pan + (Math.random() - 0.5) * 0.8);
      o.type = 'sine'; o.frequency.setValueAtTime(f0, s0); o.frequency.linearRampToValueAtTime(f0 * 1.35, s0 + d * 0.4); o.frequency.linearRampToValueAtTime(f0 * 0.9, s0 + d);
      env(vg.gain, s0, 0.05, 0.006 + 0.01 * size, d * 0.4, d * 0.5); o.connect(vg); o.start(s0); o.stop(s0 + d + 0.05);
    }
  }
  // a vowel-shaped crowd sound: "ooh" (rising) and "aww" (falling), noise through moving formants
  function vowelCrowd(from, to, dur, peak, t0 = T(), pan = 0) {
    const g = out(1, 0.5, pan), amp = A.c.createGain(); amp.connect(g);
    env(amp.gain, t0, dur * 0.25, peak, dur * 0.2, dur * 0.55);
    const src = noiseSrc(t0, dur + 0.3);
    for (let k = 0; k < 2; k++) {
      const b = filt('bandpass', from[k], 7 - k * 2);
      b.frequency.setValueAtTime(from[k], t0); b.frequency.linearRampToValueAtTime(to[k], t0 + dur);
      const m = A.c.createGain(); m.gain.value = k ? 0.6 : 1.4; src.connect(b); b.connect(m); m.connect(amp);
    }
  }
  const groan = (size, t0, pan) => { if (size <= 0) return; t0 = t0 == null ? T() : t0;
    if (A.bufs && A.bufs.groan) return playBuf(A.bufs.groan, t0, { gain: 0.1 + 0.34 * size, pan: pan || 0, rate: 0.93 + Math.random() * 0.12 });
    vowelCrowd([760, 1250], [520, 900], 1.0 + 1.2 * size, 0.08 + 0.24 * size, t0, pan); };
  const ooh = (size, t0, pan) => { t0 = t0 == null ? T() : t0;
    if (A.bufs && A.bufs.ooh) return playBuf(A.bufs.ooh, t0, { gain: 0.09 + 0.22 * size, pan: pan || 0, rate: 0.95 + Math.random() * 0.1 });
    vowelCrowd([300, 800], [420, 1050], 0.8 + 0.6 * size, 0.07 + 0.18 * size, t0, pan); };
  function gasp(t0 = T()) {
    const g = out(1, 0.4), amp = A.c.createGain(); amp.connect(g); env(amp.gain, t0, 0.12, 0.12, 0.05, 0.25);
    const src = noiseSrc(t0, 0.5), b = filt('bandpass', 1500, 0.8); b.frequency.setValueAtTime(900, t0); b.frequency.linearRampToValueAtTime(2400, t0 + 0.2); src.connect(b); b.connect(amp);
  }
  // partisan reaction: what the stands do when the offense's play went well (good) or badly
  function crowd(good, size, ctx = {}, t0 = T()) {
    if (ctx.neutral) { if (good) { cheer(size * 0.75, t0, -0.3); groan(size * 0.35, t0, 0.4); } else { groan(size * 0.75, t0, -0.3); cheer(size * 0.4, t0, 0.4); } return; }
    if (ctx.home !== false) { good ? cheer(size, t0) : groan(size, t0); return; }
    if (good) { groan(size * 0.75, t0); cheer(size * 0.45, t0, -0.55); }   // on the road: a quiet stadium, a loud visiting section
    else cheer(size * 0.9, t0);
  }

  // ---------- the field ----------
  // referee's pea whistle: a ~3 kHz tone with the pea's fast warble, plus breath
  function whistle(t0 = T(), len = 0.45, gain = 0.07, wet = 0.35) {
    const o = A.c.createOscillator(), lfo = A.c.createOscillator(), depth = A.c.createGain(), g = out(0, wet);
    o.type = 'sine'; o.frequency.value = 3050 + Math.random() * 150;
    lfo.frequency.value = 26 + Math.random() * 8; depth.gain.value = 170; lfo.connect(depth); depth.connect(o.frequency);
    const trem = A.c.createGain(); trem.gain.value = 0.75; const tl = A.c.createGain(); tl.gain.value = 0.25; lfo.connect(tl); tl.connect(trem.gain);
    o.connect(trem); trem.connect(g); env(g.gain, t0, 0.015, gain, len, 0.07);
    const br = noiseSrc(t0, len + 0.1), bb = filt('bandpass', 3200, 2), bg = out(0, wet); br.connect(bb); bb.connect(bg); env(bg.gain, t0, 0.015, gain * 0.25, len, 0.06);
    o.start(t0); lfo.start(t0); o.stop(t0 + len + 0.12); lfo.stop(t0 + len + 0.12);
  }
  // a short syllable from the quarterback: aspiration or hiss, then a voiced vowel through three formants
  function syllable(t0, formants, pitch, dur, lead) {
    const g = out(0.9, 0.45);
    if (lead) {
      const s = noiseSrc(t0, lead.d), f = filt(lead.type, lead.f, lead.q || 1), a = A.c.createGain(); s.connect(f); f.connect(a); a.connect(g);
      env(a.gain, t0, 0.01, lead.g, lead.d * 0.5, lead.d * 0.5); t0 += lead.d * 0.8;
    }
    const src = A.c.createOscillator(); src.type = 'sawtooth';
    src.frequency.setValueAtTime(pitch * 1.08, t0); src.frequency.exponentialRampToValueAtTime(pitch * 0.82, t0 + dur);
    const amp = A.c.createGain(); amp.connect(g); env(amp.gain, t0, 0.012, 0.11, dur * 0.45, dur * 0.5);
    formants.forEach(([f, q, k]) => { const b = filt('bandpass', f, q), m = A.c.createGain(); m.gain.value = k; src.connect(b); b.connect(m); m.connect(amp); });
    src.start(t0); src.stop(t0 + dur + 0.05);
  }
  function cadence(t0 = T()) {
    syllable(t0, [[500, 9, 1], [1800, 11, 0.6], [2500, 12, 0.3]], 135, 0.12, { type: 'highpass', f: 4500, d: 0.08, g: 0.05 });     // "Set"
    syllable(t0 + 0.32, [[650, 8, 1], [1190, 10, 0.7], [2400, 12, 0.3]], 150, 0.13, { type: 'bandpass', f: 1200, q: 0.7, d: 0.05, g: 0.05 }); // "Hut!"
  }
  function crack(t0 = T(), gain = 0.12, n = 3) {        // pads and helmets
    for (let i = 0; i < n; i++) {
      const s = t0 + Math.random() * 0.045, src = noiseSrc(s, 0.06), b = filt('bandpass', 1500 + Math.random() * 1500, 1.4), g = out(0, 0.35, (Math.random() - 0.5) * 0.6);
      src.connect(b); b.connect(g); env(g.gain, s, 0.002, gain * (0.6 + Math.random() * 0.4), 0.005, 0.04);
    }
  }
  function thud(t0 = T(), gain = 0.22) {
    const o = A.c.createOscillator(), g = out(0, 0.25); o.type = 'sine';
    o.frequency.setValueAtTime(95, t0); o.frequency.exponentialRampToValueAtTime(42, t0 + 0.18);
    env(g.gain, t0, 0.004, gain, 0.02, 0.18); o.connect(g); o.start(t0); o.stop(t0 + 0.25);
    const s = noiseSrc(t0, 0.15), lp = filt('lowpass', 320), ng = out(0, 0.2); s.connect(lp); lp.connect(ng); env(ng.gain, t0, 0.003, gain * 0.5, 0.01, 0.1);
  }
  function pop(t0 = T(), gain = 0.07) {                  // the ball into hands
    const s = noiseSrc(t0, 0.05), b = filt('bandpass', 1100, 3), g = out(0, 0.3); s.connect(b); b.connect(g); env(g.gain, t0, 0.002, gain, 0.004, 0.035);
  }
  function kick(t0 = T()) {
    const o = A.c.createOscillator(), g = out(0, 0.4); o.type = 'sine';
    o.frequency.setValueAtTime(150, t0); o.frequency.exponentialRampToValueAtTime(55, t0 + 0.12);
    env(g.gain, t0, 0.003, 0.2, 0.01, 0.14); o.connect(g); o.start(t0); o.stop(t0 + 0.2);
    pop(t0, 0.12);
  }

  // ---------- the band ----------
  function brass(freq, t0, dur, gain = 0.05, pan = 0) {
    const g = out(0, 0.55, pan), f = filt('lowpass', 400, 2.5);
    f.frequency.setValueAtTime(350, t0); f.frequency.linearRampToValueAtTime(2800, t0 + 0.035); f.frequency.linearRampToValueAtTime(1700, t0 + 0.12);
    f.connect(g); env(g.gain, t0, 0.018, gain, Math.max(0.02, dur - 0.08), 0.09);
    for (const [mul, det, k] of [[1, -7, 1], [1, 7, 1], [0.5, 0, 0.5]]) {
      const o = A.c.createOscillator(), m = A.c.createGain(); o.type = 'sawtooth'; o.frequency.value = freq * mul; o.detune.value = det; m.gain.value = k;
      o.connect(m); m.connect(f); o.start(t0); o.stop(t0 + dur + 0.15);
    }
  }
  function drum(t0, big) {
    const o = A.c.createOscillator(), g = out(0, 0.5); o.type = 'sine';
    o.frequency.setValueAtTime(big ? 75 : 190, t0); o.frequency.exponentialRampToValueAtTime(big ? 40 : 150, t0 + 0.15);
    env(g.gain, t0, 0.003, big ? 0.22 : 0.06, 0.01, 0.16); o.connect(g); o.start(t0); o.stop(t0 + 0.25);
    if (!big) { const s = noiseSrc(t0, 0.15), b = filt('bandpass', 1900, 0.8), ng = out(0, 0.45); s.connect(b); b.connect(ng); env(ng.gain, t0, 0.002, 0.09, 0.01, 0.11); }
  }
  // "Charge!" (the public-domain bugle call every stadium organ and band plays)
  function charge(t0 = T(), gain = 0.05, pan = 0) {
    const G4 = 392, C5 = 523.25, E5 = 659.25, G5 = 783.99;
    [[G4, 0, .13], [C5, .15, .13], [E5, .3, .13], [G5, .45, .3], [E5, .8, .13], [G5, .95, .7]].forEach(([f, s, d]) => brass(f, t0 + s, d, gain, pan));
    [[0, 0], [.15, 0], [.3, 0], [.45, 1], [.8, 0], [.95, 1]].forEach(([s, big]) => drum(t0 + s, !!big));
  }
  function horn(t0 = T()) {                               // the end-of-game horn
    const g = out(0, 0.5), f = filt('lowpass', 900, 1); f.connect(g); env(g.gain, t0, 0.04, 0.07, 1.0, 0.4);
    for (const fr of [110, 138.6, 165]) { const o = A.c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = fr; o.connect(f); o.start(t0); o.stop(t0 + 1.6); }
  }

  // ---------- crowd bed ----------
  function ambience(level) {
    if (!graph()) return;
    const now = T();
    lastLevel = level;
    const voices = !!(A.bufs && A.bufs.murmur);
    if (A.bed && voices && A.bed.kind !== 'voices') { try { A.bed.src.stop(); A.bed.lfo.stop(); } catch { /* done */ } A.bed = null; }
    if (!A.bed && (level > 0 || hypeNow() > 0.05)) {
      const g = out(0, 0.6);
      const lfo = A.c.createOscillator(), lg = A.c.createGain(); lfo.frequency.value = 0.11; lg.gain.value = 0; lfo.connect(lg); lg.connect(g.gain);
      let src;
      if (voices) { src = A.c.createBufferSource(); src.buffer = A.bufs.murmur; src.loop = true; src.connect(g); }
      else { src = A.c.createBufferSource(); src.buffer = A.noise; src.loop = true; src.playbackRate.value = 0.97; const lp = filt('lowpass', 900, 0.5), bp = filt('bandpass', 480, 0.6); src.connect(lp); lp.connect(bp); bp.connect(g); }
      src.start(now); lfo.start(now);
      A.bed = { src, g, lg, lfo, kind: voices ? 'voices' : 'noise' };
    }
    if (!A.bed) return;
    // situation from the game plus whatever hype is left over from the last big play
    const target = Math.max(0, Math.min(1.25, level + hypeNow() * 0.5)) * (A.bed.kind === 'voices' ? 0.16 : 0.07);
    A.bed.g.gain.cancelScheduledValues(now); A.bed.g.gain.setValueAtTime(Math.max(0.0001, A.bed.g.gain.value), now); A.bed.g.gain.linearRampToValueAtTime(target, now + 1.2);
    A.bed.lg.gain.setValueAtTime(target * 0.3, now);   // the bed breathes
  }

  // ---------- what the game calls ----------
  let reacted = false;
  const POP = {
    td: ['TOUCHDOWN!', 'HOUSE CALL!', 'TWO POINTS!', 'HE CAUGHT IT!'],
    big: ['MOSSED HIM!', 'JUKED HIM!', 'BROKE A TACKLE!', 'TRUCKED HIM!', 'CONTESTED CATCH!', 'SCRAMBLE!'],
    first: ['FIRST DOWN'],
    bad: ['SACKED!', 'TACKLE FOR LOSS!', 'BLOWN UP!', 'NO GOOD'],
    turnover: ['STRIP SACK!', 'FUMBLE!', 'INTERCEPTED!', 'PICK SIX!', 'LATERAL ON THE GROUND!', 'BLOWN UP, BALL OUT!'],
    inc: ['INCOMPLETE', 'BROKEN UP!', 'DROPPED!', 'THROWN AWAY', 'KNOCKED DOWN'],
    trick: ['FLEA FLICKER!', 'HALFBACK PASS!', 'PHILLY SPECIAL!', 'REVERSE!', 'JET SWEEP!', 'WILDCAT!', 'STATUE OF LIBERTY!', 'HOOK AND LADDER!', 'FAKE!', 'FAKE PUNT!'],
    good: ['GOOD!'],
  };
  const kindOf = text => Object.keys(POP).find(k => POP[k].includes(text)) || (text === 'FLAG' ? 'flag' : text && text.startsWith('SPIKE') ? 'spike' : null);
  function react(kind, ctx = {}) {
    const t = T();
    bumpHype(HYPE[kind] || 0);
    switch (kind) {
      case 'td': crowd(true, 1, ctx, t); charge(t + 0.35, ctx.home === false && !ctx.neutral ? 0.035 : 0.07, ctx.home === false && !ctx.neutral ? -0.5 : 0); break;
      case 'big': crowd(true, 0.65, ctx, t); break;
      case 'first': crowd(true, 0.35, ctx, t); break;
      case 'good': crowd(true, 0.8, ctx, t); break;
      case 'bad': crowd(false, 0.6, ctx, t); break;
      case 'turnover': gasp(t); crowd(false, 1, ctx, t + 0.25); break;
      case 'inc': crowd(false, 0.28, ctx, t + 0.05); break;
      case 'trick': ooh(0.7, t); break;
      case 'flag': whistle(t, 0.18, 0.06); whistle(t + 0.24, 0.18, 0.06); whistle(t + 0.48, 0.5, 0.06); setTimeout(() => on && A && ooh(0.25), 700); break;
      case 'spike': whistle(t + 0.1, 0.25, 0.04, 0.5); break;
      default: return false;
    }
    reacted = true; return true;
  }
  const safe = f => (...a) => { if (!on) return; try { if (!graph()) return; return f(...a); } catch (e) { if (window.__SOUND_DEBUG) throw e; /* audio unavailable */ } };

  window.Sound = {
    get on() { return on; },
    get reacted() { return reacted; },
    get _graph() { return A; },          // for tests: the master bus
    set(v) {
      on = !!v; try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* ignore */ }
      if (on) { if (graph()) A.master.gain.setTargetAtTime(0.9, T(), 0.05); }
      else if (A) { A.master.gain.setTargetAtTime(0, T(), 0.05); }
    },
    beginPlay() { reacted = false; },
    play: safe((name, ctx = {}) => {
      const t = T();
      switch (name) {
        case 'snap': cadence(t); crack(t + 0.42, 0.1, 5); thud(t + 0.44, 0.12); break;
        case 'whistle': whistle(t); break;
        case 'deadball': whistle(t + 0.05, 0.32, 0.045, 0.55); break;
        case 'timeout': whistle(t, 0.5, 0.06); setTimeout(() => on && A && ambience(0.3), 600); break;
        case 'final': horn(t); if (ctx.won) { crowd(true, 1, ctx, t + 0.3); charge(t + 0.8, 0.07); } else crowd(false, 0.8, ctx, t + 0.3); break;
        case 'toggle': whistle(t, 0.3, 0.05); cheer(0.25, t + 0.2); break;
        default: react(name, ctx);
      }
    }),
    popup: safe((text, ctx = {}) => { const k = kindOf(text); if (k) react(k, ctx); }),
    fx: safe(name => {
      const t = T();
      if (name === 'hit') { crack(t, 0.1, 2); thud(t, 0.16); }
      else if (name === 'bighit') { crack(t, 0.16, 4); thud(t, 0.26); }
      else if (name === 'catch') pop(t);
      else if (name === 'kick') kick(t);
      else if (name === 'deadball') whistle(t + 0.05, 0.32, 0.045, 0.55);
    }),
    // when the animation was skipped, the result still gets a reaction
    result: safe((o, ctx = {}) => { if (reacted) return; react(o, ctx); }),
    ambience: safe(level => ambience(level)),
  };
  // keep the bed quiet when the toggle is off, even if a screen asks for it
  const amb = window.Sound.ambience;
  window.Sound.ambience = level => { if (!on) { if (A && A.bed) { A.bed.g.gain.setTargetAtTime(0, A.c.currentTime, 0.2); } return; } amb(level); };
})();
