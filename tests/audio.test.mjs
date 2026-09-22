// Audio: <audio> layers and unmuted video, measured on the rendered file (RMS per window), not
// assumed from the markup.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { renderHtml, validateRequest } from "../lib/scene-spec.mjs";
import { sceneHasAudio } from "../lib/render-core.mjs";
import { ffmpeg, SKIP_RENDER, tmp, tool, writeJson } from "./helpers.mjs";

function problems(req, dir) {
  try {
    validateRequest(req, dir);
    return [];
  } catch (e) {
    return e.details.problems;
  }
}

/** RMS level (dBFS) of [start, start+dur) of a file's audio; -Infinity for digital silence. */
function rms(file, start, dur) {
  const out = ffmpeg(["-ss", String(start), "-t", String(dur), "-i", file, "-af", "astats=metadata=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-", "-f", "null", "-"]).toString();
  const v = out.trim().split("\n").pop().split("=")[1];
  return v === "-inf" ? -Infinity : Number(v);
}

function tone(dir, seconds = 2) {
  const f = join(dir, "tone.wav");
  ffmpeg(["-f", "lavfi", "-i", `sine=f=440:d=${seconds}`, "-ar", "48000", "-ac", "2", f]);
  return f;
}

const scene = (layers, duration = 2) => ({ scene_version: 1, width: 320, height: 180, duration, fps: 10, layers });

test("audio layers and video volume are validated", () => {
  const dir = tmp();
  tone(dir);
  const a = (extra) => scene([{ type: "audio", id: "a", start: 0, duration: 2, src: "tone.wav", ...extra }]);
  assert.deepEqual(problems(a({ volume: 0.5, fade_in: 1, fade_out: 1, media_start: 0.2 }), dir), []);
  assert.ok(problems(a({ volume: 4 }), dir).some((m) => m.includes("volume must be a number 0..3.98")));
  assert.ok(problems(a({ fade_in: 1.5, fade_out: 1 }), dir).some((m) => m.includes("fade_in + fade_out is longer")));
  assert.ok(problems(a({ box: { x: 0, y: 0, width: 1, height: 1 } }), dir).some((m) => m.includes('unknown key "box" for a audio layer')));
  assert.ok(problems(a({ src: "tone.png" }), dir).length > 0);
});

test("markup: <audio> with gain and fades; a video is muted unless it has a volume", () => {
  const dir = tmp();
  tone(dir);
  ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "v.mp4")]);
  const html = renderHtml(validateRequest(scene([
    { type: "video", id: "quiet", start: 0, duration: 1, src: "v.mp4" },
    { type: "video", id: "loud", start: 0, duration: 1, src: "v.mp4", volume: 0.5 },
    { type: "audio", id: "bgm", start: 0.5, duration: 1.5, src: "tone.wav", volume: 1, fade_in: 0.5 },
  ]), dir));
  assert.match(html, /<video id="quiet"[^>]* muted [^>]*data-volume="0"><\/video>/);
  assert.match(html, /<video id="loud"(?![^>]*muted)[^>]*data-volume="0.5" data-has-audio="true"><\/video>/);
  assert.match(html, /<audio id="bgm" class="clip" src="assets\/bgm.wav" preload="auto" data-start="0.5" data-duration="1.5" data-track-index="2" data-media-start="0" data-volume="1" data-fade-in="0.5"><\/audio>/);
  assert.ok(!html.includes("#bgm{"), "an audio layer gets no CSS rule");
  assert.equal(sceneHasAudio(html), true);
  assert.equal(sceneHasAudio('<video id="v" muted src="a.mp4"></video>'), false);
});

test("an audio layer plays at its start, at the requested gain, with its fades", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const src = tone(dir);
  const source = rms(src, 0.2, 0.6);
  const levels = {};
  for (const volume of [1, 0.5]) {
    const req = writeJson(join(dir, `r${volume}.json`), scene([{ type: "audio", id: "a", start: 0.5, duration: 1.5, src: "tone.wav", volume }]));
    assert.equal(tool("scene", [req, "-o", join(dir, `s${volume}`), "--json"]).code, 0);
    const out = join(dir, `o${volume}.mp4`);
    const r = tool("render", [join(dir, `s${volume}`), "-o", out, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.doc.verified, true);
    assert.ok(r.doc.verification.find((s) => s.step === "audio").ok);
    assert.equal(rms(out, 0, 0.4), -Infinity, "silent before the layer starts");
    levels[volume] = rms(out, 0.8, 0.8);
  }
  assert.ok(Math.abs(levels[1] - source) < 0.2, `volume 1 is unity: ${levels[1]} vs source ${source}`);
  assert.ok(Math.abs(levels[0.5] - (source - 6.02)) < 0.2, `volume 0.5 is -6 dB: ${levels[0.5]} vs ${source - 6.02}`);

  const fr = writeJson(join(dir, "fade.json"), scene([{ type: "audio", id: "a", start: 0, duration: 2, src: "tone.wav", fade_in: 1, fade_out: 0.5 }]));
  assert.equal(tool("scene", [fr, "-o", join(dir, "sf"), "--json"]).code, 0);
  assert.equal(tool("render", [join(dir, "sf"), "-o", join(dir, "fade.mp4"), "--json"]).code, 0);
  const f = join(dir, "fade.mp4");
  const early = rms(f, 0.05, 0.1);
  const mid = rms(f, 0.45, 0.1);
  const full = rms(f, 1.1, 0.3);
  const tail = rms(f, 1.85, 0.1);
  assert.ok(early < mid && mid < full, `fade-in rises: ${early} < ${mid} < ${full}`);
  assert.ok(Math.abs(full - source) < 0.2, `full level between the fades: ${full}`);
  assert.ok(tail < full - 6, `fade-out: ${tail} well below ${full}`);
});

test("a video with a volume carries its sound; without one the output has no audio", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const clip = join(dir, "clip.mp4");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x90:r=10:d=2", "-f", "lavfi", "-i", "sine=f=880:d=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clip]);
  const source = rms(clip, 0.5, 1);
  for (const [name, extra] of [["loud", { volume: 1 }], ["quiet", {}]]) {
    const req = writeJson(join(dir, `${name}.json`), scene([{ type: "video", id: "v", start: 0, duration: 2, src: "clip.mp4", fit: "fill", ...extra }]));
    assert.equal(tool("scene", [req, "-o", join(dir, name), "--json"]).code, 0);
    const r = tool("render", [join(dir, name), "-o", join(dir, `${name}.mp4`), "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.doc.verified, true);
    if (name === "loud") {
      assert.ok(r.doc.probe.audio, "audio stream present");
      assert.ok(Math.abs(rms(join(dir, "loud.mp4"), 0.5, 1) - source) < 0.5, "unity gain");
    } else {
      assert.equal(r.doc.probe.audio, null, "a muted video adds no audio stream");
      assert.equal(r.doc.verification.find((s) => s.step === "audio"), undefined);
    }
  }
});
