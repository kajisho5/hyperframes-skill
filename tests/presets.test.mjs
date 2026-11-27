// Style presets and the gallery (roadmap step 14, docs/design-decisions.md D25): six templates built on the
// motion, typesetting, shape, pattern and beat-lock layers, each with typed values and a brand kit as
// input; template --gallery renders one still per preset. The gallery run below is each preset's check
// scene in CI (its default values, its fixed still time).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { validateRequest } from "../lib/scene-spec.mjs";
import { fillTemplate, listTemplates, loadTemplate, resolveValues, TEMPLATE_DIR } from "../lib/template.mjs";
import { FIXTURES, SKIP_RENDER, tmp, tool, writeJson } from "./helpers.mjs";

const PRESETS = ["style-corporate", "style-glitch", "style-minimal", "style-neon", "style-swiss", "style-wafu"];
const FONT = join(FIXTURES, "fonts", "hfs-test-blocks.ttf");
const ROLES = { background: "colors.background", primary: "colors.primary", secondary: "colors.secondary", accent: "colors.accent", text_color: "colors.text" };

test("six style presets: typed values (copy, colours, bpm, aspect), every colour a kit role, a gallery still", () => {
  const presets = listTemplates().filter((t) => t.gallery);
  assert.deepEqual(presets.map((t) => t.name), PRESETS);
  for (const t of presets) {
    assert.equal(t.values.title.type, "string", t.name);
    assert.equal(t.values.bpm.type, "number", t.name);
    assert.deepEqual(Object.keys(t.values.aspect.options), ["landscape", "portrait", "square"], t.name);
    const colours = Object.entries(t.values).filter(([, v]) => v.type === "color").map(([k]) => k);
    for (const c of colours) assert.equal(t.kit[c], ROLES[c], `${t.name}: ${c} is filled by the kit role of the same meaning`);
    // no colour in the template's request that is not one of its values
    assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(JSON.stringify(t.request)), false, `${t.name}: no fixed colour`);
    assert.ok(t.gallery.at > 0 && Number.isInteger(Math.round(t.gallery.at * 10)) && t.gallery.at < t.request.duration, t.name);
    for (const aspect of ["landscape", "portrait", "square"]) {
      const { values, omitted } = resolveValues(t, { aspect });
      const req = fillTemplate(t, values, omitted);
      const s = validateRequest(req, TEMPLATE_DIR);
      const [W, H] = { landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080] }[aspect];
      assert.deepEqual([s.width, s.height], [W, H], `${t.name} ${aspect}`);
      for (const L of s.layers) if (L.box) assert.ok(L.box.x >= -10 && L.box.y >= 0 && L.box.x + L.box.width <= W + 10 && L.box.y + L.box.height <= H, `${t.name} ${aspect}: ${L.id} inside the frame`);
      assert.ok(s.beat_lock && s.beat_lock.bpm === 120, `${t.name}: beat-locked`);
      for (const r of s.beat_lock.layers) assert.equal(r.given, r.snapped, `${t.name}: at the default 120 BPM every layer already starts on a beat`);
    }
  }
  assert.throws(() => resolveValues(loadTemplate("style-neon"), { aspect: "cinema" }), /aspect must be one of landscape, portrait, square/);
  // another tempo moves the starts to its beats
  const t = loadTemplate("style-swiss");
  const { values, omitted } = resolveValues(t, { bpm: 90 });
  const s = validateRequest(fillTemplate(t, values, omitted), TEMPLATE_DIR);
  for (const r of s.beat_lock.layers) assert.ok(Math.abs(r.snapped / (60 / 90) - Math.round(r.snapped / (60 / 90))) * (60 / 90) <= 1 / 30, JSON.stringify(r));
});

// a still's pixels as RGB
function rgb(file) {
  const r = spawnSync(process.env.HYPERFRAMES_SKILL_FFMPEG || "ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 27 });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
}
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const near = (px, i, c, tol = 6) => Math.abs(px[i] - c[0]) <= tol && Math.abs(px[i + 1] - c[1]) <= tol && Math.abs(px[i + 2] - c[2]) <= tol;
const share = (px, c, tol) => {
  let n = 0;
  for (let i = 0; i < px.length; i += 3) if (near(px, i, c, tol)) n++;
  return n / (px.length / 3);
};

test("template --gallery renders each preset's check still: its background, and each of its colours drawn", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const r = tool("template", ["--gallery", "-o", join(dir, "gallery"), "--json"], { timeout: 900000 });
  assert.equal(r.code, 0, r.stdout.slice(0, 2000));
  assert.deepEqual(r.doc.gallery.map((g) => [g.template, g.verified, g.width, g.height]), PRESETS.map((p) => [p, true, 1920, 1080]));
  for (const g of r.doc.gallery) {
    const t = loadTemplate(g.template);
    const px = rgb(g.still);
    assert.ok(near(px, 0, hex(t.values.background.default), 2), `${g.template}: the top-left pixel is the background`);
    for (const [k, v] of Object.entries(t.values)) {
      if (v.type !== "color") continue;
      assert.ok(share(px, hex(v.default), 6) > 0.0002, `${g.template}: ${k} ${v.default} is drawn (${share(px, hex(v.default), 6)})`);
    }
  }
  // the dry run plans the same stills and renders nothing
  const d = tool("template", ["--gallery", "-o", join(dir, "plan"), "--dry-run", "--json"]);
  assert.equal(d.code, 0);
  assert.deepEqual(d.doc.gallery.map((g) => g.still), PRESETS.map((p) => join(dir, "plan", `${p}.png`)));
});

test("a preset given a brand kit uses only the kit's colours and its font", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const colors = { background: "202833", primary: "E0A030", secondary: "30A0E0", accent: "E04060", text: "F4F4F4", outline: "000000" };
  const kit = writeJson(join(dir, "kit.json"), { schema: "velisa/kit@1", colors, font_file: FONT });
  const r = tool("template", ["--gallery", "-o", join(dir, "gallery"), "--kit", kit, "--json"], { timeout: 900000 });
  assert.equal(r.code, 0, r.stdout.slice(0, 2000));
  const palette = Object.values(colors).map((c) => hex(`#${c}`));
  for (const g of r.doc.gallery) {
    const applied = Object.fromEntries(g.kit.applied.map((a) => [a.field, a.value]));
    assert.equal(applied.font_file, FONT, `${g.template}: the kit's font`);
    for (const k of Object.keys(loadTemplate(g.template).values).filter((k) => ROLES[k])) assert.ok(`colors.${ROLES[k].split(".")[1]}` in applied, `${g.template}: ${k} from the kit`);
    const px = rgb(g.still);
    let kitPixels = 0;
    for (let i = 0; i < px.length; i += 3) if (palette.some((c) => near(px, i, c, 8))) kitPixels++;
    // the rest are the anti-aliased edges between two kit colours
    assert.ok(kitPixels / (px.length / 3) > 0.97, `${g.template}: ${((100 * kitPixels) / (px.length / 3)).toFixed(2)} % of the pixels are kit colours`);
  }
  // the requests name the kit's font first for every text
  const t = tool("template", ["style-swiss", "--kit", kit, "-o", join(dir, "swiss.json"), "--json"]);
  assert.deepEqual(t.doc.request.fonts.map((f) => f.src), [FONT]);
  for (const L of t.doc.request.layers.filter((x) => x.type === "text")) assert.match(L.style.font_family, /^HFS Custom, /);
});
