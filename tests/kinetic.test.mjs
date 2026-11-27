// Kinetic typography (roadmap step 7, docs/design-decisions.md D20): unit reveals by grapheme cluster,
// word or line, mask wipes, and tracking / scale / variable-font keyframes. The renders use
// tests/fixtures/fonts/hfs-test-blocks.ttf (every glyph a block, combining marks above their base), so a
// drawn grapheme is one run of lit columns on every OS.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readAxes, textUnits, trackAt, trackConstant } from "../lib/kinetic.mjs";
import { renderHtml, validateRequest } from "../lib/scene-spec.mjs";
import { ffmpeg, FIXTURES, SKIP_RENDER, tmp, tool, writeJson } from "./helpers.mjs";

const FIXTURE = join(FIXTURES, "kinetic-chars.json");
const FONT = join(FIXTURES, "fonts", "hfs-test-blocks.ttf");
const base = () => JSON.parse(readFileSync(FIXTURE, "utf8"));
const units = (text, type, lang = "en") => textUnits(text, type, lang).filter((t) => t.unit).map((t) => t.text);

function problems(req, dir = FIXTURES) {
  try {
    validateRequest(req, dir);
    return [];
  } catch (e) {
    assert.equal(e.kind, "input", e.message);
    return e.details.problems;
  }
}

test("chars are extended grapheme clusters: combining marks, emoji sequences, flags, Indic and Thai clusters stay whole", () => {
  assert.deepEqual(units("éx̣̂", "chars"), ["é", "x̣̂"]);
  assert.deepEqual(units("👨‍👩‍👧 🇯🇵 👍🏽", "chars"), ["👨‍👩‍👧", "🇯🇵", "👍🏽"]);
  assert.deepEqual(units("क्षि", "chars", "hi"), ["क्षि"]);
  assert.deepEqual(units("ก้า", "chars", "th"), ["ก้", "า"]);
  // whitespace is never a unit; the graphemes of a word share its word index (no line break inside a word)
  const t = textUnits("ab cd", "chars", "en");
  assert.deepEqual(t.map((x) => [x.text, x.unit, x.word]), [["a", true, 0], ["b", true, 0], [" ", false, undefined], ["c", true, 2], ["d", true, 2]]);
});

test("words take punctuation with them; Japanese words come from the segmenter; lines split at line breaks", () => {
  assert.deepEqual(units("Hello, world! (yes)", "words"), ["Hello,", "world!", "(yes)"]);
  assert.deepEqual(units("今日は良い天気です。", "words", "ja").join(""), "今日は良い天気です。");
  assert.ok(units("今日は良い天気です。", "words", "ja").length > 1);
  assert.ok(units("今日は良い天気です。", "words", "ja").at(-1).endsWith("。"), "the full stop goes with the last word");
  assert.deepEqual(units("مرحبا بالعالم", "words", "ar"), ["مرحبا", "بالعالم"]);
  assert.deepEqual(units("a\nb c\n\nd", "lines"), ["a", "b c", "d"]);
});

test("the fixture: one unit per grapheme, delays offset by the layer's start, and the result reports them", () => {
  const s = validateRequest(base(), FIXTURES);
  const T = s.layers[0].transition_in;
  assert.deepEqual([T.type, T.units, T.span, T.effect], ["chars", 6, 0.6, "fade"]);
  const html = renderHtml(s);
  const spans = [...html.matchAll(/<span class="hfs-u" style="animation-delay:([^"]+)">([^<]*)<\/span>/g)];
  assert.deepEqual(spans.map((m) => m[2]), ["C", "é", "Å", "ก้", "M", "x̣̂"]);
  // HyperFrames seeks a unit on the composition's clock: the first starts at the layer's 0.3 s
  assert.deepEqual(spans.map((m) => m[1]), ["0.3s", "0.4s", "0.5s", "0.6s", "0.7s", "0.8s"]);
  assert.ok(html.includes("#t .hfs-u{display:inline;animation:hfs-t-uin 0.1s linear 0s 1 normal both;animation-play-state:paused}"));
  const dir = tmp();
  const r = tool("scene", [FIXTURE, "-o", join(dir, "s"), "--dry-run", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.doc.text_units, [{ layer: "t", edge: "in", type: "chars", units: 6, duration: 0.1, stagger: 0.1, span: 0.6 }]);
  // a request without a unit transition has no text_units key
  const plain = tool("scene", [join(FIXTURES, "two-line.json"), "-o", join(dir, "p"), "--dry-run", "--json"]);
  assert.equal("text_units" in plain.doc, false);
});

test("moving units are inline-blocks; in chars a word's graphemes sit in a no-wrap span", () => {
  const req = base();
  req.layers[0].text = "ab c";
  req.layers[0].transition_in = { type: "chars", duration: 0.1, stagger: 0.05, effect: "slide", direction: "down", distance: 20, easing: "ease_out" };
  req.layers[0].transition_out = { type: "chars", duration: 0.1, stagger: 0, effect: "zoom", scale: 2 };
  const html = renderHtml(validateRequest(req, FIXTURES));
  assert.ok(html.includes("#t .hfs-u{display:inline-block;animation:hfs-t-uin 0.1s ease-out 0s 1 normal both,hfs-t-uout 0.1s linear 0s 1 normal forwards;animation-play-state:paused}"));
  assert.ok(html.includes("@keyframes hfs-t-uin{from{opacity:0;transform:translate(0px,20px)}to{opacity:1;transform:translate(0px,0px)}}"));
  assert.ok(html.includes("@keyframes hfs-t-uout{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(2)}}"));
  // in: 0.3 + 0.05k; out: 0.3 + 1.3 - 0.1 (its span) + 0k
  assert.ok(html.includes('<span class="hfs-t"><span class="hfs-w"><span class="hfs-u" style="animation-delay:0.3s,1.5s">a</span><span class="hfs-u" style="animation-delay:0.35s,1.5s">b</span></span> <span class="hfs-w"><span class="hfs-u" style="animation-delay:0.4s,1.5s">c</span></span></span>'), html);
});

test("a wipe animates the layer's clip-path; any layer type takes it", () => {
  const req = base();
  req.layers[0].transition_in = { type: "wipe", duration: 0.5, direction: "right", easing: "ease_in_out" };
  req.layers[0].transition_out = { type: "wipe", duration: 0.25, direction: "up" };
  const html = renderHtml(validateRequest(req, FIXTURES));
  assert.ok(html.includes("@keyframes hfs-t-in{from{clip-path:inset(0px 100% 0px 0px)}to{clip-path:inset(0px 0px 0px 0px)}}"));
  assert.ok(html.includes("@keyframes hfs-t-out{from{clip-path:inset(0px 0px 0px 0px)}to{clip-path:inset(0px 0px 100% 0px)}}"));
  assert.ok(html.includes("animation:hfs-t-in 0.5s ease-in-out 0s 1 normal both,hfs-t-out 0.25s linear 1.05s 1 normal forwards"));
  assert.ok(!html.includes("hfs-u"), "a wipe is not a unit transition");
});

test("unit transitions are refused when they cannot run as stated", () => {
  const with_ = (T, extra = {}) => {
    const req = base();
    Object.assign(req.layers[0], extra);
    req.layers[0].transition_in = T;
    return problems(req);
  };
  assert.ok(with_({ type: "chars", duration: 0.1 }).some((m) => m.includes("transition_in.stagger must be a number of seconds >= 0")));
  assert.ok(with_({ type: "words", duration: 0.1, stagger: 0.1, effect: "slide" }).some((m) => m.includes("transition_in.direction must be one of")));
  assert.ok(with_({ type: "words", duration: 0.1, stagger: 0.1, scale: 2 }).some((m) => m.includes("scale is only for effect zoom")));
  assert.ok(with_({ type: "chars", duration: 0.1, stagger: 0.1, effect: "spin" }).some((m) => m.includes("effect must be one of fade, slide, zoom")));
  assert.ok(with_({ type: "chars", duration: 0.1, stagger: 0.1, order: "reverse" }).some((m) => m.includes('unknown key "order"')));
  // 6 units: 0.5 + 0.2 x 5 = 1.5 s > 1.3 s
  assert.ok(with_({ type: "chars", duration: 0.5, stagger: 0.2 }).some((m) => m.includes("its span (duration + stagger x 5 = 1.5s) is longer than the layer (1.3s)")));
  assert.ok(with_({ type: "chars", duration: 0.1, stagger: 0.1 }, { text: "   " }).some((m) => m.includes("no character to animate")));
  const req = base();
  req.layers[0].transition_in = { type: "chars", duration: 0.1, stagger: 0.1 };
  req.layers[0].transition_out = { type: "words", duration: 0.1, stagger: 0.1 };
  assert.ok(problems(req).some((m) => m.includes("transition_in is chars and transition_out is words")));
  req.layers[0].transition_out = { type: "chars", duration: 0.3, stagger: 0.1 };
  assert.ok(problems(req).some((m) => m.includes("transition_in.span + transition_out.span (1.4s) is longer than the layer (1.3s)")));
  // not on an image layer
  const img = { scene_version: 1, width: 64, height: 64, duration: 1, layers: [{ type: "image", id: "i", start: 0, duration: 1, src: "fonts/hfs-test-blocks.ttf", transition_in: { type: "chars", duration: 0.1, stagger: 0.1 } }] };
  assert.ok(problems(img).some((m) => m.includes("animates the units of a text; this is a image layer")));
  assert.ok(with_({ type: "wipe", duration: 0.2, direction: "diagonal" }).some((m) => m.includes("transition_in.direction must be one of left, right, up, down")));
});

test("keyframes: tracking, scale and font_variation become linear CSS animations over the layer", () => {
  const req = base();
  req.layers[0].keyframes = {
    tracking: [{ t: 0.2, value: 0 }, { t: 1.3, value: 26 }],
    scale: [{ t: 0, value: 1 }, { t: 0.65, value: 1.5 }],
    font_variation: { wght: [{ t: 0, value: 100 }, { t: 1.3, value: 900 }], wdth: [{ t: 0.65, value: 200 }] },
  };
  const s = validateRequest(req, FIXTURES);
  const html = renderHtml(s);
  assert.ok(html.includes("@keyframes hfs-t-kf-tracking{0%{letter-spacing:0px}15.384615%{letter-spacing:0px}100%{letter-spacing:26px}100%{letter-spacing:26px}}"), html);
  assert.ok(html.includes("@keyframes hfs-t-kf-scale{0%{scale:1}0%{scale:1}50%{scale:1.5}100%{scale:1.5}}"));
  // the axes' stops merged: every axis at 0, 0.65 and 1.3 s
  assert.ok(html.includes('@keyframes hfs-t-kf-axes{0%{font-variation-settings:"wdth" 200,"wght" 100}0%{font-variation-settings:"wdth" 200,"wght" 100}50%{font-variation-settings:"wdth" 200,"wght" 500}100%{font-variation-settings:"wdth" 200,"wght" 900}100%{font-variation-settings:"wdth" 200,"wght" 900}}'), html);
  assert.ok(html.includes("hfs-t-kf-tracking 1.3s linear 0s 1 normal both,hfs-t-kf-scale 1.3s linear 0s 1 normal both,hfs-t-kf-axes 1.3s linear 0s 1 normal both"));
  assert.equal(trackAt(s.layers[0].keyframes.tracking, 0.75), 13);
  assert.equal(trackConstant(s.layers[0].keyframes.tracking, 0, 0.2), true);
  assert.equal(trackConstant(s.layers[0].keyframes.tracking, 0, 0.3), false);
});

test("an unknown axis is refused with the font's real axes listed", () => {
  assert.deepEqual(readAxes(FONT).list, [{ tag: "wght", min: 100, max: 900, default: 400 }, { tag: "wdth", min: 50, max: 200, default: 100 }]);
  const kf = (font_variation, extra = {}) => {
    const req = base();
    Object.assign(req, extra);
    req.layers[0].keyframes = { font_variation };
    return problems(req);
  };
  const p = kf({ slnt: [{ t: 0, value: -10 }] });
  assert.ok(p.some((m) => m.includes(`the font "Blocks" (${FONT}) has no slnt axis; its axes are wght 100..900 (default 400), wdth 50..200 (default 100)`)), p.join("\n"));
  assert.ok(kf({ wght: [{ t: 0, value: 1000 }] }).some((m) => m.includes("1000 is outside the font's wght 100..900 (default 400)")));
  assert.ok(kf({ "wg ht": [{ t: 0, value: 400 }] }).some((m) => m.includes("an axis tag is four letters or digits")));
  // the family must be shipped: only a file says which axes exist
  const req = base();
  req.layers[0].style.font_family = "sans-serif";
  req.layers[0].keyframes = { font_variation: { wght: [{ t: 0, value: 700 }] } };
  assert.ok(problems(req).some((m) => m.includes('style.font_family "sans-serif" must name a family shipped in fonts[]')));
});

test("keyframes are refused when their stops are out of order, outside the layer, or clash with pulse", () => {
  const kf = (K, extra = {}) => {
    const req = base();
    Object.assign(req.layers[0], extra);
    req.layers[0].keyframes = K;
    return problems(req);
  };
  assert.ok(kf({ tracking: [{ t: 0.5, value: 1 }, { t: 0.5, value: 2 }] }).some((m) => m.includes("tracking[1].t must be later than the stop before it")));
  assert.ok(kf({ tracking: [{ t: 2, value: 1 }] }).some((m) => m.includes("tracking[0].t 2s is after the layer's end (1.3s)")));
  assert.ok(kf({ scale: [{ t: 0, value: 0 }] }).some((m) => m.includes("must be a number > 0 and <= 100")));
  assert.ok(kf({ skew: [] }).some((m) => m.includes('unknown key "skew"')));
  assert.ok(kf({ scale: [{ t: 0, value: 2 }] }, { loop_animation: { type: "pulse", period: 1, scale: 1.1 } }).some((m) => m.includes("scale and loop_animation pulse both set the scale")));
});

test("a seamless loop refuses keyframes that change inside it and unit reveals that run into it", () => {
  const req = {
    scene_version: 1, width: 320, height: 180, duration: 3, fps: 10, segments: { in: 1, loop: 1, out: 1 },
    fonts: [{ family: "Blocks", src: "fonts/hfs-test-blocks.ttf" }],
    layers: [{ type: "text", id: "t", start: 0, duration: 3, text: "abc", style: { font_family: "Blocks" } }],
  };
  const L = req.layers[0];
  L.keyframes = { tracking: [{ t: 0, value: 0 }, { t: 1, value: 10 }, { t: 2, value: 10 }, { t: 3, value: 0 }] };
  L.transition_in = { type: "chars", duration: 0.4, stagger: 0.3 };
  assert.deepEqual(problems(req), []); // span 1.0 s ends at the loop's start; tracking holds through it
  L.keyframes.tracking[2].value = 12;
  assert.ok(problems(req).some((m) => m.includes("keyframes.tracking changes inside the loop segment")));
  L.keyframes.tracking[2].value = 10;
  L.transition_in.stagger = 0.35;
  assert.ok(problems(req).some((m) => m.includes("transition_in runs until 1.1s, inside the loop segment")));
});

// frame-by-frame grey decode: the number of runs of lit columns per frame, and the framemd5
function decode(file, w, h) {
  const r = spawnSync(process.env.HYPERFRAMES_SKILL_FFMPEG || "ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, String(r.stderr));
  const frames = [];
  for (let f = 0; f < r.stdout.length / (w * h); f++) {
    let runs = 0;
    let prev = false;
    let ink = 0;
    for (let x = 0; x < w; x++) {
      let lit = false;
      for (let y = 0; y < h; y++) if (r.stdout[f * w * h + y * w + x] > 128) (lit = true), ink++;
      if (lit && !prev) runs++;
      prev = lit;
    }
    frames.push({ runs, ink });
  }
  return frames;
}
const framemd5 = (file) => ffmpeg(["-i", file, "-f", "framemd5", "-"]).toString().split("\n").filter((l) => l && !l.startsWith("#")).join("\n");

test("a per-character reveal renders the expected grapheme count per frame, framemd5 stable across two runs", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const s = tool("scene", [FIXTURE, "-o", join(dir, "scene"), "--json"]);
  assert.equal(s.code, 0, s.stderr);
  const outs = ["a.mp4", "b.mp4"].map((n) => join(dir, n));
  for (const out of outs) {
    const r = tool("render", [join(dir, "scene"), "-o", out, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.doc.verified, true, JSON.stringify(r.doc.verification));
  }
  // the layer starts at frame 3 and unit k is fully shown from frame 4 + k (duration = stagger = one frame)
  const expected = Array.from({ length: 16 }, (_, f) => Math.max(0, Math.min(6, f - 3)));
  assert.deepEqual(decode(outs[0], 320, 180).map((F) => F.runs), expected);
  assert.equal(framemd5(outs[0]), framemd5(outs[1]));
});

test("tracking and a variable-font axis change the picture over the layer; a wipe uncovers it from one side", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const req = base();
  req.duration = 1;
  req.fonts[0].src = FONT;
  req.layers = [
    { type: "text", id: "w", start: 0, duration: 1, text: "ABCD", box: { x: 0, y: 0, width: 320, height: 90 }, style: { font_family: "Blocks", font_size: 40 }, keyframes: { tracking: [{ t: 0, value: 0 }, { t: 0.9, value: 20 }], font_variation: { wght: [{ t: 0, value: 100 }, { t: 0.9, value: 900 }] } } },
    { type: "text", id: "m", start: 0, duration: 1, text: " ", box: { x: 0, y: 90, width: 320, height: 90 }, style: { background: "#ffffff" }, transition_in: { type: "wipe", duration: 0.8, direction: "right" } },
  ];
  const sc = tool("scene", [writeJson(join(dir, "r.json"), req), "-o", join(dir, "scene"), "--json"]);
  assert.equal(sc.code, 0, sc.stdout);
  const out = join(dir, "k.mp4");
  const r = tool("render", [join(dir, "scene"), "-o", out, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  // top half: four blocks, thin and close at frame 0, wide and spread at frame 9
  const top = decode(ffmpegCrop(out, dir, "0:0:320:90"), 320, 90);
  assert.deepEqual([top[0].runs, top[9].runs], [4, 4]);
  assert.ok(top[9].ink > top[0].ink * 3, `wght 900 draws more than wght 100: ${top[0].ink} -> ${top[9].ink}`);
  // bottom half: the white box is uncovered left to right, half of it at 0.4 s
  const bottom = decode(ffmpegCrop(out, dir, "0:90:320:90"), 320, 90);
  assert.equal(bottom[0].ink, 0);
  assert.ok(Math.abs(bottom[4].ink / (320 * 90) - 0.5) < 0.02, String(bottom[4].ink));
  assert.equal(bottom[8].ink, 320 * 90);
});

function ffmpegCrop(file, dir, crop) {
  const [x, y, w, h] = crop.split(":");
  const out = join(dir, `crop-${x}-${y}.mkv`);
  ffmpeg(["-y", "-i", file, "-vf", `crop=${w}:${h}:${x}:${y}`, "-c:v", "ffv1", out]);
  return out;
}
