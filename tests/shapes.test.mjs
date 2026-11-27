// Shape and pattern layers (roadmap step 9, docs/design-decisions.md D22).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { PATTERNS, rng } from "../lib/shapes.mjs";
import { renderHtml, validateRequest } from "../lib/scene-spec.mjs";
import { ffmpeg, FIXTURES, frameRgb, SKIP_RENDER, tmp, tool, writeJson } from "./helpers.mjs";

function problems(req) {
  try {
    validateRequest(req, FIXTURES);
    return [];
  } catch (e) {
    assert.equal(e.kind, "input", e.message);
    return e.details.problems;
  }
}
const scene = (layers, extra = {}) => ({ scene_version: 1, width: 320, height: 180, duration: 1, fps: 10, background: "#000000", ...extra, layers });
const pattern = (p, seed = 1, extra = {}) => ({ type: "pattern", id: "p", start: 0, duration: 1, pattern: p, seed, speed: 1, palette: ["#ff3366", "#33ccff", "#ffcc00"], ...extra });
const shape = (extra) => ({ type: "shape", id: "s", start: 0, duration: 1, box: { x: 40, y: 40, width: 100, height: 80 }, ...extra });

test("the seeded generator is the same everywhere", () => {
  const r = rng(42);
  assert.deepEqual([r(), r(), r()].map((x) => Number(x.toFixed(12))), [0.60110375192, 0.448290558998, 0.85246579349]);
  assert.notEqual(rng(1)(), rng(2)());
});

test("shapes: each figure is a static SVG of its box; fill, gradient, stroke and rotation come from the request", () => {
  const html = renderHtml(validateRequest(scene([
    shape({ id: "r", shape: "rounded_rect", radius: 12, fill: { type: "linear", angle: 90, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] }, stroke: { color: "#ffffff", width: 4 }, rotation: 15 }),
    shape({ id: "c", shape: "circle", fill: "#00ff00" }),
    shape({ id: "l", shape: "line", points: [[0, 0], [100, 80]], stroke: { color: "#ffffff", width: 3 } }),
    shape({ id: "h", shape: "polygon", sides: 6, fill: { type: "radial", stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] } }),
  ]), FIXTURES));
  assert.ok(html.includes('<linearGradient id="r-g" x1="0.5" y1="0" x2="0.5" y2="1"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>'), html);
  assert.ok(html.includes('<rect x="2" y="2" width="96" height="76" rx="12" ry="12" fill="url(#r-g)" stroke="#ffffff" stroke-width="4"/>'));
  assert.ok(html.includes("#r .hfs-s{position:absolute;inset:0;rotate:15deg}"));
  assert.ok(html.includes('<ellipse cx="50" cy="40" rx="50" ry="40" fill="#00ff00"/>'));
  assert.ok(html.includes('<line x1="0" y1="0" x2="100" y2="80" stroke="#ffffff" stroke-width="3" stroke-linecap="butt"/>'));
  assert.match(html, /<polygon points="50,0 [^"]+" fill="url\(#h-g\)" stroke-linejoin="miter"\/>/);
});

test("shape keyframes animate the inner box on the composition's clock", () => {
  const html = renderHtml(validateRequest(scene([shape({ start: 0.5, duration: 0.5, shape: "rect", fill: "#ff0000", keyframes: { position: [{ t: 0, value: [0, 0] }, { t: 0.5, value: [50, -20] }], opacity: [{ t: 0.25, value: 1 }] } })]), FIXTURES));
  assert.ok(html.includes("#s .hfs-k{position:absolute;inset:0;animation:hfs-s-kf-position 0.5s linear 0.5s 1 normal both,hfs-s-kf-opacity 0.5s linear 0.5s 1 normal both}"), html);
  assert.ok(html.includes("@keyframes hfs-s-kf-position{0%{translate:0px 0px}0%{translate:0px 0px}100%{translate:50px -20px}100%{translate:50px -20px}}"));
});

test("shapes and patterns are refused when they cannot be drawn as stated", () => {
  const p = (L) => problems(scene([L]));
  assert.ok(p(shape({ shape: "star", fill: "#fff" })).some((m) => m.includes(".shape must be one of rect, rounded_rect, circle, line, polygon")));
  assert.ok(p(shape({ shape: "rect" })).some((m) => m.includes("give fill, stroke or both")));
  assert.ok(p(shape({ shape: "rounded_rect", fill: "#fff" })).some((m) => m.includes("radius is required for a rounded_rect")));
  assert.ok(p(shape({ shape: "line", points: [[0, 0], [1, 1]] })).some((m) => m.includes("a line is drawn by its stroke")));
  assert.ok(p(shape({ shape: "polygon", fill: "#fff", points: [[0, 0], [1, 1]] })).some((m) => m.includes("points must be 3..64 points")));
  assert.ok(p(shape({ shape: "rect", fill: "red" })).some((m) => m.includes(".fill must be a colour or a gradient")));
  assert.ok(p(shape({ shape: "rect", fill: { type: "linear", stops: [{ offset: 0.5, color: "#fff" }, { offset: 0.2, color: "#000" }] } })).some((m) => m.includes("stops[1].offset must be 0..1, not below the stop before it")));
  assert.ok(p(shape({ shape: "rect", fill: "#fff", keyframes: { skew: [] } })).some((m) => m.includes('unknown key "skew"')));
  assert.ok(p(shape({ shape: "rect", fill: "#fff", style: "x" })).some((m) => m.includes('unknown key "style" for a shape layer')));
  assert.ok(p(pattern("waves")).some((m) => m.includes(".pattern must be one of grid, lines, dots, rings, polygons")));
  assert.ok(p(pattern("grid", 1.5)).some((m) => m.includes(".seed must be an integer")));
  assert.ok(p(pattern("grid", 1, { params: { count: 0 } })).some((m) => m.includes("params.count must be an integer 1..200")));
  assert.ok(p(pattern("grid", 1, { params: { css: "x" } })).some((m) => m.includes('unknown key "css" for a grid pattern (it takes count, line_width)')));
  assert.ok(p(pattern("dots", 1, { palette: ["red"] })).some((m) => m.includes(".palette must be 1..8 colours")));
});

test("a pattern in a seamless loop must complete whole cycles in it; a shape's keyframes must hold", () => {
  const seg = { segments: { in: 0.2, loop: 0.6, out: 0.2 } };
  assert.deepEqual(problems(scene([pattern("rings", 1, { speed: 5 })], seg)), []); // 0.2 s cycle, 3 per loop
  assert.ok(problems(scene([pattern("rings", 1, { speed: 4 })], seg)).some((m) => m.includes("the pattern's cycle (1 / speed = 0.25s) does not divide the loop segment's 0.6s")));
  assert.ok(problems(scene([shape({ shape: "rect", fill: "#fff", keyframes: { position: [{ t: 0, value: [0, 0] }, { t: 1, value: [10, 0] }] } })], seg)).some((m) => m.includes("keyframes.position changes inside the loop segment")));
  assert.deepEqual(problems(scene([shape({ shape: "rect", fill: "#fff", keyframes: { position: [{ t: 0, value: [0, 0] }, { t: 0.2, value: [10, 0] }, { t: 0.8, value: [10, 0] }, { t: 1, value: [0, 0] }] } })], seg)), []);
});

test("a changed seed changes the pattern's own markup and nothing else", () => {
  for (const name of PATTERNS) {
    const a = renderHtml(validateRequest(scene([{ type: "text", id: "t", start: 0, duration: 1, text: "x" }, pattern(name, 1)]), FIXTURES)).split("\n");
    const b = renderHtml(validateRequest(scene([{ type: "text", id: "t", start: 0, duration: 1, text: "x" }, pattern(name, 2)]), FIXTURES)).split("\n");
    assert.equal(a.length, b.length, name);
    const differ = a.map((l, i) => (l === b[i] ? null : l)).filter(Boolean);
    assert.ok(differ.length > 0, `${name}: the seed changes something`);
    assert.ok(differ.every((l) => /(#p[ .{]|hfs-p-|id="p")/.test(l)), `${name}: only the pattern's own lines differ:\n${differ.join("\n").slice(0, 400)}`);
  }
});

const framemd5 = (file) => ffmpeg(["-i", file, "-f", "framemd5", "-"]).toString().split("\n").filter((l) => l && !l.startsWith("#")).join("\n");

test("each pattern preset renders twice to the same framemd5; another seed renders another picture of the same file shape", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const render = (name, seed, tag) => {
    const sc = join(dir, `${name}-${tag}`);
    assert.equal(tool("scene", [writeJson(join(dir, `${name}-${tag}.json`), scene([pattern(name, seed, { duration: 0.5, box: { x: 0, y: 0, width: 320, height: 180 } })], { duration: 0.5 })), "-o", sc, "--json"]).code, 0);
    const out = join(dir, `${name}-${tag}.mp4`);
    const r = tool("render", [sc, "-o", out, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.doc.verified, true);
    return { out, probe: r.doc.probe };
  };
  for (const name of PATTERNS) {
    const a = render(name, 7, "a");
    const b = render(name, 7, "b");
    const c = render(name, 8, "c");
    assert.equal(framemd5(a.out), framemd5(b.out), `${name}: same seed, same frames`);
    assert.notEqual(framemd5(a.out), framemd5(c.out), `${name}: another seed, another picture`);
    const shapeOf = (p) => [p.video.width, p.video.height, p.video.frames, p.video.codec, p.video.fps, p.duration];
    assert.deepEqual(shapeOf(c.probe), shapeOf(a.probe), `${name}: and nothing else`);
  }
});

test("a shape moves, scales and fades as its keyframes say", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const req = scene([shape({ box: { x: 20, y: 50, width: 80, height: 80 }, shape: "rect", fill: "#ff0000", keyframes: { position: [{ t: 0, value: [0, 0] }, { t: 0.9, value: [180, 0] }] } })]);
  assert.equal(tool("scene", [writeJson(join(dir, "s.json"), req), "-o", join(dir, "scene"), "--json"]).code, 0);
  const out = join(dir, "s.mp4");
  assert.equal(tool("render", [join(dir, "scene"), "-o", out, "--json"]).code, 0);
  const centroid = (n) => {
    const f = frameRgb(out, n, 320, 180);
    let sx = 0;
    let c = 0;
    for (let i = 0; i < f.data.length; i += 3) {
      if (f.data[i] > 200 && f.data[i + 1] < 60 && f.data[i + 2] < 60) {
        sx += (i / 3) % 320;
        c++;
      }
    }
    return { x: sx / c, c };
  };
  const f0 = centroid(0);
  const f9 = centroid(9);
  assert.ok(Math.abs(f0.x - 60) < 2, JSON.stringify(f0));
  assert.ok(Math.abs(f9.x - 240) < 2, JSON.stringify(f9));
  assert.ok(Math.abs(f0.c - 6400) < 200 && Math.abs(f9.c - 6400) < 200, "the whole square both times");
});

test("patterns in a loop segment render a seamless loop", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const req = scene([pattern("lines", 3, { speed: 2.5, box: { x: 0, y: 0, width: 160, height: 180 } }), pattern("rings", 3, { id: "q", speed: 2.5, box: { x: 160, y: 0, width: 160, height: 180 } })], { duration: 1.2, segments: { in: 0.2, loop: 0.8, out: 0.2 } });
  assert.equal(tool("scene", [writeJson(join(dir, "l.json"), req), "-o", join(dir, "scene"), "--json"]).code, 0);
  const r = tool("render", [join(dir, "scene"), "-o", join(dir, "l.mp4"), "--segments", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.doc.loop_seam.ok, true, JSON.stringify(r.doc.loop_seam));
  assert.ok(r.doc.loop_seam.max_step_diff > 0, "it moves");
});
