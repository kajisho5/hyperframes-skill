// --dry-run is measured, not declared: every tool runs behind fake chrome/ffmpeg/ffprobe
// binaries that record any call, and the test asserts nothing was called and nothing written.
// probe is the stated exception (read-only: ffprobe still runs), and the contract says so.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildContract } from "../lib/contract.mjs";
import { FIXTURES, listTree, tmp, tool, writeExe } from "./helpers.mjs";

function fakes() {
  const dir = tmp("hfs-fake-");
  const log = join(dir, "calls");
  const mk = (name) => writeExe(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 0\n`);
  return { dir, log, env: { HYPERFRAMES_BROWSER_PATH: mk("chrome"), HYPERFRAMES_SKILL_FFMPEG: mk("ffmpeg"), HYPERFRAMES_SKILL_FFPROBE: mk("ffprobe") } };
}

const calls = (f) => (existsSync(f.log) ? readFileSync(f.log, "utf8").trim().split("\n") : []);

function sceneDir() {
  const dir = tmp();
  const r = tool("scene", [join(FIXTURES, "two-line.json"), "-o", join(dir, "scene"), "--json"]);
  assert.equal(r.code, 0, r.stderr);
  return dir;
}

test("scene --dry-run writes nothing and runs nothing", () => {
  const f = fakes();
  const dir = tmp();
  const r = tool("scene", [join(FIXTURES, "two-line.json"), "-o", join(dir, "out"), "--dry-run", "--json"], { env: f.env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.doc.dry_run, true);
  assert.equal(r.doc.verified, false);
  assert.deepEqual(r.doc.commands, []);
  assert.match(r.stderr, /\[dry-run\] would write .*index\.html/);
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(calls(f), []);
});

for (const name of ["render", "preview"]) {
  test(`${name} --dry-run launches neither Chrome nor ffmpeg and writes nothing`, () => {
    const f = fakes();
    const dir = sceneDir();
    const before = listTree(dir);
    const r = tool(name, [join(dir, "scene"), "-o", join(dir, "out.mp4"), "--dry-run", "--json"], { env: f.env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.doc.dry_run, true);
    assert.equal(r.doc.verified, false);
    assert.deepEqual(r.doc.commands, []);
    assert.equal(r.doc.planned_commands.length, 1);
    assert.equal(r.doc.expected.frames, name === "render" ? 30 : 10);
    assert.deepEqual(listTree(dir), before);
    assert.deepEqual(calls(f), []);
  });
}

test("template --dry-run writes nothing and runs nothing", () => {
  const f = fakes();
  const dir = tmp();
  const r = tool("template", ["break", "--set", "message=Break", "-o", join(dir, "r.json"), "--dry-run", "--json"], { env: f.env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.doc.dry_run, true);
  assert.equal(r.doc.verified, false);
  assert.equal(r.doc.request.layers.length, 1);
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(calls(f), []);
});

test("doctor --dry-run lists its probes and runs none", () => {
  const f = fakes();
  const r = tool("doctor", ["--dry-run", "--json"], { env: f.env });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.doc.planned_commands.length >= 4);
  assert.deepEqual(r.doc.commands, []);
  assert.deepEqual(calls(f), []);
});

test("probe --dry-run still runs ffprobe (read-only), as the contract states", () => {
  const f = fakes();
  const dir = sceneDir();
  const r = tool("probe", [join(dir, "scene", "index.html"), "--dry-run", "--json"], { env: f.env });
  assert.deepEqual(calls(f).map((l) => l.split(" ")[0]), ["ffprobe"]);
  const spec = buildContract().tools.find((t) => t.name === "probe");
  assert.match(spec.dry_run, /ffprobe still runs/);
  assert.equal(r.doc.status, "failed"); // the fake ffprobe prints no JSON: refused, not reported as measured
  assert.equal(r.doc.error.kind, "input");
});

test("every tool in the contract supports --dry-run and is covered above", () => {
  const names = buildContract().tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["doctor", "preview", "probe", "render", "scene", "template"]);
  for (const t of buildContract().tools) assert.equal(t.supports_dry_run, true, t.name);
});
