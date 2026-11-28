// International typesetting and text fit (roadmap step 8, docs/design-decisions.md D21): a layer's own
// lang and direction, line-break rules (strict kinsoku, BudouX phrases), vertical writing and ruby, and
// fit: shrink measured in headless Chromium. Fit and render tests use tests/fixtures/fonts/hfs-test-blocks.ttf,
// whose glyphs are blocks of known advance, so sizes and breaks are the same on every OS.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseRuby, phraseParser, textDirection } from "../lib/typeset.mjs";
import { renderHtml, validateRequest } from "../lib/scene-spec.mjs";
import { FIXTURES, SKIP_RENDER, tmp, tool, writeJson } from "./helpers.mjs";

const FIT = join(FIXTURES, "typeset-fit.json");
const FONT = join(FIXTURES, "fonts", "hfs-test-blocks.ttf");
const fixture = () => JSON.parse(readFileSync(FIT, "utf8"));

function problems(req, dir = FIXTURES) {
  try {
    validateRequest(req, dir);
    return [];
  } catch (e) {
    assert.equal(e.kind, "input", e.message);
    return e.details.problems;
  }
}

const one = (layer, extra = {}) => ({
  scene_version: 1, width: 640, height: 360, duration: 0.2, fps: 10, ...extra,
  fonts: [{ family: "Blocks", src: "fonts/hfs-test-blocks.ttf" }],
  layers: [{ type: "text", id: "t", start: 0, duration: 0.2, text: "x", style: { font_family: "Blocks" }, ...layer }],
});

test("direction comes from the layer's language, or is stated", () => {
  assert.equal(textDirection({ direction: "auto" }, "ar"), "rtl");
  assert.equal(textDirection({ direction: "auto" }, "he-IL"), "rtl");
  assert.equal(textDirection({ direction: "auto" }, "fa"), "rtl");
  assert.equal(textDirection({ direction: "auto" }, "hi"), "ltr");
  assert.equal(textDirection({ direction: "ltr" }, "ar"), "ltr");
  const html = renderHtml(validateRequest(fixture(), FIXTURES));
  assert.match(html, /<div id="ar" class="clip" lang="ar" dir="rtl" /);
  assert.match(html, /<div id="hi" class="clip" lang="hi" data-start/);
  assert.match(html, /<div id="en" class="clip" data-start/, "the page's own language needs no attribute");
  assert.match(html, /<html lang="en">/);
  // a whole scene in Arabic: the layer runs right to left from the scene's lang
  const ar = renderHtml(validateRequest(one({ text: "مرحبا" }, { lang: "ar" }), FIXTURES));
  assert.match(ar, /<div id="t" class="clip" dir="rtl" /);
});

test("phrases: BudouX for ja / zh / th, refused elsewhere; Japanese breaks only between phrases", () => {
  assert.equal(phraseParser("ja").model, "ja");
  assert.equal(phraseParser("zh-TW").model, "zh-hant");
  assert.equal(phraseParser("zh").model, "zh-hans");
  assert.equal(phraseParser("en"), null);
  const html = renderHtml(validateRequest(fixture(), FIXTURES));
  // each phrase whole in a nowrap span (Thai and CJK alike), <wbr> between phrases
  assert.ok(html.includes('<span class="hfs-t"><span class="hfs-p">国際学会で</span><wbr><span class="hfs-p">基調講演を</span><wbr><span class="hfs-p">行います</span></span>'), html);
  assert.match(html, /#ja\{[^}]*word-break:keep-all/);
  assert.match(html, /#ja \.hfs-p\{white-space:nowrap\}/);
  const th = renderHtml(validateRequest(one({ lang: "th", text: "สวัสดีครับ ยินดีต้อนรับ", style: { font_family: "Blocks", phrases: true } }), FIXTURES));
  assert.match(th, /<span class="hfs-p">[^<]+<\/span><wbr>/);
  assert.match(th, /#t \.hfs-p\{white-space:nowrap\}/);
  assert.ok(problems(one({ lang: "en", text: "hello world", style: { font_family: "Blocks", phrases: true } })).some((m) => m.includes('BudouX has no model for "en"')));
});

test("ruby: {base|reading} becomes <ruby>; stray braces are refused; title text leaves the readings out", () => {
  assert.deepEqual(parseRuby("{東京|とうきょう}の空").parts, [{ base: "東京", ruby: "とうきょう" }, { text: "の空" }]);
  assert.match(parseRuby("a {b").error, /outside a complete/);
  assert.match(parseRuby("plain").error, /has no \{base\|reading\} group/);
  const req = one({ lang: "ja", text: "{東京|とうきょう}の{夜景|やけい}", style: { font_family: "Blocks", ruby: true, writing_mode: "vertical" } });
  const html = renderHtml(validateRequest(req, FIXTURES));
  assert.ok(html.includes('<span class="hfs-t"><ruby>東京<rt>とうきょう</rt></ruby>の<ruby>夜景<rt>やけい</rt></ruby></span>'));
  assert.match(html, /writing-mode:vertical-rl;text-orientation:mixed/);
  assert.ok(problems(one({ text: "{a|b} {c", style: { font_family: "Blocks", ruby: true } })).some((m) => m.includes("outside a complete {base|reading} group")));
  assert.ok(problems(one({ text: "{a|b}", style: { font_family: "Blocks", ruby: true }, transition_in: { type: "chars", duration: 0.1, stagger: 0 } })).some((m) => m.includes("ruby cannot be combined")));
});

test("line_break, writing_mode and direction take only their values; strict is CSS line-break", () => {
  const html = renderHtml(validateRequest(one({ lang: "ja", text: "あいうえおょ", style: { font_family: "Blocks", line_break: "strict" } }), FIXTURES));
  assert.match(html, /#t\{[^}]*;line-break:strict\}/);
  const p = problems(one({ style: { font_family: "Blocks", line_break: "kinsoku", writing_mode: "sideways", direction: "up", phrases: "yes" } }));
  for (const m of ["line_break must be one of normal, strict, loose", "writing_mode must be horizontal or vertical", "direction must be one of auto, ltr, rtl", "phrases must be true or false"]) assert.ok(p.some((x) => x.includes(m)), m);
  assert.ok(problems(one({ lang: "en_US" })).some((m) => m.includes("lang must be a BCP 47 tag")));
});

test("lang takes BCP 47 extension and private-use sequences; a singleton with nothing after it is refused", () => {
  for (const lang of ["de-DE-u-co-phonebk", "en-US-x-twain", "ja-JP-u-ca-japanese-x-private", "ar-u-nu-latn", "zh-Hant-TW", "en-x-a"]) {
    assert.deepEqual(problems(one({ lang })), [], lang);
    assert.deepEqual(problems(one({}, { lang })), [], `scene ${lang}`);
  }
  for (const lang of ["en-u", "en-x", "en-US-u", "de-u-co-x", "en--US", "e", "en-a-b"]) {
    assert.ok(problems(one({ lang })).some((m) => m.includes("lang must be a BCP 47 tag")), lang);
    assert.ok(problems(one({}, { lang })).some((m) => m.includes("lang must be a BCP 47 tag")), `scene ${lang}`);
  }
  // the primary subtag still decides direction and the phrase model
  assert.equal(textDirection({ direction: "auto" }, "ar-u-nu-latn"), "rtl");
  assert.equal(phraseParser("ja-JP-u-ca-japanese").model, "ja");
});

test("vertical writing is refused when the layer resolves to right to left, stated or from its lang", () => {
  const v = (lang, direction, extra = {}) => problems(one({ lang, text: "x", style: { font_family: "Blocks", writing_mode: "vertical", ...(direction ? { direction } : {}) } }, extra));
  assert.ok(v("ar").some((m) => m.includes("writing_mode vertical runs top to bottom; direction rtl (from lang ar) does not apply")));
  assert.ok(v("he", "auto").some((m) => m.includes("(from lang he)")));
  assert.ok(v("ja", "rtl").some((m) => m.includes("direction rtl does not apply")));
  assert.deepEqual(v("ja"), []);
  assert.deepEqual(v("ar", "ltr"), []);
  // a scene in Arabic: a vertical layer without its own lang inherits it
  assert.ok(problems(one({ text: "x", style: { font_family: "Blocks", writing_mode: "vertical" } }, { lang: "ar" })).some((m) => m.includes("(from lang ar)")));
});

test("a fitted layer next to a font entry whose family is not a string is an input problem, not a TypeError", () => {
  for (const family of [null, 123]) {
    const req = one({ fit: { mode: "shrink", min_font_size: 10 } });
    req.fonts.unshift({ family, src: "fonts/hfs-test-blocks.ttf" });
    const p = problems(req);
    assert.ok(p.some((m) => m.includes("fonts[0].family must match")), p.join("\n"));
  }
});

test("a CJK phrase longer than the line overflows whole instead of breaking inside it", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  // 40 px blocks: 国際学会で is 200 px, the box 80 px; before, overflow-wrap broke it after two characters
  const req = { scene_version: 1, width: 320, height: 180, duration: 0.1, fps: 10, lang: "ja", background: "#000000",
    fonts: [{ family: "Blocks", src: FONT }],
    layers: [{ type: "text", id: "t", start: 0, duration: 0.1, text: "国際学会で基調講演を", box: { x: 0, y: 0, width: 80, height: 180 }, style: { font_family: "Blocks", font_size: 40, align: "left", valign: "top", line_height: 1, phrases: true } }] };
  const s = tool("scene", [writeJson(join(dir, "r.json"), req), "-o", join(dir, "scene"), "--json"]);
  assert.equal(s.code, 0, s.stdout);
  const out = join(dir, "p.mp4");
  const r = tool("render", [join(dir, "scene"), "-o", out, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const img = grey(out, 320, 180);
  const first = ink(img, { x: 0, y: 0, width: 320, height: 40 });
  const second = ink(img, { x: 0, y: 40, width: 320, height: 40 });
  assert.ok(first.x1 >= 180, `the first line runs on past the box: ${JSON.stringify(first)}`);
  assert.ok(second.x1 >= 180, `the second phrase is whole on the next line: ${JSON.stringify(second)}`);
  assert.equal(ink(img, { x: 0, y: 80, width: 320, height: 100 }).n, 0, "nothing on a third line");
});

test("fit is refused unless it can be measured as rendered", () => {
  const fit = (f, extra = {}) => problems(one({ fit: f, ...extra }));
  assert.ok(fit({ mode: "ellipsis", min_font_size: 10 }).some((m) => m.includes("fit.mode must be shrink")));
  assert.ok(fit({ mode: "shrink" }).some((m) => m.includes("fit.min_font_size must be an integer >= 1")));
  assert.ok(fit({ mode: "shrink", min_font_size: 80 }).some((m) => m.includes("is larger than style.font_size (64)")));
  assert.ok(fit({ mode: "shrink", min_font_size: 10 }, { style: { font_family: "sans-serif" } }).some((m) => m.includes('style.font_family "sans-serif" must name a family shipped in fonts[]')));
  assert.ok(fit({ mode: "shrink", min_font_size: 10 }, { keyframes: { tracking: [{ t: 0, value: 2 }] } }).some((m) => m.includes("cannot be combined with tracking")));
  assert.deepEqual(fit({ mode: "shrink", min_font_size: 10 }), []);
});

test("dry run plans the fit without measuring; requests without the new keys keep their markup", () => {
  const dir = tmp();
  const r = tool("scene", [FIT, "-o", join(dir, "s"), "--dry-run", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.doc.text_fit.map((x) => [x.layer, x.font_size, x.given_font_size, x.min_font_size]), [["en", null, 48, 12], ["ar", null, 48, 12], ["hi", null, 48, 12], ["ja", null, 48, 12]]);
  // the pinned markup of requests without these keys (two-line, title-card) is checked by tests/scene.test.mjs
});

// frame 0 as grey, and the bounding box of its ink (pixels > 128) inside a rectangle
function grey(file, w, h) {
  const r = spawnSync(process.env.HYPERFRAMES_SKILL_FFMPEG || "ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, String(r.stderr));
  return { w, h, data: r.stdout };
}
function ink(img, { x, y, width, height }) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, n = 0;
  for (let j = Math.max(0, y); j < Math.min(img.h, y + height); j++) {
    for (let i = Math.max(0, x); i < Math.min(img.w, x + width); i++) {
      if (img.data[j * img.w + i] > 128) {
        n++;
        x0 = Math.min(x0, i), y0 = Math.min(y0, j), x1 = Math.max(x1, i), y1 = Math.max(y1, j);
      }
    }
  }
  return { n, x0, y0, x1, y1 };
}

test("English, Arabic (RTL), Hindi and Japanese shrink to fit their boxes; the reported size is the one in the HTML and the render stays inside", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const s = tool("scene", [FIT, "-o", join(dir, "scene"), "--json"]);
  assert.equal(s.code, 0, s.stdout);
  const fit = Object.fromEntries(s.doc.text_fit.map((r) => [r.layer, r]));
  // blocks: Latin advance 0.6 em, CJK 1 em, line height 1.2: two lines of 60 px boxes are 25 px, of a 100 px box 41 px
  assert.deepEqual(Object.values(fit).map((r) => [r.layer, r.font_size, r.shrunk, r.overflow_px]), [["en", 25, true, 0], ["ar", 25, true, 0], ["hi", 25, true, 0], ["ja", 33, true, 0]]);
  assert.deepEqual(fit.en.lines, ["Professor Alexandra", "Montgomery-Wellington"]);
  assert.deepEqual(fit.ja.lines, ["国際学会で", "基調講演を行います"], "Japanese breaks between BudouX phrases");
  assert.equal(fit.ar.lines.length, 2);
  assert.equal(fit.hi.lines.length, 2);
  assert.equal(s.doc.verification.find((x) => x.step === "text_fit").ok, true);
  const html = readFileSync(join(dir, "scene", "index.html"), "utf8");
  for (const r of Object.values(fit)) assert.match(html, new RegExp(`#${r.layer}\\{[^}]*;font-size:${r.font_size}px;`), r.layer);
  const out = join(dir, "fit.mp4");
  const rr = tool("render", [join(dir, "scene"), "-o", out, "--json"]);
  assert.equal(rr.code, 0, rr.stderr);
  const img = grey(out, 640, 360);
  const req = fixture();
  const total = ink(img, { x: 0, y: 0, width: 640, height: 360 }).n;
  let inside = 0;
  for (const L of req.layers) {
    const b = ink(img, L.box);
    assert.ok(b.n > 0, `${L.id} drew something`);
    inside += b.n;
  }
  assert.equal(inside, total, "no ink outside the boxes");
  // start alignment follows the direction: English hugs the left edge, Arabic the right
  const en = ink(img, req.layers[0].box);
  const ar = ink(img, req.layers[1].box);
  assert.ok(en.x0 - req.layers[0].box.x < 10, JSON.stringify(en));
  assert.ok(req.layers[1].box.x + req.layers[1].box.width - 1 - ar.x1 < 10, JSON.stringify(ar));
});

test("a text that does not fit at its minimum is an error with the overflow in pixels, and no scene is written", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const req = fixture();
  req.fonts[0].src = FONT;
  req.layers = [req.layers[0]];
  req.layers[0].fit.min_font_size = 40;
  const r = tool("scene", [writeJson(join(dir, "r.json"), req), "-o", join(dir, "scene"), "--json"]);
  assert.equal(r.code, 1);
  assert.equal(r.doc.error.kind, "input");
  // at 40 px (24 px a letter, 16 to the line): Professor / Alexandra / Montgomery- / Wellington, four lines of 48 px in a 60 px box
  assert.match(r.doc.error.message, /layer "en" overflows by 132 px at 40 px/);
  assert.deepEqual(r.doc.details.text_fit.map((x) => [x.layer, x.overflow_px, x.lines]), [["en", 132, ["Professor", "Alexandra", "Montgomery-", "Wellington"]]]);
  assert.equal(existsSync(join(dir, "scene")), false);
});

test("strict kinsoku keeps a small kana off the start of a line; vertical writing reports its columns", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const layer = (id, y, style) => ({ type: "text", id, start: 0, duration: 0.2, text: "あいうえおょかきくけ", box: { x: 0, y, width: 200, height: 160 }, style: { font_family: "Blocks", font_size: 40, align: "left", valign: "top", ...style }, fit: { mode: "shrink", min_font_size: 40 } });
  const req = {
    scene_version: 1, width: 640, height: 360, duration: 0.2, fps: 10, lang: "ja", background: "#000000",
    fonts: [{ family: "Blocks", src: FONT }],
    layers: [
      layer("normal", 0, {}),
      layer("strict", 180, { line_break: "strict" }),
      { type: "text", id: "tate", start: 0, duration: 0.2, text: "{東京|とうきょう}の夜景を縦書きで", box: { x: 460, y: 0, width: 180, height: 360 }, style: { font_family: "Blocks", font_size: 40, writing_mode: "vertical", ruby: true, valign: "top", align: "left" }, fit: { mode: "shrink", min_font_size: 20 } },
    ],
  };
  const s = tool("scene", [writeJson(join(dir, "r.json"), req), "-o", join(dir, "scene"), "--json"]);
  assert.equal(s.code, 0, s.stdout);
  const lines = Object.fromEntries(s.doc.text_fit.map((r) => [r.layer, r.lines]));
  assert.deepEqual(lines.normal, ["あいうえお", "ょかきくけ"], "normal line breaking lets ょ start a line");
  assert.deepEqual(lines.strict, ["あいうえ", "おょかきく", "け"], "strict carries the kana before it down");
  // a 360 px column: the ruby (5 x 20 px) widens 東京 to 100 px, then 5 x 40 px; columns from the right
  assert.deepEqual(lines.tate, ["東京の夜景を縦", "書きで"]);
  const out = join(dir, "k.mp4");
  assert.equal(tool("render", [join(dir, "scene"), "-o", out, "--json"]).code, 0);
  const img = grey(out, 640, 360);
  const tate = ink(img, req.layers[2].box);
  // two columns at the right of the box, the first full height; the ruby sits right of the first column
  assert.ok(tate.x1 > 600 && tate.x0 > 460, JSON.stringify(tate));
  assert.ok(tate.y1 - tate.y0 > 300, JSON.stringify(tate));
  assert.equal(s.doc.material, undefined);
});

test("template --fit shrinks caller text down to the template's minimum and title material carries the size used", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const reqFile = join(dir, "lt.json");
  const t = tool("template", ["lower-third", "--set", "name=Professor Alexandra Montgomery-Wellington III", "--set", "affiliation=Computational Linguistics", "--set", "duration=2", "--font", FONT, "--fit", "-o", reqFile, "--json"]);
  assert.equal(t.code, 0, t.stdout);
  const written = JSON.parse(readFileSync(reqFile, "utf8"));
  assert.deepEqual(written.layers.map((L) => [L.id, L.fit]), [["name", { mode: "shrink", min_font_size: 28 }], ["affiliation", { mode: "shrink", min_font_size: 20 }]]);
  const s = tool("scene", [reqFile, "-o", join(dir, "scene"), "--json"]);
  assert.equal(s.code, 0, s.stdout);
  const name = s.doc.text_fit.find((r) => r.layer === "name");
  assert.ok(name.shrunk && name.font_size < 56 && name.font_size >= 28, JSON.stringify(name));
  const aff = s.doc.text_fit.find((r) => r.layer === "affiliation");
  assert.deepEqual([aff.font_size, aff.shrunk], [36, false]);
  assert.deepEqual(s.doc.material.text.map((x) => [x.role, x.font_size]), [["name", name.font_size], ["affiliation", 36]]);
  // without a font there is nothing to measure in
  const nf = tool("template", ["lower-third", "--set", "name=A", "--fit", "-o", join(dir, "x.json"), "--json"]);
  assert.equal(nf.doc.error.kind, "input");
  assert.match(nf.doc.error.message, /--fit needs --font/);
  // without --fit the template's request is unchanged: no fit, no fit_min
  const plain = tool("template", ["lower-third", "--set", "name=A", "-o", join(dir, "p.json"), "--json"]);
  assert.equal(plain.code, 0);
  assert.equal(JSON.stringify(plain.doc.request).includes("fit"), false);
});
