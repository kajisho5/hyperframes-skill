// Result documents that don't lie: every failure path ends in status "failed", the right
// error.kind, retryable false, verified false and the documented exit code.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { classifyFailure, hyperframesFailureMessage } from "../lib/render-core.mjs";
import { FIXTURES, ROOT, SKIP_RENDER, fakeTools, tmp, tool } from "./helpers.mjs";
import { which } from "../lib/deps.mjs";

function scene() {
  const dir = tmp();
  const r = tool("scene", [join(FIXTURES, "two-line.json"), "-o", join(dir, "scene"), "--json"]);
  assert.equal(r.code, 0, r.stderr);
  return dir;
}

function assertFailed(r, kind, code) {
  assert.equal(r.code, code, r.stderr);
  assert.equal(r.doc.status, "failed");
  assert.equal(r.doc.exit_code, code);
  assert.equal(r.doc.error.kind, kind, r.doc.error.message);
  assert.equal(r.doc.error.retryable, false);
  assert.equal(r.doc.verified, false);
}

test("input: missing scene directory", () => {
  assertFailed(tool("render", ["/nonexistent/scene", "-o", "/tmp/x.mp4", "--json"]), "input", 1);
});

test("input: unknown flag and bad flag values still produce a failure document", () => {
  const dir = scene();
  assertFailed(tool("render", [join(dir, "scene"), "-o", join(dir, "o.mp4"), "--bogus", "--json"]), "input", 1);
  assertFailed(tool("render", [join(dir, "scene"), "-o", join(dir, "o.mp4"), "--fps", "x", "--json"]), "input", 1);
  assertFailed(tool("render", [join(dir, "scene"), "-o", join(dir, "o.mp4"), "--codec", "av1", "--json"]), "input", 1);
  assertFailed(tool("render", [join(dir, "scene"), "-o", join(dir, "o.mp4"), "--codec", "prores", "--json"]), "input", 1); // extension mismatch
  assertFailed(tool("render", [join(dir, "scene"), "-o", join(dir, "o.mov"), "--codec", "prores", "--quality", "20", "--json"]), "input", 1);
});

test("input: the output may not overwrite without --overwrite, nor land inside the scene", () => {
  const dir = scene();
  writeFileSync(join(dir, "exists.mp4"), "x");
  assertFailed(tool("render", [join(dir, "scene"), "-o", join(dir, "exists.mp4"), "--json"]), "input", 1);
  assertFailed(tool("render", [join(dir, "scene"), "-o", join(dir, "scene", "o.mp4"), "--json"]), "input", 1);
  symlinkSync(join(dir, "scene"), join(dir, "link"));
  assertFailed(tool("render", [join(dir, "scene"), "-o", join(dir, "link", "sub", "o.mp4"), "--json"]), "input", 1);
});

test("missing_tool: exit 127 when ffmpeg, ffprobe or Chromium is absent", () => {
  const dir = scene();
  const s = join(dir, "scene");
  assertFailed(tool("render", [s, "-o", join(dir, "a.mp4"), "--json"], { env: { HYPERFRAMES_SKILL_FFMPEG: "/nonexistent/ffmpeg" } }), "missing_tool", 127);
  assertFailed(tool("render", [s, "-o", join(dir, "b.mp4"), "--json"], { env: { HYPERFRAMES_SKILL_FFPROBE: "/nonexistent/ffprobe" } }), "missing_tool", 127);
  assertFailed(tool("render", [s, "-o", join(dir, "c.mp4"), "--json"], { env: { HYPERFRAMES_BROWSER_PATH: "/nonexistent/chrome" } }), "missing_tool", 127);
  assertFailed(tool("probe", [join(s, "index.html"), "--json"], { env: { HYPERFRAMES_SKILL_FFPROBE: "/nonexistent/ffprobe" } }), "missing_tool", 127);
  assert.ok(!existsSync(join(dir, "a.mp4")));
});

test("render: a Chrome that cannot start is kind render, never completed", { skip: SKIP_RENDER }, () => {
  const dir = scene();
  const f = fakeTools([{ name: "chrome", exit: 1, stderr: "fake chrome failure" }], dir);
  const r = tool("render", [join(dir, "scene"), "-o", join(dir, "o.mp4"), "--json"], { env: { ...f.env, HYPERFRAMES_BROWSER_PATH: f.rules[0].path } });
  assertFailed(r, "render", 1);
  assert.match(r.doc.error.message, /Chrome cannot start/);
  assert.equal(r.doc.commands[0].exit_code, 1);
});

test("encode: ffmpeg failing on the frame stream is kind encode", { skip: SKIP_RENDER }, () => {
  const dir = scene();
  // the real ffmpeg, except the encode of the frame stream (image2pipe), which fails
  const real = which("ffmpeg");
  const f = fakeTools([{ name: "ffmpeg", path: real, when: "image2pipe", exit: 1, stderr: "fake encode failure" }], dir);
  const r = tool("render", [join(dir, "scene"), "-o", join(dir, "o.mp4"), "--json"], { env: { ...f.env, HYPERFRAMES_SKILL_FFMPEG: real } });
  assertFailed(r, "encode", 1);
  assert.deepEqual(r.doc.details.classification, { hyperframes_message_names_encode: true, ffmpeg_nonzero_exits: [1] });
});

test("classification: an ffmpeg torn down after a capture failure is not an encode failure", () => {
  const cmds = [{ via: "hyperframes", role: "ffmpeg", exit_code: 234 }];
  const out = "✗  Render failed\n   connect ENETUNREACH 127.0.0.1:45545\n   Try --docker for containerized rendering\n";
  assert.equal(hyperframesFailureMessage(out), "Render failed | connect ENETUNREACH 127.0.0.1:45545");
  assert.equal(classifyFailure(cmds, out).kind, "render");
  const enc = "✗  Render failed\n   Streaming encode failed: FFmpeg exited with code 1\n";
  assert.equal(classifyFailure(cmds, enc).kind, "encode");
  assert.equal(classifyFailure([], enc).kind, "render", "no recorded ffmpeg failure: not claimed as encode");
});

test("timeout: exit 124, kind timeout, the process group is killed", { skip: SKIP_RENDER }, () => {
  const dir = scene();
  const r = tool("render", [join(dir, "scene"), "-o", join(dir, "o.mp4"), "--timeout", "0.3", "--json"]);
  assertFailed(r, "timeout", 124);
});

// POSIX only: Windows has no signal delivery to a handler (Node's child.kill() ends a Windows process
// unconditionally, so no process can report an interruption there); the interrupt path itself is the same code.
const NO_SIGNALS = process.platform === "win32" ? "Windows delivers no SIGTERM to a handler" : false;

test("interrupted: SIGTERM gives exit 143 and a failure document", { skip: SKIP_RENDER || NO_SIGNALS }, async () => {
  const dir = scene();
  const child = spawn(process.execPath, [join(ROOT, "scripts", "render.mjs"), join(dir, "scene"), "-o", join(dir, "o.mp4"), "--json"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  let err = "";
  let signalled = false;
  child.stderr.on("data", (c) => {
    err += c;
    // Exactly one SIGTERM. `err` accumulates, so testing it on every chunk would signal again
    // on the next chunk ("error: interrupted ...", written just before the failure document);
    // that second signal can land while Node is tearing down after it has already reported,
    // when its handlers are gone, and kill the process with no exit code at all.
    if (!signalled && err.includes("rendering ")) {
      signalled = true;
      child.kill("SIGTERM");
    }
  });
  const code = await new Promise((res) => child.on("close", (c) => res(c)));
  const doc = JSON.parse(out);
  assert.equal(code, 143);
  assert.equal(doc.status, "failed");
  assert.equal(doc.error.kind, "interrupted");
  assert.equal(doc.exit_code, 143);
});
