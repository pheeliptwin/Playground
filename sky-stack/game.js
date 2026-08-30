'use strict';

/* ============================================================
   Sky-Stack — a touch-first tower-stacking game.
   No external dependencies. Canvas 2D + WebAudio synth.
   ============================================================ */

// ---------- constants ----------
const BLOCK_H = 42;          // world units (zoom-independent)
const BASE_W = 210;
const MAX_W = 210;
const HIGH_KEY = 'skystack.highscore.v1';
const MUTE_KEY = 'skystack.muted.v1';

// Sky palettes, keyed by tower height. Interpolated between.
const PHASES = [
  { h: 0,   top: [252, 142, 110], bot: [255, 209, 153], night: 0.0 }, // dawn
  { h: 14,  top: [96, 186, 242],  bot: [170, 228, 250], night: 0.0 }, // clear day
  { h: 32,  top: [122, 96, 214],  bot: [255, 140, 176], night: 0.25 },// sunset
  { h: 54,  top: [36, 42, 114],   bot: [98, 74, 168],   night: 0.62 },// dusk
  { h: 85,  top: [6, 6, 28],      bot: [24, 20, 58],    night: 1.0 }, // deep space
];

const MAX_PHASE = PHASES[PHASES.length - 1].h;

// ---------- helpers ----------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

function hash01(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function skyPalette(height) {
  let a = PHASES[0], b = PHASES[PHASES.length - 1];
  for (let i = 0; i < PHASES.length - 1; i++) {
    if (height <= PHASES[i + 1].h) { a = PHASES[i]; b = PHASES[i + 1]; break; }
  }
  const f = a === b ? 1 : clamp((height - a.h) / (b.h - a.h), 0, 1);
  return {
    top: [lerp(a.top[0], b.top[0], f), lerp(a.top[1], b.top[1], f), lerp(a.top[2], b.top[2], f)],
    bot: [lerp(a.bot[0], b.bot[0], f), lerp(a.bot[1], b.bot[1], f), lerp(a.bot[2], b.bot[2], f)],
    night: lerp(a.night, b.night, f),
  };
}

function blockHue(i) {
  return (170 + i * 2.6) % 360;
}

const css = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

// ---------- state ----------
const S = {
  phase: 'start',             // start | playing | gameover
  blocks: [],                 // {x, w, y(center), hue}
  moving: null,               // {x,w,y,dir,speed,falling,...}
  nextWidth: BASE_W,
  height: 0,
  dispScore: 0,
  best: 0,
  combo: 0,
  camX: 0,
  camY: 0,
  camYOff: 0,
  shake: 0,
  debris: [],
  particles: [],
  rings: [],
  popups: [],
  stars: [],
  clouds: [],
  t: 0,
  overAt: 0,
  bestBroken: false,
  soundOn: true,
};

// ---------- canvas ----------
const cv = document.getElementById('game');
const ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1, Z = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = cv.clientWidth;
  H = cv.clientHeight;
  cv.width = Math.round(W * DPR);
  cv.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  Z = clamp(Math.min(W / 860, H / 720), 0.55, 1.25);
}
window.addEventListener('resize', resize);

// world -> screen
const sx = (x) => (x - S.camX) * Z + W / 2;
const sy = (y) => (y - S.camY - S.camYOff) * Z + H * 0.42;

// ---------- audio (tiny WebAudio synth) ----------
let AC = null;
function audio() {
  if (!AC) {
    const ACtor = window.AudioContext || window.webkitAudioContext;
    if (!ACtor) return null;
    AC = new ACtor();
  }
  if (AC.state === 'suspended') AC.resume();
  return AC;
}

function beep(freq, dur, type, vol, delay, slide) {
  if (!S.soundOn) return;
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + (delay || 0);
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type || 'sine';
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  g.gain.setValueAtTime(vol || 0.18, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(ac.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.03);
}

const sfx = {
  drop: () => beep(620, 0.06, 'square', 0.05, 0, -340),
  land(h) { beep(300 + h * 9, 0.08, 'triangle', 0.22, 0, 30); },
  perfect() {
    beep(660, 0.09, 'triangle', 0.24);
    beep(880, 0.11, 'triangle', 0.2, 0.06);
    beep(1320, 0.16, 'sine', 0.12, 0.12);
  },
  miss() { beep(190, 0.4, 'sawtooth', 0.28, 0, -140); },
  start() {
    beep(523, 0.1, 'triangle', 0.2);
    beep(659, 0.1, 'triangle', 0.2, 0.09);
    beep(784, 0.18, 'triangle', 0.2, 0.18);
  },
  gameover() {
    beep(440, 0.14, 'triangle', 0.2);
    beep(330, 0.14, 'triangle', 0.18, 0.14);
    beep(220, 0.34, 'triangle', 0.18, 0.28);
  },
};

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const elScore = $('score');
const elBest = $('best');
const elCombo = $('combo');
const elOverStart = $('overlay-start');
const elOverEnd = $('overlay-gameover');
const elFinal = $('final-height');
const elNewBest = $('new-best');
const elMute = $('mute');

// ---------- world generation ----------
function genStars() {
  S.stars = [];
  for (let i = 0; i < 140; i++) {
    S.stars.push({
      x: hash01(i * 7.31),
      y: hash01(i * 3.17),
      r: 0.5 + hash01(i * 9.23) * 1.7,
      tw: hash01(i * 5.7) * 6.28,
    });
  }
}
function genClouds() {
  S.clouds = [];
  for (let i = 0; i < 7; i++) {
    S.clouds.push({
      x: hash01(i * 13.7),
      y: 0.18 + hash01(i * 6.1) * 0.42,
      s: 0.6 + hash01(i * 4.3) * 0.9,
      v: 0.004 + hash01(i * 8.9) * 0.01,
      a: 0.10 + hash01(i * 2.9) * 0.16,
    });
  }
}

// ---------- game flow ----------
function initGame() {
  S.blocks = [{ x: 0, w: BASE_W, y: 0, h: BLOCK_H, hue: blockHue(0) }];
  S.height = 0;
  S.dispScore = 0;
  S.nextWidth = BASE_W;
  S.combo = 0;
  S.camX = 0;
  S.camY = 0;
  S.camYOff = 0;
  S.shake = 0;
  S.debris = [];
  S.particles = [];
  S.rings = [];
  S.popups = [];
  S.bestBroken = false;
  S.moving = spawnMoving();
  elCombo.classList.add('hidden');
  updateHUD();
}

function spawnMoving() {
  const top = S.blocks[S.blocks.length - 1];
  const baseScreenSpeed = 205;
  const speed = Math.min(baseScreenSpeed * Math.pow(1.032, S.height), baseScreenSpeed * 3.3) / Z;
  return {
    x: top.x,
    w: S.nextWidth,
    y: top.y - BLOCK_H * 2.6,
    dir: Math.random() < 0.5 ? 1 : -1,
    speed,
    falling: false,
  };
}

function startGame() {
  elOverStart.classList.add('hidden');
  elOverEnd.classList.add('hidden');
  if (document.activeElement) document.activeElement.blur();
  initGame();
  S.phase = 'playing';
  audio();
  sfx.start();
}

function endGame() {
  S.phase = 'gameover';
  S.overAt = performance.now();
  S.shake = Math.max(S.shake, 10);
  sfx.gameover();
  elFinal.textContent = S.height;
  if (S.height > S.best) {
    S.best = S.height;
    try { localStorage.setItem(HIGH_KEY, String(S.best)); } catch (e) { /* ignore */ }
    elNewBest.classList.remove('hidden');
  } else {
    elNewBest.classList.add('hidden');
  }
  elBest.textContent = S.best;
  elScore.textContent = S.height;
  elOverEnd.classList.remove('hidden');
}

function restartGame() {
  elOverEnd.classList.add('hidden');
  if (document.activeElement) document.activeElement.blur();
  initGame();
  S.phase = 'playing';
  audio();
  sfx.start();
}

// ---------- core actions ----------
function press() {
  if (S.phase === 'start') {
    startGame();
  } else if (S.phase === 'playing') {
    if (S.moving && !S.moving.falling) drop();
  } else if (S.phase === 'gameover') {
    if (performance.now() - S.overAt > 550) restartGame();
  }
}

function drop() {
  const mb = S.moving;
  const top = S.blocks[S.blocks.length - 1];
  const ml = mb.x - mb.w / 2, mr = mb.x + mb.w / 2;
  const tl = top.x - top.w / 2, tr = top.x + top.w / 2;
  const ol = Math.max(ml, tl), or = Math.min(mr, tr);
  const overlap = or - ol;
  sfx.drop();

  if (overlap <= 0) {
    // full miss — whole block becomes debris
    S.debris.push(makeDebris(mb.x, mb.y, mb.w, mb.dir * (60 + Math.random() * 90), -(70 + Math.random() * 70), blockHue(S.height), mb.w));
    S.moving = null;
    S.shake = Math.max(S.shake, 22);
    S.camYOff = Math.max(S.camYOff, 7);
    spawnPopup(mb.x, mb.y - 30, 'MISS', '#ff8a8a', 20);
    spawnParticles(mb.x, mb.y + BLOCK_H, blockHue(S.height), 16);
    setTimeout(endGame, 750);
    return;
  }

  const perfect = overlap >= top.w - 1.6;
  mb.falling = true;
  mb.fallFromY = mb.y;
  mb.fallToY = top.y - BLOCK_H;
  mb.fallT = 0;
  mb.fallDur = 0.22;
  mb.land = { ol, or, overlap, perfect };
}

function settle() {
  const mb = S.moving;
  const top = S.blocks[S.blocks.length - 1];
  const { ol, or, overlap, perfect } = mb.land;

  const newW = perfect ? top.w : overlap;
  const newX = (ol + or) / 2;

  // cut away overhangs as falling debris
  const ml = mb.x - mb.w / 2, mr = mb.x + mb.w / 2;
  if (ml < ol) S.debris.push(makeDebris((ml + ol) / 2, mb.y, ol - ml, -(50 + Math.random() * 70), -(55 + Math.random() * 45), blockHue(S.height), ol - ml));
  if (mr > or) S.debris.push(makeDebris((or + mr) / 2, mb.y, mr - or, 50 + Math.random() * 70, -(55 + Math.random() * 45), blockHue(S.height), mr - or));

  const b = { x: newX, w: newW, y: top.y - BLOCK_H, h: BLOCK_H, hue: blockHue(S.height) };
  S.blocks.push(b);
  S.height++;
  S.camYOff = Math.max(S.camYOff, 5);

  // combo / perfect handling
  if (perfect) {
    S.combo++;
    sfx.perfect();
    S.nextWidth = Math.min(top.w + 9, MAX_W);
    spawnRing(newX, b.y + BLOCK_H / 2, blockHue(S.height));
    spawnParticles(newX, b.y + BLOCK_H, blockHue(S.height), 26);
    const label = S.combo > 1 ? `PERFECT ×${S.combo}` : 'PERFECT';
    spawnPopup(newX, b.y + 6, label, '#ffd76a', 22 + Math.min(S.combo, 5) * 1.5);
    if (S.combo >= 2) showCombo(S.combo);
  } else {
    S.combo = 0;
    S.nextWidth = Math.max(newW, 12);
    sfx.land(S.height);
    spawnParticles(newX, b.y + BLOCK_H, blockHue(S.height), 9);
    elCombo.classList.add('hidden');
  }

  // flag the moment a run overtakes the lifetime best
  if (!S.bestBroken && S.best > 0 && S.height > S.best) {
    S.bestBroken = true;
    spawnPopup(newX, b.y - 26, 'NEW BEST!', '#8ef0c8', 20);
  }

  S.moving = spawnMoving();
  updateHUD();
}

// ---------- entities ----------
function makeDebris(x, y, w, vx, vy, hue, fullW) {
  return {
    x, y, w: fullW || w, h: BLOCK_H,
    vx: vx / Z, vy: vy / Z,
    rot: (Math.random() - 0.5) * 0.4,
    vrot: (Math.random() - 0.5) * 7,
    alpha: 1,
    hue,
  };
}

function spawnParticles(x, y, hue, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = (40 + Math.random() * 130) / Z;
    S.particles.push({
      x, y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 60 / Z,
      size: (2 + Math.random() * 3.4) / Z,
      hue,
      life: 0,
      max: 0.45 + Math.random() * 0.5,
    });
  }
}

function spawnRing(x, y, hue) {
  S.rings.push({ x, y, r: 8 / Z, vr: 330 / Z, alpha: 0.55, hue });
}

function spawnPopup(x, y, text, color, size) {
  S.popups.push({ x, y, text, color, size: size || 18, t: 0, dur: 1.0 });
}

// ---------- update ----------
function update(dt) {
  S.t += dt;
  S.camYOff *= Math.exp(-8 * dt);
  S.shake *= Math.exp(-6 * dt);
  if (S.shake < 0.2) S.shake = 0;

  const top = S.blocks[S.blocks.length - 1];

  // camera follows the tower top
  S.camX += (top.x - S.camX) * Math.min(1, dt * 8);
  const targetCamY = top.y + (H * 0.04) / Z;
  S.camY += (targetCamY - S.camY) * Math.min(1, dt * 6);

  // moving platform
  if (S.moving && !S.moving.falling && !S.moving.frozen) {
    const mb = S.moving;
    const amp = Math.max((W * 0.32) / Z, top.w + 60);
    mb.x += mb.dir * mb.speed * dt;
    if (mb.x > S.camX + amp) { mb.x = S.camX + amp; mb.dir = -1; }
    if (mb.x < S.camX - amp) { mb.x = S.camX - amp; mb.dir = 1; }
  } else if (S.moving && S.moving.falling) {
    const mb = S.moving;
    mb.fallT += dt / mb.fallDur;
    const t = Math.min(mb.fallT, 1);
    mb.y = mb.fallFromY + (mb.fallToY - mb.fallFromY) * t * t;
    if (mb.fallT >= 1) {
      mb.y = mb.fallToY;
      if (S.phase === 'playing') {
        settle();
      } else {
        mb.falling = false;
        mb.frozen = true; // rest in place without scoring
      }
    }
  }

  // debris
  for (let i = S.debris.length - 1; i >= 0; i--) {
    const d = S.debris[i];
    d.vy += (1500 / Z) * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.rot += d.vrot * dt;
    d.alpha -= dt * 1.15;
    if (d.alpha <= 0) S.debris.splice(i, 1);
  }

  // particles
  for (let i = S.particles.length - 1; i >= 0; i--) {
    const p = S.particles[i];
    p.vy += (900 / Z) * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life += dt;
    if (p.life >= p.max) S.particles.splice(i, 1);
  }

  // rings
  for (let i = S.rings.length - 1; i >= 0; i--) {
    const r = S.rings[i];
    r.r += r.vr * dt;
    r.alpha -= dt * 2.2;
    if (r.alpha <= 0) S.rings.splice(i, 1);
  }

  // popups
  for (let i = S.popups.length - 1; i >= 0; i--) {
    const p = S.popups[i];
    p.t += dt;
    p.y -= 22 * dt / Z;
    if (p.t >= p.dur) S.popups.splice(i, 1);
  }

  // scored number count-up
  if (S.dispScore < S.height) {
    S.dispScore += (S.height - S.dispScore) * Math.min(1, dt * 14);
    if (S.height - S.dispScore < 0.02) S.dispScore = S.height;
    elScore.textContent = Math.round(S.dispScore);
  }
}

// ---------- drawing ----------
function draw() {
  const sky = skyPalette(Math.min(S.height, MAX_PHASE));

  // sky
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, css(sky.top, 1));
  g.addColorStop(1, css(sky.bot, 1));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  drawCelestial(sky.night);
  drawStars(sky.night);
  drawClouds(sky.night);

  ctx.save();
  let shx = 0, shy = 0;
  if (S.shake > 0.2) {
    shx = (Math.random() - 0.5) * S.shake;
    shy = (Math.random() - 0.5) * S.shake;
  }
  ctx.translate(shx, shy);

  drawDebris();
  for (const b of S.blocks) drawBlock(b, false);
  if (S.moving) drawMoving();
  drawRings();
  drawParticles();
  drawPopups();
  ctx.restore();

  drawVignette(sky.night);
}

function drawBlock(b, falling) {
  const x = sx(b.x - b.w / 2);
  const y = sy(b.y - BLOCK_H / 2);
  const w = b.w * Z;
  const h = BLOCK_H * Z;
  const hue = b.hue;

  if (falling) {
    // motion streak
    const streakH = Math.max(h, (sy(b.fallFromY + BLOCK_H / 2) - y) * 0.9);
    ctx.fillStyle = `hsla(${hue} 60% 55% / 0.18)`;
    ctx.fillRect(x, y + h, w, streakH);
  }

  // soft contact shadow
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(x, y + h - 2 * Z, w, 4 * Z);

  // main body
  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, `hsl(${hue} 66% 66%)`);
  grad.addColorStop(0.45, `hsl(${hue} 60% 55%)`);
  grad.addColorStop(1, `hsl(${hue} 50% 42%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);

  // top highlight
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(x, y, w, Math.max(3, h * 0.12));

  // side shading for roundness
  const sg = ctx.createLinearGradient(x, 0, x + w, 0);
  sg.addColorStop(0, 'rgba(0,0,0,0.28)');
  sg.addColorStop(0.16, 'rgba(255,255,255,0.12)');
  sg.addColorStop(0.84, 'rgba(255,255,255,0.12)');
  sg.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.fillStyle = sg;
  ctx.fillRect(x, y, w, h);

  // outline
  ctx.strokeStyle = 'rgba(0,0,0,0.16)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function drawMoving() {
  const mb = S.moving;
  const top = S.blocks[S.blocks.length - 1];

  // ghost overlap + guide lines
  const ml = mb.x - mb.w / 2, mr = mb.x + mb.w / 2;
  const tl = top.x - top.w / 2, tr = top.x + top.w / 2;
  const ol = Math.max(ml, tl), or = Math.min(mr, tr);
  const topScreenY = sy(top.y - BLOCK_H / 2);
  const bottomScreenY = sy(mb.y + BLOCK_H / 2);

  ctx.save();
  ctx.setLineDash([5, 7]);
  ctx.strokeStyle = 'rgba(255,255,255,0.34)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(sx(ml), bottomScreenY);
  ctx.lineTo(sx(ml), topScreenY);
  ctx.moveTo(sx(mr), bottomScreenY);
  ctx.lineTo(sx(mr), topScreenY);
  ctx.stroke();
  ctx.restore();

  // highlight the would-be landing zone on the tower top
  if (or > ol) {
    ctx.fillStyle = 'rgba(255,255,255,0.20)';
    ctx.fillRect(sx(ol), topScreenY, (or - ol) * Z, BLOCK_H * Z);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(sx((ol + or) / 2) - 1, topScreenY, 2, BLOCK_H * Z);
  }

  // soft glow beneath the moving block (stronger near perfect)
  const perfectness = clamp((top.w - (or - ol)) / top.w, 0, 1);
  const glowR = (34 + (1 - perfectness) * 10) * Z;
  const gl = ctx.createRadialGradient(sx(mb.x), sy(mb.y + BLOCK_H / 2), 2, sx(mb.x), sy(mb.y + BLOCK_H / 2), glowR);
  gl.addColorStop(0, `rgba(255,215,106,${0.28 * (1 - perfectness) + 0.3})`);
  gl.addColorStop(1, 'rgba(255,215,106,0)');
  ctx.fillStyle = gl;
  ctx.fillRect(sx(mb.x) - glowR, sy(mb.y + BLOCK_H / 2) - glowR, glowR * 2, glowR * 2);

  drawBlock({ ...mb, hue: blockHue(S.height) }, mb.falling);
}

function drawDebris() {
  for (const d of S.debris) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, d.alpha);
    ctx.translate(sx(d.x), sy(d.y));
    ctx.rotate(d.rot);
    const w = d.w * Z, h = d.h * Z;
    ctx.fillStyle = `hsl(${d.hue} 55% 50%)`;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(-w / 2, -h / 2, w, h * 0.18);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }
}

function drawParticles() {
  for (const p of S.particles) {
    const a = 1 - p.life / p.max;
    ctx.globalAlpha = a;
    ctx.fillStyle = `hsl(${p.hue} 90% 70%)`;
    const s = p.size * Z;
    ctx.fillRect(sx(p.x) - s / 2, sy(p.y) - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
}

function drawRings() {
  for (const r of S.rings) {
    ctx.globalAlpha = Math.max(0, r.alpha);
    ctx.strokeStyle = `hsl(${r.hue} 90% 78%)`;
    ctx.lineWidth = 3 * Z;
    ctx.beginPath();
    ctx.arc(sx(r.x), sy(r.y), r.r * Z, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawPopups() {
  for (const p of S.popups) {
    const k = p.t / p.dur;
    const a = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
    const scale = k < 0.15 ? 0.6 + (k / 0.15) * 0.4 : 1;
    ctx.save();
    ctx.globalAlpha = Math.max(0, a);
    ctx.translate(sx(p.x), sy(p.y));
    ctx.scale(scale, scale);
    ctx.font = `800 ${p.size}px "Avenir Next","Segoe UI",system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, 0, 0);
    ctx.restore();
  }
}

function drawCelestial(night) {
  const cx = W * 0.78, cy = H * 0.18;
  const warm = [255, 196, 120];
  const pale = [255, 250, 226];
  const moon = [228, 234, 250];
  let col;
  if (night < 0.3) col = lerpColor(warm, pale, night / 0.3);
  else col = lerpColor(pale, moon, (night - 0.3) / 0.7);
  const r = (30 + night * 8) * Z;
  const glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, r * 5);
  glow.addColorStop(0, css(col, 0.55));
  glow.addColorStop(0.3, css(col, 0.18));
  glow.addColorStop(1, css(col, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(cx - r * 5, cy - r * 5, r * 10, r * 10);
  ctx.fillStyle = css(col, 1);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawStars(night) {
  if (night <= 0.02) return;
  for (const s of S.stars) {
    const tw = 0.6 + 0.4 * Math.sin(S.t * 2 + s.tw);
    ctx.globalAlpha = night * tw * 0.9;
    ctx.fillStyle = '#ffffff';
    const x = s.x * W, y = s.y * H * 0.85;
    ctx.beginPath();
    ctx.arc(x, y, s.r * Z, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawClouds(night) {
  const fade = 1 - clamp(night * 1.6, 0, 1);
  if (fade <= 0.02) return;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  for (const c of S.clouds) {
    const x = ((c.x + S.t * c.v) % 1.3 - 0.15) * W;
    const y = c.y * H;
    const w = 90 * c.s * Z;
    ctx.globalAlpha = c.a * fade;
    ctx.beginPath();
    ctx.ellipse(x, y, w, w * 0.3, 0, 0, Math.PI * 2);
    ctx.ellipse(x - w * 0.55, y + 4, w * 0.5, w * 0.22, 0, 0, Math.PI * 2);
    ctx.ellipse(x + w * 0.55, y + 3, w * 0.5, w * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawVignette(night) {
  const v = ctx.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.45, W / 2, H * 0.5, Math.max(W, H) * 0.78);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, `rgba(4,5,18,${0.28 + night * 0.18})`);
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

function lerpColor(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

// ---------- HUD ----------
function updateHUD() {
  elScore.textContent = Math.round(S.dispScore);
  elBest.textContent = Math.max(S.best, S.height);
}

function showCombo(n) {
  elCombo.textContent = `COMBO ×${n}`;
  elCombo.classList.remove('hidden', 'bump');
  void elCombo.offsetWidth; // restart animation
  elCombo.classList.add('bump');
}

// ---------- input ----------
function toggleMute() {
  S.soundOn = !S.soundOn;
  elMute.textContent = S.soundOn ? '\u{1F50A}' : '\u{1F507}';
  try { localStorage.setItem(MUTE_KEY, S.soundOn ? '1' : '0'); } catch (e) { /* ignore */ }
}

cv.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  press();
});

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'KeyM') {
    toggleMute();
    return;
  }
  if (['Space', 'ArrowUp', 'ArrowDown', 'Enter'].includes(e.code)) {
    e.preventDefault();
    press();
  }
});

// tapping anywhere on an overlay triggers its action
elOverStart.addEventListener('pointerdown', (e) => { e.preventDefault(); press(); });
elOverEnd.addEventListener('pointerdown', (e) => { e.preventDefault(); press(); });
elMute.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMute();
});

cv.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

// load persisted state
try {
  S.best = parseInt(localStorage.getItem(HIGH_KEY), 10) || 0;
  S.soundOn = localStorage.getItem(MUTE_KEY) !== '0';
} catch (e) { /* ignore */ }
elMute.textContent = S.soundOn ? '\u{1F50A}' : '\u{1F507}';

// ---------- boot ----------
resize();
genStars();
genClouds();
initGame();
S.phase = 'start';          // show attract screen
elBest.textContent = S.best;
elScore.textContent = '0';

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.033);
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
