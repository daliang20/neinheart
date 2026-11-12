// Runs one CUI app module full-window: creates the wasm instance, feeds it
// mouse, keyboard and clipboard input, and draws each frame with WebGL2 (the
// port of CUI's OpenGL renderer in gl.js) or, when that is unavailable, with
// CUI's software renderer through a 2D canvas. Add ?software to the URL to
// force the software path.
//
// runtime.js and gl.js are CUI's own files (third_party/CUI/web/site/js, MIT).

import { loadModule } from './runtime.js?v=6fc7381763';
import { GLRenderer } from './gl.js?v=6fc7381763';

// cui_key values (third_party/CUI/include/cui/cui.h)
const MODKEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);
const KEYS = { Tab: 1, Enter: 2, NumpadEnter: 2, Escape: 3, Backspace: 4, Delete: 5, Space: 6,
  ArrowLeft: 7, ArrowRight: 8, ArrowUp: 9, ArrowDown: 10, Home: 11, End: 12, PageUp: 13, PageDown: 14,
  Minus: 51, Equal: 52, Comma: 53, Period: 54, Slash: 55 };
for (let i = 0; i < 26; i++) KEYS['Key' + String.fromCharCode(65 + i)] = 15 + i;
for (let i = 0; i < 10; i++) { KEYS['Digit' + i] = 41 + i; KEYS['Numpad' + i] = 41 + i; }
for (let i = 1; i <= 12; i++) KEYS['F' + i] = 55 + i;
const CURSORS = ['default', 'pointer', 'text', 'ew-resize', 'ns-resize', 'move', 'not-allowed'];
// browser shortcuts that keep working while the app has focus
const PASS = new Set(['F5', 'F11', 'F12']);
const PASS_CTRL = new Set(['KeyR', 'KeyT', 'KeyW', 'KeyL', 'Tab', 'PageUp', 'PageDown']);

// Pictures over the canvas (src/web_media.h): one <img> per slot, placed during a frame and hidden after
// any frame that did not place it. They let pointer events through to the canvas underneath.
function mediaLayer(canvas) {
  const slots = new Map();   // slot -> { box, img, url, seen }
  const layer = document.createElement('div');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden;';
  canvas.after(layer);
  return {
    place(slot, url, x, y, w, h, cx, cy, cw, ch, radius, opacity) {
      let m = slots.get(slot);
      if (!m) {
        // the box sits at the rect and clips to what is visible; the picture keeps its shape inside it
        const box = document.createElement('div');
        box.style.cssText = 'position:absolute;left:0;top:0;display:flex;align-items:center;justify-content:center;' +
          'transition:opacity .25s ease-out;opacity:0;';
        const img = document.createElement('img');
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        img.alt = '';
        img.style.cssText = 'max-width:100%;max-height:100%;display:block;';
        img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
        box.appendChild(img);
        layer.appendChild(box);
        m = { box, img, url: '' };
        slots.set(slot, m);
      }
      if (m.url !== url) {
        // a new picture starts hidden: no fade, so the old one never shows over a roll and the new one
        // never shows before it is meant to
        m.box.style.transition = 'none';
        m.box.style.opacity = '0';
        void m.box.offsetWidth;
        m.box.style.transition = 'opacity .25s ease-out';
        m.url = url; m.img.style.visibility = ''; m.img.src = url;
      }
      const r = canvas.getBoundingClientRect(), k = r.width / Math.max(1, canvas.clientWidth || r.width);
      const st = m.box.style;
      st.left = (r.left + x * k) + 'px'; st.top = (r.top + y * k) + 'px';
      st.width = (w * k) + 'px'; st.height = (h * k) + 'px';
      m.img.style.borderRadius = (radius * k) + 'px';
      // only the visible part (the rect can be scrolled partly out of view)
      const t = Math.max(0, cy - y), l = Math.max(0, cx - x);
      const b = Math.max(0, (y + h) - (cy + ch)), rt = Math.max(0, (x + w) - (cx + cw));
      st.clipPath = t + b >= h || l + rt >= w ? 'inset(50%)' : `inset(${t * k}px ${rt * k}px ${b * k}px ${l * k}px)`;
      // fade in, but hide at once: nothing from the last roll lingers over the next one
      st.transition = opacity > 0 ? 'opacity .25s ease-out' : 'none';
      st.opacity = String(opacity);
      st.display = 'flex';
      m.seen = true;
    },
    begin() { for (const m of slots.values()) m.seen = false; },
    end() { for (const m of slots.values()) if (!m.seen) m.box.style.display = 'none'; },
  };
}

// The channel roll's GIFs. The deploy resolves web/gifs.txt into gifs.json; a local build has only
// gifs.txt, so its direct picture links are used as they are (Tenor ones in the small size).
let gifList = [];
async function loadGifs() {
  const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(r.status); return r; };
  try { gifList = await (await get(new URL('gifs.json?v=6fc7381763', siteBase))).json(); return; } catch (e) { /* not deployed: try the list */ }
  try {
    const text = await (await get(new URL('gifs.txt', siteBase))).text();
    gifList = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
      const m = l.match(/^https?:\/\/(?:media\d*|c)\.tenor\.com\/(?:m\/)?([\w-]{11})[\w-]{5}(?:\/|$)/);
      return m ? `https://media.tenor.com/${m[1]}AAAAM/tenor.gif` : /^https:\/\/.*\.(gif|webp|png|jpe?g)(\?.*)?$/i.test(l) ? l : null;
    }).filter(Boolean);
  } catch (e) { /* no GIFs */ }
}

// The equipment reader's screen share (src/pages/equip-reader/capture.h). The shared video plays in a
// <video> that is never added to the page; a grab draws its current frame on a canvas and copies the
// pixels out. state: 0 off, 1 asking, 2 live, 3 refused or failed. Browsers only ask from a click; the
// app calls start in the frame after the click, which is still within the click's user activation.
function screenShare() {
  let state = 0, stream = null, video = null, ctx = null;
  const stop = () => {
    if (stream) for (const t of stream.getTracks()) t.stop();
    stream = null; video = null; state = 0;
  };
  return {
    state: () => state,
    start() {
      if (state === 1 || state === 2) return;
      state = 1;
      navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'never' }, audio: false }).then((s) => {
        stream = s;
        video = document.createElement('video');
        video.muted = true; video.playsInline = true; video.srcObject = s;
        video.play().catch(() => {});
        // the browser's own "Stop sharing" button, or the shared window closing
        s.getVideoTracks()[0].addEventListener('ended', stop);
        state = 2;
      }, () => { state = 3; });
    },
    stop,
    width: () => (state === 2 && video ? video.videoWidth : 0),
    height: () => (state === 2 && video ? video.videoHeight : 0),
    grab(out, w, h) {
      if (state !== 2 || !video || video.videoWidth !== w || video.videoHeight !== h) return false;
      if (!ctx) ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      if (ctx.canvas.width !== w || ctx.canvas.height !== h) { ctx.canvas.width = w; ctx.canvas.height = h; }
      ctx.drawImage(video, 0, 0, w, h);
      out.set(ctx.getImageData(0, 0, w, h).data);
      return true;
    },
  };
}

// One address per page: <site>/phantom-forest/ and so on, where <site> is the folder above js/ (the
// site can live under a path, like GitHub Pages' /<repo>/). The deploy gives each page a folder with a
// copy of index.html, so an address opened directly loads the app too.
const siteBase = new URL('..', import.meta.url);
function routeName() {
  const path = decodeURIComponent(location.pathname);
  const base = decodeURIComponent(siteBase.pathname);
  if (!path.startsWith(base)) return '';
  return path.slice(base.length).replace(/(^|\/)index\.html$/, '').replace(/^\/+|\/+$/g, '');
}

export async function mount(canvas, wasmUrl, opts = {}) {
  const media = mediaLayer(canvas);
  loadGifs(); // needed only by the time someone rolls
  let routeSerial = 1, onRoute = () => {};
  window.addEventListener('popstate', () => { routeSerial++; onRoute(); });
  const mod = await loadModule(wasmUrl, {
    routeSerial: () => routeSerial,
    routeGet: routeName,
    routeSet: (name, title, replace) => {
      document.title = title;
      if (name === routeName()) return;
      const url = new URL(name ? encodeURI(name) + '/' : '', siteBase);
      url.search = location.search;
      history[replace ? 'replaceState' : 'pushState'](null, '', url);
    },
    mediaPlace: (...a) => media.place(...a),
    gifs: () => gifList,
    share: navigator.mediaDevices?.getDisplayMedia ? screenShare() : null,
    touchOnly: () => matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches,
    clipboardSet: (t) => navigator.clipboard?.writeText(t).catch(() => {}),
    // settings survive a reload; storage can be missing or throw (private mode, blocked site data)
    storageGet: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    storageSet: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* not saved this time */ } },
  });
  const x = mod.exports;
  const content = mod.contents[0];
  if (!content) throw new Error('the module has no app (its main must call cui_app_run)');
  if (content.name) document.title = content.name;

  // renderer
  const params = new URLSearchParams(location.search);
  let gl = null, ctx2d = null;
  if (opts.renderer !== 'software' && !params.has('software')) {
    try { gl = new GLRenderer(canvas); } catch (e) { console.warn('[host] WebGL2 unavailable, using the software renderer:', e.message); }
  }
  if (!gl) ctx2d = canvas.getContext('2d', { alpha: false });
  const owner = gl ? 1 : 0;
  if (gl) mod.registerOwner(owner, gl);

  // theme: the app's own choice, else the system setting
  const prefersDark = matchMedia('(prefers-color-scheme: dark)');
  const dark = content.theme >= 0 ? content.theme : (prefersDark.matches ? 1 : 0);
  const accent = content.accent >= 0 ? content.accent : 0;

  const ratio = () => Math.min(window.devicePixelRatio || 1, 3);
  const logical = () => {
    const r = canvas.getBoundingClientRect();
    return [Math.max(320, Math.round(r.width)), Math.max(240, Math.round(r.height))];
  };
  let [w, h] = logical();
  let scale = ratio();
  const inst = x.inst_new(content.index, w, h, scale, dark, accent, owner);
  if (content.theme < 0) prefersDark.addEventListener('change', (e) => { x.inst_set_theme(inst, e.matches ? 1 : 0); poke(); });
  x.inst_set_reduced_motion(inst, matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 0);

  function sizeCanvas() {
    const W = Math.round(w * scale), H = Math.round(h * scale);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  }
  function resize() {
    [w, h] = logical();
    scale = ratio();
    x.inst_resize(inst, w, h, scale);
    sizeCanvas();
    poke();
  }
  sizeCanvas();

  // ---- frame loop: runs only while something changes, plus timed wakeups ----
  let fling = null;   // a flick's glide after the finger lifts: { vx, vy (px/ms), mx, my, t }
  let dirty = true, animating = false, wakeAt = 0, last = 0, raf = 0, buttons = 0;
  // A finger lifting fires pointerup then pointerleave before the next frame. Leaving at once would
  // move the mouse off the control before CUI sees the release, so a tap would never click; the
  // leave waits until a frame has run.
  let leavePending = false;
  let flingStep = null;   // set by the touch code: advances a flick's glide by one frame
  const schedule = () => { if (!raf) raf = requestAnimationFrame(step); };
  const poke = () => { dirty = true; schedule(); };
  onRoute = poke;
  function paint() {
    if (gl) { gl.draw(mod, inst); return; }
    const px = mod.pixels(inst);
    if (canvas.width !== px.w || canvas.height !== px.h) { canvas.width = px.w; canvas.height = px.h; }
    ctx2d.putImageData(new ImageData(px.data, px.w, px.h), 0, 0);
  }
  function step(now) {
    raf = 0;
    if (document.hidden) { dirty = true; return; }
    const wake = wakeAt && now >= wakeAt;
    if (!dirty && !animating && !wake) return;
    const dt = last ? Math.min((now - last) / 1000, 0.25) : 1 / 60;
    last = now;
    dirty = false;
    if (fling) flingStep(now);
    media.begin();
    x.inst_frame(inst, dt, gl ? 0 : 1);
    media.end();
    if (leavePending) { leavePending = false; x.inst_mouse_leave(inst); poke(); }   // repaint without the hover
    paint();
    animating = !!x.inst_needs_redraw(inst);
    const next = x.inst_next_wakeup(inst);
    wakeAt = next >= 0 ? now + next * 1000 : 0;
    const cur = CURSORS[x.inst_cursor(inst)] || 'default';
    if (canvas.style.cursor !== cur) canvas.style.cursor = cur;
    if (animating) schedule(); else last = 0;
  }
  setInterval(() => { if (wakeAt && performance.now() >= wakeAt) schedule(); }, 50);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poke(); });
  new ResizeObserver(resize).observe(canvas);
  window.addEventListener('resize', resize);

  // ---- input (the same mapping CUI's own site uses) ----
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (w / r.width), (e.clientY - r.top) * (h / r.height)];
  };
  const on = (t, f, o) => canvas.addEventListener(t, f, o);
  let released = false;
  const takeOver = () => { if (!released) { released = true; if (x.inst_release_scripted(inst)) poke(); } };
  for (const t of ['pointerenter', 'pointerdown', 'wheel', 'keydown']) on(t, takeOver, { capture: true });

  // touch: a vertical swipe scrolls, a sideways one drags. The content follows the finger 1:1 (CUI eases
  // wheel scrolling, so motion is off while a finger scrolls) and keeps going after a flick, like a
  // native page; a touch during the glide stops it without pressing what is under the finger.
  let touch = null;
  const reducedMotion = () => (matchMedia('(prefers-reduced-motion: reduce)').matches || (x.ms_reduced_motion && x.ms_reduced_motion())) ? 1 : 0;
  const linesPerPx = () => h / canvas.getBoundingClientRect().height / 44;   // pixels to wheel lines
  const cancelPress = () => {
    x.inst_mouse_move(inst, -10000, -10000);
    for (let b = 0; b < 3; b++) if (buttons & (1 << b)) x.inst_mouse_button(inst, b, 0);
    buttons = 0;
    x.inst_frame(inst, 0, 0);
  };
  const endScroll = () => { x.inst_set_reduced_motion(inst, reducedMotion()); };
  const stopFling = () => { if (fling) { fling = null; x.inst_mouse_leave(inst); poke(); } };
  flingStep = (now) => {
    const dt = Math.min(now - fling.t, 50);
    fling.t = now;
    const decay = Math.exp(-dt / 325);   // iOS-like deceleration
    fling.vx *= decay; fling.vy *= decay;
    if (Math.hypot(fling.vx, fling.vy) < 0.03) { stopFling(); return; }
    const k = linesPerPx();
    x.inst_mouse_move(inst, fling.mx, fling.my);
    x.inst_scroll(inst, fling.vx * dt * k, fling.vy * dt * k);
    poke();
  };
  on('pointerdown', (e) => {
    if (e.pointerType !== 'touch') { stopFling(); return; }
    touch = { x: e.clientX, y: e.clientY, mode: '', samples: [] };
    if (fling) {   // catch the glide: this touch only stops it (or starts a new scroll)
      const fast = Math.hypot(fling.vx, fling.vy) > 0.15;
      fling = null;
      if (fast) { touch.mode = 'caught'; e.stopImmediatePropagation(); e.preventDefault(); }
    }
  }, { capture: true });
  on('pointermove', (e) => {
    if (!touch || e.pointerType !== 'touch') return;
    const dx = e.clientX - touch.x, dy = e.clientY - touch.y;
    if ((!touch.mode || touch.mode === 'caught') && Math.hypot(dx, dy) > 8) {
      touch.mode = Math.abs(dy) > Math.abs(dx) ? 'scroll' : 'drag';
      if (touch.mode === 'scroll') { cancelPress(); x.inst_set_reduced_motion(inst, 1); }
    }
    if (touch.mode === 'caught') { e.stopImmediatePropagation(); return; }
    if (touch.mode === 'scroll') {
      const [mx, my] = pos(e);
      x.inst_mouse_move(inst, mx, my);
      const k = linesPerPx();
      x.inst_scroll(inst, (e.clientX - touch.x) * k, (e.clientY - touch.y) * k);
      touch.x = e.clientX; touch.y = e.clientY;
      touch.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
      while (touch.samples.length > 2 && e.timeStamp - touch.samples[0].t > 100) touch.samples.shift();
      poke();
      e.stopImmediatePropagation();
    }
  }, { capture: true });
  on('pointercancel', () => { if (touch) { cancelPress(); if (touch.mode === 'scroll') endScroll(); } touch = null; }, { capture: true });
  on('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    if (touch && touch.mode === 'scroll') {
      endScroll();
      const s = touch.samples, a = s[0], b = s[s.length - 1];
      const span = b && e.timeStamp - a.t;
      if (s.length >= 2 && span > 0 && span < 150 && b.t - a.t > 0) {
        const vx = (b.x - a.x) / (b.t - a.t), vy = (b.y - a.y) / (b.t - a.t);   // px per ms
        if (Math.hypot(vx, vy) > 0.2) {
          const [mx, my] = pos(e);
          fling = { vx, vy, mx, my, t: performance.now() };
        }
      }
      if (!fling) x.inst_mouse_leave(inst);
      e.stopImmediatePropagation();
      poke();
    } else if (touch && touch.mode === 'caught') e.stopImmediatePropagation();
    touch = null;
  }, { capture: true });

  on('pointermove', (e) => {
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const lastEv = events[events.length - 1] || e;
    const [mx, my] = pos(lastEv);
    x.inst_mouse_move(inst, mx, my);
    poke();
  });
  on('pointerdown', (e) => {
    leavePending = false;
    if (e.pointerType === 'mouse' && e.button > 2) return;
    canvas.focus({ preventScroll: true });
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointers have no capture */ }
    const [mx, my] = pos(e);
    x.inst_mouse_move(inst, mx, my);
    const b = e.button === 2 ? 1 : e.button === 1 ? 2 : 0;
    buttons |= 1 << b;
    x.inst_mouse_button(inst, b, 1);
    poke();
    e.preventDefault();
  });
  const up = (e) => {
    const b = e.button === 2 ? 1 : e.button === 1 ? 2 : 0;
    if (!(buttons & (1 << b))) return;
    buttons &= ~(1 << b);
    const [mx, my] = pos(e);
    x.inst_mouse_move(inst, mx, my);
    x.inst_mouse_button(inst, b, 0);
    poke();
  };
  on('pointerup', up);
  on('pointercancel', up);
  on('pointerleave', (e) => {
    if (buttons) return;
    if (e.pointerType === 'touch') leavePending = true; else x.inst_mouse_leave(inst);
    poke();
  });
  on('contextmenu', (e) => e.preventDefault());
  on('wheel', (e) => {
    fling = null;
    const k = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 10 : 1 / 100;
    let dx = -e.deltaX * k, dy = -e.deltaY * k;
    if (e.shiftKey && !e.deltaX) { dx = dy; dy = 0; }
    const [mx, my] = pos(e);
    x.inst_mouse_move(inst, mx, my);
    x.inst_scroll(inst, dx, dy);
    e.preventDefault();
    poke();
  }, { passive: false });
  let pasteMods = 0;
  on('keydown', (e) => {
    if (PASS.has(e.code) || ((e.ctrlKey || e.metaKey) && PASS_CTRL.has(e.code)) || (e.ctrlKey && e.shiftKey && e.code === 'KeyI')) return;
    const mods = (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') { pasteMods = mods; return; }   // the paste event follows
    const key = KEYS[e.code];
    if (key) x.inst_key(inst, key, 1, mods);
    else if (MODKEYS.has(e.key)) x.inst_key(inst, 0, 1, mods);
    if (e.key.length >= 1 && [...e.key].length === 1 && !e.ctrlKey && !e.metaKey) mod.text(inst, e.key);
    if (key || e.key.length === 1) e.preventDefault();
    poke();
  });
  on('keyup', (e) => {
    const key = KEYS[e.code];
    const mods = (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
    if (!key) { if (MODKEYS.has(e.key)) { x.inst_key(inst, 0, 0, mods); poke(); } return; }
    x.inst_key(inst, key, 0, mods);
    poke();
  });
  on('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    mod.setClipboardCache(text);
    x.inst_key(inst, KEYS.KeyV, 1, pasteMods || 2);
    x.inst_key(inst, KEYS.KeyV, 0, pasteMods || 2);
    e.preventDefault();
    poke();
  });
  on('focus', () => { x.inst_focus(inst, 1); poke(); });
  on('blur', () => {
    for (const k of Object.values(KEYS)) x.inst_key(inst, k, 0, 0);   // never leave a key stuck
    x.inst_focus(inst, 0);
    poke();
  });

  canvas.focus({ preventScroll: true });
  x.inst_frame(inst, 0, gl ? 0 : 1);
  paint();
  schedule();
  return { module: mod, instance: inst, renderer: gl ? 'WebGL2' : 'Software' };
}
