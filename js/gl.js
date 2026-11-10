// WebGL2 port of src/render/cui_render_gl.c: same shaders, same blending,
// same scissoring. Draws a cui_draw_data straight out of wasm memory.

const VS = `#version 300 es
precision highp float; precision highp int;
in vec2 a_pos; in vec2 a_uv; in vec2 a_local; in vec2 a_half; in vec4 a_radii; in vec2 a_params; in vec4 a_color; in vec4 a_bcolor;
uniform vec2 u_viewport;
out vec2 v_uv; out vec2 v_local; flat out vec2 v_half; flat out vec4 v_radii; flat out vec2 v_params; out vec4 v_color; flat out vec4 v_bcolor;
void main() {
  v_uv = a_uv; v_local = a_local; v_half = a_half; v_radii = a_radii;
  v_params = a_params; v_color = a_color; v_bcolor = a_bcolor;
  gl_Position = vec4(a_pos.x / u_viewport.x * 2.0 - 1.0, 1.0 - a_pos.y / u_viewport.y * 2.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float; precision highp int;
in vec2 v_uv; in vec2 v_local; flat in vec2 v_half; flat in vec4 v_radii; flat in vec2 v_params; in vec4 v_color; flat in vec4 v_bcolor;
uniform sampler2D u_tex;
out vec4 frag;
float sd_rrect(vec2 p, vec2 b, vec4 r) {
  float rr = p.x < 0.0 ? (p.y < 0.0 ? r.x : r.w) : (p.y < 0.0 ? r.y : r.z);
  rr = min(rr, min(b.x, b.y));
  vec2 q = abs(p) - b + rr;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - rr;
}
float erf_(float x) {
  float s = sign(x); x = abs(x);
  float t = 1.0 / (1.0 + 0.3275911 * x);
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
  return s * y;
}
void main() {
  int mode = int(v_params.y + 0.5);
  vec4 c = v_color;
  if (mode == 4) { frag = vec4(c.rgb * c.a, c.a); return; }
  if (mode == 0) { float a = c.a * texture(u_tex, v_uv).r; frag = vec4(c.rgb * a, a); return; }
  float d = sd_rrect(v_local, v_half, v_radii);
  if (mode == 1) {
    float outer = clamp(0.5 - d, 0.0, 1.0);
    float bw = v_params.x;
    float inner = bw > 0.0 ? clamp(0.5 - (d + bw), 0.0, 1.0) : outer;
    float fa = c.a * inner, ba = v_bcolor.a * (outer - inner);
    frag = vec4(c.rgb * fa + v_bcolor.rgb * ba, fa + ba);
  } else if (mode == 2) {
    float s = max(v_params.x, 0.01);
    float a = c.a * 0.5 * (1.0 - erf_(d / (s * 1.41421356)));
    frag = vec4(c.rgb * a, a);
  } else {
    float cov = clamp(0.5 - d, 0.0, 1.0);
    vec4 t = texture(u_tex, v_uv);
    float k = c.a * cov;
    frag = vec4(t.rgb * t.a * c.rgb * k, t.a * k);
  }
}`;

export class GLRenderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false,
                                             premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.textures = new Map();
    this.nextTex = 1;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('CUI shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    ['a_pos', 'a_uv', 'a_local', 'a_half', 'a_radii', 'a_params', 'a_color', 'a_bcolor'].forEach((n, i) => gl.bindAttribLocation(p, i, n));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('CUI program: ' + gl.getProgramInfoLog(p));
    this.program = p;
    this.uViewport = gl.getUniformLocation(p, 'u_viewport');
    this.uTex = gl.getUniformLocation(p, 'u_tex');
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.ebo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ebo);
    const S = 64;   // sizeof(cui_vertex), checked against the module in draw()
    const attr = (i, n, type, norm, off) => { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, type, norm, S, off); };
    attr(0, 2, gl.FLOAT, false, 0);    // x, y
    attr(1, 2, gl.FLOAT, false, 8);    // u, v
    attr(2, 2, gl.FLOAT, false, 16);   // lx, ly
    attr(3, 2, gl.FLOAT, false, 24);   // hw, hh
    attr(4, 4, gl.FLOAT, false, 32);   // radii
    attr(5, 2, gl.FLOAT, false, 48);   // border, mode
    attr(6, 4, gl.UNSIGNED_BYTE, true, 56);   // color
    attr(7, 4, gl.UNSIGNED_BYTE, true, 60);   // border color
    gl.bindVertexArray(null);
  }

  // texture callbacks (called from wasm through runtime.js)
  createTexture(w, h, fmt, px) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    if (fmt === 1) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, px);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const id = this.nextTex++;
    this.textures.set(id, { t, fmt });
    return id;
  }
  updateTexture(id, x, y, w, h, px, stride) {
    const gl = this.gl, e = this.textures.get(id);
    if (!e) return;
    gl.bindTexture(gl.TEXTURE_2D, e.t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride / e.fmt);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, e.fmt === 1 ? gl.RED : gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  }
  destroyTexture(id) {
    const e = this.textures.get(id);
    if (e) { this.gl.deleteTexture(e.t); this.textures.delete(id); }
  }

  // draws the instance's current cui_draw_data
  draw(mod, inst) {
    const x = mod.exports, gl = this.gl, buf = mod.memory().buffer;
    const dd = x.inst_draw_data(inst);
    const W = x.dd_width(dd), H = x.dd_height(dd);
    if (x.web_sizeof_vertex() !== 64) throw new Error('cui_vertex layout changed');
    const cs = x.web_sizeof_cmd(), ot = x.web_offsetof_cmd_texture(), oi = x.web_offsetof_cmd_index();
    gl.viewport(0, 0, W, H);
    const cc = x.dd_clear(dd);
    gl.clearColor((cc & 255) / 255, ((cc >> 8) & 255) / 255, ((cc >> 16) & 255) / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const ic = x.dd_index_count(dd);
    if (!ic) return;
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.SCISSOR_TEST);
    gl.useProgram(this.program);
    gl.uniform2f(this.uViewport, W, H);
    gl.uniform1i(this.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(buf, x.dd_vertices(dd), x.dd_vertex_count(dd) * 64), gl.STREAM_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint8Array(buf, x.dd_indices(dd), ic * 4), gl.STREAM_DRAW);
    const atlas = x.dd_font_atlas(dd);
    const cmds = x.dd_commands(dd), n = x.dd_command_count(dd);
    const f32 = new Float32Array(buf), u32 = new Uint32Array(buf);
    let bound = -1;
    for (let i = 0; i < n; i++) {
      const base = cmds + i * cs;
      const count = u32[(base + oi + 4) >> 2];
      if (!count) continue;
      const cx = f32[base >> 2], cy = f32[(base + 4) >> 2], cw = f32[(base + 8) >> 2], ch = f32[(base + 12) >> 2];
      const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.ceil(cx + cw), y1 = Math.ceil(cy + ch);
      if (x1 <= x0 || y1 <= y0) continue;
      gl.scissor(x0, H - y1, x1 - x0, y1 - y0);
      const tid = u32[(base + ot) >> 2] || atlas;
      if (tid !== bound) { const e = this.textures.get(tid); gl.bindTexture(gl.TEXTURE_2D, e ? e.t : null); bound = tid; }
      gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, u32[(base + oi) >> 2] * 4);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    for (const e of this.textures.values()) gl.deleteTexture(e.t);
    this.textures.clear();
    gl.deleteBuffer(this.vbo); gl.deleteBuffer(this.ebo);
    gl.deleteVertexArray(this.vao); gl.deleteProgram(this.program);
  }
}
