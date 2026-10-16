/* Sound cues, synthesized with WebAudio so there are no files to load. Off by default until the player turns them on;
 * the choice is remembered in this browser. Everything is short and quiet: a whistle at the snap, a crowd swell on a
 * big play, a thud on a sack or a stop, a two-note ding on a score, a flat buzz on a turnover. */
(function () {
  'use strict';
  const KEY = 'cfb2md:sound';
  let ctx = null, on = false;
  try { on = localStorage.getItem(KEY) === '1'; } catch { on = false; }
  const ac = () => { if (!ctx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; ctx = new C(); } if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return ctx; };
  function tone(freq, t0, dur, type = 'sine', gain = 0.08, slide = 0) {
    const c = ac(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, c.currentTime + t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), c.currentTime + t0 + dur);
    g.gain.setValueAtTime(0.0001, c.currentTime + t0);
    g.gain.exponentialRampToValueAtTime(gain, c.currentTime + t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + t0 + dur);
    o.connect(g); g.connect(c.destination); o.start(c.currentTime + t0); o.stop(c.currentTime + t0 + dur + 0.02);
  }
  function noise(t0, dur, gain = 0.05, lp = 1200) {
    const c = ac(); if (!c) return;
    const n = Math.floor(c.sampleRate * dur), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = buf; f.type = 'lowpass'; f.frequency.value = lp;
    g.gain.setValueAtTime(0.0001, c.currentTime + t0); g.gain.exponentialRampToValueAtTime(gain, c.currentTime + t0 + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + t0 + dur);
    s.connect(f); f.connect(g); g.connect(c.destination); s.start(c.currentTime + t0);
  }
  const cues = {
    snap: () => { tone(2400, 0, 0.12, 'square', 0.03); },
    whistle: () => { tone(2800, 0, 0.35, 'square', 0.035, -150); },
    crowd: () => { noise(0, 1.6, 0.07, 900); noise(0.2, 1.2, 0.05, 600); },
    thud: () => { tone(90, 0, 0.18, 'sine', 0.12, -40); noise(0, 0.12, 0.05, 400); },
    score: () => { tone(880, 0, 0.14, 'triangle', 0.07); tone(1175, 0.15, 0.3, 'triangle', 0.07); noise(0.1, 1.8, 0.07, 1000); },
    turnover: () => { tone(160, 0, 0.35, 'sawtooth', 0.05, -60); noise(0.05, 0.6, 0.04, 500); },
    flag: () => { tone(2800, 0, 0.12, 'square', 0.03); tone(2800, 0.18, 0.12, 'square', 0.03); tone(2800, 0.36, 0.3, 'square', 0.03); },
    first: () => { tone(660, 0, 0.1, 'triangle', 0.05); },
  };
  window.Sound = {
    get on() { return on; },
    set(v) { on = !!v; try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* ignore */ } if (on) ac(); },
    play(name) { if (!on) return; try { const f = cues[name]; if (f) f(); } catch { /* audio unavailable */ } },
  };
})();
