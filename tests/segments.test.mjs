// IN / LOOP / OUT segments and seamless loops (roadmap step 12, docs/design-decisions.md D12).
// Validation, markup and planning run without Chrome; the real renders are skipped with
// HYPERFRAMES_SKILL_SKIP_RENDER_TESTS=1 like every other render test.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { seamFromFrames } from "../lib/loop-seam.mjs";
import { readDeclared, readSegments, renderHtml, validateRequest } from "../lib/scene-spec.mjs";
import { ffmpeg, FIXTURES, SKIP_RENDER, tmp, tool, writeJson } from "./helpers.mjs";

const FIXTURE = join(FIXTURES, "lower-third-loop.json");
const base = () => JSON.parse(readFileSync(FIXTURE, "utf8"));

function problems(req) {
  try {
    validateRequest(req, FIXTURES);
    return [];
  } catch (e) {
    assert.equal(e.kind, "input");
    return e.details.problems;
  }
}

test("segments normalize to start frames and frame counts that fill the scene", () => {
  const s = validateRequest(base(), FIXTURES);
  assert.deepEqual(s.segments, [
    { name: "in", start: 0, duration: 0.5, start_frame: 0, frames: 5 },
    { name: "loop", start: 0.5, duration: 4, start_frame: 5, frames: 40 },
    { name: "out", start: 4.5, duration: 0.5, start_frame: 45, frames: 5 },
  ]);
  assert.equal(validateRequest({ ...base(), segments: undefined }, FIXTURES).segments, null);
});

test("segments are refused when they do not fill the scene in whole frames", () => {
  const p = (segments, extra = {}) => problems({ ...base(), ...extra, segments });
  assert.ok(p({ in: 0.5, loop: 4, out: 1 }).some((m) => /in \+ loop \+ out \(5\.5s\) must equal the scene's duration 5s/.test(m)));
  assert.ok(p({ in: 0.55, loop: 4, out: 0.45 }).some((m) => /segments\.in \(0\.55s\) is not a whole number of frames at 10 fps/.test(m)));
  assert.ok(p({ in: 0.5, loop: 0, out: 4.5 }).some((m) => /segments\.loop must be a number of seconds > 0/.test(m)));
  assert.ok(p({ in: 0.5, loop: 4, out: 0.5, hold: 1 }).some((m) => /unknown key "hold"/.test(m)));
  assert.ok(p([0.5, 4, 0.5]).some((m) => /segments must be an object/.test(m)));
  assert.deepEqual(p({ in: 0, loop: 5, out: 0 }, { layers: [{ type: "text", id: "t", start: 0, duration: 5, text: "x" }] }), [], "in and out may be 0");
});

test("one-frame segments at 30 fps add up in frames, and their declaration reads back whole", () => {
  const dir = tmp();
  const req = { ...base(), duration: 0.1, fps: 30, segments: { in: 1 / 30, loop: 1 / 30, out: 1 / 30 }, layers: [{ type: "text", id: "t", start: 0, duration: 0.1, text: "x" }] };
  const s = validateRequest(req, FIXTURES);
  assert.deepEqual(s.segments.map((S) => [S.start_frame, S.frames]), [[0, 1], [1, 1], [2, 1]]);
  const r = tool("scene", [writeJson(join(dir, "req.json"), req), "-o", join(dir, "scene"), "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.doc.verified, true);
  const p = tool("render", [join(dir, "scene"), "-o", join(dir, "o.mp4"), "--segments", "--dry-run", "--json"]);
  assert.equal(p.code, 0, p.stderr);
  assert.deepEqual(p.doc.segments.map((S) => S.frames), [1, 1, 1]);
});

test("inherited object names are not loop types or easings", () => {
  const p = (A) => problems({ ...base(), segments: undefined, layers: [{ type: "text", id: "t", start: 0, duration: 5, text: "x", loop_animation: A }] });
  assert.match(p({ type: "constructor", period: 1 }).join(), /type must be one of pulse, bob, spin/);
  assert.match(p({ type: "pulse", period: 1, scale: 2, easing: "constructor" }).join(), /easing must be one of/);
});

test("a loop that cannot be seamless is refused, with the reason", () => {
  const req = (mut) => {
    const r = base();
    mut(r.layers[0], r);
    return problems(r);
  };
  const one = (mut, re) => {
    const p = req(mut);
    assert.equal(p.length, 1, p.join("\n"));
    assert.match(p[0], re);
    assert.match(p[0], /must end on the picture it starts with/);
  };
  one((L) => (L.loop_animation.period = 3), /period 3s does not divide the loop segment's 4s \(40 frames at 10 fps\).*Periods that fit: 4, 2, 1, 0\.8, 0\.5, 0\.4 s/);
  one((L) => (L.loop_animation.period = 0.15), /period 0\.15s does not divide/);
  one((L) => (L.transition_in.duration = 1), /transition_in runs until 1s, inside the loop segment/);
  one((L) => (L.transition_out.duration = 1), /transition_out starts at 4s, inside the loop segment/);
  one((L) => ((L.start = 1), (L.duration = 4), delete L.transition_in), /starts inside the loop segment/);
  one((L) => ((L.duration = 3), (L.transition_out.duration = 0.5)), /ends inside the loop segment/);
  // compared at the microsecond precision the markup carries, not rounded to milliseconds
  one((L) => ((L.start = 0.5004), (L.duration = 4.4996), delete L.transition_in), /starts inside the loop segment/);
  // a layer wholly outside the loop is fine, whatever it does
  assert.deepEqual(req((L) => ((L.duration = 0.5), (L.transition_in.duration = 0.25), (L.transition_out.duration = 0.25), (L.loop_animation.period = 0.3))), []);
});

test("a video layer through the loop is refused; outside it, it is allowed", () => {
  const dir = tmp();
  writeFileSync(join(dir, "clip.mp4"), "not decoded by validation");
  const video = (start, duration) => ({ type: "video", id: "v", start, duration, src: join(dir, "clip.mp4") });
  const p = (L) => problems({ ...base(), layers: [L] });
  assert.match(p(video(0, 5)).join("\n"), /video layer playing through the loop segment/);
  assert.deepEqual(p(video(4.5, 0.5)), []);
});

test("loop_animation fields are validated", () => {
  const p = (A) => problems({ ...base(), segments: undefined, layers: [{ type: "text", id: "t", start: 0, duration: 5, text: "x", loop_animation: A }] });
  assert.match(p({ type: "wobble", period: 1 }).join(), /type must be one of pulse, bob, spin/);
  assert.match(p({ type: "pulse", period: 1 }).join(), /scale must be a number > 0 and != 1/);
  assert.match(p({ type: "pulse", period: 0, scale: 2 }).join(), /period must be a number of seconds > 0/);
  assert.match(p({ type: "bob", period: 1, direction: "sideways", distance: 4 }).join(), /direction must be one of left, right, up, down/);
  assert.match(p({ type: "spin", period: 1, direction: "left" }).join(), /direction must be cw or ccw/);
  assert.match(p({ type: "spin", period: 1, direction: "cw", scale: 2 }).join(), /unknown key "scale" for a spin loop animation/);
  assert.deepEqual(p({ type: "spin", period: 1, direction: "ccw" }), []);
});

test("markup: the root declares the segments; each segment is its own window of the scene", () => {
  const s = validateRequest(base(), FIXTURES);
  const full = renderHtml(s);
  assert.deepEqual(readSegments(readDeclared(full, "f"), "f"), [{ name: "in", duration: 0.5 }, { name: "loop", duration: 4 }, { name: "out", duration: 0.5 }]);
  // loop animations use the individual transform properties, which compose with the transitions' transform
  assert.match(full, /@keyframes hfs-name-loop\{0%,100%\{scale:1\}50%\{scale:1\.1\}\}/);
  assert.match(full, /@keyframes hfs-dot-loop\{0%,100%\{translate:0px 0px\}50%\{translate:0px 6px\}\}/);
  assert.match(full, /hfs-name-loop 2s ease-in-out 0s 2\.5 normal both/);
  const loop = renderHtml(s, s.segments[1]);
  const d = readDeclared(loop, "loop");
  assert.equal(d.duration, 4);
  assert.equal(readSegments(d, "loop"), null, "a segment declares no segments of its own");
  // the cut-off 0.5 s moves every delay back by 0.5 s
  assert.match(loop, /hfs-name-in 0\.5s ease-out -0\.5s 1 normal both,hfs-name-out 0\.5s linear 4s 1 normal forwards,hfs-name-loop 2s ease-in-out -0\.5s 2\.5 normal both/);
  assert.match(loop, /<div id="name" class="clip" data-start="0" data-duration="4"/);
  const out = renderHtml(s, s.segments[2]);
  assert.match(out, /hfs-name-out 0\.5s linear 0s 1 normal forwards/);
  assert.match(out, /data-start="0" data-duration="0\.5"/);
  assert.equal(renderHtml(s), full, "deterministic");
});

test("markup: a video cut by a segment starts its media later by the cut", () => {
  const dir = tmp();
  writeFileSync(join(dir, "clip.mp4"), "x");
  // a valid scene never cuts a video (it may not play through the loop), so the window is given directly
  const s = validateRequest({ ...base(), segments: undefined, layers: [{ type: "video", id: "v", start: 4, duration: 1, src: join(dir, "clip.mp4"), media_start: 2 }] }, FIXTURES);
  assert.match(renderHtml(s, { name: "out", start: 4.5, duration: 0.5 }), /data-start="0" data-duration="0\.5" data-track-index="0" data-media-start="2\.5"/);
});

test("readSegments refuses a malformed declaration", () => {
  for (const v of ["in=1 loop=2", "loop=2 in=1 out=1", "in=a loop=2 out=1", ""]) {
    assert.throws(() => readSegments({ attrs: { "data-hfs-segments": v } }, "f"), (e) => e.kind === "input" && /must read "in=S loop=S out=S"/.test(e.message), v);
  }
});

test("scene writes one composition per non-empty segment and reports them", () => {
  const dir = tmp();
  const req = writeJson(join(dir, "req.json"), { ...base(), duration: 4.5, segments: { in: 0.5, loop: 4, out: 0 }, layers: base().layers.map(({ transition_out, ...L }) => ({ ...L, duration: 4.5 })) });
  const r = tool("scene", [req, "-o", join(dir, "scene"), "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.doc.verified, true);
  const seg = (name) => join(dir, "scene", "segments", `${name}.html`);
  assert.deepEqual(r.doc.segments.map((S) => [S.name, S.frames, S.html]), [["in", 5, seg("in")], ["loop", 40, seg("loop")], ["out", 0, null]]);
  const step = r.doc.verification.find((s) => s.step === "segments");
  assert.deepEqual([step.ok, step.actual.frames], [true, 45]);
  // --overwrite on a scene without segments removes the stale segment compositions
  const plain = writeJson(join(dir, "plain.json"), { ...base(), segments: undefined });
  const again = tool("scene", [plain, "-o", join(dir, "scene"), "--overwrite", "--json"]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.doc.segments, null);
  assert.throws(() => readFileSync(join(dir, "scene", "segments", "in.html")));
});

test("render --segments --dry-run plans one file per segment; a scene without segments is refused", () => {
  const dir = tmp();
  assert.equal(tool("scene", [FIXTURE, "-o", join(dir, "scene"), "--json"]).code, 0);
  const r = tool("render", [join(dir, "scene"), "-o", join(dir, "lt.mov"), "--codec", "prores", "--segments", "--dry-run", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.doc.segments.map((S) => [S.name, S.start_frame, S.frames, S.output]), [["in", 0, 5, join(dir, "lt.in.mov")], ["loop", 5, 40, join(dir, "lt.loop.mov")], ["out", 45, 5, join(dir, "lt.out.mov")]]);
  assert.equal(r.doc.planned_commands.length, 4);
  // at 3 fps 0.5 s is 1.5 frames
  const f = tool("render", [join(dir, "scene"), "-o", join(dir, "lt.mov"), "--codec", "prores", "--segments", "--fps", "3", "--dry-run", "--json"]);
  assert.equal(f.doc.error.kind, "input");
  assert.match(f.doc.error.message, /the in segment \(0\.5s\) is not a whole number of frames at 3 fps/);
  assert.equal(tool("scene", [join(FIXTURES, "two-line.json"), "-o", join(dir, "plain"), "--json"]).code, 0);
  const n = tool("render", [join(dir, "plain"), "-o", join(dir, "p.mp4"), "--segments", "--dry-run", "--json"]);
  assert.equal(n.doc.error.kind, "input");
  assert.match(n.doc.error.message, /declares no segments/);
});

test("seam measure: a closing loop passes, a jump at the wrap does not", () => {
  const frame = (v) => Buffer.alloc(16, v);
  const ramp = (n, period) => Array.from({ length: n }, (_, i) => frame(Math.round(100 + 50 * Math.sin((2 * Math.PI * i) / period))));
  assert.equal(seamFromFrames(ramp(40, 20)).ok, true);
  assert.equal(seamFromFrames(ramp(40, 40)).ok, true);
  const broken = seamFromFrames(ramp(40, 30));
  assert.equal(broken.ok, false);
  assert.ok(broken.wrap_diff > broken.max_step_diff + broken.tolerance, JSON.stringify(broken));
  assert.deepEqual(seamFromFrames([frame(1), frame(1)]).wrap_diff, 0);
  assert.deepEqual([seamFromFrames([frame(3)]).ok, seamFromFrames([frame(3)]).wrap_diff], [true, 0]);
  assert.deepEqual(seamFromFrames([]), { measured: false, reason: "no frame was decoded", frames: 0, tolerance: 1, ok: false });
});

// colour planes only: HyperFrames' alpha plane for a scaled layer (pulse here, and the zoom
// transition before it) is not bit-exact between two renders of the same scene (D12, measured)
const framemd5 = (file) => ffmpeg(["-i", file, "-vf", "format=yuv444p12le", "-f", "framemd5", "-"]).toString().split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop().trim());

test("lower third in 0.5 s / loop 4 s / out 0.5 s: three files that add up to the full render, frame for frame", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  assert.equal(tool("scene", [FIXTURE, "-o", join(dir, "scene"), "--json"]).code, 0);
  const out = join(dir, "lt.mov");
  const r = tool("render", [join(dir, "scene"), "-o", out, "--codec", "prores", "--segments", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const d = r.doc;
  assert.equal(d.verified, true);
  assert.deepEqual(d.segments.map((S) => [S.name, S.frames, S.probe.video.frames, S.verified]), [["in", 5, 5, true], ["loop", 40, 40, true], ["out", 5, 5, true]]);
  assert.equal(d.segments.reduce((n, S) => n + S.probe.video.frames, 0), d.probe.video.frames);
  const seg = d.verification.find((s) => s.step === "segments");
  assert.deepEqual([seg.ok, seg.actual.frames, seg.expected.frames], [true, 50, 50]);
  assert.equal(d.loop_seam.ok, true, JSON.stringify(d.loop_seam));
  assert.ok(d.loop_seam.max_step_diff > 0, "the loop moves (pulse, bob), so the seam check measured motion");
  // each segment is exactly the full render's frames at the same scene time (ProRes is intra-only),
  // in colour; alpha is excluded, see framemd5 above
  const full = framemd5(out);
  for (const S of d.segments) assert.deepEqual(framemd5(S.output), full.slice(S.start_frame, S.start_frame + S.frames), S.name);
});

test("a loop composition edited so it does not close fails the seam check", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const req = base();
  req.layers[0].loop_animation = { type: "spin", period: 2, direction: "cw" };
  req.layers = [req.layers[0]];
  assert.equal(tool("scene", [writeJson(join(dir, "req.json"), req), "-o", join(dir, "scene"), "--json"]).code, 0);
  const loopHtml = join(dir, "scene", "segments", "loop.html");
  const html = readFileSync(loopHtml, "utf8");
  assert.ok(html.includes("hfs-name-loop 2s"));
  writeFileSync(loopHtml, html.replace("hfs-name-loop 2s", "hfs-name-loop 3s"));
  const r = tool("render", [join(dir, "scene"), "-o", join(dir, "sp.mp4"), "--segments", "--json"]);
  assert.equal(r.code, 1);
  assert.equal(r.doc.error.kind, "verification");
  assert.match(r.doc.error.message, /loop_seam/);
  assert.equal(r.doc.loop_seam.ok, false);
  assert.ok(r.doc.loop_seam.wrap_diff > r.doc.loop_seam.max_step_diff + 1, JSON.stringify(r.doc.loop_seam));
});
