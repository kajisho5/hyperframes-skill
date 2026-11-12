// Alpha deliveries (roadmap step 13, docs/design-decisions.md D13): WebM VP9 with alpha, ProRes
// 4444 and PNG sequences, read back by probe --alpha. The real renders are skipped with
// HYPERFRAMES_SKILL_SKIP_RENDER_TESTS=1; the rest needs ffmpeg only.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ffmpeg, FIXTURES, SKIP_RENDER, tmp, tool } from "./helpers.mjs";

const SOLID = "90,90"; // inside the opaque #2050ff layer
const HALF = "230,90"; // inside the rgba(0,0,255,0.5) layer

function sceneDir(dir) {
  const r = tool("scene", [join(FIXTURES, "alpha.json"), "-o", join(dir, "scene"), "--json"]);
  assert.equal(r.code, 0, r.stderr);
  return join(dir, "scene");
}

/** RGBA of one pixel of the first frame (libvpx-vp9 decodes VP9's alpha; the native decoder drops it). */
function rgbaAt(file, x, y, vp9 = false) {
  const px = ffmpeg([...(vp9 ? ["-c:v", "libvpx-vp9"] : []), "-i", file, "-frames:v", "1", "-vf", `format=rgba,crop=1:1:${x}:${y}`, "-f", "rawvideo", "-"]);
  return [...px];
}

test("render --codec png: a video extension, a file, or a directory with other files is refused", () => {
  const dir = tmp();
  const scene = sceneDir(dir);
  const ext = tool("render", [scene, "-o", join(dir, "frames.mp4"), "--codec", "png", "--dry-run", "--json"]);
  assert.match(ext.doc.error.message, /writes a directory of PNG frames; the output frames\.mp4 has a video file extension/);
  writeFileSync(join(dir, "afile"), "x");
  assert.match(tool("render", [scene, "-o", join(dir, "afile"), "--codec", "png", "--overwrite", "--dry-run", "--json"]).doc.error.message, /writes a directory; .* is a file/);
  mkdirSync(join(dir, "mixed"));
  writeFileSync(join(dir, "mixed", "frame_000001.png"), "x");
  writeFileSync(join(dir, "mixed", "notes.txt"), "keep me");
  assert.match(tool("render", [scene, "-o", join(dir, "mixed"), "--codec", "png", "--json"]).doc.error.message, /output exists/);
  assert.match(tool("render", [scene, "-o", join(dir, "mixed"), "--codec", "png", "--overwrite", "--json"]).doc.error.message, /holds files that are not frames of a PNG sequence \(notes\.txt\); nothing was touched/);
  const ok = tool("render", [scene, "-o", join(dir, "frames"), "--codec", "png", "--dry-run", "--json"]);
  assert.equal(ok.code, 0, ok.stderr);
  const argv = ok.doc.planned_commands[0];
  assert.equal(argv[argv.indexOf("--format") + 1], "png-sequence");
  assert.equal(ok.doc.ffmpeg_skill.status, "UNCHECKED");
  // --quality has no meaning for PNG
  assert.match(tool("render", [scene, "-o", join(dir, "frames"), "--codec", "png", "--quality", "10", "--dry-run", "--json"]).doc.error.message, /--quality is not supported with --codec png/);
});

test("probe reads a PNG sequence directory and the alpha at sampled pixels", () => {
  const dir = tmp();
  const seq = join(dir, "seq");
  mkdirSync(seq);
  // transparent 64x36 frames with an opaque white 16x16 square at (8,8)
  ffmpeg(["-f", "lavfi", "-i", "color=c=black@0.0:s=64x36:r=10:d=0.3,format=rgba", "-f", "lavfi", "-i", "color=c=white:s=16x16:r=10:d=0.3,format=rgba", "-filter_complex", "[0][1]overlay=8:8,format=rgba", "-start_number", "1", join(seq, "frame_%06d.png")]);
  const r = tool("probe", [seq, "--alpha", "--sample", "0,0", "--sample", "12,12", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const p = r.doc.probe;
  assert.deepEqual([p.format, p.video.frames, p.video.frames_source, p.contiguous, p.video.codec, p.video.pix_fmt], ["png-sequence", 3, "files", true, "png", "rgba"]);
  assert.equal(p.alpha.mode, "straight");
  assert.deepEqual(p.alpha.samples, [{ x: 0, y: 0, alpha: 0 }, { x: 12, y: 12, alpha: 255 }]);
  assert.deepEqual([p.alpha.first_frame.min, p.alpha.first_frame.max, p.alpha.first_frame.corners.top_left], [0, 255, 0]);
});

test("probe --alpha on a file without alpha says so; --sample needs --alpha and X,Y", () => {
  const dir = tmp();
  const f = join(dir, "x.mp4");
  ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=64x36:r=10:d=0.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", f]);
  const r = tool("probe", [f, "--alpha", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([r.doc.probe.alpha.mode, r.doc.probe.alpha.channel], ["none", false]);
  assert.match(tool("probe", [f, "--sample", "1,1", "--json"]).doc.error.message, /--sample needs --alpha/);
  assert.match(tool("probe", [f, "--alpha", "--sample", "1;1", "--json"]).doc.error.message, /--sample must be X,Y/);
});

for (const [codec, out, vp9] of [["vp9", "a.webm", true], ["prores", "a.mov", false], ["png", "frames", false]]) {
  test(`--codec ${codec}: first frame alpha 0 in an empty corner, 255 on a solid layer, straight alpha`, { skip: SKIP_RENDER }, () => {
    const dir = tmp();
    const file = join(dir, out);
    const r = tool("render", [sceneDir(dir), "-o", file, "--codec", codec, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.doc.verified, true);
    assert.deepEqual([r.doc.alpha.mode, r.doc.alpha.channel], ["straight", true]);
    const step = r.doc.verification.find((s) => s.step === "alpha");
    assert.equal(step.ok, true);
    if (codec === "png") {
      assert.equal(r.doc.probe.video.frames, 5);
      assert.equal(r.doc.ffmpeg_skill.status, "UNCHECKED");
    }
    // read back by probe
    const p = tool("probe", [file, "--alpha", "--sample", "0,0", "--sample", "319,179", "--sample", SOLID, "--sample", HALF, "--json"]);
    assert.equal(p.code, 0, p.stderr);
    const a = p.doc.probe.alpha.samples.map((s) => s.alpha);
    assert.deepEqual(a.slice(0, 3), [0, 0, 255], JSON.stringify(p.doc.probe.alpha));
    assert.ok(Math.abs(a[3] - 128) <= 2, `half layer alpha ${a[3]}`);
    // straight, not premultiplied: the 50% blue layer keeps full blue in its colour
    const frame = codec === "png" ? join(file, "frame_000001.png") : file;
    const [R, G, B, A] = rgbaAt(frame, 230, 90, vp9);
    assert.ok(B >= 245 && R <= 8 && G <= 8, `colour of the 50% layer: ${[R, G, B, A]}`);
  });
}
