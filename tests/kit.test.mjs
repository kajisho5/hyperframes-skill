// Brand input (roadmap step 16, design-decisions D15): --kit on template and batch maps a Velisa
// kit@1 / ffmpeg-skill brand.json onto a template's typed values. Explicit values win, only what the
// kit states is used, and every field the kit has is reported as applied, overridden or unused.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyKit, loadKit } from "../lib/kit.mjs";
import { listTemplates, loadTemplate } from "../lib/template.mjs";
import { ffmpeg, frameRgb, ROOT, SKIP_RENDER, tmp, tool, writeJson } from "./helpers.mjs";

const SERIF_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
  "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
  "/System/Library/Fonts/Supplemental/Georgia.ttf",
  "C:\\Windows\\Fonts\\georgia.ttf",
  "C:\\Windows\\Fonts\\times.ttf",
];
function serifFont() {
  const f = SERIF_CANDIDATES.find((p) => existsSync(p));
  assert.ok(f, `no test font found; looked for ${SERIF_CANDIDATES.join(", ")}`);
  return f;
}

const LOGO = join(ROOT, "demos", "title-card", "logo.svg");

// a full kit@1: the brand.json keys plus the proposed ones
function fullKit(dir) {
  mkdirSync(join(dir, "brand"), { recursive: true });
  writeFileSync(join(dir, "brand", "logo.svg"), readFileSync(LOGO));
  return writeJson(join(dir, "kit.json"), {
    schema: "velisa/kit@1",
    name: "Test brand",
    font: "Test Serif",
    font_file: serifFont(),
    colors: { primary: "FFD200", secondary: "1E6F8E", text: "F0F0F0", outline: "000000", background: "203040", accent: "#E84855" },
    logo: "brand/logo.svg",
    logo_position: "top-right",
    logo_scale: 160,
    logo_opacity: 0.9,
    safe_margin: 48,
    lang: "en",
    styles: { caption: { font: "Test Serif", size: 30 } },
    caption: { size: 26 },
    loudness: { lufs: -14, tp: -1 },
    fonts: [{ family: "Test Serif", file: "x.ttf", licence: "OFL", embedding: true }],
    logo_variants: { mono: "brand/mono.svg" },
    contrast: [{ fg: "FFFFFF", bg: "203040", ratio: 12.6 }],
  });
}

const fieldsOf = (K) => [...Object.keys(K.kit).filter((k) => !["schema", "colors", "colours"].includes(k)), ...Object.keys(K.colors).map((r) => `${K.colorsKey}.${r}`)].sort();
const reported = (r) => [...r.applied, ...r.overridden, ...r.unused].map((x) => x.field).sort();

test("every template's kit map names its own colour or logo values", () => {
  for (const t of listTemplates()) {
    for (const [k, field] of Object.entries(t.kit ?? {})) {
      assert.ok(k in t.values, `${t.name}: ${k}`);
      assert.equal(t.values[k].type, field === "logo" ? "string" : "color", `${t.name}: ${k} <- ${field}`);
    }
  }
  assert.deepEqual(loadTemplate("title-card").kit, { background: "colors.background" });
  assert.deepEqual(loadTemplate("stinger-logo-reveal").kit, { logo: "logo", background: "colors.background", text_color: "colors.text" });
  assert.equal(loadTemplate("lower-third").kit, undefined, "a template with no colour, logo or font value maps nothing");
});

test("a full kit: mapped fields applied, everything else reported once with a reason", () => {
  const dir = tmp("hfs-kit-");
  const K = loadKit(fullKit(dir));
  for (const t of listTemplates()) {
    const { given, report } = applyKit(t, K, {});
    assert.deepEqual(reported(report), fieldsOf(K), `${t.name}: every kit field is in exactly one list`);
    for (const u of report.unused) assert.ok(u.reason.length > 10, `${t.name}: ${u.field} has a reason`);
    for (const a of report.applied) if (a.to !== "--font") assert.equal(given[a.to], a.value, `${t.name}: ${a.field}`);
    for (const k of Object.keys(given)) assert.ok(k in (t.kit ?? {}), `${t.name}: only mapped values are filled (${k})`);
  }
  const ss = applyKit(loadTemplate("stinger-logo-reveal"), K, { text: "Hello" });
  assert.deepEqual(ss.given, { text: "Hello", logo: join(dir, "brand", "logo.svg"), background: "#203040", text_color: "#F0F0F0" });
  assert.equal(ss.font, serifFont());
  const slate = applyKit(loadTemplate("session-slate"), K, {}).given;
  assert.equal(slate.accent, "#E84855", "a leading # is accepted and kept");
});

test("explicit values and --font win over the kit; the kit fills nothing it lacks", () => {
  const K = loadKit(fullKit(tmp("hfs-kit-")));
  const r = applyKit(loadTemplate("session-slate"), K, { accent: "#00ff00" }, { font: "/x/given.otf" });
  assert.equal(r.given.accent, "#00ff00");
  assert.equal(r.given.background, "#203040");
  assert.equal(r.font, "/x/given.otf");
  assert.deepEqual(r.report.overridden, [
    { field: "colors.accent", to: "accent", by: "value" },
    { field: "font_file", to: "--font", by: "--font" },
  ]);
  // a plain brand.json with only a primary colour: no template value is filled from ffmpeg-skill's defaults
  const dir = tmp("hfs-kit-");
  const B = loadKit(writeJson(join(dir, "brand.json"), { colors: { primary: "FFD200" } }));
  for (const t of listTemplates()) {
    const b = applyKit(t, B, {});
    assert.deepEqual(b.given, {}, t.name);
    assert.equal(b.font, undefined);
    assert.deepEqual(b.report.unused.map((u) => u.field), ["colors.primary"]);
    assert.equal(b.report.schema, null);
  }
  // font_file on a template whose text is not the caller's is reported, not applied
  const F = loadKit(writeJson(join(dir, "font.json"), { font_file: serifFont() }));
  const g = applyKit(loadTemplate("stinger-geometric"), F, {});
  assert.equal(g.font, undefined);
  assert.equal(g.report.unused[0].field, "font_file");
  const lr = applyKit(loadTemplate("stinger-logo-reveal"), F, {});
  assert.equal(lr.font, undefined, "the optional text left out: no caller text is drawn");
  assert.equal(applyKit(loadTemplate("stinger-logo-reveal"), F, { text: "Hi" }).font, serifFont());
});

test("kit files are checked: JSON object, schema, colours spelling, colour format", () => {
  const dir = tmp("hfs-kit-");
  const bad = (obj) => {
    const f = writeJson(join(dir, "k.json"), obj);
    try {
      applyKit(loadTemplate("title-card"), loadKit(f), {});
      return null;
    } catch (e) {
      assert.equal(e.kind, "input");
      return e.message;
    }
  };
  assert.match(bad([]), /JSON object/);
  assert.match(bad({ schema: "velisa/kit@2" }), /schema/);
  assert.match(bad({ colors: {}, colours: {} }), /both colors and colours/);
  assert.match(bad({ colors: { background: "navy" } }), /colors\.background must be RRGGBB/);
  assert.match(bad({ colours: { background: "12345" } }), /colours\.background must be RRGGBB/);
  assert.equal(bad({ colours: { background: "102030" } }), null, "colours is read like colors");
  assert.equal(bad({ colors: { primary: "not a colour" } }), null, "an unused colour is reported, not refused");
});

test("template --kit: the result writes the values used; without --kit nothing changes", () => {
  const dir = tmp("hfs-kit-");
  const kit = fullKit(dir);
  const r = tool("template", ["title-card", "--kit", kit, "--set", "title=Opening", "-o", join(dir, "a.json"), "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.doc.values.background, "#203040");
  assert.deepEqual(r.doc.kit.applied.map((a) => [a.field, a.to]), [["colors.background", "background"], ["font_file", "--font"]]);
  assert.equal(r.doc.request.fonts[0].src, serifFont());
  assert.ok(r.doc.kit.unused.some((u) => u.field === "colors.primary"));
  const plain = tool("template", ["title-card", "--set", "title=Opening", "-o", join(dir, "b.json"), "--json"]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal("kit" in plain.doc, false);
  assert.equal(plain.doc.values.background, "#101820", "the template default is unchanged");
  const list = tool("template", ["--list", "--json"]);
  assert.deepEqual(list.doc.templates.find((t) => t.name === "session-slate").kit, { values: { background: "colors.background", accent: "colors.accent" }, font_file: true });
  const missing = tool("template", ["title-card", "--kit", join(dir, "nope.json"), "--set", "title=x", "-o", join(dir, "c.json"), "--json"]);
  assert.equal(missing.code, 1);
  assert.equal(missing.doc.error.kind, "input");
});

test("batch --kit: every row gets the kit, a row's own value wins", () => {
  const dir = tmp("hfs-kit-");
  const kit = writeJson(join(dir, "kit.json"), { colors: { background: "203040", accent: "E84855" } });
  writeFileSync(join(dir, "rows.csv"), "session,title,speaker,accent\nS1,One,A,\nS2,Two,B,#00ff00\n");
  const r = tool("batch", [join(dir, "rows.csv"), "--template", "session-slate", "--kit", kit, "-o", join(dir, "out"), "--dry-run", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.doc.rows[0].kit.applied.map((a) => a.to), ["background", "accent"]);
  assert.deepEqual(r.doc.rows[1].kit.overridden, [{ field: "colors.accent", to: "accent", by: "value" }]);
});

test("a title card from a kit renders frame-for-frame as the same values given directly", { skip: SKIP_RENDER }, () => {
  const dir = tmp("hfs-kit-");
  const font = serifFont();
  const kit = writeJson(join(dir, "kit.json"), { colors: { background: "203040", primary: "FFD200" }, font_file: font });
  const common = ["title-card", "--set", "title=Kit Hg", "--set", "duration=2"];
  const a = tool("template", [...common, "--kit", kit, "-o", join(dir, "a.json"), "--json"]);
  const b = tool("template", [...common, "--set", "background=#203040", "--font", font, "-o", join(dir, "b.json"), "--json"]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(readFileSync(join(dir, "a.json"), "utf8"), readFileSync(join(dir, "b.json"), "utf8"), "the same request");
  const md5 = {};
  for (const n of ["a", "b"]) {
    assert.equal(tool("scene", [join(dir, `${n}.json`), "-o", join(dir, n), "--json"]).code, 0);
    const r = tool("render", [join(dir, n), "-o", join(dir, `${n}.mp4`), "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.doc.verified, true);
    md5[n] = ffmpeg(["-i", join(dir, `${n}.mp4`), "-f", "framemd5", "-"]).toString().split("\n").filter((l) => l && !l.startsWith("#"));
  }
  assert.equal(md5.a.length, 60);
  assert.deepEqual(md5.a, md5.b);
  const { data } = frameRgb(join(dir, "a.mp4"), 30, 1920, 1080);
  const [r, g, bl] = data.subarray(0, 3);
  assert.ok(Math.abs(r - 0x20) <= 4 && Math.abs(g - 0x30) <= 4 && Math.abs(bl - 0x40) <= 4, `top-left pixel ${r},${g},${bl} is the kit's #203040`);
});
