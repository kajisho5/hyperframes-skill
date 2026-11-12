// Scene requests -> HyperFrames HTML. Purely mechanical: every value in the markup comes from
// the request; nothing here chooses copy, timing, layout or assets. A value outside the schema
// is refused, never "fixed up".
import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { ToolError } from "./result.mjs";

export const SCENE_VERSION = 1;
export const FPS_MIN = 1;
export const FPS_MAX = 240;
export const DEFAULT_FPS = 30;
const MAX_DIM = 8192;

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// Colours are validated, not escaped: the value lands in a <style> block.
export const COLOR_RE = /^(#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|transparent|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;
const FONT_RE = /^[A-Za-z0-9 ,'_-]{1,200}$/;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const FITS = ["contain", "cover", "fill"];

const TOP_KEYS = new Set(["scene_version", "id", "width", "height", "duration", "fps", "background", "lang", "fonts", "segments", "layers"]);
// Fonts (0.5.0): font files shipped inside the scene and declared with @font-face, so text renders
// with that font on any machine instead of whatever the machine's fontconfig picks.
const FONT_EXT = new Set([".woff2", ".woff", ".ttf", ".otf"]);
const FONT_KEYS = new Set(["family", "src", "weight", "style"]);
const FONT_FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
const LAYER_KEYS = {
  text: new Set(["type", "id", "start", "duration", "box", "text", "style", "transition_in", "transition_out", "loop_animation"]),
  image: new Set(["type", "id", "start", "duration", "box", "src", "fit", "transition_in", "transition_out", "loop_animation"]),
  video: new Set(["type", "id", "start", "duration", "box", "src", "fit", "media_start", "transition_in", "transition_out", "loop_animation"]),
};
// Transitions (0.2.0). Every motion value comes from the request: slide needs its direction and
// distance, zoom its scale; only the easing has a default (linear, the neutral one).
export const TRANSITION_TYPES = ["fade", "slide", "zoom"];
export const EASINGS = { linear: "linear", ease_in: "ease-in", ease_out: "ease-out", ease_in_out: "ease-in-out" };
const DIRECTIONS = ["left", "right", "up", "down"];
const TRANSITION_KEYS = {
  fade: new Set(["type", "duration", "easing"]),
  slide: new Set(["type", "duration", "easing", "direction", "distance"]),
  zoom: new Set(["type", "duration", "easing", "scale"]),
};
// Loop animations (0.7.0): periodic motion that returns to its start every `period` seconds, so a
// layer can move inside a seamless loop segment. They animate the individual transform properties
// (scale, translate, rotate), which compose with the transitions' `transform` instead of
// overriding it.
export const LOOP_TYPES = ["pulse", "bob", "spin"];
const LOOP_KEYS = {
  pulse: new Set(["type", "period", "scale", "easing"]),
  bob: new Set(["type", "period", "direction", "distance", "easing"]),
  spin: new Set(["type", "period", "direction", "easing"]),
};
// Segments (0.7.0): IN / LOOP / OUT, in this order, filling the scene.
export const SEGMENT_NAMES = ["in", "loop", "out"];
const STYLE_KEYS = new Set(["font_family", "font_size", "font_weight", "color", "align", "valign", "line_height", "background"]);
const TEXT_STYLE_DEFAULTS = {
  font_family: "sans-serif",
  font_size: 64,
  font_weight: 400,
  color: "#ffffff",
  align: "center",
  valign: "middle",
  line_height: 1.2,
  background: "transparent",
};

// Timing values are compared in milliseconds (integers) so 0.1 + 0.2 never fails a bound.
const ms = (s) => Math.round(s * 1000);

function isInt(v) {
  return Number.isInteger(v);
}
function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** Read and parse a request file. */
export function loadRequest(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ToolError("input", `cannot read scene request ${path}: ${e.code ?? e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ToolError("input", `scene request ${path} is not valid JSON: ${e.message}`);
  }
}

/**
 * Validate a request. Returns a normalized scene (defaults filled in, asset paths resolved
 * against `baseDir`) or throws ToolError(input) listing every problem found.
 */
export function validateRequest(req, baseDir) {
  const errs = [];
  const err = (m) => errs.push(m);
  if (typeof req !== "object" || req === null || Array.isArray(req)) {
    throw new ToolError("input", "scene request must be a JSON object");
  }
  for (const k of Object.keys(req)) if (!TOP_KEYS.has(k)) err(`unknown key "${k}"`);
  if (req.scene_version !== SCENE_VERSION) err(`scene_version must be ${SCENE_VERSION}`);
  const id = req.id ?? "main";
  if (!ID_RE.test(id)) err(`id must match ${ID_RE}`);
  for (const k of ["width", "height"]) {
    if (!isInt(req[k]) || req[k] < 2 || req[k] > MAX_DIM || req[k] % 2 !== 0) err(`${k} must be an even integer 2..${MAX_DIM}`);
  }
  if (!isNum(req.duration) || req.duration <= 0 || req.duration > 3600) err("duration must be a number of seconds in (0, 3600]");
  const fps = req.fps ?? DEFAULT_FPS;
  if (!isInt(fps) || fps < FPS_MIN || fps > FPS_MAX) err(`fps must be an integer ${FPS_MIN}..${FPS_MAX}`);
  const background = req.background ?? "#000000";
  if (typeof background !== "string" || !COLOR_RE.test(background)) err("background must be a colour (#rgb, #rrggbb, #rrggbbaa, rgb(), rgba() or transparent)");
  const lang = req.lang ?? "en";
  if (typeof lang !== "string" || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) err("lang must be a BCP 47 tag such as en or ja");
  if (!Array.isArray(req.layers) || req.layers.length === 0) err("layers must be a non-empty array");

  const fonts = [];
  if (req.fonts !== undefined && !Array.isArray(req.fonts)) err("fonts must be an array");
  (Array.isArray(req.fonts) ? req.fonts : []).forEach((F, i) => {
    const at = `fonts[${i}]`;
    if (typeof F !== "object" || F === null) return err(`${at} must be an object`);
    for (const k of Object.keys(F)) if (!FONT_KEYS.has(k)) err(`${at}: unknown key "${k}"`);
    if (typeof F.family !== "string" || !FONT_FAMILY_RE.test(F.family)) err(`${at}.family must match ${FONT_FAMILY_RE} (the name layers use in style.font_family)`);
    const weight = F.weight ?? null;
    if (weight !== null && (!isInt(weight) || weight < 100 || weight > 900 || weight % 100)) err(`${at}.weight must be 100, 200, ..., 900 (omit it to use this file for every weight)`);
    const style = F.style ?? "normal";
    if (!["normal", "italic"].includes(style)) err(`${at}.style must be normal or italic`);
    let srcAbs = null;
    if (typeof F.src !== "string" || F.src === "") err(`${at}.src must be a path to a local font file`);
    else if (/^[a-z][a-z0-9+.-]*:/i.test(F.src) && !/^[A-Za-z]:[\\/]/.test(F.src)) err(`${at}.src must be a local file path, not a URL (this skill never fetches)`);
    else {
      srcAbs = isAbsolute(F.src) ? F.src : resolve(baseDir, F.src);
      const ext = extname(srcAbs).toLowerCase();
      if (!FONT_EXT.has(ext)) err(`${at}.src: font extension must be one of ${[...FONT_EXT].join(" ")}`);
      let isFile = false;
      try {
        isFile = statSync(srcAbs).isFile();
      } catch {
        /* reported below */
      }
      if (!isFile) err(`${at}.src: no such file: ${srcAbs}`);
      fonts.push({ family: F.family, srcAbs, assetName: `fonts/font-${i + 1}${ext}`, weight, style });
    }
  });

  const layers = [];
  const seen = new Set();
  (Array.isArray(req.layers) ? req.layers : []).forEach((L, i) => {
    const at = `layers[${i}]`;
    if (typeof L !== "object" || L === null) return err(`${at} must be an object`);
    const allowed = LAYER_KEYS[L.type];
    if (!allowed) return err(`${at}.type must be one of text, image, video`);
    for (const k of Object.keys(L)) if (!allowed.has(k)) err(`${at}: unknown key "${k}" for a ${L.type} layer`);
    if (!ID_RE.test(L.id ?? "")) err(`${at}.id must match ${ID_RE}`);
    else if (seen.has(L.id)) err(`${at}.id "${L.id}" is used twice`);
    else seen.add(L.id);
    if (!isNum(L.start) || L.start < 0) err(`${at}.start must be a number >= 0`);
    if (!isNum(L.duration) || L.duration <= 0) err(`${at}.duration must be a number > 0`);
    if (isNum(L.start) && isNum(L.duration) && isNum(req.duration) && ms(L.start) + ms(L.duration) > ms(req.duration)) {
      err(`${at} ends at ${L.start + L.duration}s, after the scene's duration ${req.duration}s`);
    }
    const box = L.box ?? { x: 0, y: 0, width: req.width, height: req.height };
    if (typeof box !== "object" || box === null) err(`${at}.box must be an object`);
    else {
      for (const k of ["x", "y"]) if (!isInt(box[k])) err(`${at}.box.${k} must be an integer (pixels)`);
      for (const k of ["width", "height"]) if (!isInt(box[k]) || box[k] <= 0) err(`${at}.box.${k} must be a positive integer (pixels)`);
      for (const k of Object.keys(box)) if (!["x", "y", "width", "height"].includes(k)) err(`${at}.box: unknown key "${k}"`);
    }
    const out = { type: L.type, id: L.id, start: L.start, duration: L.duration, box, z: i + 1 };
    if (L.type === "text") {
      if (typeof L.text !== "string" || L.text.length === 0) err(`${at}.text must be a non-empty string`);
      out.text = L.text;
      const style = { ...TEXT_STYLE_DEFAULTS, ...(L.style ?? {}) };
      if (L.style !== undefined && (typeof L.style !== "object" || L.style === null)) err(`${at}.style must be an object`);
      for (const k of Object.keys(L.style ?? {})) if (!STYLE_KEYS.has(k)) err(`${at}.style: unknown key "${k}"`);
      if (!FONT_RE.test(style.font_family)) err(`${at}.style.font_family may contain only letters, digits, spaces and , ' _ -`);
      if (!isInt(style.font_size) || style.font_size < 1 || style.font_size > 2000) err(`${at}.style.font_size must be an integer 1..2000 (px)`);
      if (!isInt(style.font_weight) || style.font_weight < 100 || style.font_weight > 900 || style.font_weight % 100) err(`${at}.style.font_weight must be 100, 200, ..., 900`);
      for (const k of ["color", "background"]) if (typeof style[k] !== "string" || !COLOR_RE.test(style[k])) err(`${at}.style.${k} must be a colour`);
      if (!["left", "center", "right"].includes(style.align)) err(`${at}.style.align must be left, center or right`);
      if (!["top", "middle", "bottom"].includes(style.valign)) err(`${at}.style.valign must be top, middle or bottom`);
      if (!isNum(style.line_height) || style.line_height <= 0 || style.line_height > 10) err(`${at}.style.line_height must be a number in (0, 10]`);
      out.style = style;
    } else {
      const fit = L.fit ?? "contain";
      if (!FITS.includes(fit)) err(`${at}.fit must be one of ${FITS.join(", ")}`);
      out.fit = fit;
      if (typeof L.src !== "string" || L.src.length === 0) err(`${at}.src must be a path to a local file`);
      else if (/^[a-z][a-z0-9+.-]*:/i.test(L.src) && !/^[A-Za-z]:[\\/]/.test(L.src)) err(`${at}.src must be a local file path, not a URL (this skill never fetches)`);
      else {
        const abs = isAbsolute(L.src) ? L.src : resolve(baseDir, L.src);
        const ext = extname(abs).toLowerCase();
        const okExt = L.type === "image" ? IMAGE_EXT : VIDEO_EXT;
        if (!okExt.has(ext)) err(`${at}.src: ${L.type} extension must be one of ${[...okExt].join(" ")}`);
        let isFile = false;
        try {
          isFile = statSync(abs).isFile();
        } catch {
          /* reported below */
        }
        if (!isFile) err(`${at}.src: no such file: ${abs}`);
        out.srcAbs = abs;
        out.assetName = `${L.id}${ext}`;
      }
      if (L.type === "video") {
        const mediaStart = L.media_start ?? 0;
        if (!isNum(mediaStart) || mediaStart < 0) err(`${at}.media_start must be a number >= 0`);
        out.media_start = mediaStart;
      }
    }
    for (const edge of ["in", "out"]) {
      const key = `transition_${edge}`;
      if (L[key] === undefined) continue;
      const t = validateTransition(L[key], `${at}.${key}`, err);
      if (t) out[key] = t;
    }
    if (L.loop_animation !== undefined) {
      const A = validateLoopAnimation(L.loop_animation, `${at}.loop_animation`, err);
      if (A) out.loop_animation = A;
    }
    if (out.transition_in && out.transition_out && isNum(L.duration) && ms(out.transition_in.duration) + ms(out.transition_out.duration) > ms(L.duration)) {
      err(`${at}: transition_in.duration + transition_out.duration (${out.transition_in.duration + out.transition_out.duration}s) is longer than the layer (${L.duration}s)`);
    }
    layers.push(out);
  });
  let segments = null;
  if (req.segments !== undefined) segments = validateSegments(req.segments, req.duration, fps, err);
  if (segments && !errs.length) checkSeamlessLoop(segments, layers, fps, err);
  if (errs.length) {
    throw new ToolError("input", `invalid scene request:\n  - ${errs.join("\n  - ")}`, { details: { problems: errs } });
  }
  return { id, width: req.width, height: req.height, duration: req.duration, fps, background, lang, fonts, segments, layers };
}

// A whole number of frames, within a microsecond's worth of rounding.
function wholeFrames(seconds, fps) {
  const f = seconds * fps;
  const r = Math.round(f);
  return Math.abs(f - r) < 1e-6 ? r : null;
}

/**
 * segments: {in, loop, out} in seconds. in and out may be 0 (no file for that segment), loop
 * must be > 0, the three add up to the scene's duration, and each is a whole number of frames.
 * Returns [{name, start, duration, start_frame, frames}] or null after reporting the problems.
 */
function validateSegments(S, duration, fps, err) {
  const at = "segments";
  if (typeof S !== "object" || S === null || Array.isArray(S)) return err(`${at} must be an object {in, loop, out} (seconds)`), null;
  let ok = true;
  const bad = (m) => {
    ok = false;
    err(m);
  };
  for (const k of Object.keys(S)) if (!SEGMENT_NAMES.includes(k)) bad(`${at}: unknown key "${k}" (segments are in, loop, out)`);
  for (const k of SEGMENT_NAMES) {
    const v = S[k];
    if (!isNum(v) || v < 0 || (k === "loop" && v === 0)) bad(`${at}.${k} must be a number of seconds ${k === "loop" ? "> 0" : ">= 0 (0: no ${k} segment)"}`);
    else if (isInt(fps) && wholeFrames(v, fps) === null) bad(`${at}.${k} (${v}s) is not a whole number of frames at ${fps} fps`);
  }
  if (!ok) return null;
  if (isNum(duration) && ms(S.in) + ms(S.loop) + ms(S.out) !== ms(duration)) {
    return err(`${at}: in + loop + out (${Number((S.in + S.loop + S.out).toFixed(6))}s) must equal the scene's duration ${duration}s`), null;
  }
  if (!isInt(fps)) return null;
  const out = [];
  let start = 0;
  for (const name of SEGMENT_NAMES) {
    out.push({ name, start: Number(start.toFixed(6)), duration: S[name], start_frame: wholeFrames(start, fps), frames: wholeFrames(S[name], fps) });
    start += S[name];
  }
  return out;
}

function validateLoopAnimation(A, at, err) {
  if (typeof A !== "object" || A === null || Array.isArray(A)) return err(`${at} must be an object`);
  const allowed = LOOP_KEYS[A.type];
  if (!allowed) return err(`${at}.type must be one of ${LOOP_TYPES.join(", ")}`);
  for (const k of Object.keys(A)) if (!allowed.has(k)) err(`${at}: unknown key "${k}" for a ${A.type} loop animation`);
  let ok = true;
  const bad = (m) => {
    ok = false;
    err(m);
  };
  const easing = A.easing ?? (A.type === "spin" ? "linear" : "ease_in_out");
  if (!isNum(A.period) || A.period <= 0) bad(`${at}.period must be a number of seconds > 0 (one full cycle)`);
  if (!(easing in EASINGS)) bad(`${at}.easing must be one of ${Object.keys(EASINGS).join(", ")}`);
  if (A.type === "pulse" && (!isNum(A.scale) || A.scale <= 0 || A.scale > 100 || A.scale === 1)) bad(`${at}.scale must be a number > 0 and != 1 (the scale at the middle of each cycle)`);
  if (A.type === "bob") {
    if (!DIRECTIONS.includes(A.direction)) bad(`${at}.direction must be one of ${DIRECTIONS.join(", ")} (where the layer moves to at the middle of each cycle)`);
    if (!isInt(A.distance) || A.distance <= 0 || A.distance > MAX_DIM) bad(`${at}.distance must be a positive integer (pixels)`);
  }
  if (A.type === "spin" && !["cw", "ccw"].includes(A.direction)) bad(`${at}.direction must be cw or ccw (one full turn per period)`);
  return ok ? { type: A.type, period: A.period, easing, scale: A.scale, direction: A.direction, distance: A.distance } : undefined;
}

/**
 * The loop segment must be seamless by construction: the picture at its end equals the picture at
 * its start. So inside [loop start, loop end) a layer is either absent the whole time or present
 * the whole time, no transition runs, no video plays, and every loop animation has a period that
 * divides the loop length (in whole frames). Anything else is refused, never adjusted.
 */
function checkSeamlessLoop(segments, layers, fps, err) {
  const loop = segments.find((s) => s.name === "loop");
  const A = ms(loop.start);
  const B = ms(loop.start + loop.duration);
  const why = `the loop segment [${loop.start}s, ${Number((loop.start + loop.duration).toFixed(6))}s) must end on the picture it starts with`;
  layers.forEach((L, i) => {
    const at = `layers[${i}] ("${L.id}")`;
    const s = ms(L.start);
    const e = ms(L.start + L.duration);
    if (e <= A || s >= B) return;
    if (s > A || e < B) return err(`${at} ${s > A ? "starts" : "ends"} inside the loop segment; ${why} (start it at or before ${loop.start}s and end it at or after the loop's end, or keep it out of the loop)`);
    if (L.type === "video") err(`${at} is a video layer playing through the loop segment; ${why} (footage does not repeat; use it outside the loop)`);
    if (L.transition_in && s + ms(L.transition_in.duration) > A) err(`${at}.transition_in runs until ${Number((L.start + L.transition_in.duration).toFixed(6))}s, inside the loop segment; ${why}`);
    if (L.transition_out && e - ms(L.transition_out.duration) < B) err(`${at}.transition_out starts at ${Number((L.start + L.duration - L.transition_out.duration).toFixed(6))}s, inside the loop segment; ${why}`);
    const P = L.loop_animation;
    if (P) {
      const pf = wholeFrames(P.period, fps);
      if (pf === null || loop.frames % pf !== 0) {
        const fits = [];
        for (let n = 1; n <= loop.frames && fits.length < 6; n++) if (loop.frames % n === 0) fits.push(Number((loop.frames / n / fps).toFixed(6)));
        err(`${at}.loop_animation.period ${P.period}s does not divide the loop segment's ${loop.duration}s (${loop.frames} frames at ${fps} fps); ${why}. Periods that fit: ${fits.join(", ")} s, ...`);
      }
    }
  });
}

function validateTransition(T, at, err) {
  if (typeof T !== "object" || T === null || Array.isArray(T)) return err(`${at} must be an object`);
  const allowed = TRANSITION_KEYS[T.type];
  if (!allowed) return err(`${at}.type must be one of ${TRANSITION_TYPES.join(", ")}`);
  for (const k of Object.keys(T)) if (!allowed.has(k)) err(`${at}: unknown key "${k}" for a ${T.type} transition`);
  const easing = T.easing ?? "linear";
  let ok = true;
  const bad = (m) => {
    ok = false;
    err(m);
  };
  if (!isNum(T.duration) || T.duration <= 0) bad(`${at}.duration must be a number of seconds > 0`);
  if (!(easing in EASINGS)) bad(`${at}.easing must be one of ${Object.keys(EASINGS).join(", ")}`);
  if (T.type === "slide") {
    if (!DIRECTIONS.includes(T.direction)) bad(`${at}.direction must be one of ${DIRECTIONS.join(", ")} (the side the layer enters from / leaves towards)`);
    if (!isInt(T.distance) || T.distance <= 0 || T.distance > MAX_DIM) bad(`${at}.distance must be a positive integer (pixels)`);
  }
  if (T.type === "zoom" && (!isNum(T.scale) || T.scale <= 0 || T.scale > 100 || T.scale === 1)) {
    bad(`${at}.scale must be a number > 0 and != 1 (the scale the layer starts from / ends at)`);
  }
  return ok ? { type: T.type, duration: T.duration, easing, direction: T.direction, distance: T.distance, scale: T.scale } : undefined;
}

// The transformed end of a transition: where the layer comes from (in) or goes to (out).
function motionFrame(T) {
  if (T.type === "slide") {
    const d = T.distance;
    const [x, y] = { left: [-d, 0], right: [d, 0], up: [0, -d], down: [0, d] }[T.direction];
    return `opacity:0;transform:translate(${x}px,${y}px)`;
  }
  if (T.type === "zoom") return `opacity:0;transform:scale(${Number(T.scale.toFixed(6))})`;
  return "opacity:0";
}

function restFrame(T) {
  return T.type === "fade" ? "opacity:1" : T.type === "slide" ? "opacity:1;transform:translate(0px,0px)" : "opacity:1;transform:scale(1)";
}

/**
 * CSS for a layer's transitions and loop animation. HyperFrames seeks CSS animations in
 * clip-local time (0 = the layer's data-start; measured, pinned by tests/render.test.mjs), so the
 * in-transition starts at 0s and the out-transition at (layer duration - its duration). `in`
 * fills both ways (invisible before it starts), `out` only forwards, so it cannot override `in`
 * before its own start. `clip` (seconds) is how much of the layer's start a segment cut off: every
 * delay moves back by it (a negative delay starts the animation partway), so a segment shows
 * exactly the frames the full scene shows at the same scene time.
 */
function transitionCss(L, clip = 0) {
  const anims = [];
  const frames = [];
  const delay = (d) => sec(d - clip);
  if (L.transition_in) {
    const T = L.transition_in;
    anims.push(`hfs-${L.id}-in ${sec(T.duration)}s ${EASINGS[T.easing]} ${delay(0)}s 1 normal both`);
    frames.push(`@keyframes hfs-${L.id}-in{from{${motionFrame(T)}}to{${restFrame(T)}}}`);
  }
  if (L.transition_out) {
    const T = L.transition_out;
    anims.push(`hfs-${L.id}-out ${sec(T.duration)}s ${EASINGS[T.easing]} ${delay(L.duration - T.duration)}s 1 normal forwards`);
    frames.push(`@keyframes hfs-${L.id}-out{from{${restFrame(T)}}to{${motionFrame(T)}}}`);
  }
  if (L.loop_animation) {
    const P = L.loop_animation;
    // as many cycles as fit in the layer (a fraction allowed), from the layer's start
    anims.push(`hfs-${L.id}-loop ${sec(P.period)}s ${EASINGS[P.easing]} ${delay(0)}s ${sec(L.duration / P.period)} normal both`);
    frames.push(`@keyframes hfs-${L.id}-loop{${loopKeyframes(P)}}`);
  }
  return { animation: anims.length ? `;animation:${anims.join(",")}` : "", keyframes: frames };
}

function loopKeyframes(P) {
  if (P.type === "pulse") return `0%,100%{scale:1}50%{scale:${Number(P.scale.toFixed(6))}}`;
  if (P.type === "bob") {
    const d = P.distance;
    const [x, y] = { left: [-d, 0], right: [d, 0], up: [0, -d], down: [0, d] }[P.direction];
    return `0%,100%{translate:0px 0px}50%{translate:${x}px ${y}px}`;
  }
  return `from{rotate:0deg}to{rotate:${P.direction === "ccw" ? -360 : 360}deg}`;
}

export function expectedFrames(duration, fps) {
  return Math.round(duration * fps);
}

function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Seconds as they appear in data-* attributes: shortest exact decimal form, no exponent.
function sec(v) {
  return String(Number(v.toFixed(6)));
}

const JUSTIFY = { left: "flex-start", center: "center", right: "flex-end", top: "flex-start", middle: "center", bottom: "flex-end" };

/**
 * Normalized scene -> HTML text. Deterministic: same scene, same bytes. With `segment` (one of
 * scene.segments) the HTML is that time window alone, as its own composition starting at 0: a
 * layer is kept when it overlaps the window and cut to it, its animations and media offset by
 * what was cut, so frame k of the segment is frame (segment.start_frame + k) of the full scene.
 */
export function renderHtml(scene, segment = null) {
  const { id, width: W, height: H, fps, background, lang, fonts = [] } = scene;
  const duration = segment ? segment.duration : scene.duration;
  const segments = segment ? null : scene.segments;
  const layers = segment ? windowLayers(scene.layers, segment) : scene.layers;
  const css = [
    "*{margin:0;padding:0;box-sizing:border-box}",
    `html,body{width:${W}px;height:${H}px;overflow:hidden;background:${background}}`,
    `#root{position:relative;width:${W}px;height:${H}px;overflow:hidden}`,
    ".clip{position:absolute;display:block}",
  ];
  const body = [];
  for (const L of layers) {
    const sel = `#${L.id}`;
    const b = L.box;
    let rule = `left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;z-index:${L.z}`;
    const clip = L.clip ?? 0;
    const timing = `data-start="${sec(L.windowStart ?? L.start)}" data-duration="${sec(L.windowDuration ?? L.duration)}" data-track-index="${L.z - 1}"`;
    if (L.type === "text") {
      const s = L.style;
      rule +=
        `;display:flex;flex-direction:column;justify-content:${JUSTIFY[s.valign]};text-align:${s.align}` +
        `;font-family:${s.font_family};font-size:${s.font_size}px;font-weight:${s.font_weight}` +
        `;line-height:${s.line_height};color:${s.color};background:${s.background};white-space:pre-wrap;overflow-wrap:break-word`;
      body.push(`      <div id="${L.id}" class="clip" ${timing}>${esc(L.text)}</div>`);
    } else if (L.type === "image") {
      rule += `;object-fit:${L.fit}`;
      body.push(`      <img id="${L.id}" class="clip" src="assets/${esc(L.assetName)}" alt="" ${timing}>`);
    } else {
      rule += `;object-fit:${L.fit}`;
      body.push(
        `      <video id="${L.id}" class="clip" src="assets/${esc(L.assetName)}" muted playsinline preload="auto" ${timing} data-media-start="${sec(L.media_start + clip)}" data-volume="0"></video>`,
      );
    }
    const tr = transitionCss(L, clip);
    css.push(`${sel}{${rule}${tr.animation}}`, ...tr.keyframes);
  }
  return [
    "<!doctype html>",
    `<html lang="${esc(lang)}">`,
    "  <head>",
    '    <meta charset="UTF-8">',
    `    <meta name="viewport" content="width=${W}, height=${H}">`,
    `    <meta name="generator" content="hyperframes-skill scene v${SCENE_VERSION}">`,
    "    <style>",
    // weight omitted: one file for every weight (100 900), so the browser neither synthesizes
    // bold nor falls back to another face for a weight the request did not declare
    ...fonts.map((F) => `      @font-face{font-family:"${F.family}";src:url("assets/${F.assetName}");font-weight:${F.weight ?? "100 900"};font-style:${F.style}}`),
    ...css.map((l) => "      " + l),
    "    </style>",
    "  </head>",
    "  <body>",
    // data-no-timeline: the scene has no script timeline; visibility is driven by data-start /
    // data-duration alone, so the renderer must not wait for window.__timelines[id].
    `    <div id="root" data-composition-id="${id}" data-no-timeline data-start="0" data-duration="${sec(duration)}" data-width="${W}" data-height="${H}" data-fps="${fps}"${segments ? ` ${SEGMENTS_ATTR}="${segmentsAttr(segments)}"` : ""}>`,
    ...body,
    "    </div>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

// Where a scene with segments keeps each segment's own composition, inside the scene directory.
// render --segments stages each one as index.html of a copy of the scene and renders it.
export const SEGMENTS_ATTR = "data-hfs-segments";
export const segmentHtmlPath = (name) => `segments/${name}.html`;

function segmentsAttr(segments) {
  return segments.map((S) => `${S.name}=${sec(S.duration)}`).join(" ");
}

/** The layers of one segment's window, with their cut-to-window timing (renderHtml). */
function windowLayers(layers, S) {
  const A = ms(S.start);
  const B = ms(S.start + S.duration);
  const out = [];
  for (const L of layers) {
    const s = ms(L.start);
    const e = ms(L.start + L.duration);
    if (e <= A || s >= B) continue;
    const from = Math.max(s, A);
    const to = Math.min(e, B);
    out.push({ ...L, windowStart: (from - A) / 1000, windowDuration: (to - from) / 1000, clip: Math.max(0, A - s) / 1000 });
  }
  return out;
}

/**
 * The segments a root tag declares (`data-hfs-segments="in=0.5 loop=4 out=0.5"`), in order, as
 * [{name, duration}], or null when it declares none. Throws ToolError(input) on a malformed value.
 */
export function readSegments(declared, where) {
  const raw = declared.attrs?.[SEGMENTS_ATTR];
  if (raw === undefined) return null;
  const parts = raw.trim().split(/\s+/).map((p) => /^(in|loop|out)=(\d+(?:\.\d+)?)$/.exec(p));
  const names = parts.map((m) => m?.[1]);
  if (parts.some((m) => !m) || names.join(" ") !== SEGMENT_NAMES.join(" ")) {
    throw new ToolError("input", `${where}: ${SEGMENTS_ATTR}="${raw}" must read "in=S loop=S out=S" (seconds, in this order)`);
  }
  return parts.map((m) => ({ name: m[1], duration: Number(m[2]) }));
}

/**
 * Declared values of an existing HyperFrames HTML file: the attributes of the first element
 * carrying data-composition-id. Returns {id, width, height, duration, fps|null} or throws
 * ToolError(input) when one of the required values is absent or not a number.
 */
export function readDeclared(html, where) {
  const m = /<[A-Za-z][^>]*\sdata-composition-id\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>/s.exec(html);
  if (!m) throw new ToolError("input", `${where}: no element with data-composition-id`);
  const tag = m[0];
  const attrs = {};
  for (const a of tag.matchAll(/\s([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g)) {
    const v = a[2] === undefined ? "" : a[2].replace(/^["']|["']$/g, "");
    attrs[a[1].toLowerCase()] = v;
  }
  const n = (k) => (attrs[k] === undefined || attrs[k] === "" ? null : Number(attrs[k]));
  const out = { id: attrs["data-composition-id"], width: n("data-width"), height: n("data-height"), duration: n("data-duration"), fps: n("data-fps"), tag, attrs };
  const missing = ["width", "height", "duration"].filter((k) => out[k] === null || !Number.isFinite(out[k]) || out[k] <= 0);
  if (missing.length) {
    throw new ToolError("input", `${where}: root composition does not declare a numeric ${missing.map((k) => "data-" + k).join(", ")}`, {
      hint: "the render is verified against the root's declared data-width, data-height and data-duration; declare them",
    });
  }
  if (out.fps !== null && (!Number.isInteger(out.fps) || out.fps < FPS_MIN || out.fps > FPS_MAX)) {
    throw new ToolError("input", `${where}: data-fps must be an integer ${FPS_MIN}..${FPS_MAX}`);
  }
  return out;
}

/** Replace one attribute's value inside the root tag (used on a staged copy only). */
export function setRootAttr(html, declared, name, value) {
  const tag = declared.tag;
  const re = new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s>]+)`);
  const newTag = re.test(tag) ? tag.replace(re, `$1"${value}"`) : tag.replace(/\s*\/?>$/, (end) => ` ${name}="${value}"${end}`);
  const next = html.replace(tag, newTag);
  return { html: next, declared: { ...declared, tag: newTag } };
}

