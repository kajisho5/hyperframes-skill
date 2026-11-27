// Audio layers and beat lock (roadmap step 11, docs/design-decisions.md D24).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readGrid } from "../lib/audio.mjs";
import { renderHtml, validateRequest } from "../lib/scene-spec.mjs";
import { ffmpeg, SKIP_RENDER, tmp, tool, writeJson } from "./helpers.mjs";

// a 4 s 440 Hz tone, made with ffmpeg in each test directory (no binary fixture)
function tone(dir, name = "music.wav", seconds = 4) {
  ffmpeg(["-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-ar", "48000", join(dir, name)]);
  return join(dir, name);
}

function problems(req, dir) {
  try {
    validateRequest(req, dir);
    return [];
  } catch (e) {
    assert.equal(e.kind, "input", e.message);
    return e.details.problems;
  }
}

const req = (extra = {}, layers) => ({
  scene_version: 1, width: 320, height: 180, duration: 3, fps: 30, background: "#000000", ...extra,
  layers: layers ?? [
    { type: "audio", id: "music", start: 0, duration: 3, src: "music.wav", fade_in: 0.2, fade_out: 0.5, volume: 0.8 },
    { type: "text", id: "a", start: 0.13, duration: 1.5, text: "ONE", transition_in: { type: "chars", duration: 0.1, stagger: 0.2 } },
    { type: "text", id: "b", start: 1.27, duration: 1, text: "TWO" },
    { type: "shape", id: "s", start: 2.2, duration: 0.8, shape: "rect", fill: "#ff0000", box: { x: 0, y: 0, width: 40, height: 40 } },
  ],
});

test("an audio layer is a local sound file with a gain and fades; HyperFrames plays it from data-start", () => {
  const dir = tmp();
  tone(dir);
  const html = renderHtml(validateRequest(req(), dir));
  assert.ok(html.includes('<audio id="music" class="clip" src="assets/music.wav" preload="auto" data-start="0" data-duration="3" data-track-index="0" data-media-start="0" data-volume="0.8" data-fade-in="0.2" data-fade-out="0.5"></audio>'), html);
  assert.ok(!html.includes("#music{"), "no box, no style");
  const bad = (L) => problems(req({}, [{ type: "audio", id: "m", start: 0, duration: 3, src: "music.wav", ...L }]), dir);
  writeFileSync(join(dir, "x.txt"), "x");
  assert.ok(bad({ src: "x.txt" }).some((m) => m.includes("audio extension must be one of")));
  assert.ok(bad({ src: "https://example.com/a.mp3" }).some((m) => m.includes("not a URL")));
  assert.ok(bad({ volume: 5 }).some((m) => m.includes("volume must be a gain 0..3.98")));
  assert.ok(bad({ fade_out: 4 }).some((m) => m.includes("fade_out must be a number of seconds 0..the layer's duration")));
  assert.ok(bad({ box: { x: 0, y: 0, width: 2, height: 2 } }).some((m) => m.includes('unknown key "box" for a audio layer')));
  // sound does not repeat with a seamless loop
  assert.ok(problems(req({ segments: { in: 0.5, loop: 2, out: 0.5 } }, [{ type: "audio", id: "m", start: 0, duration: 3, src: "music.wav" }]), dir).some((m) => m.includes("is an audio layer playing through the loop segment")));
});

test("at 120 BPM every start moves to the nearest beat (a multiple of 0.5 s, on a frame) and staggers become whole beats", () => {
  const dir = tmp();
  tone(dir);
  const s = validateRequest(req({ beat: { bpm: 120 } }), dir);
  const B = s.beat_lock;
  assert.deepEqual([B.source, B.bpm, B.interval, B.beats, B.snap], ["bpm", 120, 0.5, 7, "starts_and_staggers"]);
  assert.deepEqual(B.layers.map((x) => [x.layer, x.given, x.snapped]), [["a", 0.13, 0], ["b", 1.27, 1.5], ["s", 2.2, 2]]);
  for (const L of s.layers.filter((x) => x.type !== "audio")) {
    assert.ok(Math.abs(L.start / 0.5 - Math.round(L.start / 0.5)) * 0.5 <= 1 / 30, `${L.id} ${L.start}`);
    assert.ok(Math.abs(L.start * 30 - Math.round(L.start * 30)) < 1e-6, "on a frame");
  }
  assert.equal(s.layers.find((L) => L.id === "music").start, 0, "audio is never moved");
  assert.deepEqual(B.staggers, [{ layer: "a", edge: "in", given: 0.2, snapped: 0.5, beats: 1 }]);
  assert.equal(s.layers.find((L) => L.id === "a").transition_in.stagger, 0.5);
  // eighths, an offset, and starts only
  const e = validateRequest(req({ beat: { bpm: 120, division: 2, offset: 0.1, snap: "starts" } }), dir).beat_lock;
  // 1.35 s is frame 40.5 at 30 fps: the nearest frame, 41, is 1.366667 s (within one frame of the beat)
  assert.deepEqual(e.layers.map((x) => x.snapped), [0.1, 1.366667, 2.1]);
  assert.deepEqual(e.staggers, []);
  // at 25 fps a beat of 120 BPM with an offset of 0.01 s lands within one frame
  const f = validateRequest(req({ fps: 25, beat: { bpm: 120, offset: 0.01 } }), dir);
  for (const x of f.beat_lock.layers) assert.ok(x.frame_error <= 1 / 25 && Math.abs(x.snapped * 25 - Math.round(x.snapped * 25)) < 1e-6, JSON.stringify(x));
});

test("beat lock is refused when it cannot be applied as stated", () => {
  const dir = tmp();
  tone(dir);
  const p = (beat, layers) => problems(req({ beat }, layers), dir);
  assert.ok(p({}).some((m) => m.includes("beat needs bpm or grid")));
  assert.ok(p({ bpm: 120, grid: "g.json" }).some((m) => m.includes("beat needs bpm or grid")));
  assert.ok(p({ bpm: 1000 }).some((m) => m.includes("beat.bpm must be a number 20..400")));
  assert.ok(p({ bpm: 120, division: 5 }).some((m) => m.includes("beat.division must be one of 1, 2, 3, 4, 6, 8")));
  assert.ok(p({ bpm: 120, swing: 0.2 }).some((m) => m.includes('beat: unknown key "swing"')));
  // a layer that would end after the scene once moved
  assert.ok(p({ bpm: 120 }, [{ type: "text", id: "late", start: 2.8, duration: 0.2, text: "x" }]).some((m) => m.includes('"late") snapped to 3s would end at 3.2s, after the scene\'s 3s')));
});

test("beat grids: ffmpeg-skill scenes --beats (supported beats only), a sound-design-skill tempo map, an array", () => {
  const dir = tmp();
  writeJson(join(dir, "ff.json"), { beats: [0, 0.5, 1, 1.5, 2, 2.5], beat_grid: { supported_beats: [0, 0.5, 1.5, 2], tempo_bpm: 120 } });
  writeJson(join(dir, "sd.json"), { schema: "sound-design-skill/beats@1", bpm: 120, beats: [0, 0.5, 1, 1.5, 2, 2.5].map((time, index) => ({ index, time, bar: 1 + (index >> 2), beat: 1 + (index % 4) })) });
  writeJson(join(dir, "tm.json"), { tempo_map: { beats: [{ time: 0.25 }, { time: 0.75 }] } });
  writeJson(join(dir, "arr.json"), [0.1, 0.6, 1.1]);
  writeJson(join(dir, "bad.json"), [1, 0.5]);
  assert.deepEqual(readGrid("ff.json", dir).times, [0, 0.5, 1.5, 2], "a tool that moves things uses the supported beats only");
  assert.deepEqual(readGrid("sd.json", dir).times, [0, 0.5, 1, 1.5, 2, 2.5]);
  assert.deepEqual(readGrid("tm.json", dir).times, [0.25, 0.75]);
  assert.deepEqual(readGrid("arr.json", dir).times, [0.1, 0.6, 1.1]);
  assert.match(readGrid("bad.json", dir).error, /increasing/);
  tone(dir);
  const ff = validateRequest(req({ beat: { grid: "ff.json" } }), dir).beat_lock;
  assert.deepEqual(ff.layers.map((x) => x.snapped), [0, 1.5, 2]);
  assert.equal(ff.interval, null, "the supported beats are not evenly spaced");
  assert.match(ff.staggers[0].reason, /not evenly spaced/);
  const sd = validateRequest(req({ beat: { grid: "sd.json" } }), dir).beat_lock;
  assert.deepEqual([sd.interval, sd.staggers[0].snapped], [0.5, 0.5]);
  assert.equal(sd.source, "sound-design-skill/beats@1 beats");
});

test("render --codec png refuses a scene with audio; a scene without audio expects none", () => {
  const dir = tmp();
  tone(dir);
  assert.equal(tool("scene", [writeJson(join(dir, "r.json"), req()), "-o", join(dir, "scene"), "--json"]).code, 0);
  const r = tool("render", [join(dir, "scene"), "-o", join(dir, "seq"), "--codec", "png", "--dry-run", "--json"]);
  assert.equal(r.doc.error.kind, "input");
  assert.match(r.doc.error.message, /the scene has audio, and --codec png writes picture frames only/);
  const d = tool("render", [join(dir, "scene"), "-o", join(dir, "a.mp4"), "--dry-run", "--json"]);
  assert.equal(d.doc.expected.audio, true);
});

// RMS of the decoded sound in [a, b) seconds, in dBFS
function rms(file, a, b) {
  const r = spawnSync(process.env.HYPERFRAMES_SKILL_FFMPEG || "ffmpeg", ["-v", "error", "-i", file, "-ss", String(a), "-t", String(b - a), "-ac", "1", "-f", "f32le", "-"], { maxBuffer: 1 << 26 });
  const f = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4);
  let s = 0;
  for (const x of f) s += x * x;
  return 10 * Math.log10(s / Math.max(1, f.length) + 1e-12);
}

test("a 120 BPM scene with music renders with its sound, as long as the scene, every start on a beat", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  tone(dir);
  const R = req({ beat: { bpm: 120 } });
  R.layers[0].start = 0.5;
  R.layers[0].duration = 2.5;
  const s = tool("scene", [writeJson(join(dir, "r.json"), R), "-o", join(dir, "scene"), "--json"]);
  assert.equal(s.code, 0, s.stdout);
  for (const x of s.doc.beat_lock.layers) assert.ok(Math.abs(x.snapped - 0.5 * Math.round(x.snapped / 0.5)) <= 1 / 30, JSON.stringify(x));
  for (const [codec, ext] of [["h264", "mp4"], ["prores", "mov"]]) {
    const out = join(dir, `b.${ext}`);
    const r = tool("render", [join(dir, "scene"), "-o", out, "--codec", codec, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.doc.verified, true, JSON.stringify(r.doc.verification));
    const a = r.doc.verification.find((x) => x.step === "audio");
    assert.equal(a.ok, true);
    assert.ok(Math.abs(r.doc.probe.audio.duration - 3) <= 1 / 30, JSON.stringify(r.doc.probe.audio));
    // silent before the layer's start, the tone after it
    assert.ok(rms(out, 0, 0.45) < -60, "silence before 0.5 s");
    assert.ok(rms(out, 0.7, 2.3) > -30, "the tone after it (ffmpeg's sine is -21 dBFS RMS)");
  }
});

test("a stinger with an audio layer says so in stinger.json", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  tone(dir, "whoosh.wav", 2);
  const R = {
    scene_version: 1, width: 320, height: 180, duration: 1.2, fps: 30, background: "transparent", stinger: { cut_point: 0.5, cover: { start: 0.5, end: 0.7 } },
    layers: [
      { type: "audio", id: "whoosh", start: 0, duration: 1.2, src: "whoosh.wav" },
      { type: "shape", id: "wipe", start: 0.5, duration: 0.2, shape: "rect", fill: "#ffffff" },
    ],
  };
  assert.equal(tool("scene", [writeJson(join(dir, "st.json"), R), "-o", join(dir, "scene"), "--json"]).code, 0);
  const out = join(dir, "st.mov");
  const r = tool("render", [join(dir, "scene"), "-o", out, "--codec", "prores", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const sc = JSON.parse(readFileSync(join(dir, "st.stinger.json"), "utf8"));
  assert.equal(sc.audio, true);
});
