// Real renders: headless Chrome + ffmpeg, small fixtures (320x180, 1 s). Not mocked.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { countPixels, ffmpeg, FIXTURES, frameRgb, listTree, SKIP_RENDER, tmp, tool, writeJson } from "./helpers.mjs";

const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const white = (r, g, b) => r > 200 && g > 200 && b > 200;
const yellow = (r, g, b) => r > 200 && g > 150 && b < 90;

function makeScene(dir, request = join(FIXTURES, "two-line.json")) {
  const r = tool("scene", [request, "-o", join(dir, "scene"), "--json"]);
  assert.equal(r.code, 0, r.stderr);
  return join(dir, "scene");
}

test("end to end: scene -> render -> probe on the two-line fixture", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const scene = makeScene(dir);
  const before = listTree(scene);
  const out = join(dir, "two-line.mp4");
  const r = tool("render", [scene, "-o", out, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const d = r.doc;
  assert.equal(d.status, "completed");
  assert.equal(d.verified, true);
  assert.deepEqual(
    d.verification.map((s) => [s.step, s.ok]),
    [["exists", true], ["probe", true], ["codec", true], ["resolution", true], ["fps", true], ["frames", true], ["duration", true], ["input_preserved", true]],
  );
  assert.deepEqual(d.expected, { width: 320, height: 180, duration: 1, fps: 30, frames: 30, codec: "h264", fps_source: "data-fps" });
  // commands: the hyperframes CLI, then what it really started, then our own probe
  assert.equal(d.commands[0].argv[2], "render");
  assert.equal(d.commands[0].exit_code, 0);
  const roles = d.commands.filter((c) => c.via === "hyperframes").map((c) => c.role);
  assert.ok(roles.includes("chrome") && roles.includes("ffmpeg"), roles.join(","));
  const encode = d.commands.find((c) => c.role === "ffmpeg" && c.argv.includes("image2pipe"));
  assert.ok(encode, "the frame-encoding ffmpeg argv is recorded");
  assert.equal(encode.exit_code, 0);
  assert.equal(d.commands.at(-1).program, "ffprobe");
  assert.deepEqual(listTree(scene), before);

  // independent read-back through the probe tool
  const p = tool("probe", [out, "--json"]);
  assert.equal(p.code, 0, p.stderr);
  assert.deepEqual([p.doc.probe.video.width, p.doc.probe.video.height, p.doc.probe.video.frames, p.doc.probe.video.codec], [320, 180, 30, "h264"]);

  // the picture itself: line one (white) in the first half, line two (yellow) in the second
  const f1 = frameRgb(out, 7, 320, 180);
  const f2 = frameRgb(out, 22, 320, 180);
  assert.ok(countPixels(f1, white) > 50, "white text in frame 7");
  assert.equal(countPixels(f1, yellow), 0, "no yellow text in frame 7");
  assert.ok(countPixels(f2, yellow) > 50, "yellow text in frame 22");
  assert.equal(countPixels(f2, white), 0, "no white text in frame 22");
});

test("determinism: the same scene renders to byte-identical files", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const scene = makeScene(dir);
  const a = tool("render", [scene, "-o", join(dir, "a.mp4"), "--json"]);
  const b = tool("render", [scene, "-o", join(dir, "b.mp4"), "--json"]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(sha(join(dir, "a.mp4")), sha(join(dir, "b.mp4")));
  const md5 = (f) => ffmpeg(["-i", f, "-f", "framemd5", "-"]).toString().split("\n").filter((l) => !l.startsWith("#")).join("\n");
  assert.equal(md5(join(dir, "a.mp4")), md5(join(dir, "b.mp4")));
});

test("preview: lower fps, first N seconds, scene untouched", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const scene = makeScene(dir);
  const before = readFileSync(join(scene, "index.html"), "utf8");
  const r = tool("preview", [scene, "-o", join(dir, "p.mp4"), "--fps", "10", "--max-duration", "0.5", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.doc.verified, true);
  assert.equal(r.doc.truncated, true);
  assert.deepEqual([r.doc.expected.frames, r.doc.probe.video.frames, r.doc.probe.video.fps], [5, 5, 10]);
  assert.ok(r.doc.commands[0].argv.includes("draft"));
  assert.equal(readFileSync(join(scene, "index.html"), "utf8"), before);
});

test("image and video layers render with their timing", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", join(dir, "red.png")]);
  // 1 s of green then 1 s of blue: media_start 1 must show the blue half
  ffmpeg(["-f", "lavfi", "-i", "color=c=green:s=160x90:r=30:d=1", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=30:d=1", "-filter_complex", "[0][1]concat=n=2:v=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "clip.mp4")]);
  const req = writeJson(join(dir, "req.json"), {
    scene_version: 1,
    width: 320,
    height: 180,
    duration: 1,
    fps: 30,
    layers: [
      { type: "video", id: "clip", start: 0, duration: 0.5, src: "clip.mp4", fit: "fill", media_start: 1 },
      { type: "image", id: "logo", start: 0.5, duration: 0.5, src: "red.png", box: { x: 128, y: 58, width: 64, height: 64 } },
    ],
  });
  const scene = makeScene(dir, req);
  const out = join(dir, "media.mp4");
  const r = tool("render", [scene, "-o", out, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.doc.verified, true);
  const blue = (R, G, B) => B > 180 && R < 60 && G < 60;
  const red = (R, G, B) => R > 180 && G < 60 && B < 60;
  const f1 = frameRgb(out, 5, 320, 180);
  const f2 = frameRgb(out, 25, 320, 180);
  assert.ok(countPixels(f1, blue) > 320 * 180 * 0.9, "video fills the frame first, from media_start (blue, not green)");
  assert.equal(countPixels(f1, red), 0);
  assert.ok(countPixels(f2, red) > 64 * 64 * 0.8, "image shows in the second half");
  assert.equal(countPixels(f2, blue), 0);
});

for (const [codec, ext] of [["vp9", ".webm"], ["prores", ".mov"]]) {
  test(`--codec ${codec} writes ${ext} and verifies it`, { skip: SKIP_RENDER }, () => {
    const dir = tmp();
    const scene = makeScene(dir);
    const r = tool("render", [scene, "-o", join(dir, "o" + ext), "--codec", codec, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.doc.verified, true);
    assert.equal(r.doc.probe.video.codec, codec);
    assert.equal(r.doc.probe.video.frames, 30);
  });
}

test("--quality maps to the encoder's CRF", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const scene = makeScene(dir);
  const r = tool("render", [scene, "-o", join(dir, "q.mp4"), "--quality", "35", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const enc = r.doc.commands.find((c) => c.role === "ffmpeg" && c.argv.includes("image2pipe"));
  assert.equal(enc.argv[enc.argv.indexOf("-crf") + 1], "35");
});
