// scene: request validation and markup generation. No Chrome, no ffmpeg (lint runs node only).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readDeclared, renderHtml, setRootAttr, validateRequest } from "../lib/scene-spec.mjs";
import { FIXTURES, listTree, tmp, tool, writeJson } from "./helpers.mjs";

const base = () => JSON.parse(readFileSync(join(FIXTURES, "two-line.json"), "utf8"));

function problems(req, dir = FIXTURES) {
  try {
    validateRequest(req, dir);
    return [];
  } catch (e) {
    assert.equal(e.kind, "input");
    return e.details.problems;
  }
}

test("the two-line fixture is valid and normalizes with defaults", () => {
  const s = validateRequest(base(), FIXTURES);
  assert.equal(s.layers.length, 2);
  assert.equal(s.layers[0].style.font_family, "sans-serif");
  assert.equal(s.layers[1].style.color, "#ffcc00");
  assert.deepEqual(s.layers[0].box, { x: 0, y: 0, width: 320, height: 180 });
});

test("every problem in a request is reported, not just the first", () => {
  const req = base();
  req.width = 321;
  req.fps = 0;
  req.layers[1].start = 0.9; // 0.9 + 0.5 > 1
  req.layers[0].id = "line2"; // duplicate
  req.extra = true;
  const p = problems(req);
  assert.ok(p.some((m) => m.startsWith("width must be an even integer")), p.join("\n"));
  assert.ok(p.some((m) => m.startsWith("fps must be an integer")));
  assert.ok(p.some((m) => m.includes("after the scene's duration")));
  assert.ok(p.some((m) => m.includes("is used twice")));
  assert.ok(p.some((m) => m === 'unknown key "extra"'));
});

test("layer timing bounds are compared exactly, not in floating point", () => {
  const req = base();
  req.duration = 0.3;
  req.layers = [{ type: "text", id: "a", start: 0.1, duration: 0.2, text: "x" }];
  assert.deepEqual(problems(req), []);
});

test("colours and font families that could break out of the style block are refused", () => {
  for (const bad of ["red;}body{display:none", "url(x)", "#12345", "expression(alert(1))"]) {
    const req = base();
    req.layers[0].style.color = bad;
    assert.ok(problems(req).some((m) => m.includes("style.color must be a colour")), bad);
  }
  const req = base();
  req.layers[0].style.font_family = "Inter;}*{color:red";
  assert.ok(problems(req).some((m) => m.includes("font_family")));
});

test("text is HTML-escaped, never interpreted as markup", () => {
  const req = base();
  req.layers[0].text = `<script>alert("x")</script> & 'q'`;
  const html = renderHtml(validateRequest(req, FIXTURES));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;"));
});

test("media src must be an existing local file with a known extension; URLs are refused", () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.png"), "not really a png");
  const layer = (src) => ({ scene_version: 1, width: 64, height: 64, duration: 1, layers: [{ type: "image", id: "img", start: 0, duration: 1, src }] });
  assert.deepEqual(problems(layer("a.png"), dir), []);
  assert.ok(problems(layer("https://example.com/a.png"), dir).some((m) => m.includes("not a URL")));
  assert.ok(problems(layer("missing.png"), dir).some((m) => m.includes("no such file")));
  assert.ok(problems(layer("a.txt"), dir).some((m) => m.includes("extension must be one of")));
});

test("markup is deterministic and declares what the request declared", () => {
  const s = validateRequest(base(), FIXTURES);
  const a = renderHtml(s);
  assert.equal(a, renderHtml(validateRequest(base(), FIXTURES)));
  const d = readDeclared(a, "x");
  assert.deepEqual([d.id, d.width, d.height, d.duration, d.fps], ["two-line", 320, 180, 1, 30]);
  assert.match(a, /data-no-timeline/);
  assert.match(a, /<div id="line2" class="clip" data-start="0.5" data-duration="0.5" data-track-index="1">Line two<\/div>/);
});

test("readDeclared refuses a root without numeric size/duration", () => {
  assert.throws(() => readDeclared('<div data-composition-id="m" data-width="10"></div>', "f"), (e) => e.kind === "input" && /data-height, data-duration/.test(e.message));
  assert.throws(() => readDeclared("<div></div>", "f"), (e) => e.kind === "input");
});

test("setRootAttr rewrites only the root tag", () => {
  const html = '<div id="root" data-composition-id="m" data-duration="4" data-width="2" data-height="2"><div data-duration="4"></div></div>';
  const d = readDeclared(html, "f");
  const { html: out } = setRootAttr(html, d, "data-duration", "1.5");
  assert.equal(out, '<div id="root" data-composition-id="m" data-duration="1.5" data-width="2" data-height="2"><div data-duration="4"></div></div>');
});

test("scene writes index.html, verifies it (lint included) and is byte-identical on a re-run", () => {
  const dir = tmp();
  const r = tool("scene", [join(FIXTURES, "two-line.json"), "-o", join(dir, "s"), "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.doc.status, "completed");
  assert.equal(r.doc.verified, true);
  assert.deepEqual(r.doc.verification.map((s) => s.step), ["exists", "declared_values", "hyperframes_lint"]);
  assert.deepEqual(r.doc.expected, { width: 320, height: 180, duration: 1, fps: 30, frames: 30 });
  assert.equal(r.doc.commands.length, 1);
  assert.deepEqual(r.doc.commands[0].argv.slice(2, 3), ["lint"]);
  const first = readFileSync(join(dir, "s", "index.html"), "utf8");
  const again = tool("scene", [join(FIXTURES, "two-line.json"), "-o", join(dir, "s"), "--overwrite", "--json"]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(readFileSync(join(dir, "s", "index.html"), "utf8"), first);
});

test("scene copies assets and verifies the copies", () => {
  const dir = tmp();
  writeFileSync(join(dir, "logo.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  const req = writeJson(join(dir, "req.json"), { scene_version: 1, width: 64, height: 64, duration: 1, layers: [{ type: "image", id: "logo", start: 0, duration: 1, src: "logo.png" }] });
  const r = tool("scene", [req, "-o", join(dir, "out"), "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.doc.verification.find((s) => s.step === "assets_copied").ok);
  assert.deepEqual(listTree(join(dir, "out")), ["assets/", "assets/logo.png", "index.html"]);
});

test("scene refuses a non-empty directory it did not write, even with --overwrite", () => {
  const dir = tmp();
  mkdirSync(join(dir, "o"));
  writeFileSync(join(dir, "o", "keep.txt"), "user data");
  const r = tool("scene", [join(FIXTURES, "two-line.json"), "-o", join(dir, "o"), "--json"]);
  assert.equal(r.code, 1);
  assert.equal(r.doc.error.kind, "input");
  const o = tool("scene", [join(FIXTURES, "two-line.json"), "-o", join(dir, "o"), "--overwrite", "--json"]);
  assert.equal(o.code, 1);
  assert.match(o.doc.error.message, /--overwrite refused/);
  assert.deepEqual(listTree(join(dir, "o")), ["keep.txt"]);
});

test("an invalid request fails with kind input, exit 1, and writes nothing", () => {
  const dir = tmp();
  const req = writeJson(join(dir, "bad.json"), { scene_version: 1, width: 10, height: 10, duration: 1, layers: [] });
  const r = tool("scene", [req, "-o", join(dir, "out"), "--json"]);
  assert.equal(r.code, 1);
  assert.equal(r.doc.status, "failed");
  assert.equal(r.doc.error.kind, "input");
  assert.equal(r.doc.error.retryable, false);
  assert.equal(r.doc.verified, false);
  assert.ok(!existsSync(join(dir, "out")));
});

// scene_version 1 promise (docs/contract.md): a request that validated before keeps rendering the
// same markup. Transitions (0.2.0) are additive: without them, the bytes are the 0.1.0 bytes.
test("markup of pre-transition requests is byte-identical to the 0.1.0 snapshots", () => {
  for (const [req, snap] of [
    [join(FIXTURES, "two-line.json"), join(FIXTURES, "two-line.index.html")],
    [join(FIXTURES, "..", "..", "demos", "title-card", "request.json"), join(FIXTURES, "title-card.index.html")],
  ]) {
    const html = renderHtml(validateRequest(JSON.parse(readFileSync(req, "utf8")), join(req, "..")));
    assert.equal(html, readFileSync(snap, "utf8"), snap);
  }
});

test("transitions become clip-local CSS animations: in at 0s, out at duration - out", () => {
  const html = renderHtml(validateRequest(JSON.parse(readFileSync(join(FIXTURES, "transitions.json"), "utf8")), FIXTURES));
  assert.ok(html.includes("animation:hfs-left-in 0.5s linear 0s 1 normal both,hfs-left-out 0.5s linear 1.5s 1 normal forwards"));
  assert.ok(html.includes("@keyframes hfs-right-in{from{opacity:0;transform:translate(0px,-180px)}to{opacity:1;transform:translate(0px,0px)}}"));
  assert.ok(html.includes("animation:hfs-right-in 0.5s ease-out 0s 1 normal both"));
  const zoom = validateRequest({ scene_version: 1, width: 64, height: 64, duration: 1, layers: [{ type: "text", id: "z", start: 0, duration: 1, text: "z", transition_out: { type: "zoom", duration: 0.25, scale: 1.5, easing: "ease_in" } }] }, FIXTURES);
  const zh = renderHtml(zoom);
  assert.ok(zh.includes("animation:hfs-z-out 0.25s ease-in 0.75s 1 normal forwards"));
  assert.ok(zh.includes("@keyframes hfs-z-out{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(1.5)}}"));
});

test("transition values are validated, never defaulted except easing", () => {
  const layer = (extra) => ({ scene_version: 1, width: 64, height: 64, duration: 1, layers: [{ type: "text", id: "t", start: 0, duration: 1, text: "t", ...extra }] });
  assert.ok(problems(layer({ transition_in: { type: "slide", duration: 0.5 } })).some((m) => m.includes("direction must be one of")));
  assert.ok(problems(layer({ transition_in: { type: "slide", duration: 0.5, direction: "left" } })).some((m) => m.includes("distance must be a positive integer")));
  assert.ok(problems(layer({ transition_in: { type: "zoom", duration: 0.5 } })).some((m) => m.includes("scale must be")));
  assert.ok(problems(layer({ transition_in: { type: "spin", duration: 0.5 } })).some((m) => m.includes("type must be one of fade, slide, zoom")));
  assert.ok(problems(layer({ transition_in: { type: "fade", duration: 0.5, easing: "bounce" } })).some((m) => m.includes("easing must be one of")));
  assert.ok(problems(layer({ transition_in: { type: "fade", duration: 0.5, distance: 3 } })).some((m) => m.includes('unknown key "distance" for a fade transition')));
  assert.ok(problems(layer({ transition_in: { type: "fade", duration: 0.6 }, transition_out: { type: "fade", duration: 0.5 } })).some((m) => m.includes("is longer than the layer")));
  assert.deepEqual(problems(layer({ transition_in: { type: "fade", duration: 0.5 }, transition_out: { type: "fade", duration: 0.5 } })), []);
});
