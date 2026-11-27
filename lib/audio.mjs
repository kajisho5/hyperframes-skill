// Audio and beat lock (roadmap step 11, design-decisions D24). An `audio` layer puts a local sound file in
// the scene (HyperFrames mixes it into the output), and a top-level `beat` (a tempo, or a beat grid file
// from ffmpeg-skill `scenes --beats` or sound-design-skill's tempo map) moves every visual layer's start to
// the nearest beat and every unit stagger to a whole number of beats. The snapped times are reported.
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const AUDIO_EXT = new Set([".wav", ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac"]);
export const DIVISIONS = [1, 2, 3, 4, 6, 8];
const BEAT_KEYS = new Set(["bpm", "offset", "grid", "division", "snap"]);
const SNAPS = ["starts", "starts_and_staggers"];
const MAX_BEATS = 100000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const n6 = (v) => Number(Number(v).toFixed(6));

/** An audio layer's own values: volume (gain, 1 = 0 dB, up to +12 dB), fades, media_start. */
export function validateAudio(L, at, err) {
  const volume = L.volume ?? 1;
  if (!isNum(volume) || volume < 0 || volume > 3.98) err(`${at}.volume must be a gain 0..3.98 (1 is 0 dB, 3.98 is +12 dB)`);
  for (const k of ["fade_in", "fade_out"]) if (L[k] !== undefined && (!isNum(L[k]) || L[k] < 0 || (isNum(L.duration) && L[k] > L.duration))) err(`${at}.${k} must be a number of seconds 0..the layer's duration`);
  const mediaStart = L.media_start ?? 0;
  if (!isNum(mediaStart) || mediaStart < 0) err(`${at}.media_start must be a number >= 0`);
  return { volume, fade_in: L.fade_in ?? 0, fade_out: L.fade_out ?? 0, media_start: mediaStart };
}

/**
 * The beat times a grid file gives, in seconds. Read: ffmpeg-skill `scenes --beats --json` (its
 * `beat_grid.supported_beats`: the beats a measured onset supports, the subset a tool that moves things
 * may use), sound-design-skill's `<name>.beats.json` / `tempo_map` (`beats: [{time}]`), or a plain JSON
 * array of seconds. Returns {times, source} or {error}.
 */
export function readGrid(path, baseDir) {
  const abs = isAbsolute(path) ? path : resolve(baseDir, path);
  let doc;
  try {
    doc = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    return { error: `cannot read beat grid ${abs}: ${e.code ?? e.message}` };
  }
  let times;
  let source;
  if (Array.isArray(doc)) {
    times = doc;
    source = "a JSON array of seconds";
  } else if (isPlainObject(doc) && Array.isArray(doc.beat_grid?.supported_beats)) {
    times = doc.beat_grid.supported_beats;
    source = "ffmpeg-skill scenes --beats (beat_grid.supported_beats)";
  } else if (isPlainObject(doc) && isPlainObject(doc.tempo_map) && Array.isArray(doc.tempo_map.beats)) {
    times = doc.tempo_map.beats;
    source = "sound-design-skill tempo_map";
  } else if (isPlainObject(doc) && Array.isArray(doc.beats)) {
    times = doc.beats;
    source = typeof doc.schema === "string" ? `${doc.schema} beats` : "beats";
  } else return { error: `${abs} has no beats (ffmpeg-skill beat_grid.supported_beats, a tempo map's beats, or an array of seconds)` };
  times = times.map((b) => (isPlainObject(b) ? b.time : b));
  if (!times.length || !times.every(isNum) || times.some((t, i) => t < 0 || (i && t <= times[i - 1]))) return { error: `${abs}: the beats must be increasing times in seconds >= 0` };
  if (times.length > MAX_BEATS) return { error: `${abs}: more than ${MAX_BEATS} beats` };
  return { times, source, file: abs };
}

/**
 * beat: {bpm | grid, offset?, division?, snap?}. On the raw request: returns a copy whose visual layers
 * start on the nearest beat (rounded to a frame) and whose unit staggers are whole beats, and the
 * report, or null after reporting the problems through err.
 */
export function applyBeatLock(req, baseDir, fps, err) {
  const B = req.beat;
  if (!isPlainObject(B)) return err("beat must be an object {bpm or grid, offset?, division?, snap?}"), null;
  let ok = true;
  const bad = (m) => {
    ok = false;
    err(m);
  };
  for (const k of Object.keys(B)) if (!BEAT_KEYS.has(k)) bad(`beat: unknown key "${k}" (${[...BEAT_KEYS].join(", ")})`);
  if ((B.bpm === undefined) === (B.grid === undefined)) bad("beat needs bpm or grid (one of them)");
  const division = B.division ?? 1;
  if (!DIVISIONS.includes(division)) bad(`beat.division must be one of ${DIVISIONS.join(", ")} (beats subdivided: 2 = eighths at a quarter-note bpm)`);
  const snap = B.snap ?? "starts_and_staggers";
  if (!SNAPS.includes(snap)) bad(`beat.snap must be ${SNAPS.join(" or ")}`);
  const offset = B.offset ?? 0;
  if (!isNum(offset) || offset < 0) bad("beat.offset must be a number of seconds >= 0 (the first beat)");
  if (B.bpm !== undefined && (!isNum(B.bpm) || B.bpm < 20 || B.bpm > 400)) bad("beat.bpm must be a number 20..400");
  if (B.grid !== undefined && B.offset !== undefined) bad("beat.offset is for bpm; a grid's first beat is in the file");
  if (!ok || !isNum(req.duration) || !fps) return null;
  let beats;
  let interval = null;
  let source;
  let file;
  if (B.bpm !== undefined) {
    interval = 60 / B.bpm / division;
    beats = [];
    for (let k = 0; offset + k * interval <= req.duration + 1e-9 && k < MAX_BEATS; k++) beats.push(offset + k * interval);
    source = "bpm";
  } else {
    if (typeof B.grid !== "string" || !B.grid) return bad("beat.grid must be a path to a beat grid JSON file"), null;
    const g = readGrid(B.grid, baseDir);
    if (g.error) return bad(`beat.grid: ${g.error}`), null;
    source = g.source;
    file = g.file;
    beats = [];
    g.times.forEach((t, i) => {
      beats.push(t);
      const next = g.times[i + 1];
      if (next !== undefined) for (let d = 1; d < division; d++) beats.push(t + ((next - t) * d) / division);
    });
    beats = beats.filter((t) => t <= req.duration + 1e-9);
    // a grid whose intervals are all the same (within a millisecond) snaps staggers too
    const gaps = beats.slice(1).map((t, i) => t - beats[i]);
    if (gaps.length && gaps.every((x) => Math.abs(x - gaps[0]) < 1e-3)) interval = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  }
  if (!beats.length) return bad(`beat: no beat falls inside the scene's ${req.duration}s`), null;
  const onFrame = (t) => Math.round(t * fps) / fps;
  const out = structuredClone(req);
  delete out.beat;
  const layers = [];
  const staggers = [];
  (Array.isArray(out.layers) ? out.layers : []).forEach((L, i) => {
    if (!isPlainObject(L) || L.type === "audio" || !isNum(L.start)) return;
    let best = 0;
    for (let k = 1; k < beats.length; k++) if (Math.abs(beats[k] - L.start) < Math.abs(beats[best] - L.start)) best = k;
    const snapped = n6(onFrame(beats[best]));
    layers.push({ layer: L.id ?? `layers[${i}]`, given: L.start, snapped, beat_index: best, beat: n6(beats[best]), frame_error: n6(Math.abs(snapped - beats[best])) });
    L.start = snapped;
    if (isNum(L.duration) && Math.round((snapped + L.duration) * 1e6) > Math.round(req.duration * 1e6)) bad(`beat: layers[${i}] ("${L.id}") snapped to ${snapped}s would end at ${n6(snapped + L.duration)}s, after the scene's ${req.duration}s; shorten it or move it earlier`);
    if (snap !== "starts_and_staggers") return;
    for (const edge of ["in", "out"]) {
      const T = L[`transition_${edge}`];
      if (!isPlainObject(T) || !["chars", "words", "lines"].includes(T.type) || !isNum(T.stagger) || T.stagger === 0) continue;
      if (interval === null) {
        staggers.push({ layer: L.id, edge, given: T.stagger, snapped: null, reason: "the grid's beats are not evenly spaced, so a stagger has no beat length" });
        continue;
      }
      const s = n6(Math.max(1, Math.round(T.stagger / interval)) * interval);
      staggers.push({ layer: L.id, edge, given: T.stagger, snapped: s, beats: Math.max(1, Math.round(T.stagger / interval)) });
      T.stagger = s;
    }
  });
  if (!ok) return null;
  const report = { source, ...(file ? { grid: file } : {}), ...(B.bpm !== undefined ? { bpm: B.bpm, offset } : {}), division, interval: interval === null ? null : n6(interval), snap, beats: beats.length, layers, staggers };
  return { req: out, report };
}

/** An audio layer's markup: HyperFrames plays it from data-start for data-duration and mixes it into the output. */
export function audioMarkup(L, timing, clip, esc, sec) {
  const A = L.audio;
  // a segment that cuts the layer keeps only the fades of the edges it did not cut
  const cutEnd = clip + (L.windowDuration ?? L.duration) < L.duration - 1e-9;
  const fades = `${A.fade_in && clip === 0 ? ` data-fade-in="${sec(A.fade_in)}"` : ""}${A.fade_out && !cutEnd ? ` data-fade-out="${sec(A.fade_out)}"` : ""}`;
  return `      <audio id="${L.id}" class="clip" src="assets/${esc(L.assetName)}" preload="auto" ${timing} data-media-start="${sec(A.media_start + clip)}" data-volume="${sec(A.volume)}"${fades}></audio>`;
}
