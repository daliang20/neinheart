// Loads a CUI wasm module and drives its instances. Works in the browser and
// in Node (for smoke tests). No dependencies.

const enc = new TextEncoder();
const dec = new TextDecoder();

function fmtFloat(v, conv, prec, alt) {
  const upper = conv === 70 || conv === 69 || conv === 71 || conv === 65; // F E G A
  let s;
  if (!Number.isFinite(v)) s = Number.isNaN(v) ? 'nan' : 'inf';
  else {
    const fixed = (x, p) => {
      if (x >= 1e21) {               // toFixed switches to exponent form here
        let int = BigInt(Math.trunc(x)).toString();
        return p > 0 ? int + '.' + '0'.repeat(p) : int;
      }
      return x.toFixed(Math.min(p, 100));
    };
    const expo = (x, p) => {
      let t = x.toExponential(Math.min(p, 100));
      return t.replace(/e([+-])(\d)$/, 'e$10$2');   // C prints at least two exponent digits
    };
    const c = String.fromCharCode(conv).toLowerCase();
    if (c === 'f') s = fixed(v, prec);
    else if (c === 'e') s = expo(v, prec);
    else if (c === 'a') s = v.toString(16);
    else {                            // %g
      const P = prec === 0 ? 1 : prec;
      const X = v === 0 ? 0 : Number(v.toExponential(P - 1).split('e')[1]);
      if (P > X && X >= -4) s = fixed(v, P - 1 - X);
      else s = expo(v, P - 1);
      if (!alt && s.includes('.')) s = s.replace(/\.?0+(e|$)/, '$1');
    }
    if (alt && prec === 0 && !s.includes('.') && c !== 'g') s = s.replace(/^(\d+)/, '$1.');
  }
  return upper ? s.toUpperCase() : s;
}

const compiled = new Map();
// Compiles a module once per URL; each preview then gets its own instance.
export function compileModule(url) {
  if (!compiled.has(url)) {
    compiled.set(url, (async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      if (WebAssembly.compileStreaming) {
        try { return await WebAssembly.compileStreaming(r.clone()); } catch (e) { /* wrong MIME type: fall back */ }
      }
      return WebAssembly.compile(await r.arrayBuffer());
    })());
  }
  return compiled.get(url);
}

export async function loadModule(source, hooks = {}) {
  let mem, emojiCanvas = null, emojiCtx = null;
  const owners = new Map();
  const u8 = () => new Uint8Array(mem.buffer);
  const str = (p, n) => dec.decode(u8().subarray(p, n === undefined ? u8().indexOf(0, p) : p + n));
  const lines = { 1: '', 2: '' };
  const env = {
    js_write(fd, p, n) {
      lines[fd] += str(p, n);
      let i;
      while ((i = lines[fd].indexOf('\n')) >= 0) {
        const line = lines[fd].slice(0, i);
        lines[fd] = lines[fd].slice(i + 1);
        (fd === 2 ? console.warn : console.log)('[cui]', line);
      }
    },
    js_fmt_float(v, conv, prec, alt, buf, cap) {
      const b = enc.encode(fmtFloat(v, conv, prec, alt));
      const n = Math.min(b.length, cap);
      u8().set(b.subarray(0, n), buf);
      return n;
    },
    js_parse_float: (p, n) => parseFloat(str(p, n)),
    js_date_now: () => Date.now(),
    js_perf_now: () => performance.now(),
    js_tz_offset: (ms) => -new Date(ms).getTimezoneOffset(),
    js_abort(p) { throw new Error('CUI aborted: ' + str(p)); },
    js_tex_create(owner, w, h, fmt, p) {
      return owners.get(owner).createTexture(w, h, fmt, p ? new Uint8Array(mem.buffer, p, w * h * fmt) : null);
    },
    js_tex_update(owner, tex, x0, y0, w, h, p, stride) {
      const r = owners.get(owner), e = r && r.textures.get(tex);
      if (!e) return;
      r.updateTexture(tex, x0, y0, w, h, new Uint8Array(mem.buffer, p, (h - 1) * stride + w * e.fmt), stride);
    },
    js_tex_destroy(owner, tex) { const r = owners.get(owner); if (r) r.destroyTexture(tex); },
    js_draw_emoji(p, n, px, out) {
      // the browser's color emoji, drawn on a canvas and copied back with straight alpha
      if (!emojiCanvas) {
        emojiCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(px, px) : document.createElement('canvas');
        emojiCtx = emojiCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (!emojiCtx) return 0;
      if (emojiCanvas.width < px) { emojiCanvas.width = px; emojiCanvas.height = px; }
      const c = emojiCtx;
      c.clearRect(0, 0, emojiCanvas.width, emojiCanvas.height);
      c.font = `${Math.round(px * 0.84)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = '#000';
      c.fillText(str(p, n), px / 2, px * 0.54);
      const d = c.getImageData(0, 0, px, px).data;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]) { ink = 1; break; }
      if (!ink) return 0;
      u8().set(d, out);
      return 1;
    },
    js_clipboard_set(p, n) {
      const text = str(p, n);
      if (hooks.clipboardSet) hooks.clipboardSet(text);
    },
  };
  for (const f of ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'exp', 'expm1', 'log', 'log10', 'log2', 'log1p', 'cbrt'])
    env['math_' + f] = Math[f];
  env.math_atan2 = Math.atan2;
  env.math_pow = Math.pow;
  env.math_hypot = Math.hypot;
  env.math_fmod = (x, y) => x % y;

  let instance;
  if (source instanceof WebAssembly.Module) instance = await WebAssembly.instantiate(source, { env });
  else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) instance = (await WebAssembly.instantiate(source, { env })).instance;
  else instance = await WebAssembly.instantiate(await compileModule(source), { env });
  const x = instance.exports;
  mem = x.memory;
  if (x.web_boot) x.web_boot();

  const cstr = (s) => {           // caller frees
    const b = enc.encode(s);
    const p = x.web_alloc(b.length + 1);
    u8().set(b, p); u8()[p + b.length] = 0;
    return p;
  };
  const contents = [];
  for (let i = 0; i < x.content_count(); i++)
    contents.push({ index: i, name: str(x.content_name(i)), width: x.content_width(i), height: x.content_height(i),
                    accent: x.content_accent(i), theme: x.content_theme(i) });
  return {
    exports: x,
    contents,
    find: (name) => contents.find((c) => c.name === name),
    memory: () => mem,
    registerOwner(id, renderer) { owners.set(id, renderer); },
    unregisterOwner(id) { owners.delete(id); },
    cstr,
    text(inst, s) { const p = cstr(s); x.inst_text(inst, p); x.web_free(p); },
    setClipboardCache(s) {
      const b = enc.encode(s);
      const p = x.web_clipboard_buffer(b.length);
      u8().set(b, p); u8()[p + b.length] = 0;
    },
    pixels(inst) {
      const p = x.inst_pixels(inst), w = x.inst_pixel_width(inst), h = x.inst_pixel_height(inst);
      return { w, h, data: new Uint8ClampedArray(mem.buffer, p, w * h * 4) };
    },
  };
}
