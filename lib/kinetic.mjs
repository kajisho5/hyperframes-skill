// Kinetic typography (roadmap step 7, design-decisions D20): a text layer's units (grapheme clusters,
// words or lines) reveal one after another, a layer is wiped in or out behind a moving mask, and a text
// layer's tracking, scale and variable-font axes follow keyframes. Everything is CSS animations that
// HyperFrames seeks frame by frame, as it seeks the three transitions, so renders stay bit-exact on
// one machine. Nothing here chooses a value: every timing and every motion comes from the request.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const UNIT_TYPES = ["chars", "words", "lines"];
export const UNIT_EFFECTS = ["fade", "slide", "zoom"];
export const WIPE_DIRECTIONS = ["left", "right", "up", "down"];
export const KEYFRAME_TRACKS = ["tracking", "scale", "font_variation"];
const AXIS_RE = /^[A-Za-z0-9]{4}$/;
const MAX_UNITS = 2000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const n6 = (v) => String(Number(v.toFixed(6)));

/**
 * The units of a text for a unit transition, as tokens {text, unit}. Whitespace (spaces, tabs, line
 * breaks) is never a unit: it is written as it is, so lines still break where they did. chars: one
 * unit per extended grapheme cluster (Unicode UAX #29, Intl.Segmenter), so a base and its combining
 * marks, an emoji ZWJ sequence or an Indic / Thai cluster stays whole; the graphemes of one word are
 * grouped (`word` = the word's index) so a line never breaks inside a word. words: one unit per word
 * (Intl.Segmenter with the scene's lang), punctuation joined to the word before it (or after it, at the
 * start of a line). lines: one unit per line of the text (split at its line breaks).
 */
export function textUnits(text, type, lang) {
  const out = [];
  const ws = (s) => /^\s+$/u.test(s);
  if (type === "lines") {
    for (const part of text.split(/(\r\n|\n)/)) {
      if (part === "") continue;
      out.push({ text: part, unit: !ws(part) });
    }
    return out;
  }
  const words = [...new Intl.Segmenter(lang, { granularity: "word" }).segment(text)];
  if (type === "words") {
    let pendingPunct = "";
    for (const w of words) {
      if (ws(w.segment)) {
        if (pendingPunct) out.push({ text: pendingPunct, unit: true }), (pendingPunct = "");
        out.push({ text: w.segment, unit: false });
      } else if (w.isWordLike) {
        out.push({ text: pendingPunct + w.segment, unit: true });
        pendingPunct = "";
      } else {
        // punctuation: onto the unit just before it, when nothing separates them
        const prev = out.at(-1);
        if (prev && prev.unit && !pendingPunct) prev.text += w.segment;
        else pendingPunct += w.segment;
      }
    }
    if (pendingPunct) out.push({ text: pendingPunct, unit: true });
    return out;
  }
  const graphemes = new Intl.Segmenter(lang, { granularity: "grapheme" });
  words.forEach((w, wi) => {
    for (const g of graphemes.segment(w.segment)) {
      const s = g.segment;
      out.push(ws(s) ? { text: s, unit: false } : { text: s, unit: true, word: wi });
    }
  });
  return out;
}

export const unitCount = (tokens) => tokens.filter((t) => t.unit).length;

/**
 * A unit transition {type: chars|words|lines, duration, stagger, easing, effect, direction, distance,
 * scale}: each unit runs `effect` (fade, slide or zoom, as the layer transitions) for `duration`, unit
 * k starting `stagger` x k after the first. Its span is duration + stagger x (units - 1).
 */
export function validateUnitTransition(T, at, L, lang, err, { DIRECTIONS, EASINGS, MAX_DIM }) {
  let ok = true;
  const bad = (m) => {
    ok = false;
    err(m);
  };
  const allowed = new Set(["type", "duration", "stagger", "easing", "effect", "direction", "distance", "scale"]);
  for (const k of Object.keys(T)) if (!allowed.has(k)) bad(`${at}: unknown key "${k}" for a ${T.type} transition`);
  if (L.type !== "text") bad(`${at}.type ${T.type} animates the units of a text; this is a ${L.type} layer`);
  const easing = T.easing ?? "linear";
  const effect = T.effect ?? "fade";
  if (!isNum(T.duration) || T.duration <= 0) bad(`${at}.duration must be a number of seconds > 0 (each unit's own animation)`);
  if (!isNum(T.stagger) || T.stagger < 0) bad(`${at}.stagger must be a number of seconds >= 0 (from one unit's start to the next one's)`);
  if (!Object.hasOwn(EASINGS, easing)) bad(`${at}.easing must be one of ${Object.keys(EASINGS).join(", ")}`);
  if (!UNIT_EFFECTS.includes(effect)) bad(`${at}.effect must be one of ${UNIT_EFFECTS.join(", ")}`);
  if (effect === "slide") {
    if (!DIRECTIONS.includes(T.direction)) bad(`${at}.direction must be one of ${DIRECTIONS.join(", ")} (the side each unit enters from / leaves towards)`);
    if (!Number.isInteger(T.distance) || T.distance <= 0 || T.distance > MAX_DIM) bad(`${at}.distance must be a positive integer (pixels)`);
  } else {
    if (T.direction !== undefined) bad(`${at}.direction is only for effect slide`);
    if (T.distance !== undefined) bad(`${at}.distance is only for effect slide`);
  }
  if (effect === "zoom") {
    if (!isNum(T.scale) || T.scale <= 0 || T.scale > 100 || T.scale === 1) bad(`${at}.scale must be a number > 0 and != 1 (the scale each unit starts from / ends at)`);
  } else if (T.scale !== undefined) bad(`${at}.scale is only for effect zoom`);
  if (!ok || L.type !== "text" || typeof L.text !== "string" || !L.text) return undefined;
  const units = unitCount(textUnits(L.text, T.type, lang));
  if (units === 0) return err(`${at}: the text has no ${T.type === "lines" ? "line" : T.type === "words" ? "word" : "character"} to animate (whitespace is not a unit)`), undefined;
  if (units > MAX_UNITS) return err(`${at}: ${units} units; at most ${MAX_UNITS} per layer`), undefined;
  const span = Number((T.duration + T.stagger * (units - 1)).toFixed(6));
  return { type: T.type, duration: T.duration, stagger: T.stagger, easing, effect, direction: T.direction, distance: T.distance, scale: T.scale, units, span };
}

/** A mask wipe {type: wipe, duration, direction, easing}: the visible edge travels towards `direction`. */
export function validateWipe(T, at, err, { EASINGS }) {
  let ok = true;
  const bad = (m) => {
    ok = false;
    err(m);
  };
  for (const k of Object.keys(T)) if (!["type", "duration", "direction", "easing"].includes(k)) bad(`${at}: unknown key "${k}" for a wipe transition`);
  const easing = T.easing ?? "linear";
  if (!isNum(T.duration) || T.duration <= 0) bad(`${at}.duration must be a number of seconds > 0`);
  if (!WIPE_DIRECTIONS.includes(T.direction)) bad(`${at}.direction must be one of ${WIPE_DIRECTIONS.join(", ")} (the way the mask's edge travels)`);
  if (!Object.hasOwn(EASINGS, easing)) bad(`${at}.easing must be one of ${Object.keys(EASINGS).join(", ")}`);
  return ok ? { type: "wipe", duration: T.duration, direction: T.direction, easing, span: T.duration } : undefined;
}

// clip-path insets: the layer fully shown, and fully hidden on the side the edge comes from (in) or goes to (out)
const SHOWN = "inset(0px 0px 0px 0px)";
const HIDDEN_FROM = { right: "inset(0px 100% 0px 0px)", left: "inset(0px 0px 0px 100%)", down: "inset(0px 0px 100% 0px)", up: "inset(100% 0px 0px 0px)" };
const HIDDEN_TO = { right: "inset(0px 0px 0px 100%)", left: "inset(0px 100% 0px 0px)", down: "inset(100% 0px 0px 0px)", up: "inset(0px 0px 100% 0px)" };

export function wipeKeyframes(T, edge) {
  return edge === "in" ? `from{clip-path:${HIDDEN_FROM[T.direction]}}to{clip-path:${SHOWN}}` : `from{clip-path:${SHOWN}}to{clip-path:${HIDDEN_TO[T.direction]}}`;
}

/** The transformed end of one unit's animation, and its rest state. */
export function unitFrames(T) {
  if (T.effect === "slide") {
    const d = T.distance;
    const [x, y] = { left: [-d, 0], right: [d, 0], up: [0, -d], down: [0, d] }[T.direction];
    return { moved: `opacity:0;transform:translate(${x}px,${y}px)`, rest: "opacity:1;transform:translate(0px,0px)" };
  }
  if (T.effect === "zoom") return { moved: `opacity:0;transform:scale(${n6(T.scale)})`, rest: "opacity:1;transform:scale(1)" };
  return { moved: "opacity:0", rest: "opacity:1" };
}

/** Do units of this transition need their own box (a transform does not apply to an inline box)? */
export const unitsAreBoxes = (T) => T.effect !== "fade" || T.type === "lines";

/**
 * keyframes {tracking?, scale?, font_variation?}: each track a list of {t, value} (t: seconds from the
 * layer's start, strictly increasing, within the layer), linear between stops and held before the
 * first and after the last. font_variation is {AXIS: [{t, value}]} per variable-font axis; the axes are
 * checked against the font file the layer's font_family names (fonts[]).
 */
export function validateKeyframes(K, at, L, fonts, err) {
  if (!isPlainObject(K)) return err(`${at} must be an object {tracking?, scale?, font_variation?}`), undefined;
  let ok = true;
  const bad = (m) => {
    ok = false;
    err(m);
  };
  for (const k of Object.keys(K)) if (!KEYFRAME_TRACKS.includes(k)) bad(`${at}: unknown key "${k}" (tracks are ${KEYFRAME_TRACKS.join(", ")})`);
  if (Object.keys(K).length === 0) bad(`${at} must have at least one track`);
  const track = (V, where, check) => {
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
  };
  const out = {};
  if (K.tracking !== undefined) out.tracking = track(K.tracking, `${at}.tracking`, (v) => (isNum(v) && v >= -1000 && v <= 1000 ? null : "must be a number of pixels -1000..1000 (letter-spacing)"));
  if (K.scale !== undefined) {
    out.scale = track(K.scale, `${at}.scale`, (v) => (isNum(v) && v > 0 && v <= 100 ? null : "must be a number > 0 and <= 100"));
    if (L.loop_animation?.type === "pulse") bad(`${at}.scale and loop_animation pulse both set the scale; use one`);
  }
  if (K.font_variation !== undefined) {
    if (!isPlainObject(K.font_variation) || Object.keys(K.font_variation).length === 0) bad(`${at}.font_variation must be an object {AXIS: [{t, value}]} with at least one axis`);
    else {
      const axes = fontAxes(L, fonts, `${at}.font_variation`, bad);
      out.font_variation = {};
      for (const [tag, V] of Object.entries(K.font_variation)) {
        const where = `${at}.font_variation.${tag}`;
        if (!AXIS_RE.test(tag)) {
          bad(`${where}: an axis tag is four letters or digits (such as wght, wdth, opsz)`);
          continue;
        }
        if (axes && !axes.list.some((a) => a.tag === tag)) {
          bad(`${where}: the font ${axes.where} has no ${tag} axis; its axes are ${axes.list.length ? axes.list.map(axisText).join(", ") : "none (not a variable font)"}`);
          continue;
        }
        const A = axes?.list.find((a) => a.tag === tag);
        out.font_variation[tag] = track(V, where, (v) => (!isNum(v) ? "must be a number" : A && (v < A.min || v > A.max) ? `${v} is outside the font's ${axisText(A)}` : null));
      }
    }
  }
  return ok ? out : undefined;
}

const axisText = (a) => `${a.tag} ${a.min}..${a.max} (default ${a.default})`;

/**
 * The variation axes of the font file(s) the layer's font_family names: the first family in the list
 * must be one the request ships in fonts[], since only a file can say which axes exist. Returns
 * {where, list: [{tag, min, max, default}]} (the axes every file of that family has) or null after
 * reporting why they cannot be read.
 */
function fontAxes(L, fonts, at, bad) {
  const first = String(L.style?.font_family ?? "").split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  const files = fonts.filter((F) => F.family.toLowerCase() === first.toLowerCase()); // CSS family names ignore case
  if (!files.length) return bad(`${at}: style.font_family "${first}" must name a family shipped in fonts[]; the axes are read from its file`), null;
  let list = null;
  for (const F of files) {
    const axes = readAxes(F.srcAbs);
    if (axes.error) return bad(`${at}: cannot read the font ${F.srcAbs}: ${axes.error}`), null;
    list = list === null ? axes.list : list.filter((a) => axes.list.some((b) => b.tag === a.tag)).map((a) => {
      const b = axes.list.find((x) => x.tag === a.tag);
      return { tag: a.tag, min: Math.max(a.min, b.min), max: Math.min(a.max, b.max), default: a.default };
    });
  }
  return { where: files.length === 1 ? `"${first}" (${files[0].srcAbs})` : `"${first}" (${files.length} files, axes every file has)`, list };
}

const axisCache = new Map();
/** The fvar axes of a font file (ttf, otf, woff, woff2), read with fontkit. */
export function readAxes(path) {
  if (axisCache.has(path)) return axisCache.get(path);
  let res;
  try {
    const fontkit = require("fontkit");
    let f = fontkit.openSync(path);
    if (f.fonts) f = f.fonts[0]; // a collection: its first face
    const list = Object.entries(f.variationAxes ?? {}).map(([tag, a]) => ({ tag, min: a.min, max: a.max, default: a.default }));
    res = { list };
  } catch (e) {
    res = { error: e.message };
  }
  axisCache.set(path, res);
  return res;
}

/** Value of a piecewise-linear track at time t (held outside its stops). */
export function trackAt(stops, t) {
  if (t <= stops[0].t) return stops[0].value;
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].t) {
      const a = stops[i - 1];
      const b = stops[i];
      return a.value + ((b.value - a.value) * (t - a.t)) / (b.t - a.t);
    }
  }
  return stops.at(-1).value;
}

/** Is the track constant on [a, b] (layer-local seconds)? */
export function trackConstant(stops, a, b) {
  const v = trackAt(stops, a);
  if (Math.abs(trackAt(stops, b) - v) > 1e-9) return false;
  return stops.every((S) => S.t <= a || S.t >= b || Math.abs(S.value - v) <= 1e-9);
}

/** The tracks of a keyframes object as [{name, stops}] with font_variation's axes as their own tracks. */
export function keyframeTracks(K) {
  const out = [];
  if (K.tracking) out.push({ name: "tracking", stops: K.tracking });
  if (K.scale) out.push({ name: "scale", stops: K.scale });
  for (const [tag, stops] of Object.entries(K.font_variation ?? {})) out.push({ name: `font_variation.${tag}`, stops });
  return out;
}

/**
 * The @keyframes of a layer's keyframes, one animation per property, over the layer's duration (linear;
 * the stops carry the shape). font-variation-settings takes every axis at every stop, so the axes'
 * stops are merged and each axis is interpolated there.
 */
export function keyframesCss(L, delay) {
  const K = L.keyframes;
  const D = L.duration;
  const pct = (t) => `${n6((t / D) * 100)}%`;
  const anims = [];
  const frames = [];
  const one = (name, stops, decl) => {
    const body = [`0%{${decl(stops[0].value)}}`, ...stops.map((S) => `${pct(S.t)}{${decl(S.value)}}`), `100%{${decl(stops.at(-1).value)}}`];
    anims.push(`hfs-${L.id}-kf-${name} ${n6(D)}s linear ${delay(0)}s 1 normal both`);
    frames.push(`@keyframes hfs-${L.id}-kf-${name}{${body.join("")}}`);
  };
  if (K.tracking) one("tracking", K.tracking, (v) => `letter-spacing:${n6(v)}px`);
  if (K.scale) one("scale", K.scale, (v) => `scale:${n6(v)}`);
  if (K.font_variation && Object.keys(K.font_variation).length) {
    const axes = Object.keys(K.font_variation).sort();
    const times = [...new Set(axes.flatMap((a) => K.font_variation[a].map((S) => S.t)))].sort((x, y) => x - y);
    const decl = (t) => `font-variation-settings:${axes.map((a) => `"${a}" ${n6(trackAt(K.font_variation[a], t))}`).join(",")}`;
    const body = [`0%{${decl(times[0])}}`, ...times.map((t) => `${pct(t)}{${decl(t)}}`), `100%{${decl(times.at(-1))}}`];
    anims.push(`hfs-${L.id}-kf-axes ${n6(D)}s linear ${delay(0)}s 1 normal both`);
    frames.push(`@keyframes hfs-${L.id}-kf-axes{${body.join("")}}`);
  }
  return { anims, frames };
}
