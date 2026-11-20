// The sidecars against the Velisa spec's own schemas and conformance fixtures (Velisa ADR-024):
// tests/fixtures/velisa/ is a copy of Velisa registry/ for title and stinger, made by
// `python3 -m registry.spec_conformance --export title stinger --to <this repo>/tests/fixtures/velisa`
// in a Velisa checkout. manifest.json records the Velisa commit; re-export to update, never edit by hand.
// material.test.mjs checks the same rules from the spec's text; this file checks them against the
// owner's schema, so a field renamed on either side fails here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { buildSidecar, SIDECAR } from "../lib/sidecar.mjs";
import { FIXTURES, tmp } from "./helpers.mjs";

const VELISA = join(FIXTURES, "velisa");
const manifest = JSON.parse(readFileSync(join(VELISA, "manifest.json"), "utf8"));
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators = Object.fromEntries(Object.entries(manifest.specs).map(([spec, e]) => [spec, ajv.compile(JSON.parse(readFileSync(join(VELISA, e.schema), "utf8")))]));
const problems = (spec, doc) => (validators[spec](doc) ? [] : validators[spec].errors.map((e) => `${e.instancePath || "$"} ${e.message}`));

test("the copy is Velisa's: every schema and fixture has the hash its manifest records", () => {
  assert.match(manifest.source.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(manifest.specs).sort(), ["stinger", "title"]);
  for (const e of Object.values(manifest.specs)) {
    assert.equal(sha256(join(VELISA, e.schema)), e.schema_sha256, e.schema);
    for (const f of e.fixtures) assert.equal(sha256(join(VELISA, f.path)), f.sha256, f.path);
  }
});

test("ajv agrees with Velisa on every fixture: valid ones pass, the ones Velisa refuses by schema fail", () => {
  for (const [spec, e] of Object.entries(manifest.specs)) {
    for (const f of e.fixtures) {
      const doc = JSON.parse(readFileSync(join(VELISA, f.path), "utf8"));
      // `rules` fixtures pass the schema; Velisa refuses them by a rule a schema cannot state
      const bySchema = f.fails.includes("schema");
      assert.equal(validators[spec](doc), !bySchema, `${f.path}: ${problems(spec, doc).join("; ") || "passed"}`);
    }
  }
});

test("SIDECAR names exactly the schema's fields: read = required, read + proposed = every property", () => {
  for (const kind of ["stinger", "title"]) {
    const schema = JSON.parse(readFileSync(join(VELISA, manifest.specs[kind].schema), "utf8"));
    assert.deepEqual([...SIDECAR[kind].read].sort(), [...schema.required].sort(), kind);
    assert.deepEqual([...SIDECAR[kind].read, ...SIDECAR[kind].proposed].sort(), Object.keys(schema.properties).sort(), kind);
    assert.equal(SIDECAR[kind].schema, schema.properties.schema.const, kind);
  }
});

test("what buildSidecar writes validates against the schemas (with and without a file, alpha and text)", () => {
  const dir = tmp();
  const out = join(dir, "st.mov");
  writeFileSync(out, "not a real movie; only its hash is read");
  const plan = { output: out, spec: { sequence: false }, codec: "prores", expected: { frames: 48 } };
  const stinger = buildSidecar({ kind: "stinger", fps: 24, cut_point_frame: 25, cover_frames: { start: 24, end: 30 }, material: {} }, plan, { probe: { duration: 2, video: { frames: 48 } } });
  assert.equal(stinger.sha256, sha256(out));
  assert.deepEqual(problems("stinger", stinger), []);
  const absent = { ...plan, output: join(dir, "absent.mov") };
  const bare = buildSidecar({ kind: "stinger", fps: 30, cut_point_frame: 15, cover_frames: { start: 15, end: 21 }, material: {} }, absent, { probe: null });
  assert.deepEqual(problems("stinger", bare), []);
  const material = { safe_area: { x: 120, y: 800, width: 1100, height: 154 }, text: [{ role: "name", text: "Ada Lovelace", lang: "en", font: "sans-serif", font_size: 56 }] };
  const title = buildSidecar({ kind: "title", fps: 30, segment_frames: { in: 15, loop: 30, out: 15 }, material }, plan, { probe: null, loopSeam: { measured: true, ok: true } });
  assert.deepEqual(problems("title", title), []);
  const h264 = buildSidecar({ kind: "title", fps: 24, segment_frames: { in: 13, loop: 48, out: 11 }, material: { safe_area: material.safe_area, text: [] } }, { ...absent, codec: "h264" }, { probe: null });
  assert.equal(h264.alpha, undefined);
  assert.deepEqual(problems("title", h264), []);
});
