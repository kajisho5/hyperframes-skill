// Generative layers (roadmap step 10, design-decisions D23): `type: generative` runs one of the programs
// this skill ships (particles, noise field, shader gradient, 3D type from a font file) or a fragment shader
// from a local file, with a seed and typed parameters, on a canvas. The bundled three.js (MIT, copied from
// node_modules into the scene, never fetched) draws it, and lib/generative-runtime.js is the custom frame
// adapter: HyperFrames' `hf-seek` event sets the program's time from the frame being captured, so frame N
// is a function of N alone. Rendering stays on SwiftShader (render passes --no-browser-gpu).
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

export const PROGRAMS = ["particles", "noise_field", "shader_gradient", "type3d", "shader"];
export const RUNTIME_ASSET = "assets/hfs-generative.js";
const FONT_EXT = new Set([".ttf", ".otf", ".woff", ".woff2"]);
const SHADER_EXT = new Set([".frag", ".glsl", ".fs"]);
const MAX_SHADER_BYTES = 64 * 1024;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// [default, min, max, integer?, doc]
const PARAMS = {
  particles: { count: [400, 1, 20000, true, "particles"], size: [3, 0.5, 64, false, "pixels"], speed: [1, 0, 10, false, "how far a particle drifts per second, in box widths x 0.25"], depth: [1, 0, 1, false, "0: flat, 1: full depth with perspective"] },
  noise_field: { scale: [3, 0.1, 50, false, "noise cells across the box"], speed: [0.2, 0, 10, false, "how fast the field flows"], octaves: [4, 1, 8, true, "layers of detail"] },
  shader_gradient: { speed: [0.3, 0, 10, false, "how fast the colour blobs travel"], softness: [0.6, 0.05, 1, false, "how far each colour spreads"] },
  type3d: { depth: [0.25, 0.01, 2, false, "extrusion depth in em"], spin: [0.25, -10, 10, false, "turns per second about the vertical axis"], tilt: [0.15, -1, 1, false, "radians of tilt towards the camera"] },
  shader: {},
};
const PALETTE_MIN = { particles: 1, noise_field: 2, shader_gradient: 2, type3d: 1, shader: 0 };

/**
 * A generative layer's own keys: program, seed, palette, params, time_start, and per program text + font
 * (type3d) or src (shader). `baseDir` resolves the files. Returns the normalized program or null.
 */
export function validateGenerative(L, at, err, { COLOR_RE, baseDir, fonts }) {
  let ok = true;
  const bad = (m) => {
    ok = false;
    err(m);
  };
  if (!PROGRAMS.includes(L.program)) return bad(`${at}.program must be one of ${PROGRAMS.join(", ")}`), null;
  const P = L.program;
  if (!isInt(L.seed) || L.seed < 0 || L.seed > 4294967295) bad(`${at}.seed must be an integer 0..4294967295`);
  const palette = L.palette ?? [];
  if (!Array.isArray(palette) || palette.length > 8 || !palette.every((c) => typeof c === "string" && COLOR_RE.test(c))) bad(`${at}.palette must be up to 8 colours`);
  else if (palette.length < PALETTE_MIN[P]) bad(`${at}.palette: a ${P} program needs at least ${PALETTE_MIN[P]} colour(s)`);
  const ts = L.time_start ?? 0;
  if (!isNum(ts) || ts < 0 || ts > 86400) bad(`${at}.time_start must be a number of seconds >= 0 (the program's time at the layer's first frame)`);
  const spec = PARAMS[P];
  const params = {};
  const given = L.params ?? {};
  if (!isPlainObject(given)) bad(`${at}.params must be an object`);
  else {
    for (const k of Object.keys(given)) if (!(k in spec)) bad(`${at}.params: unknown key "${k}" for ${P} (it takes ${Object.keys(spec).join(", ") || "none"})`);
    for (const [k, [def, lo, hi, int, doc]] of Object.entries(spec)) {
      const v = given[k] ?? def;
      if (!isNum(v) || v < lo || v > hi || (int && !isInt(v))) bad(`${at}.params.${k} must be ${int ? "an integer" : "a number"} ${lo}..${hi} (${doc})`);
      params[k] = v;
    }
  }
  const out = { program: P, seed: L.seed, palette: Array.isArray(palette) ? [...palette] : [], params, time_start: ts };
  if (P === "type3d") {
    if (typeof L.text !== "string" || !L.text.trim() || [...L.text].length > 100) bad(`${at}.text must be a non-empty string of at most 100 characters`);
    const font = typeof L.font === "string" ? L.font : null;
    if (!font) bad(`${at}.font must be the family of a font shipped in fonts[] (its outlines are extruded)`);
    else {
      const F = fonts.find((f) => f.family.toLowerCase() === font.toLowerCase());
      if (!F) bad(`${at}.font "${font}" is not a family shipped in fonts[]`);
      else {
        out.text = L.text;
        out.fontFile = F.srcAbs;
      }
    }
  } else {
    if (L.text !== undefined) bad(`${at}.text is for the type3d program`);
    if (L.font !== undefined) bad(`${at}.font is for the type3d program`);
  }
  if (P === "shader") {
    const r = readShader(L.src, baseDir);
    if (r.error) bad(`${at}.src ${r.error}`);
    else out.shader = r.source;
  } else if (L.src !== undefined) bad(`${at}.src is for the shader program (a local fragment shader file)`);
  return ok ? out : null;
}

/**
 * A user's fragment shader: a local .frag / .glsl / .fs file of plain GLSL ES text. It is checked to be
 * text a shader compiler takes and nothing that reaches out of the GPU: no preprocessor includes or
 * extensions, and none of the words a script would need for network or DOM access (a shader cannot run
 * script, and the text goes into the page as a JSON string, never as markup or code).
 */
export function readShader(src, baseDir) {
  if (typeof src !== "string" || !src) return { error: "must be a path to a local fragment shader file (.frag, .glsl, .fs)" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[A-Za-z]:[\\/]/.test(src)) return { error: "must be a local file path, not a URL (this skill never fetches)" };
  const abs = isAbsolute(src) ? src : resolve(baseDir, src);
  if (!SHADER_EXT.has(extname(abs).toLowerCase())) return { error: `must end in ${[...SHADER_EXT].join(", ")}` };
  let st;
  try {
    st = statSync(abs);
  } catch {
    return { error: `: no such file: ${abs}` };
  }
  if (!st.isFile()) return { error: `: not a file: ${abs}` };
  if (st.size > MAX_SHADER_BYTES) return { error: `is ${st.size} bytes; at most ${MAX_SHADER_BYTES}` };
  const buf = readFileSync(abs);
  const text = buf.toString("utf8");
  if (Buffer.from(text, "utf8").compare(buf) !== 0 || /[\u0000-\u0008\u000e-\u001f]/.test(text)) return { error: "is not UTF-8 text" };
  if (/^\s*#\s*(include|extension|pragma\s+import)/m.test(text)) return { error: "uses #include / #extension; a shader here is one self-contained file" };
  const words = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|import|require|eval|Function|document|window|navigator|localStorage|sessionStorage|indexedDB|postMessage|Worker|script)\b/.exec(text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ""));
  if (words) return { error: `contains "${words[1]}", a word for script, network or DOM access; a fragment shader has none` };
  if (!/\bvoid\s+main\s*\(/.test(text)) return { error: "has no void main()" };
  if (!/\bgl_FragColor\b|\bout\s+(highp\s+|mediump\s+|lowp\s+)?vec4\b/.test(text)) return { error: "writes no colour (gl_FragColor or an out vec4)" };
  return { source: text, file: abs };
}

/**
 * type3d: the outlines of the text in the font, laid out with fontkit (kerning, ligatures), as path
 * commands in em units (y up), one list per glyph with its pen position. The page extrudes them.
 */
export function textOutlines(fontFile, text) {
  const fontkit = require("fontkit");
  let f = fontkit.openSync(fontFile);
  if (f.fonts) f = f.fonts[0];
  const run = f.layout(text);
  const upm = f.unitsPerEm;
  const glyphs = [];
  let x = 0;
  run.glyphs.forEach((g, i) => {
    const pos = run.positions[i];
    const cmds = g.path.commands.map((c) => [c.command, ...c.args.map((a) => Number((a / upm).toFixed(5)))]);
    if (cmds.length) glyphs.push({ x: Number(((x + pos.xOffset) / upm).toFixed(5)), y: Number((pos.yOffset / upm).toFixed(5)), cmds });
    x += pos.xAdvance;
  });
  return { width: Number((x / upm).toFixed(5)), ascent: Number((f.ascent / upm).toFixed(5)), descent: Number((f.descent / upm).toFixed(5)), glyphs };
}

/** The files a scene with generative layers ships: three.js (core + module) and the runtime. */
// three's package root (its exports do not include package.json): node_modules/three/build/three.cjs -> node_modules/three
const threeRoot = () => dirname(dirname(require.resolve("three")));

export function generativeAssets(dir) {
  const three = threeRoot();
  return [
    { lib: "three", source: join(three, "build", "three.core.js"), path: join(dir, "assets", "three.core.js") },
    { lib: "three", source: join(three, "build", "three.module.js"), path: join(dir, "assets", "three.module.js") },
    { lib: "runtime", source: join(HERE, "generative-runtime.js"), path: join(dir, RUNTIME_ASSET) },
  ];
}

export const threeVersion = () => JSON.parse(readFileSync(join(threeRoot(), "package.json"), "utf8")).version;

/** The JSON a canvas's program reads (inline, as a JSON script; `<` escaped so it can never close the tag). */
export function generativeConfig(L, W, H, at) {
  const G = L.generative;
  const cfg = { id: L.id, program: G.program, seed: G.seed, palette: G.palette, params: G.params, width: W, height: H, duration: L.duration, offset: G.time_start - at };
  if (G.program === "type3d") cfg.outlines = textOutlines(G.fontFile, G.text);
  if (G.program === "shader") cfg.shader = G.shader;
  return JSON.stringify(cfg).replace(/</g, "\\u003c");
}
