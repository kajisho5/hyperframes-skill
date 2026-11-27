// Shape and pattern layers (roadmap step 9, design-decisions D22). A `shape` layer is one geometric
// figure drawn as a static inline SVG (rect, rounded rect, circle, line, polygon; fill colour or gradient,
// stroke, rotation) whose position, scale, rotation and opacity follow keyframes. A `pattern` layer is a
// preset (grid, lines, dots, rings, polygons) drawn from a seed with typed parameters, never raw CSS.
// Motion is CSS animations on HTML elements only: HyperFrames' CSS adapter seeks animations on HTML
// elements and skips SVG ones, so an SVG is only ever drawn, never animated.

export const SHAPES = ["rect", "rounded_rect", "circle", "line", "polygon"];
export const PATTERNS = ["grid", "lines", "dots", "rings", "polygons"];
export const SHAPE_TRACKS = ["position", "scale", "rotation", "opacity"];
const MAX_POINTS = 64;
const MAX_ELEMENTS = 4000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const n6 = (v) => String(Number(Number(v).toFixed(6)));
const n3 = (v) => String(Number(Number(v).toFixed(3)));

/** mulberry32: a small, fast PRNG; the same seed gives the same sequence on every machine. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- validation --------------------------------------------------------------------------------

function validateFill(F, at, err, COLOR_RE) {
  if (typeof F === "string") return COLOR_RE.test(F) ? { color: F } : (err(`${at} must be a colour or a gradient {type: linear|radial, stops}`), null);
  if (!isPlainObject(F)) return err(`${at} must be a colour or a gradient {type: linear|radial, angle?, stops: [{offset, color}]}`), null;
  let ok = true;
  const bad = (m) => {
    ok = false;
    err(m);
  };
  for (const k of Object.keys(F)) if (!["type", "angle", "stops"].includes(k)) bad(`${at}: unknown key "${k}" (type, angle, stops)`);
  if (!["linear", "radial"].includes(F.type)) bad(`${at}.type must be linear or radial`);
  if (F.angle !== undefined && (F.type !== "linear" || !isNum(F.angle))) bad(`${at}.angle is a number of degrees, for a linear gradient only (0: left to right, 90: top to bottom)`);
  if (!Array.isArray(F.stops) || F.stops.length < 2 || F.stops.length > 16) bad(`${at}.stops must be 2..16 stops {offset 0..1, color}`);
  else {
    let prev = -1;
    F.stops.forEach((S, i) => {
      if (!isPlainObject(S) || !isNum(S.offset) || S.offset < 0 || S.offset > 1 || S.offset < prev) bad(`${at}.stops[${i}].offset must be 0..1, not below the stop before it`);
      else prev = S.offset;
      if (!isPlainObject(S) || typeof S.color !== "string" || !COLOR_RE.test(S.color)) bad(`${at}.stops[${i}].color must be a colour`);
      for (const k of Object.keys(S ?? {})) if (!["offset", "color"].includes(k)) bad(`${at}.stops[${i}]: unknown key "${k}"`);
    });
  }
  return ok ? { gradient: { type: F.type, angle: F.angle ?? 0, stops: F.stops.map((S) => ({ offset: S.offset, color: S.color })) } } : null;
}

function validateTrack(V, where, L, bad, check) {
  if (!Array.isArray(V) || V.length === 0) return bad(`${where} must be a non-empty array of {t, value}`), null;
  let prev = -Infinity;
  const stops = [];
  V.forEach((S, i) => {
    const w = `${where}[${i}]`;
    if (!isPlainObject(S)) return bad(`${w} must be an object {t, value}`);
    for (const k of Object.keys(S)) if (!["t", "value"].includes(k)) bad(`${w}: unknown key "${k}" (t, value)`);
    if (!isNum(S.t) || S.t < 0) return bad(`${w}.t must be a number of seconds >= 0 (from the layer's start)`);
    if (isNum(L.duration) && Math.round(S.t * 1e6) > Math.round(L.duration * 1e6)) bad(`${w}.t ${S.t}s is after the layer's end (${L.duration}s)`);
    if (!(S.t > prev)) bad(`${w}.t must be later than the stop before it`);
    prev = S.t;
    const m = check(S.value);
    if (m) bad(`${w}.value ${m}`);
    stops.push({ t: S.t, value: S.value });
  });
  return stops;
}

/** A shape layer's own keys; `out` is the normalized layer (box set). Returns the shape or null. */
export function validateShape(L, out, at, err, { COLOR_RE, MAX_DIM }) {
  let ok = true;
  const bad = (m) => {
    ok = false;
    err(m);
  };
  if (!SHAPES.includes(L.shape)) bad(`${at}.shape must be one of ${SHAPES.join(", ")}`);
  const fill = L.fill === undefined ? null : validateFill(L.fill, `${at}.fill`, bad, COLOR_RE);
  let stroke = null;
  if (L.stroke !== undefined) {
    const S = L.stroke;
    if (!isPlainObject(S)) bad(`${at}.stroke must be an object {color, width}`);
    else {
      for (const k of Object.keys(S)) if (!["color", "width"].includes(k)) bad(`${at}.stroke: unknown key "${k}" (color, width)`);
      if (typeof S.color !== "string" || !COLOR_RE.test(S.color)) bad(`${at}.stroke.color must be a colour`);
      if (!isNum(S.width) || S.width <= 0 || S.width > MAX_DIM) bad(`${at}.stroke.width must be a number of pixels > 0`);
      stroke = { color: S.color, width: S.width };
    }
  }
  if (L.shape === "line" && L.stroke === undefined) bad(`${at}: a line is drawn by its stroke; give stroke {color, width}`);
  if (L.shape === "line" && L.fill !== undefined) bad(`${at}.fill: a line has no area to fill`);
  if (L.shape !== "line" && L.fill === undefined && L.stroke === undefined) bad(`${at}: give fill, stroke or both`);
  if (L.radius !== undefined && (L.shape !== "rounded_rect" || !isNum(L.radius) || L.radius < 0)) bad(`${at}.radius is a number of pixels >= 0, for a rounded_rect only`);
  if (L.shape === "rounded_rect" && L.radius === undefined) bad(`${at}.radius is required for a rounded_rect (pixels)`);
  let points = null;
  if (L.shape === "polygon" || L.shape === "line") {
    if (L.sides !== undefined && L.shape === "polygon") {
      if (L.points !== undefined) bad(`${at}: give points or sides, not both`);
      if (!isInt(L.sides) || L.sides < 3 || L.sides > MAX_POINTS) bad(`${at}.sides must be an integer 3..${MAX_POINTS} (a regular polygon inscribed in the box)`);
    } else {
      const min = L.shape === "line" ? 2 : 3;
      const max = L.shape === "line" ? 2 : MAX_POINTS;
      if (!Array.isArray(L.points) || L.points.length < min || L.points.length > max) bad(`${at}.points must be ${L.shape === "line" ? "two points [[x1, y1], [x2, y2]]" : `${min}..${max} points [[x, y], ...]`} in the box's pixels`);
      else if (!L.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum))) bad(`${at}.points: each point is [x, y], numbers (pixels from the box's top left)`);
      else points = L.points.map(([x, y]) => [x, y]);
    }
  } else {
    if (L.points !== undefined) bad(`${at}.points is for a line or polygon`);
    if (L.sides !== undefined) bad(`${at}.sides is for a polygon`);
  }
  if (L.rotation !== undefined && !isNum(L.rotation)) bad(`${at}.rotation must be a number of degrees (clockwise, about the box's centre)`);
  let keyframes = null;
  if (L.keyframes !== undefined) {
    const K = L.keyframes;
    if (!isPlainObject(K) || !Object.keys(K).length) bad(`${at}.keyframes must be an object {position?, scale?, rotation?, opacity?}`);
    else {
      keyframes = {};
      for (const k of Object.keys(K)) if (!SHAPE_TRACKS.includes(k)) bad(`${at}.keyframes: unknown key "${k}" (tracks are ${SHAPE_TRACKS.join(", ")})`);
      if (K.position !== undefined) keyframes.position = validateTrack(K.position, `${at}.keyframes.position`, L, bad, (v) => (Array.isArray(v) && v.length === 2 && v.every((x) => isNum(x) && Math.abs(x) <= MAX_DIM) ? null : "must be [dx, dy], pixels from the box's own place"));
      if (K.scale !== undefined) keyframes.scale = validateTrack(K.scale, `${at}.keyframes.scale`, L, bad, (v) => (isNum(v) && v >= 0 && v <= 100 ? null : "must be a number 0..100"));
      if (K.rotation !== undefined) keyframes.rotation = validateTrack(K.rotation, `${at}.keyframes.rotation`, L, bad, (v) => (isNum(v) && Math.abs(v) <= 36000 ? null : "must be a number of degrees"));
      if (K.opacity !== undefined) keyframes.opacity = validateTrack(K.opacity, `${at}.keyframes.opacity`, L, bad, (v) => (isNum(v) && v >= 0 && v <= 1 ? null : "must be a number 0..1"));
    }
  }
  return ok ? { shape: L.shape, fill, stroke, radius: L.radius ?? 0, points, sides: L.sides ?? null, rotation: L.rotation ?? 0, keyframes } : null;
}

// typed parameters of each pattern preset: [name, check, default]
const PATTERN_PARAMS = {
  grid: { count: [10, 1, 200], line_width: [2, 0.5, 200] },
  lines: { count: [12, 1, 400], line_width: [4, 0.5, 400], angle: [45, -360, 360] },
  dots: { count: [12, 1, 200], size: [0.35, 0.05, 1] },
  rings: { count: [8, 1, 200], line_width: [3, 0.5, 400] },
  polygons: { count: [6, 1, 200], size: [0.25, 0.02, 1], sides: [5, 3, 12] },
};
const PATTERN_DOC = {
  count: "how many cells / lines / dots / rings / polygons across",
  line_width: "pixels",
  angle: "degrees of the lines (0: vertical, 45: diagonal)",
  size: "fraction of a cell (dots: the dot's radius; polygons: the polygon's radius against the box's shorter side)",
  sides: "vertices of each polygon",
};

/** A pattern layer's own keys: pattern, seed, speed, palette and the preset's typed parameters. */
export function validatePattern(L, at, err, { COLOR_RE }) {
  let ok = true;
  const bad = (m) => {
    ok = false;
    err(m);
  };
  if (!PATTERNS.includes(L.pattern)) return bad(`${at}.pattern must be one of ${PATTERNS.join(", ")}`), null;
  const spec = PATTERN_PARAMS[L.pattern];
  if (!isInt(L.seed) || L.seed < 0 || L.seed > 4294967295) bad(`${at}.seed must be an integer 0..4294967295 (the same seed draws the same picture)`);
  const speed = L.speed ?? 0;
  if (!isNum(speed) || speed < 0 || speed > 60) bad(`${at}.speed must be a number of cycles per second 0..60 (0: still; one cycle returns the pattern to its first picture)`);
  if (!Array.isArray(L.palette) || L.palette.length < 1 || L.palette.length > 8 || !L.palette.every((c) => typeof c === "string" && COLOR_RE.test(c))) bad(`${at}.palette must be 1..8 colours`);
  const params = {};
  const given = L.params ?? {};
  if (!isPlainObject(given)) bad(`${at}.params must be an object of ${Object.keys(spec).join(", ")}`);
  else {
    for (const k of Object.keys(given)) if (!(k in spec)) bad(`${at}.params: unknown key "${k}" for a ${L.pattern} pattern (it takes ${Object.keys(spec).join(", ")})`);
    for (const [k, [def, lo, hi]] of Object.entries(spec)) {
      const v = given[k] ?? def;
      const intOnly = k === "count" || k === "sides";
      if (!isNum(v) || v < lo || v > hi || (intOnly && !isInt(v))) bad(`${at}.params.${k} must be ${intOnly ? "an integer" : "a number"} ${lo}..${hi} (${PATTERN_DOC[k]})`);
      params[k] = v;
    }
  }
  return ok ? { pattern: L.pattern, seed: L.seed, speed, palette: [...L.palette], params, period: speed > 0 ? 1 / speed : null } : null;
}

// --- markup ------------------------------------------------------------------------------------

function svgFill(id, F) {
  if (!F) return { defs: "", attr: 'fill="none"' };
  if (F.color) return { defs: "", attr: `fill="${F.color}"` };
  const G = F.gradient;
  const stops = G.stops.map((S) => `<stop offset="${n6(S.offset)}" stop-color="${S.color}"/>`).join("");
  if (G.type === "radial") return { defs: `<defs><radialGradient id="${id}-g">${stops}</radialGradient></defs>`, attr: `fill="url(#${id}-g)"` };
  // angle 0: left to right; 90: top to bottom (about the centre, in the shape's bounding box)
  const a = (G.angle * Math.PI) / 180;
  const [dx, dy] = [Math.cos(a) / 2, Math.sin(a) / 2];
  return { defs: `<defs><linearGradient id="${id}-g" x1="${n6(0.5 - dx)}" y1="${n6(0.5 - dy)}" x2="${n6(0.5 + dx)}" y2="${n6(0.5 + dy)}">${stops}</linearGradient></defs>`, attr: `fill="url(#${id}-g)"` };
}

/** The static SVG of a shape layer, the size of its box. */
export function shapeSvg(id, S, W, H) {
  const f = svgFill(id, S.fill);
  const st = S.stroke ? ` stroke="${S.stroke.color}" stroke-width="${n6(S.stroke.width)}"` : "";
  // a stroke is centred on the outline: inset the figure by half of it so the stroke stays in the box
  const h = S.stroke ? S.stroke.width / 2 : 0;
  let el;
  if (S.shape === "rect" || S.shape === "rounded_rect") {
    const r = S.shape === "rounded_rect" ? ` rx="${n6(S.radius)}" ry="${n6(S.radius)}"` : "";
    el = `<rect x="${n6(h)}" y="${n6(h)}" width="${n6(Math.max(0, W - 2 * h))}" height="${n6(Math.max(0, H - 2 * h))}"${r} ${f.attr}${st}/>`;
  } else if (S.shape === "circle") {
    el = `<ellipse cx="${n6(W / 2)}" cy="${n6(H / 2)}" rx="${n6(Math.max(0, W / 2 - h))}" ry="${n6(Math.max(0, H / 2 - h))}" ${f.attr}${st}/>`;
  } else if (S.shape === "line") {
    const [[x1, y1], [x2, y2]] = S.points;
    el = `<line x1="${n6(x1)}" y1="${n6(y1)}" x2="${n6(x2)}" y2="${n6(y2)}"${st} stroke-linecap="butt"/>`;
  } else {
    const pts = S.points ?? regularPolygon(S.sides, W / 2, H / 2, Math.min(W, H) / 2 - h, -90);
    el = `<polygon points="${pts.map(([x, y]) => `${n6(x)},${n6(y)}`).join(" ")}" ${f.attr}${st} stroke-linejoin="miter"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;overflow:visible">${f.defs}${el}</svg>`;
}

function regularPolygon(n, cx, cy, r, startDeg) {
  return Array.from({ length: n }, (_, i) => {
    const a = ((startDeg + (360 * i) / n) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

/** CSS for a shape's keyframes: one linear animation per track on its inner element, over the layer. */
export function shapeKeyframesCss(id, K, D, delay) {
  const anims = [];
  const frames = [];
  const pct = (t) => `${n6((t / D) * 100)}%`;
  const one = (name, stops, decl) => {
    const body = [`0%{${decl(stops[0].value)}}`, ...stops.map((S) => `${pct(S.t)}{${decl(S.value)}}`), `100%{${decl(stops.at(-1).value)}}`];
    anims.push(`hfs-${id}-kf-${name} ${n6(D)}s linear ${delay}s 1 normal both`);
    frames.push(`@keyframes hfs-${id}-kf-${name}{${body.join("")}}`);
  };
  if (K.position) one("position", K.position, (v) => `translate:${n6(v[0])}px ${n6(v[1])}px`);
  if (K.scale) one("scale", K.scale, (v) => `scale:${n6(v)}`);
  if (K.rotation) one("rotation", K.rotation, (v) => `rotate:${n6(v)}deg`);
  if (K.opacity) one("opacity", K.opacity, (v) => `opacity:${n6(v)}`);
  return { anims, frames };
}

/**
 * A pattern's markup and CSS. Every element is an absolutely placed HTML box; a moving pattern moves in
 * whole cycles of `period` (1 / speed), and a cycle ends on the picture it started with: grid and lines
 * shift by as many cells as the palette has colours (the colour of cell k + n is the colour of cell k),
 * rings grow by that many ring spacings, dots pulse and polygons morph and turn once per cycle. The seed
 * picks the colours, the phases and (polygons) the places and shapes; nothing else.
 * `at` is the layer's start on the composition's clock less what a segment cut off (as kinetic units).
 */
export function patternMarkup(id, P, W, H, D, at) {
  const r = rng(P.seed);
  const k = P.palette.length;
  const off = Math.floor(r() * k);
  const color = (i) => P.palette[(((i + off) % k) + k) % k];
  const css = [];
  const html = [];
  const moving = P.period !== null;
  const per = moving ? n6(P.period) : null;
  const iters = moving ? n6(D / P.period) : null;
  const anim = (name, extra = "", phase = 0) => (moving ? `animation:hfs-${id}-${name} ${per}s linear ${n6(at - phase * P.period)}s ${iters} normal both${extra}` : "");
  let n = 0;
  const count = () => {
    if (++n > MAX_ELEMENTS) throw new Error(`pattern ${id}: more than ${MAX_ELEMENTS} elements`);
  };
  if (P.pattern === "grid" || P.pattern === "lines") {
    const lw = P.params.line_width;
    const angle = P.pattern === "grid" ? 0 : P.params.angle;
    const diag = Math.ceil(Math.hypot(W, H));
    const S = P.pattern === "grid" ? W / P.params.count : diag / P.params.count;
    const shift = S * k;
    // a square field big enough to cover the box at any angle and any shift
    const F = diag + 2 * Math.ceil(shift) + 2 * Math.ceil(S);
    const lines = Math.ceil(F / S) + 1;
    css.push(`#${id} .hfs-f{position:absolute;left:${n6((W - F) / 2)}px;top:${n6((H - F) / 2)}px;width:${F}px;height:${F}px;rotate:${n6(angle)}deg}`);
    // the seed's phase: where in its cycle the shift starts (a still pattern stands there)
    const phase = r();
    const still = moving ? "" : `translate:${n6(phase * shift)}px ${P.pattern === "grid" ? n6(phase * shift) : 0}px`;
    css.push(`#${id} .hfs-m{position:absolute;inset:0;${moving ? anim("shift", "", phase) : still}}`);
    if (moving) css.push(`@keyframes hfs-${id}-shift{from{translate:0px 0px}to{translate:${n6(shift)}px ${P.pattern === "grid" ? n6(shift) : 0}px}}`);
    const inner = [];
    // lines start one shift to the left (and above) of the field, so the shifted field is still covered
    for (let i = 0; i < lines; i++) {
      count();
      const x = i * S - shift;
      inner.push(`<i style="position:absolute;left:${n6(x - lw / 2)}px;top:${n6(-shift)}px;width:${n6(lw)}px;height:${n6(F + shift)}px;background:${color(i)}"></i>`);
    }
    if (P.pattern === "grid") {
      for (let i = 0; i < lines; i++) {
        count();
        const y = i * S - shift;
        inner.push(`<i style="position:absolute;top:${n6(y - lw / 2)}px;left:${n6(-shift)}px;height:${n6(lw)}px;width:${n6(F + shift)}px;background:${color(i + 1)}"></i>`);
      }
    }
    html.push(`<div class="hfs-f"><div class="hfs-m">${inner.join("")}</div></div>`);
  } else if (P.pattern === "dots") {
    const S = W / P.params.count;
    const rad = S * P.params.size;
    const rows = Math.ceil(H / S);
    if (moving) css.push(`@keyframes hfs-${id}-pulse{0%,100%{scale:1}50%{scale:0.2}}`);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < P.params.count; x++) {
        count();
        const c = P.palette[Math.floor(r() * k)];
        const phase = r();
        html.push(`<i style="position:absolute;left:${n6((x + 0.5) * S - rad)}px;top:${n6((y + 0.5) * S - rad)}px;width:${n6(2 * rad)}px;height:${n6(2 * rad)}px;border-radius:50%;background:${c};${anim("pulse", "", phase)}"></i>`);
      }
    }
  } else if (P.pattern === "rings") {
    // one box filled with a repeating radial gradient: ring j of every k is palette colour j. The rings
    // grow by moving the gradient's start outward through a registered length (--p), k spacings per
    // cycle, which is the gradient's own repeat, so a cycle ends on the picture it started with
    const lw = P.params.line_width;
    const S = Math.hypot(W, H) / 2 / P.params.count;
    const v = `--hfs-${id}-p`;
    const stops = [];
    for (let j = 0; j < k; j++) {
      const a0 = j * S;
      stops.push(`${color(j)} calc(var(${v}) + ${n6(a0)}px)`, `${color(j)} calc(var(${v}) + ${n6(a0 + lw)}px)`, `transparent calc(var(${v}) + ${n6(a0 + lw)}px)`, `transparent calc(var(${v}) + ${n6(a0 + S)}px)`);
    }
    const p0 = r() * k * S; // the seed's phase
    css.push(`@property ${v}{syntax:"<length>";inherits:false;initial-value:0px}`);
    css.push(`#${id} .hfs-r{position:absolute;inset:0;${v}:${n6(p0)}px;background:repeating-radial-gradient(circle at 50% 50%,${stops.join(",")});${anim("grow")}}`);
    if (moving) css.push(`@keyframes hfs-${id}-grow{from{${v}:${n6(p0)}px}to{${v}:${n6(p0 + k * S)}px}}`);
    count();
    html.push('<div class="hfs-r"></div>');
  } else {
    const N = P.params.sides;
    const m = Math.min(W, H);
    if (moving) css.push(`@keyframes hfs-${id}-turn{from{rotate:0deg}to{rotate:360deg}}`);
    for (let j = 0; j < P.params.count; j++) {
      count();
      const rad = m * P.params.size * (0.6 + 0.4 * r());
      const cx = rad + r() * Math.max(0, W - 2 * rad);
      const cy = rad + r() * Math.max(0, H - 2 * rad);
      const shape = () => regularPolygon(N, 50, 50, 50, -90).map(([x, y]) => {
        const s = 0.55 + 0.45 * r();
        return [50 + (x - 50) * s, 50 + (y - 50) * s];
      });
      const a = shape();
      const b = shape();
      const poly = (pts) => `polygon(${pts.map(([x, y]) => `${n3(x)}% ${n3(y)}%`).join(",")})`;
      const c = P.palette[Math.floor(r() * k)];
      const phase = r();
      const dir = r() < 0.5 ? "normal" : "reverse";
      css.push(`@keyframes hfs-${id}-m${j}{0%,100%{clip-path:${poly(a)}}50%{clip-path:${poly(b)}}}`);
      const anims = moving ? `animation:hfs-${id}-m${j} ${per}s ease-in-out ${n6(at - phase * P.period)}s ${iters} normal both,hfs-${id}-turn ${per}s linear ${n6(at - phase * P.period)}s ${iters} ${dir} both` : "";
      html.push(`<i style="position:absolute;left:${n6(cx - rad)}px;top:${n6(cy - rad)}px;width:${n6(2 * rad)}px;height:${n6(2 * rad)}px;background:${c};clip-path:${poly(a)};${anims}"></i>`);
    }
  }
  return { html: html.join(""), css };
}
