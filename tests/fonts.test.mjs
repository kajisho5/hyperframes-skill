// Fonts shipped with the scene: request `fonts`, --font on template / batch, and doctor's
// fontconfig report. The font files used are ones the CI runners have (Linux: DejaVu; macOS:
// the system's Supplemental fonts); a machine with none of them fails loudly rather than skipping.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { which } from "../lib/deps.mjs";
import { renderHtml, validateRequest } from "../lib/scene-spec.mjs";
import { FIXTURES, frameRgb, SKIP_RENDER, tmp, tool, writeJson } from "./helpers.mjs";

const SERIF_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
  "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
  "/System/Library/Fonts/Supplemental/Georgia.ttf",
];

function serifFont() {
  const f = SERIF_CANDIDATES.find((p) => existsSync(p));
  assert.ok(f, `no test font found; looked for ${SERIF_CANDIDATES.join(", ")}`);
  return f;
}

function problems(req, dir = FIXTURES) {
  try {
    validateRequest(req, dir);
    return [];
  } catch (e) {
    return e.details.problems;
  }
}

const base = (fonts, family = "Test Serif") => ({
  scene_version: 1, width: 320, height: 180, duration: 0.2, fps: 10, background: "#ffffff", fonts,
  layers: [{ type: "text", id: "t", start: 0, duration: 0.2, text: "Hg Wy", style: { font_size: 80, color: "#000000", font_family: family } }],
});

test("fonts are validated: local files with a font extension, safe family names, weights", () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.otf"), "x");
  writeFileSync(join(dir, "a.txt"), "x");
  assert.deepEqual(problems(base([{ family: "Test Serif", src: "a.otf", weight: 700, style: "italic" }]), dir), []);
  assert.ok(problems(base([{ family: "X", src: "https://example.com/a.woff2" }]), dir).some((m) => m.includes("not a URL")));
  assert.ok(problems(base([{ family: "X", src: "a.txt" }]), dir).some((m) => m.includes("font extension")));
  assert.ok(problems(base([{ family: "X", src: "missing.ttf" }]), dir).some((m) => m.includes("no such file")));
  assert.ok(problems(base([{ family: 'X";}body{', src: "a.otf" }]), dir).some((m) => m.includes(".family must match")));
  assert.ok(problems(base([{ family: "X", src: "a.otf", weight: 650 }]), dir).some((m) => m.includes(".weight must be")));
  assert.ok(problems(base([{ family: "X", src: "a.otf", color: "red" }]), dir).some((m) => m.includes('unknown key "color"')));
});

test("a shipped font becomes an @font-face on a copied asset; weight omitted = every weight", () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.otf"), "x");
  writeFileSync(join(dir, "b.woff2"), "x");
  const html = renderHtml(validateRequest(base([{ family: "Test Serif", src: "a.otf" }, { family: "Test Serif", src: "b.woff2", weight: 700 }]), dir));
  assert.ok(html.includes('@font-face{font-family:"Test Serif";src:url("assets/fonts/font-1.otf");font-weight:100 900;font-style:normal}'));
  assert.ok(html.includes('@font-face{font-family:"Test Serif";src:url("assets/fonts/font-2.woff2");font-weight:700;font-style:normal}'));
});

test("scene copies the font, and hyperframes lint accepts the declared family", () => {
  const dir = tmp();
  const req = writeJson(join(dir, "req.json"), base([{ family: "Test Serif", src: serifFont() }]));
  const r = tool("scene", [req, "-o", join(dir, "scene"), "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.doc.verified, true);
  assert.ok(r.doc.verification.find((s) => s.step === "assets_copied").ok);
  assert.ok(r.doc.verification.find((s) => s.step === "hyperframes_lint").ok);
  assert.deepEqual(readFileSync(join(dir, "scene", "assets", "fonts", `font-1${serifFont().slice(-4)}`)), readFileSync(serifFont()));
});

test("the shipped font is what renders: pixels differ from the default font and repeat exactly", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const withFont = writeJson(join(dir, "with.json"), base([{ family: "Test Serif", src: serifFont() }]));
  const without = writeJson(join(dir, "without.json"), base(undefined, "sans-serif"));
  const frames = {};
  for (const [name, req] of [["with", withFont], ["without", without]]) {
    assert.equal(tool("scene", [req, "-o", join(dir, name), "--json"]).code, 0);
    const r = tool("render", [join(dir, name), "-o", join(dir, `${name}.mp4`), "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.doc.verified, true);
    frames[name] = frameRgb(join(dir, `${name}.mp4`), 0, 320, 180).data;
  }
  assert.notDeepEqual(frames.with, frames.without, "the shipped serif font must change the glyphs");
  const again = tool("render", [join(dir, "with"), "-o", join(dir, "with2.mp4"), "--json"]);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(frameRgb(join(dir, "with2.mp4"), 0, 320, 180).data, frames.with);
});

test("template --font ships the font and puts it first in every text layer's font list", () => {
  const dir = tmp();
  const r = tool("template", ["lower-third", "--set", "name=A", "--set", "affiliation=B", "--font", serifFont(), "-o", join(dir, "r.json"), "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.doc.request.fonts, [{ family: "HFS Custom", src: serifFont() }]);
  assert.deepEqual(r.doc.request.layers.map((L) => L.style.font_family), ["HFS Custom, sans-serif", "HFS Custom, sans-serif"]);
  const s = tool("scene", [join(dir, "r.json"), "-o", join(dir, "scene"), "--json"]);
  assert.equal(s.code, 0, s.stderr);
  assert.ok(s.doc.verification.find((x) => x.step === "hyperframes_lint").ok);
  const missing = tool("template", ["lower-third", "--set", "name=A", "--font", join(dir, "nope.otf"), "-o", join(dir, "x.json"), "--json"]);
  assert.equal(missing.doc.error.kind, "input");
});

test("batch --font copies the font into every row's scene", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const rows = writeJson(join(dir, "rows.json"), [{ message: "A", duration: 1 }, { message: "B", duration: 1 }]);
  const r = tool("batch", [rows, "--template", "break", "--font", serifFont(), "-o", join(dir, "out"), "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.doc.verified, true);
  for (const name of ["001", "002"]) assert.ok(existsSync(join(dir, "out", "scenes", name, "assets", "fonts", `font-1${serifFont().slice(-4)}`)), name);
});

test("doctor reports CJK font coverage as information, unknown without fontconfig", () => {
  const r = tool("doctor", ["--json", "--no-chromium-probe"]);
  for (const lang of ["ja", "zh-cn", "ko"]) assert.ok(["available", "missing", "unknown"].includes(r.doc.fonts.scripts[lang].status), lang);
  const nodeDir = dirname(process.execPath);
  const noFc = tool("doctor", ["--json", "--no-chromium-probe"], {
    env: { PATH: nodeDir, HYPERFRAMES_SKILL_FFMPEG: which("ffmpeg"), HYPERFRAMES_SKILL_FFPROBE: which("ffprobe") },
  });
  assert.equal(noFc.doc.fonts.scripts.ja.status, "unknown", "fontconfig absent is unknown, never missing");
  assert.equal(noFc.doc.ok, r.doc.ok, "fonts never change ok");
});
