// Stinger and title material (roadmap steps 15 and 17, design-decisions D14): the request keys,
// the template arithmetic, and the sidecars (stinger.json / title.json) checked against the rules
// of the Velisa spec for title and stinger metadata.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readAlphaFrames } from "../lib/alpha.mjs";
import { validateRequest } from "../lib/scene-spec.mjs";
import { buildSidecar, SIDECAR } from "../lib/sidecar.mjs";
import { fillTemplate, loadTemplate, resolveValues, TEMPLATE_DIR } from "../lib/template.mjs";
import { SKIP_RENDER, tmp, tool, writeJson } from "./helpers.mjs";

// The spec's field lists, written out here rather than imported, so lib/sidecar.mjs is checked
// against the spec and not against itself.
const SPEC = {
  stinger: { read: ["cut_point", "cover"], proposed: ["schema", "file", "sha256", "frame_rate", "cut_point_frame", "cover_frames", "alpha", "duration", "frames", "audio"] },
  title: { read: ["segments"], proposed: ["schema", "file", "sha256", "frame_rate", "alpha", "segment_frames", "loop_seam", "safe_area", "text"] },
};

const rate = (fr) => {
  const [n, d] = fr.split("/").map(Number);
  return n / d;
};
// "A time that names a frame must be on one: t * frame_rate within 1/1000 of a whole frame."
const onFrame = (t, fps) => Math.abs(t * fps - Math.round(t * fps)) <= 1e-3;

/** The spec's rules for a sidecar; returns the list of problems (empty = valid). */
function specProblems(kind, doc, { frames } = {}) {
  const p = [];
  const allowed = new Set([...SPEC[kind].read, ...SPEC[kind].proposed]);
  for (const k of Object.keys(doc)) if (!allowed.has(k)) p.push(`${k} is not a ${kind}.json field of the spec`);
  for (const k of SPEC[kind].read) if (!(k in doc)) p.push(`${k} (read by a receiver) is missing`);
  const fps = rate(doc.frame_rate);
  if (doc.schema !== `velisa/${kind}@1`) p.push(`schema ${doc.schema}`);
  if (doc.alpha !== undefined && !["straight", "premultiplied"].includes(doc.alpha)) p.push(`alpha ${doc.alpha}`);
  if (kind === "stinger") {
    const { cut_point: c, cover } = doc;
    if (typeof c !== "number" || !onFrame(c, fps)) p.push(`cut_point ${c} is not on a frame at ${doc.frame_rate}`);
    if (typeof cover?.start !== "number" || typeof cover?.end !== "number") p.push("cover is not {start, end}");
    else {
      if (!(cover.start <= c && c < cover.end)) p.push(`cut_point ${c} is not in [${cover.start}, ${cover.end})`);
      if (!onFrame(cover.start, fps) || !onFrame(cover.end, fps)) p.push("cover is not on frames");
    }
    if (doc.cut_point_frame !== Math.round(c * fps)) p.push(`cut_point_frame ${doc.cut_point_frame} != round(cut_point * frame_rate)`);
    if (c < 0 || c > 60) p.push("cut_point outside the agent's 0-60 s");
  } else {
    const S = doc.segments;
    const names = ["in", "loop", "out"];
    if (!S || names.some((n) => typeof S[n] !== "number" || S[n] < 0)) p.push("segments is not {in, loop, out} >= 0");
    else {
      for (const n of names) if (!onFrame(S[n], fps)) p.push(`segments.${n} is not whole frames`);
      if (frames !== undefined && names.reduce((a, n) => a + Math.round(S[n] * fps), 0) !== frames) p.push("segments do not add up to the clip");
      for (const n of names) if (doc.segment_frames && doc.segment_frames[n] !== Math.round(S[n] * fps)) p.push(`segment_frames.${n}`);
      if (S.in > 60 || S.out > 60) p.push("in / out over rendered_layer's 60 s");
    }
  }
  return p;
}

function problemsOf(req) {
  try {
    validateRequest(req, TEMPLATE_DIR);
    return [];
  } catch (e) {
    return e.details?.problems ?? [e.message];
  }
}

const base = (extra) => ({
  scene_version: 1, width: 320, height: 180, duration: 1.2, fps: 30, background: "transparent",
  layers: [{ type: "text", id: "t", start: 0, duration: 1.2, text: "x", box: { x: 20, y: 120, width: 200, height: 40 } }],
  ...extra,
});

test("stinger: each time on a frame, the cut point inside [start, end), the cover inside the scene", () => {
  assert.deepEqual(problemsOf(base({ stinger: { cut_point: 0.5, cover: { start: 0.5, end: 0.7 } } })), []);
  const cases = [
    [{ cut_point: 0.51, cover: { start: 0.5, end: 0.7 } }, "stinger.cut_point (0.51s) is not on a frame"],
    [{ cut_point: 0.7, cover: { start: 0.5, end: 0.7 } }, "outside the cover window"],
    [{ cut_point: 0.4, cover: { start: 0.5, end: 0.7 } }, "outside the cover window"],
    [{ cut_point: 0.5, cover: { start: 0.7, end: 0.5 } }, "must be before end"],
    [{ cut_point: 0.5, cover: { start: 0.5, end: 1.5 } }, "after the scene's duration"],
    [{ cut_point: 0.5 }, "stinger.cover must be an object"],
    [{ cut_point: 0.5, cover: { start: 0.5, end: 0.7 }, cut_at: 1 }, 'unknown key "cut_at"'],
  ];
  for (const [stinger, want] of cases) {
    const p = problemsOf(base({ stinger }));
    assert.ok(p.some((m) => m.includes(want)), `${JSON.stringify(stinger)}: ${want} in ${p.join(" / ")}`);
  }
  const both = problemsOf(base({ stinger: { cut_point: 0.5, cover: { start: 0.5, end: 0.7 } }, title: { safe_area: { x: 0, y: 0, width: 320, height: 180 } } }));
  assert.ok(both.some((m) => m.includes("not both")), both.join(" / "));
});

test("title: needs segments, and every text box inside the safe area", () => {
  const segments = { in: 0.2, loop: 0.8, out: 0.2 };
  assert.deepEqual(problemsOf(base({ segments, title: { safe_area: { x: 0, y: 100, width: 320, height: 80 } } })), []);
  const noSeg = problemsOf(base({ title: { safe_area: { x: 0, y: 100, width: 320, height: 80 } } }));
  assert.ok(noSeg.some((m) => m.includes("must declare segments")), noSeg.join(" / "));
  const outside = problemsOf(base({ segments, title: { safe_area: { x: 0, y: 0, width: 320, height: 100 } } }));
  assert.ok(outside.some((m) => m.includes('text layer "t"') && m.includes("not inside")), outside.join(" / "));
  const past = problemsOf(base({ segments, title: { safe_area: { x: 100, y: 100, width: 320, height: 80 } } }));
  assert.ok(past.some((m) => m.includes("extends past")), past.join(" / "));
});

test("stinger templates: enter over [0, cut_point), cover for the hold, exit over the rest, in whole frames", () => {
  for (const name of ["stinger-geometric", "stinger-glitch", "stinger-particles", "stinger-brush", "stinger-logo-reveal"]) {
    const t = loadTemplate(name);
    const given = name === "stinger-logo-reveal" ? { logo: join(TEMPLATE_DIR, "assets", "brush-stroke-a.svg") } : {};
    const { values, omitted } = resolveValues(t, given);
    const req = fillTemplate(t, values, omitted);
    assert.deepEqual(req.stinger, { cut_point: 0.5, cover: { start: 0.5, end: 0.7 } }, name);
    assert.equal(req.duration, 1.2, name);
    for (const L of req.layers) {
      assert.equal(L.transition_in.duration, 0.5, `${name}/${L.id}: enters until the cut point`);
      assert.equal(L.transition_out.duration, 0.5, `${name}/${L.id}: 1.2 - 0.5 - 0.2 is exactly 0.5 s, not 0.49999999999999994`);
      if (L.src) assert.ok(existsSync(L.src), `${name}/${L.id}: the template's own asset is an absolute path`);
    }
  }
  const t = loadTemplate("stinger-glitch");
  assert.throws(() => fillTemplate(t, resolveValues(t, { duration: 0.6 }).values, []), /exit .* comes to -3 frames/);
  assert.throws(() => fillTemplate(t, resolveValues(t, { cut_point: 0.51 }).values, []), /cut_point \(0\.51s\) is not on a frame/);
});

test("title templates declare segments from their transitions, on the frame grid", () => {
  const want = { "lower-third": [0.5, 7, 0.5], "title-card": [0.8, 3.4, 0.8], "session-slate": [0.6, 8.8, 0.6], break: [0, 10, 0] };
  const need = { "lower-third": { name: "A" }, "title-card": { title: "T" }, "session-slate": { session: "S", title: "T", speaker: "P" }, break: { message: "M" } };
  for (const [name, [i, l, o]] of Object.entries(want)) {
    const t = loadTemplate(name);
    const { values, omitted } = resolveValues(t, need[name]);
    const req = fillTemplate(t, values, omitted);
    assert.deepEqual(req.segments, { in: i, loop: l, out: o }, name);
    assert.ok(req.title.safe_area, name);
    validateRequest(req, TEMPLATE_DIR);
  }
  // a duration off the frame grid was already rendered as whole frames; the request now says so
  const t = loadTemplate("lower-third");
  const req = fillTemplate(t, resolveValues(t, { name: "A", duration: 7.05 }).values, ["affiliation"]);
  assert.equal(Math.round(req.duration * 30), 212);
  assert.equal(Math.round((req.segments.in + req.segments.loop + req.segments.out) * 30), 212);
});

test("sidecar fields are the spec's, and times are frame / frame_rate exactly (24 fps, frame 25)", () => {
  assert.deepEqual(SIDECAR.stinger.read, SPEC.stinger.read);
  assert.deepEqual(SIDECAR.stinger.proposed, SPEC.stinger.proposed);
  assert.deepEqual(SIDECAR.title.read, SPEC.title.read);
  assert.deepEqual(SIDECAR.title.proposed, SPEC.title.proposed);
  const plan = { output: join(tmp(), "absent.mov"), spec: { sequence: false }, codec: "prores", expected: { frames: 48 } };
  const doc = buildSidecar({ kind: "stinger", fps: 24, cut_point_frame: 25, cover_frames: { start: 24, end: 30 }, material: {} }, plan, { probe: { duration: 2, video: { frames: 48 } } });
  assert.equal(doc.cut_point, 25 / 24);
  assert.notEqual(doc.cut_point, 1.042);
  assert.ok(onFrame(doc.cut_point, 24) && !onFrame(1.042, 24), "1.042 s is frame 25.008, which a receiver refuses");
  assert.deepEqual(specProblems("stinger", doc), []);
  assert.equal(doc.sha256, undefined, "no file, no sha256");
  const title = buildSidecar({ kind: "title", fps: 24, segment_frames: { in: 13, loop: 48, out: 11 }, material: { safe_area: { x: 0, y: 0, width: 2, height: 2 }, text: [] } }, { ...plan, codec: "h264" }, { probe: null });
  assert.deepEqual(specProblems("title", title, { frames: 72 }), []);
  assert.equal(title.segments.in, 13 / 24);
  assert.equal(title.alpha, undefined, "h264 has no alpha plane, so no alpha mode");
});

test("render plans the sidecar: dry run names it, a stinger without alpha and an existing sidecar are refused", () => {
  const dir = tmp();
  const req = writeJson(join(dir, "r.json"), base({ stinger: { cut_point: 0.5, cover: { start: 0.5, end: 0.7 } } }));
  const s = tool("scene", [req, "-o", join(dir, "scene"), "--json"]);
  assert.equal(s.code, 0, s.stderr);
  assert.deepEqual(s.doc.material, { material_version: 1, kind: "stinger", fps: 30, cut_point_frame: 15, cover_frames: { start: 15, end: 21 } });
  assert.ok(s.doc.verification.some((v) => v.step === "material" && v.ok));
  const dry = tool("render", [join(dir, "scene"), "-o", join(dir, "st.mov"), "--codec", "prores", "--dry-run", "--json"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dry.doc.sidecar.path, join(dir, "st.stinger.json"));
  assert.deepEqual(dry.doc.sidecar.fields, SPEC.stinger);
  assert.ok(!existsSync(join(dir, "st.stinger.json")));
  const h264 = tool("render", [join(dir, "scene"), "-o", join(dir, "st.mp4"), "--dry-run", "--json"]);
  assert.equal(h264.doc.error.kind, "input");
  assert.match(h264.doc.error.message, /a stinger needs an alpha channel/);
  writeFileSync(join(dir, "st.stinger.json"), "{}");
  const exists = tool("render", [join(dir, "scene"), "-o", join(dir, "st.mov"), "--codec", "prores", "--dry-run", "--json"]);
  assert.equal(exists.doc.error.kind, "input");
  assert.match(exists.doc.error.message, /st\.stinger\.json/);
  const fps = tool("render", [join(dir, "scene"), "-o", join(dir, "st2.mov"), "--codec", "prores", "--fps", "25", "--dry-run", "--json"]);
  assert.equal(fps.doc.error.kind, "input");
  assert.match(fps.doc.error.message, /not on a frame at --fps 25/);
});

test("the default stinger: full cover from frame 15 (0.5 s at 30 fps), and stinger.json gives the same frame", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const req = join(dir, "st.json");
  assert.equal(tool("template", ["stinger-geometric", "--set", "duration=1.2", "--set", "cut_point=0.5", "-o", req, "--json"]).code, 0);
  assert.equal(tool("scene", [req, "-o", join(dir, "scene"), "--json"]).code, 0);
  const out = join(dir, "st.mov");
  const r = tool("render", [join(dir, "scene"), "-o", out, "--codec", "prores", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.doc.verified, true);
  assert.ok(r.doc.verification.some((s) => s.step === "stinger_cover" && s.ok));
  assert.deepEqual(r.doc.stinger.frames.map((f) => [f.frame, f.below]), [[15, 0], [16, 0], [17, 0], [18, 0], [19, 0], [20, 0]]);
  const sc = JSON.parse(readFileSync(join(dir, "st.stinger.json"), "utf8"));
  assert.deepEqual(sc, r.doc.sidecar.content);
  assert.deepEqual(specProblems("stinger", sc), []);
  assert.deepEqual([sc.cut_point, sc.cut_point_frame, sc.cover, sc.frame_rate, sc.frames, sc.alpha, sc.audio, sc.file], [0.5, 15, { start: 0.5, end: 0.7 }, "30/1", 36, "straight", false, "st.mov"]);
  // the cut point is the first covered frame: the frame before it still shows the picture underneath
  const before = readAlphaFrames({ record: () => ({}) }, out, r.doc.probe.video, 14, 15);
  assert.equal(before.measured, true);
  assert.ok(before.frames[0].below > 0, "frame 14 is not fully covered");
});

test("a lower third rendered with --segments writes title.json with its segments, frames and loop seam", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const req = join(dir, "lt.json");
  assert.equal(tool("template", ["lower-third", "--set", "name=Ada Lovelace", "--set", "duration=2", "-o", req, "--json"]).code, 0);
  assert.equal(tool("scene", [req, "-o", join(dir, "scene"), "--json"]).code, 0);
  const r = tool("render", [join(dir, "scene"), "-o", join(dir, "lt.mov"), "--codec", "prores", "--segments", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.doc.verified, true);
  const doc = JSON.parse(readFileSync(join(dir, "lt.title.json"), "utf8"));
  assert.deepEqual(specProblems("title", doc, { frames: r.doc.probe.video.frames }), []);
  assert.deepEqual(doc.segments, { in: 0.5, loop: 1, out: 0.5 });
  assert.deepEqual(doc.segment_frames, Object.fromEntries(r.doc.segments.map((S) => [S.name, S.probe.video.frames])));
  assert.deepEqual(doc.loop_seam, r.doc.loop_seam);
  assert.equal(doc.alpha, "straight");
  assert.deepEqual(doc.safe_area, { x: 120, y: 800, width: 1100, height: 154 });
  assert.deepEqual(doc.text, [{ role: "name", text: "Ada Lovelace", lang: "en", font: "sans-serif", font_size: 56 }]);
});
