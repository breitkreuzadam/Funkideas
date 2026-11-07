(() => {
'use strict';

const EVEREST_M = 8849;
const M_TO_FT = 3.28084;
const MAX_DIM = 1600;        // processing resolution (long side)
const MAX_PIXELS = 12e6;     // stay under mobile Safari's canvas limit

// Well-known peaks: [name, summit elevation in metres]
const PRESETS = [
  ['Aconcagua', 6961], ['Aoraki / Mount Cook', 3724], ['Ben Nevis', 1345],
  ['Denali', 6190], ['Eiger', 3967], ['Grand Teton', 4199], ['Half Dome', 2694],
  ['K2', 8611], ['Kilimanjaro', 5895], ['Longs Peak', 4346], ['Matterhorn', 4478],
  ['Mont Blanc', 4806], ['Mount Elbrus', 5642], ['Mount Fuji', 3776],
  ['Mount Hood', 3429], ['Mount Kosciuszko', 2228], ['Mount Olympus (Greece)', 2918],
  ['Mount Rainier', 4392], ['Mount Shasta', 4322], ['Mount St. Helens', 2549],
  ['Mount Washington (NH)', 1917], ['Mount Whitney', 4421], ['Pikes Peak', 4302],
  ['Table Mountain', 1085],
];

// Stylised Everest skyline seen from the north: [metres from summit, elevation m]
const BASE_PROFILE = [
  [-9000,5200],[-7600,5500],[-6400,6150],[-5600,6500],[-4800,6900],[-4000,7250],
  [-3300,7650],[-2600,7980],[-1900,8250],[-1200,8520],[-600,8720],[-250,8810],
  [0,EVEREST_M],
  [300,8800],[800,8660],[1300,8560],[1700,8540],[2200,8420],[2700,8390],[3300,8180],
  [4000,7800],[4800,7300],[5600,6700],[6600,6100],[7800,5500],[9000,5200],
];
const PROFILE = buildProfile();

const $ = id => document.getElementById(id);
const view = $('view');
const ctx = view.getContext('2d');

const state = {
  ready: false, W: 0, H: 0, photo: null, pixels: null, skyline: null,
  skyRGB: [150, 185, 225],
  summit: { x: 0, y: 0 }, base: { x: 0, y: 0 }, everestX: 0,
  name: 'Mount Rainier', summitM: 4392, baseM: 0, unit: 'm',
  occlude: true, fit: true, showMask: false, threshold: 38, haze: 0.3, opacity: 1,
  extra: 0, drag: null, frozenExtra: null,
};

/* ---------------- utilities ---------------- */
function mulberry32(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function buildProfile() {
  const rnd = mulberry32(EVEREST_M);
  const pts = [];
  for (let i = 0; i < BASE_PROFILE.length - 1; i++) {
    const [x0, e0] = BASE_PROFILE[i], [x1, e1] = BASE_PROFILE[i + 1];
    const n = 8;
    for (let k = 0; k < n; k++) {
      const t = k / n;
      let e = e0 + (e1 - e0) * t;
      if (k > 0) e += (rnd() - 0.5) * Math.abs(x1 - x0) * 0.06;
      pts.push([x0 + (x1 - x0) * t, Math.min(e, EVEREST_M - 5 * (k > 0))]);
    }
  }
  pts.push(BASE_PROFILE[BASE_PROFILE.length - 1]);
  return pts;
}
const offscreen = {};
function canvasFor(key, w, h) {
  let c = offscreen[key];
  if (!c) c = offscreen[key] = document.createElement('canvas');
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}
const toUnit = m => state.unit === 'ft' ? m * M_TO_FT : m;
const fromUnit = v => state.unit === 'ft' ? v / M_TO_FT : v;
const fmt = m => `${Math.round(toUnit(m)).toLocaleString()} ${state.unit}`;
const rgba = ([r, g, b], a) => `rgba(${r|0},${g|0},${b|0},${a})`;

/* ---------------- image loading ---------------- */
async function loadFile(file) {
  if (!file) return;
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    src = await new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej;
      i.src = URL.createObjectURL(file);
    });
  }
  setImage(src);
}

function setImage(src) {
  const sw = src.width, sh = src.height;
  const s = Math.min(1, MAX_DIM / Math.max(sw, sh));
  const W = Math.max(1, Math.round(sw * s)), H = Math.max(1, Math.round(sh * s));
  const photo = canvasFor('photo', W, H);
  const pc = photo.getContext('2d', { willReadFrequently: true });
  pc.drawImage(src, 0, 0, W, H);
  Object.assign(state, { W, H, photo, pixels: pc.getImageData(0, 0, W, H).data, ready: true });
  computeSkyline();
  autoPlaceMarkers();
  $('start').hidden = true;
  $('editor').hidden = false;
  $('newPhoto').hidden = false;
  render();
}

/* ---------------- sky detection ---------------- */
// For each column, walk down from the top while pixels stay close to an
// adaptive sky colour; the first sustained break is the skyline.
function computeSkyline() {
  const { W, H, pixels: d } = state;
  const t2 = state.threshold ** 2;
  const raw = new Int32Array(W);
  let ar = 0, ag = 0, ab = 0;
  const seedRows = Math.min(3, H);
  for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0;
    for (let y = 0; y < seedRows; y++) { const j = (y * W + x) * 4; r += d[j]; g += d[j+1]; b += d[j+2]; }
    r /= seedRows; g /= seedRows; b /= seedRows;
    ar += r; ag += g; ab += b;
    let miss = 0, y = 0;
    for (; y < H; y++) {
      const j = (y * W + x) * 4;
      const dr = d[j] - r, dg = d[j+1] - g, db = d[j+2] - b;
      // local edge: compare with the pixel two rows up (catches pale slopes vs pale sky)
      let edge = false;
      if (y >= 2) {
        const k = j - 8 * W;
        const er = d[j] - d[k], eg = d[j+1] - d[k+1], eb = d[j+2] - d[k+2];
        edge = er*er + eg*eg + eb*eb > t2 * 0.35;
      }
      if (!edge && dr*dr + dg*dg + db*db < t2) {
        r += dr * 0.06; g += dg * 0.06; b += db * 0.06; miss = 0;
      } else if (edge || ++miss >= 4) { if (edge) miss = 1; break; }
    }
    raw[x] = y < H ? y - miss + 1 : H - miss;
  }
  state.skyRGB = [ar / W, ag / W, ab / W];
  // median filter to remove single-column spikes
  const out = new Int32Array(W), win = Math.max(4, Math.round(W / 150)), buf = [];
  for (let x = 0; x < W; x++) {
    buf.length = 0;
    for (let k = Math.max(0, x - win); k <= Math.min(W - 1, x + win); k++) buf.push(raw[k]);
    buf.sort((a, b) => a - b);
    out[x] = buf[buf.length >> 1];
  }
  state.skyline = out;
}

function autoPlaceMarkers() {
  const { W, H, skyline } = state;
  const margin = Math.floor(W * 0.04);
  let bx = Math.floor(W / 2), by = H;
  for (let x = margin; x < W - margin; x++) if (skyline[x] < by) { by = skyline[x]; bx = x; }
  if (by >= H - 2) by = Math.round(H * 0.3);
  state.summit = { x: bx, y: by };
  state.base = { x: bx, y: Math.min(H - 1, Math.round(by + (H - by) * 0.65)) };
  state.everestX = bx;
}

/* ---------------- rendering ---------------- */
function geometry() {
  const span = state.summitM - state.baseM;
  const px = state.base.y - state.summit.y;
  const ppm = px / span; // pixels per metre at the mountain's distance
  const valid = span > 0 && px > 2 && isFinite(ppm);
  return { ppm, valid };
}

function computeExtra(ppm, valid) {
  if (!valid || !state.fit) return 0;
  const topImg = state.base.y - (EVEREST_M - state.baseM) * ppm;
  const need = Math.ceil(-topImg + state.H * 0.08);
  const cap = Math.floor(MAX_PIXELS / state.W) - state.H;
  return Math.max(0, Math.min(need, cap));
}

function render(opts = {}) {
  if (!state.ready) return;
  const { W, H } = state;
  const { ppm, valid } = geometry();
  const extra = state.frozenExtra ?? computeExtra(ppm, valid);
  state.extra = extra;
  const CH = H + extra;
  if (view.width !== W || view.height !== CH) { view.width = W; view.height = CH; }

  // sky extension + photo
  if (extra > 0) {
    const g = ctx.createLinearGradient(0, 0, 0, extra);
    const s = state.skyRGB;
    g.addColorStop(0, rgba(s.map(v => v * 0.72), 1));
    g.addColorStop(1, rgba(s, 1));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, extra + 1);
  }
  ctx.drawImage(state.photo, 0, extra);

  if (valid) {
    const layer = canvasFor('everest', W, CH);
    const lc = layer.getContext('2d');
    lc.clearRect(0, 0, W, CH);
    drawEverest(lc, ppm, extra, CH);
    if (state.occlude) {
      lc.globalCompositeOperation = 'destination-in';
      lc.drawImage(skyMask(W, CH, extra), 0, 0);
      lc.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = state.opacity;
    ctx.drawImage(layer, 0, 0);
    ctx.globalAlpha = 1;
  }

  if (state.showMask && !opts.clean) {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.drawImage(tinted(skyMask(W, CH, extra)), 0, 0);
    ctx.restore();
  }

  drawGuides(ppm, valid, extra, opts.clean);
  if (opts.clean) drawWatermark();
  updateStat(ppm, valid);
}

function drawEverest(c, ppm, extra, CH) {
  const baseLineY = extra + state.base.y;
  const toY = e => baseLineY - (e - state.baseM) * ppm;
  const toX = m => state.everestX + m * ppm;
  const topY = toY(EVEREST_M);
  const bottom = CH + 10;
  const first = PROFILE[0], last = PROFILE[PROFILE.length - 1];

  const outline = () => {
    c.beginPath();
    PROFILE.forEach(([m, e], i) => i ? c.lineTo(toX(m), toY(e)) : c.moveTo(toX(m), toY(e)));
    c.lineTo(toX(last[0]) + Math.max(0, bottom - toY(last[1])) * 1.4, bottom);
    c.lineTo(toX(first[0]) - Math.max(0, bottom - toY(first[1])) * 1.4, bottom);
    c.closePath();
  };

  // snow-to-rock gradient
  const g = c.createLinearGradient(0, topY, 0, toY(4200));
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.3, '#e3eaf2');
  g.addColorStop(0.65, '#9aabbd');
  g.addColorStop(1, '#5f6e7e');
  outline();
  c.fillStyle = g;
  c.fill();

  // shaded west face (light from the right)
  c.save();
  outline(); c.clip();
  c.beginPath();
  c.moveTo(toX(0), topY);
  for (let i = PROFILE.length - 1; i >= 0; i--) if (PROFILE[i][0] < 0) c.lineTo(toX(PROFILE[i][0]), toY(PROFILE[i][1]));
  c.lineTo(toX(first[0]) - CH * 2, bottom);
  c.lineTo(toX(1400), bottom);
  c.quadraticCurveTo(toX(600), toY(6800), toX(0), topY);
  c.fillStyle = 'rgba(35,55,85,0.30)';
  c.fill();
  // a few snow gullies
  c.strokeStyle = 'rgba(255,255,255,0.28)';
  c.lineWidth = Math.max(1, ppm * 60);
  for (const [m0, e0, m1, e1] of [[-1200,8500,-1700,6900],[-2600,7950,-2900,6600],[1300,8540,1800,7000],[2700,8370,3100,6900],[-300,8780,-200,7300]]) {
    c.beginPath(); c.moveTo(toX(m0), toY(e0)); c.lineTo(toX(m1), toY(e1)); c.stroke();
  }
  c.restore();

  // atmospheric haze, thicker lower down
  if (state.haze > 0) {
    c.globalCompositeOperation = 'source-atop';
    const h = c.createLinearGradient(0, topY, 0, baseLineY);
    h.addColorStop(0, rgba(state.skyRGB, state.haze * 0.55));
    h.addColorStop(1, rgba(state.skyRGB, Math.min(1, state.haze * 1.3)));
    c.fillStyle = h;
    c.fillRect(0, 0, c.canvas.width, c.canvas.height);
    c.globalCompositeOperation = 'source-over';
  }

  // crisp sunlit rim
  outline();
  c.strokeStyle = 'rgba(255,255,255,0.55)';
  c.lineWidth = Math.max(1, state.W / 900);
  c.stroke();
}

function skyMask(w, h, extra) {
  const m = canvasFor('mask', w, h);
  const c = m.getContext('2d');
  c.clearRect(0, 0, w, h);
  c.filter = `blur(${Math.max(0.6, state.W / 1200)}px)`;
  c.fillStyle = '#fff';
  c.beginPath();
  c.moveTo(0, 0); c.lineTo(w, 0);
  const s = state.skyline;
  for (let x = w - 1; x >= 0; x--) c.lineTo(x + 0.5, extra + s[x]);
  c.closePath();
  c.fill();
  c.filter = 'none';
  return m;
}

function tinted(mask) {
  const t = canvasFor('tint', mask.width, mask.height);
  const c = t.getContext('2d');
  c.clearRect(0, 0, t.width, t.height);
  c.drawImage(mask, 0, 0);
  c.globalCompositeOperation = 'source-in';
  c.fillStyle = '#00e5ff';
  c.fillRect(0, 0, t.width, t.height);
  c.globalCompositeOperation = 'source-over';
  return t;
}

function fontPx() { return Math.max(12, Math.round(state.W / 42)); }

function label(text, x, y, color, align = 'left') {
  const fs = fontPx();
  ctx.font = `600 ${fs}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'bottom';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(3, fs / 4);
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function hline(y, color) {
  ctx.save();
  ctx.setLineDash([state.W / 80, state.W / 120]);
  ctx.lineWidth = Math.max(1, state.W / 700);
  ctx.strokeStyle = color;
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(state.W, y); ctx.stroke();
  ctx.restore();
}

function drawGuides(ppm, valid, extra, clean) {
  const pad = fontPx() * 0.6;
  const sy = extra + state.summit.y, by = extra + state.base.y;
  if (valid) {
    const ey = extra + state.base.y - (EVEREST_M - state.baseM) * ppm;
    if (ey >= 0) {
      hline(ey, 'rgba(255,255,255,0.85)');
      label(`Mt. Everest · ${fmt(EVEREST_M)}`, pad, ey - 4, '#fff');
    } else {
      label(`▲ Everest's summit is above the frame`, pad, fontPx() * 1.4, '#fff');
    }
  }
  hline(sy, 'rgba(255,200,61,0.9)');
  label(`${state.name} · ${fmt(state.summitM)}`, state.W - pad, sy - 4, '#ffc83d', 'right');
  hline(by, 'rgba(47,214,163,0.9)');
  label(`base · ${fmt(state.baseM)}`, state.W - pad, by - 4, '#2fd6a3', 'right');

  if (!clean) {
    handle(extra + state.summit.y, state.summit.x, '#ffc83d');
    handle(extra + state.base.y, state.base.x, '#2fd6a3');
  }
}

function handle(y, x, color) {
  const r = handleRadius();
  ctx.save();
  ctx.lineWidth = Math.max(2, r / 5);
  ctx.strokeStyle = '#000';
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - r * 0.55, y); ctx.lineTo(x + r * 0.55, y);
  ctx.moveTo(x, y - r * 0.55); ctx.lineTo(x, y + r * 0.55);
  ctx.stroke();
  ctx.restore();
}

function drawWatermark() {
  const fs = Math.round(fontPx() * 0.7);
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillText('▲ Everest Scale', state.W - fs, view.height - fs * 0.6);
}

function updateStat(ppm, valid) {
  const el = $('stat');
  if (!valid) {
    el.innerHTML = state.summitM <= state.baseM
      ? 'The summit elevation must be higher than the base elevation.'
      : 'Drag the <b class="c-summit">summit</b> marker above the <b class="c-base">base</b> marker.';
    return;
  }
  const ratio = (EVEREST_M - state.baseM) / (state.summitM - state.baseM);
  const diff = EVEREST_M - state.summitM;
  el.innerHTML = `<span class="big">${ratio.toFixed(ratio < 10 ? 1 : 0)}× taller</span>
    From this base, Everest would rise <b>${ratio.toFixed(1)}×</b> as high as ${escapeHtml(state.name)}
    — its summit is <b>${fmt(Math.abs(diff))}</b> ${diff >= 0 ? 'higher' : 'lower'}.`;
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

let raf = 0;
function scheduleRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

/* ---------------- interaction ---------------- */
function handleRadius() {
  const rect = view.getBoundingClientRect();
  const k = rect.width ? view.width / rect.width : 1;
  return 15 * k;
}
function toCanvas(e) {
  const rect = view.getBoundingClientRect();
  const k = view.width / rect.width;
  return { x: (e.clientX - rect.left) * k, y: (e.clientY - rect.top) * k };
}

view.addEventListener('pointerdown', e => {
  if (!state.ready) return;
  const p = toCanvas(e);
  const ex = state.extra;
  const near = (m) => Math.hypot(p.x - m.x, p.y - (m.y + ex)) < handleRadius() * 2;
  // prefer whichever handle is closest when they overlap
  const ds = Math.hypot(p.x - state.summit.x, p.y - (state.summit.y + ex));
  const db = Math.hypot(p.x - state.base.x, p.y - (state.base.y + ex));
  if (near(state.summit) && ds <= db) state.drag = { kind: 'summit' };
  else if (near(state.base)) state.drag = { kind: 'base' };
  else state.drag = { kind: 'everest', startX: p.x, startEv: state.everestX };
  state.frozenExtra = state.extra; // keep the canvas stable while dragging
  view.setPointerCapture(e.pointerId);
  view.style.cursor = 'grabbing';
});
view.addEventListener('pointermove', e => {
  const d = state.drag;
  if (!d) return;
  const p = toCanvas(e);
  const x = Math.max(0, Math.min(state.W - 1, p.x));
  const y = Math.max(0, Math.min(state.H - 1, p.y - state.extra));
  if (d.kind === 'everest') state.everestX = d.startEv + (p.x - d.startX);
  else state[d.kind] = { x, y };
  scheduleRender();
});
const endDrag = () => {
  if (!state.drag) return;
  state.drag = null; state.frozenExtra = null;
  view.style.cursor = 'grab';
  render();
};
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);

/* ---------------- controls ---------------- */
function syncInputs() {
  $('summitIn').value = Math.round(toUnit(state.summitM));
  $('baseIn').value = Math.round(toUnit(state.baseM));
  document.querySelectorAll('.unit').forEach(u => u.textContent = state.unit);
  document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.unit === state.unit));
}

function initPresets() {
  const sel = $('preset');
  sel.innerHTML = PRESETS.map(([n, m], i) => `<option value="${i}">${n}</option>`).join('') +
    '<option value="custom">Custom / other…</option>';
  sel.value = String(PRESETS.findIndex(p => p[0] === state.name));
  sel.addEventListener('change', () => {
    if (sel.value === 'custom') { state.name = 'Your mountain'; }
    else { const [n, m] = PRESETS[+sel.value]; state.name = n; state.summitM = m; }
    syncInputs(); render();
  });
}

$('summitIn').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  if (!isFinite(v)) return;
  state.summitM = fromUnit(v);
  if ($('preset').value !== 'custom' && Math.abs(state.summitM - PRESETS[+$('preset').value]?.[1]) > 1) {
    $('preset').value = 'custom';
    if (!$('nearby').value) state.name = 'Your mountain';
  }
  render();
});
$('baseIn').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  if (isFinite(v)) { state.baseM = fromUnit(v); render(); }
});
document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
  state.unit = b.dataset.unit; syncInputs(); render();
}));
$('occlude').addEventListener('change', e => { state.occlude = e.target.checked; render(); });
$('fit').addEventListener('change', e => { state.fit = e.target.checked; render(); });
$('showMask').addEventListener('change', e => { state.showMask = e.target.checked; render(); });
$('threshold').addEventListener('input', e => { state.threshold = +e.target.value; computeSkyline(); scheduleRender(); });
$('haze').addEventListener('input', e => { state.haze = e.target.value / 100; scheduleRender(); });
$('opacity').addEventListener('input', e => { state.opacity = e.target.value / 100; scheduleRender(); });

$('camInput').addEventListener('change', e => loadFile(e.target.files[0]));
$('fileInput').addEventListener('change', e => loadFile(e.target.files[0]));
$('newPhoto').addEventListener('click', () => {
  $('camInput').value = ''; $('fileInput').value = '';
  $('editor').hidden = true; $('start').hidden = false; $('newPhoto').hidden = true;
  state.ready = false;
});

/* ---------------- location: base elevation + nearby peaks ---------------- */
function haversineKm(a, b, c, d) {
  const R = 6371, rad = Math.PI / 180;
  const x = Math.sin((c - a) * rad / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin((d - b) * rad / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function parseEle(s) {
  let v = parseFloat(String(s).replace(',', '.'));
  if (!isFinite(v)) return NaN;
  if (/ft|'|feet/i.test(s)) v /= M_TO_FT;
  return v;
}

$('locateBtn').addEventListener('click', async () => {
  const btn = $('locateBtn'), status = $('locStatus');
  if (!navigator.geolocation) { status.textContent = 'Location is not available in this browser.'; return; }
  btn.disabled = true;
  status.textContent = 'Getting your location…';
  try {
    const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 20000 }));
    const { latitude: lat, longitude: lon, altitude } = pos.coords;
    let alt = altitude;
    if (alt == null) {
      try {
        const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}`);
        alt = (await r.json()).elevation?.[0];
      } catch { /* ignore */ }
    }
    if (alt != null && isFinite(alt)) { state.baseM = alt; syncInputs(); render(); }
    status.textContent = (alt != null ? `Your elevation: ${fmt(alt)} (used as base). ` : 'Could not determine your elevation. ') + 'Searching for nearby peaks…';

    const q = `[out:json][timeout:25];node["natural"="peak"]["ele"](around:80000,${lat},${lon});out body 400;`;
    const r = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST', body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const data = await r.json();
    const peaks = data.elements
      .map(n => ({ name: n.tags.name || n.tags['name:en'], ele: parseEle(n.tags.ele), km: haversineKm(lat, lon, n.lat, n.lon) }))
      .filter(p => p.name && isFinite(p.ele))
      .sort((a, b) => b.ele - a.ele)
      .slice(0, 30);
    if (!peaks.length) { status.textContent += ' none found within 80 km.'; return; }
    const sel = $('nearby');
    sel.innerHTML = '<option value="">Pick a peak…</option>' + peaks.map((p, i) =>
      `<option value="${i}">${escapeHtml(p.name)} — ${fmt(p.ele)} · ${p.km.toFixed(0)} km</option>`).join('');
    sel.onchange = () => {
      const p = peaks[+sel.value]; if (!p) return;
      state.name = p.name; state.summitM = p.ele; $('preset').value = 'custom';
      syncInputs(); render();
    };
    $('nearbyRow').hidden = false;
    status.textContent = (alt != null ? `Your elevation: ${fmt(alt)} (used as base). ` : '') + `Found ${peaks.length} peaks nearby (highest first).`;
  } catch (err) {
    status.textContent = 'Location failed: ' + (err.message || err);
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- save / share ---------------- */
$('saveBtn').addEventListener('click', () => {
  render({ clean: true });
  view.toBlob(async blob => {
    render();
    if (!blob) return;
    const file = new File([blob], 'everest-scale.jpg', { type: 'image/jpeg' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Everest Scale', text: `${state.name} vs. Mt. Everest` });
        return;
      }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'everest-scale.jpg';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, 'image/jpeg', 0.92);
});

/* ---------------- sample scene ---------------- */
$('sampleBtn').addEventListener('click', () => {
  const W = 1400, H = 1000;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, H * 0.7);
  sky.addColorStop(0, '#5f97d6'); sky.addColorStop(1, '#c4dcef');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  const rnd = mulberry32(42);
  const ridge = (peakX, peakY, spread, baseY, color, rough) => {
    g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 6) {
      const t = Math.abs(x - peakX) / spread;
      const y = peakY + (baseY - peakY) * Math.min(1, Math.pow(t, 0.9)) + (rnd() - 0.5) * rough;
      g.lineTo(x, y);
    }
    g.lineTo(W, H); g.closePath(); g.fillStyle = color; g.fill();
  };
  // snowy volcano on its own layer so the rock shading doesn't touch the sky
  const v = document.createElement('canvas'); v.width = W; v.height = H;
  const vg = v.getContext('2d');
  const main = g;
  { const g = vg; // reuse ridge() drawing on the volcano layer
    g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 6) {
      const t = Math.abs(x - 720) / 560;
      g.lineTo(x, 430 + 330 * Math.min(1, Math.pow(t, 0.9)) + (rnd() - 0.5) * 10);
    }
    g.lineTo(W, H); g.closePath(); g.fillStyle = '#eef2f7'; g.fill();
    g.globalCompositeOperation = 'source-atop';
    const rock = g.createLinearGradient(0, 430, 0, 780);
    rock.addColorStop(0, 'rgba(93,107,120,0)'); rock.addColorStop(0.4, 'rgba(93,107,120,0)');
    rock.addColorStop(0.6, 'rgba(93,107,120,0.85)'); rock.addColorStop(1, '#5d6b78');
    g.fillStyle = rock; g.fillRect(0, 0, W, H);
  }
  main.drawImage(v, 0, 0);
  ridge(250, 700, 700, 830, '#4b6a52', 14);       // foothills
  ridge(1150, 760, 600, 860, '#3b5a45', 12);
  g.fillStyle = '#2e4433'; g.fillRect(0, 880, W, H - 880);
  state.name = 'Mount Rainier'; state.summitM = 4392; state.baseM = 120;
  $('preset').value = String(PRESETS.findIndex(p => p[0] === 'Mount Rainier'));
  syncInputs();
  setImage(c);
  state.base = { x: 720, y: 880 };
  render();
});

initPresets();
syncInputs();
})();
