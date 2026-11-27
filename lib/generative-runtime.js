// hyperframes-skill generative runtime (roadmap step 10, docs/design-decisions.md D23). Copied into a
// scene as assets/hfs-generative.js beside three.js. It is the scene's custom frame adapter: every
// program draws a pure function of (seed, params, time), and HyperFrames' `hf-seek` event gives the time
// of the frame being captured. Nothing reads a clock, a random source or the network.
import * as THREE from "./three.module.js";

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const colour = (c) => new THREE.Color().setStyle(c, THREE.LinearSRGBColorSpace);

const FULLSCREEN_VS = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";

const NOISE_FS = `
precision highp float;
varying vec2 vUv;
uniform float uTime; uniform float uScale; uniform float uSpeed; uniform int uOctaves; uniform vec2 uSeed; uniform vec2 uAspect;
uniform vec3 uColors[8]; uniform int uCount;
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y); }
vec3 ramp(float v){ float x = clamp(v, 0.0, 0.9999) * float(uCount - 1); int i = int(floor(x)); float f = fract(x); vec3 a = uColors[0]; vec3 b = uColors[0];
  for (int k = 0; k < 8; k++) { if (k == i) a = uColors[k]; if (k == i + 1) b = uColors[k]; } return mix(a, b, f); }
void main(){ vec2 p = vUv * uAspect * uScale + uSeed; float t = uTime * uSpeed; float v = 0.0; float amp = 0.5; float sum = 0.0;
  for (int o = 0; o < 8; o++) { if (o >= uOctaves) break; v += amp * noise(p + vec2(t, -t * 0.7)); sum += amp; p = p * 2.03 + vec2(1.7, 9.2); amp *= 0.5; }
  gl_FragColor = vec4(ramp(v / sum), 1.0); }`;

const GRADIENT_FS = `
precision highp float;
varying vec2 vUv;
uniform float uTime; uniform float uSpeed; uniform float uSoft; uniform vec2 uAspect;
uniform vec3 uColors[8]; uniform vec4 uPaths[8]; uniform int uCount;
void main(){ vec2 p = vUv * uAspect; vec3 acc = vec3(0.0); float wsum = 0.0; float t = uTime * uSpeed;
  for (int k = 0; k < 8; k++) { if (k >= uCount) break; vec4 q = uPaths[k];
    vec2 c = vec2(0.5 + 0.45 * sin(t * q.x + q.z), 0.5 + 0.45 * cos(t * q.y + q.w)) * uAspect;
    float d = distance(p, c); float w = exp(-d * d / (uSoft * uSoft * 0.25)); acc += uColors[k] * w; wsum += w; }
  gl_FragColor = vec4(acc / max(wsum, 1e-4), 1.0); }`;

function fullscreen(material) {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  return { scene, camera: new THREE.Camera() };
}

const PROGRAMS = {
  particles(cfg) {
    const r = rng(cfg.seed);
    const n = cfg.params.count;
    const base = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        base[i * 3 + k] = r() * 2 - 1;
        vel[i * 3 + k] = (r() * 2 - 1) * 0.25;
      }
      const c = colour(cfg.palette[Math.floor(r() * cfg.palette.length)]);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const pos = new Float32Array(n * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({ size: cfg.params.size, sizeAttenuation: false, vertexColors: true });
    const scene = new THREE.Scene();
    scene.add(new THREE.Points(geo, mat));
    const aspect = cfg.width / cfg.height;
    const camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 10);
    camera.position.z = 2.6;
    const wrap = (v) => ((((v + 1) % 2) + 2) % 2) - 1;
    return {
      scene,
      camera,
      update(t) {
        const s = cfg.params.speed;
        for (let i = 0; i < n; i++) {
          pos[i * 3] = wrap(base[i * 3] + vel[i * 3] * t * s) * aspect * 1.1;
          pos[i * 3 + 1] = wrap(base[i * 3 + 1] + vel[i * 3 + 1] * t * s) * 1.1;
          pos[i * 3 + 2] = wrap(base[i * 3 + 2] + vel[i * 3 + 2] * t * s) * cfg.params.depth;
        }
        geo.attributes.position.needsUpdate = true;
      },
    };
  },
  noise_field(cfg) {
    const r = rng(cfg.seed);
    const colors = Array.from({ length: 8 }, (_, i) => colour(cfg.palette[Math.min(i, cfg.palette.length - 1)]));
    const u = {
      uTime: { value: 0 }, uScale: { value: cfg.params.scale }, uSpeed: { value: cfg.params.speed }, uOctaves: { value: cfg.params.octaves },
      uSeed: { value: new THREE.Vector2(r() * 1000, r() * 1000) }, uAspect: { value: new THREE.Vector2(cfg.width / cfg.height, 1) },
      uColors: { value: colors }, uCount: { value: cfg.palette.length },
    };
    const fs = fullscreen(new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VS, fragmentShader: NOISE_FS, uniforms: u }));
    return { ...fs, update: (t) => (u.uTime.value = t) };
  },
  shader_gradient(cfg) {
    const r = rng(cfg.seed);
    const colors = Array.from({ length: 8 }, (_, i) => colour(cfg.palette[Math.min(i, cfg.palette.length - 1)]));
    const paths = Array.from({ length: 8 }, () => new THREE.Vector4(0.5 + r() * 1.5, 0.5 + r() * 1.5, r() * 6.2832, r() * 6.2832));
    const u = {
      uTime: { value: 0 }, uSpeed: { value: cfg.params.speed }, uSoft: { value: cfg.params.softness }, uAspect: { value: new THREE.Vector2(cfg.width / cfg.height, 1) },
      uColors: { value: colors }, uPaths: { value: paths }, uCount: { value: cfg.palette.length },
    };
    const fs = fullscreen(new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VS, fragmentShader: GRADIENT_FS, uniforms: u }));
    return { ...fs, update: (t) => (u.uTime.value = t) };
  },
  shader(cfg) {
    const u = { u_time: { value: 0 }, u_resolution: { value: new THREE.Vector2(cfg.width, cfg.height) }, u_seed: { value: cfg.seed } };
    const fs = fullscreen(new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VS, fragmentShader: cfg.shader, uniforms: u }));
    return { ...fs, update: (t) => (u.u_time.value = t) };
  },
  type3d(cfg) {
    const O = cfg.outlines;
    const shapes = [];
    for (const g of O.glyphs) shapes.push(...glyphShapes(g));
    const geo = new THREE.ExtrudeGeometry(shapes, { depth: cfg.params.depth, bevelEnabled: false, curveSegments: 8 });
    geo.translate(-O.width / 2, -(O.ascent + O.descent) / 2, -cfg.params.depth / 2);
    const mat = new THREE.MeshStandardMaterial({ color: colour(cfg.palette[0]), roughness: 0.45, metalness: 0.1 });
    const mesh = new THREE.Mesh(geo, mat);
    const scene = new THREE.Scene();
    scene.add(mesh);
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1, 1.5, 2);
    scene.add(key);
    const aspect = cfg.width / cfg.height;
    const camera = new THREE.PerspectiveCamera(35, aspect, 0.1, 100);
    // the text's width fills about 80 % of the frame
    const fit = Math.max(O.width / aspect, O.ascent - O.descent) / 0.8;
    camera.position.z = fit / 2 / Math.tan((35 * Math.PI) / 360) + cfg.params.depth;
    return {
      scene,
      camera,
      update(t) {
        mesh.rotation.y = t * cfg.params.spin * Math.PI * 2;
        mesh.rotation.x = cfg.params.tilt;
      },
    };
  },
};

// Path commands in em units (y up) -> THREE.Shape outlines with their holes, by winding and containment.
function glyphShapes(g) {
  const paths = [];
  let cur = null;
  for (const [c, ...a] of g.cmds) {
    const X = (i) => g.x + a[i];
    const Y = (i) => g.y + a[i];
    if (c === "moveTo") {
      cur = new THREE.Path();
      paths.push(cur);
      cur.moveTo(X(0), Y(1));
    } else if (c === "lineTo") cur.lineTo(X(0), Y(1));
    else if (c === "quadraticCurveTo") cur.quadraticCurveTo(X(0), Y(1), X(2), Y(3));
    else if (c === "bezierCurveTo") cur.bezierCurveTo(X(0), Y(1), X(2), Y(3), X(4), Y(5));
    else if (c === "closePath" && cur) cur.closePath();
  }
  const rings = paths.map((p) => {
    const pts = p.getPoints(8);
    return { p, pts, area: THREE.ShapeUtils.area(pts) };
  }).filter((r) => Math.abs(r.area) > 1e-9);
  if (!rings.length) return [];
  // the outer winding is the largest ring's; the others of the opposite winding are holes of the outline containing them
  const outerSign = Math.sign(rings.reduce((a, b) => (Math.abs(b.area) > Math.abs(a.area) ? b : a)).area);
  const outers = rings.filter((r) => Math.sign(r.area) === outerSign).map((r) => ({ ...r, shape: new THREE.Shape(r.pts) }));
  for (const h of rings.filter((r) => Math.sign(r.area) !== outerSign)) {
    const host = outers.find((o) => inside(h.pts[0], o.pts)) ?? outers[0];
    host.shape.holes.push(new THREE.Path(h.pts));
  }
  return outers.map((o) => o.shape);
}

function inside(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

const layers = [];
let lastTime = 0;

function drawAll(time) {
  lastTime = time;
  for (const L of layers) {
    // the program's own time: the composition's, moved to the layer's start (and its time_start)
    L.prog.update(time + L.cfg.offset);
    L.renderer.render(L.prog.scene, L.prog.camera);
  }
}

function init() {
  for (const el of document.querySelectorAll('script[type="application/json"].hfs-gen')) {
    const cfg = JSON.parse(el.textContent);
    const canvas = document.getElementById(`${cfg.id}-cv`);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, preserveDrawingBuffer: true, powerPreference: "low-power" });
    renderer.setPixelRatio(1);
    renderer.setSize(cfg.width, cfg.height, false);
    renderer.setClearColor(0x000000, 0);
    layers.push({ cfg, renderer, prog: PROGRAMS[cfg.program](cfg) });
  }
  window.addEventListener("hf-seek", (e) => drawAll(Number(e.detail?.time) || 0));
  drawAll(lastTime);
}

try {
  init();
  window.__hfsGenerative?.resolve();
} catch (e) {
  window.__hfsGenerative?.reject(e);
  throw e;
}
