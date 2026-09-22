// template: shipped templates always fill into a request `scene` accepts; values are checked, never guessed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { validateRequest } from "../lib/scene-spec.mjs";
import { fillTemplate, listTemplates, loadTemplate, resolveValues, TEMPLATE_DIR } from "../lib/template.mjs";
import { ffmpeg, SKIP_RENDER, tmp, tool, writeJson } from "./helpers.mjs";

function sample(spec, k) {
  if (spec.type === "number") return spec.min ?? 3;
  if (spec.type === "color") return "#123456";
  if (k === "lang") return "ja";
  return "x".repeat(Math.min(spec.max_length ?? 10, 10));
}

test("every shipped template fills into a valid request, with only required values and with all values", () => {
  const all = listTemplates();
  assert.deepEqual(all.map((t) => t.name), ["break", "lower-third", "session-slate", "title-card"]);
  for (const t of all) {
    for (const mode of ["required", "all"]) {
      const given = Object.fromEntries(Object.entries(t.values).filter(([, s]) => mode === "all" || s.required).map(([k, s]) => [k, sample(s, k)]));
      const { values, omitted } = resolveValues(t, given);
      const req = fillTemplate(t, values, omitted);
      validateRequest(req, TEMPLATE_DIR);
      assert.ok(!JSON.stringify(req).includes("{{"), `${t.name}/${mode}: unresolved placeholder`);
      assert.ok(!JSON.stringify(req).includes('"when"'), `${t.name}/${mode}: "when" left in the request`);
      if (mode === "all") assert.deepEqual(omitted, []);
    }
  }
});

test("an optional value that is not given drops exactly the layers that need it", () => {
  const t = loadTemplate("lower-third");
  const without = resolveValues(t, { name: "A" });
  assert.deepEqual(without.omitted, ["affiliation"]);
  assert.deepEqual(fillTemplate(t, without.values, without.omitted).layers.map((L) => L.id), ["name"]);
  const withIt = resolveValues(t, { name: "A", affiliation: "B" });
  assert.deepEqual(fillTemplate(t, withIt.values, withIt.omitted).layers.map((L) => L.id), ["name", "affiliation"]);
  const filled = fillTemplate(t, { ...withIt.values, duration: 4 }, []);
  assert.equal(filled.duration, 4, "a whole-string {{number}} placeholder becomes a number");
  assert.equal(filled.layers[1].text, "B");
});

test("bad values are all reported at once, kind input", () => {
  const dir = tmp();
  const r = tool("template", ["session-slate", "--set", "sesion=typo", "--set", "duration=abc", "--set", "accent=red;}", "--set", `title=${"x".repeat(121)}`, "-o", join(dir, "r.json"), "--json"]);
  assert.equal(r.code, 1);
  assert.equal(r.doc.error.kind, "input");
  const p = r.doc.details.problems;
  for (const want of ['unknown value "sesion"', "session is required", "speaker is required", "duration must be a number", "accent must be a colour", "title is 121 characters"]) {
    assert.ok(p.some((m) => m.includes(want)), `${want} in ${p.join(" / ")}`);
  }
});

test("template writes the request, verifies it, is byte-identical on re-run and refuses to overwrite", () => {
  const dir = tmp();
  const values = writeJson(join(dir, "v.json"), { title: "Opening\nRemarks", subtitle: "Day 1", duration: 3 });
  const out = join(dir, "req.json");
  const r = tool("template", ["title-card", "--values", values, "--set", "duration=4", "-o", out, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.doc.verified, true);
  assert.deepEqual(r.doc.verification.map((s) => s.step), ["exists", "request_valid"]);
  assert.equal(r.doc.values.duration, 4, "--set overrides --values");
  assert.deepEqual(r.doc.expected, { width: 1920, height: 1080, duration: 4, fps: 30, frames: 120 });
  const first = readFileSync(out, "utf8");
  const again = tool("template", ["title-card", "--values", values, "--set", "duration=4", "-o", out, "--json"]);
  assert.equal(again.code, 1);
  assert.equal(again.doc.error.kind, "input");
  const over = tool("template", ["title-card", "--values", values, "--set", "duration=4", "-o", out, "--overwrite", "--json"]);
  assert.equal(over.code, 0, over.stderr);
  assert.equal(readFileSync(out, "utf8"), first);
  // the filled request goes straight into scene
  const s = tool("scene", [out, "-o", join(dir, "scene"), "--json"]);
  assert.equal(s.code, 0, s.stderr);
  assert.equal(s.doc.verified, true);
});

test("--list describes every template and its values", () => {
  const r = tool("template", ["--list", "--json"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.doc.templates.map((t) => t.name), ["break", "lower-third", "session-slate", "title-card"]);
  for (const t of r.doc.templates) for (const v of Object.values(t.values)) assert.ok(v.description, t.name);
  const unknown = tool("template", ["nope", "-o", join(tmp(), "x.json"), "--json"]);
  assert.equal(unknown.doc.error.kind, "input");
  assert.match(unknown.doc.error.message, /templates: break, lower-third, session-slate, title-card/);
});

// The lower third's whole point is keying over a live feed: its background must come out
// transparent in a ProRes 4444 render, with the bar opaque.
test("lower-third renders to ProRes with real alpha", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const req = join(dir, "lt.json");
  assert.equal(tool("template", ["lower-third", "--set", "name=Hanako Sato", "--set", "affiliation=Imaging Center", "--set", "duration=2", "-o", req, "--json"]).code, 0);
  assert.equal(tool("scene", [req, "-o", join(dir, "scene"), "--json"]).code, 0);
  const out = join(dir, "lt.mov");
  const r = tool("render", [join(dir, "scene"), "-o", out, "--codec", "prores", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.doc.verified, true);
  assert.match(r.doc.probe.video.pix_fmt, /^yuva/);
  const alphaMax = (crop) =>
    Number(/YMAX=([\d.]+)/.exec(ffmpeg(["-ss", "1", "-i", out, "-vf", `alphaextract,${crop},signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-`, "-frames:v", "1", "-f", "null", "-"]).toString())[1]);
  assert.equal(alphaMax("crop=1920:700:0:0"), 0, "top of the frame fully transparent");
  assert.ok(alphaMax("crop=900:80:130:805") > 0, "the name bar is opaque");
});

