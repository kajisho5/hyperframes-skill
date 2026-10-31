// The ffmpeg-skill cross-check (docs/design-decisions.md D3). Three statuses, none of them
// assumed: PASSED only from a real ffmpeg-skill/probe document that matches, FAILED when it
// refuses the file or measures a mismatch, UNCHECKED (never a pass) otherwise.
//
// Most tests use a stand-in checkout whose scripts/probe.py prints a document the test chose,
// so the comparison logic is pinned on every machine. The "real ffmpeg-skill" tests run the
// actual checkout named by HYPERFRAMES_SKILL_FFMPEG_SKILL_DIR (CI clones a pinned tag) on tiny
// files made with ffmpeg here.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { compare, expectsAlpha, ffmpegSkillStep, locateFfmpegSkill, measuredFrom, verifyWithFfmpegSkill } from "../lib/ffmpeg-skill.mjs";
import { Context } from "../lib/result.mjs";
import { ffmpeg, FIXTURES, SKIP_RENDER, tmp, tool, writeJson } from "./helpers.mjs";

const REAL = process.env.HYPERFRAMES_SKILL_FFMPEG_SKILL_DIR || null;
const SKIP_REAL = REAL ? false : "HYPERFRAMES_SKILL_FFMPEG_SKILL_DIR is not set (CI sets it to a pinned ffmpeg-skill checkout)";

// No checkout anywhere the default search looks.
const NOWHERE = (() => {
  const d = tmp("hfs-nowhere-");
  return { env: {}, home: d, cwd: d, root: join(d, "root") };
})();

/** A stand-in ffmpeg-skill checkout: scripts/probe.py prints `out` and exits `code`, logging its argv. */
function stubSkill(out, { code = 0, version = "9.9.9", raw } = {}) {
  const dir = tmp("hfs-ffmpeg-skill-");
  mkdirSync(join(dir, "scripts"));
  writeJson(join(dir, "package.json"), { name: "ffmpeg-skill", version });
  writeFileSync(join(dir, "scripts", "out.txt"), raw ?? JSON.stringify(out));
  writeFileSync(
    join(dir, "scripts", "probe.py"),
    [
      "import json, os, sys",
      "here = os.path.dirname(os.path.abspath(__file__))",
      "open(os.path.join(here, 'argv.json'), 'w').write(json.dumps(sys.argv[1:]))",
      "sys.stdout.write(open(os.path.join(here, 'out.txt')).read())",
      `sys.exit(${code})`,
      "",
    ].join("\n"),
  );
  return dir;
}

const argvOf = (dir) => JSON.parse(readFileSync(join(dir, "scripts", "argv.json"), "utf8"));

/** An ffmpeg-skill/probe document (the keys it really prints that this reads). */
function probeDoc({ width = 320, height = 180, fps = 30, duration = 1, codec = "h264", pix_fmt = "yuv420p", nb_frames = 30 } = {}) {
  return { file: "x", format: "mov,mp4,m4a,3gp,3g2,mj2", duration, size_bytes: 1000, video: { codec, width, height, fps, pix_fmt, nb_frames, duration }, audio: null };
}

const EXPECTED = { width: 320, height: 180, duration: 1, fps: 30, frames: 30, codec: "h264", fps_source: "data-fps" };

function verify(skillDir, file, { expected = EXPECTED, codec = "h264" } = {}) {
  const ctx = new Context({ json: true });
  const res = verifyWithFfmpegSkill(ctx, { file, expected, codec, explicit: skillDir ?? undefined, search: NOWHERE });
  return { ctx, res };
}

function tinyFile() {
  const dir = tmp();
  const f = join(dir, "out.mp4");
  writeFileSync(f, "not inspected by the stand-in");
  return f;
}

test("present: ffmpeg-skill/probe's measurements and version are reported, and a match is PASSED", () => {
  const skill = stubSkill(probeDoc());
  const file = tinyFile();
  const { ctx, res } = verify(skill, file);
  assert.equal(res.status, "PASSED", JSON.stringify(res));
  assert.equal(res.reason, undefined);
  assert.equal(res.tool, "ffmpeg-skill/probe");
  assert.deepEqual(res.skill, { dir: skill, source: "--ffmpeg-skill", version: "9.9.9", version_source: "package.json" });
  assert.deepEqual(res.measured, { duration: 1, width: 320, height: 180, fps: 30, codec: "h264", pix_fmt: "yuv420p", alpha: false, frames: 30 });
  assert.deepEqual(res.checks.map((c) => [c.check, c.ok]), [["codec", true], ["resolution", true], ["fps", true], ["duration", true]]);
  // run as python3 <dir>/scripts/probe.py --json -- <file>, and recorded
  assert.deepEqual(argvOf(skill), ["--json", "--", file]);
  assert.equal(ctx.commands.length, 1);
  assert.equal(ctx.commands[0].role, "ffmpeg-skill/probe");
  assert.equal(ctx.commands[0].exit_code, 0);
  assert.deepEqual(ctx.commands[0].argv.slice(1), [join(skill, "scripts", "probe.py"), "--json", "--", file]);
  assert.deepEqual(ffmpegSkillStep(res), { step: "ffmpeg_skill", ok: true, detail: "ffmpeg-skill/probe 9.9.9 agrees: codec, resolution, fps, duration" });
});

test("a mismatch ffmpeg-skill measures is FAILED, naming each failing check", () => {
  const skill = stubSkill(probeDoc({ width: 640, height: 360, fps: 25, duration: 1.03 }));
  const { res } = verify(skill, tinyFile());
  assert.equal(res.status, "FAILED");
  assert.match(res.reason, /mismatch: resolution, fps/);
  const byName = Object.fromEntries(res.checks.map((c) => [c.check, c]));
  assert.deepEqual([byName.codec.ok, byName.resolution.ok, byName.fps.ok, byName.duration.ok], [true, false, false, true]);
  assert.equal(byName.resolution.expected, "320x180");
  assert.equal(byName.resolution.actual, "640x360");
  assert.deepEqual(ffmpegSkillStep(res).ok, false);
  // duration outside one frame + 1 ms fails too; a wrong codec too
  assert.equal(verify(stubSkill(probeDoc({ duration: 1.05 })), tinyFile()).res.checks.find((c) => c.check === "duration").ok, false);
  assert.equal(verify(stubSkill(probeDoc({ codec: "hevc" })), tinyFile()).res.status, "FAILED");
});

test("absent: UNCHECKED with the reason and every place looked, nothing run, no verification step", () => {
  const ctx = new Context({ json: true });
  const res = verifyWithFfmpegSkill(ctx, { file: tinyFile(), expected: EXPECTED, codec: "h264", search: NOWHERE });
  assert.equal(res.status, "UNCHECKED");
  assert.equal(res.reason, "ffmpeg-skill not found");
  assert.equal(res.skill, null);
  assert.deepEqual(res.tried.map((t) => t.split(":")[0]), ["claude-skills", "vendor", "sibling"]);
  assert.deepEqual(ctx.commands, []);
  assert.equal(ffmpegSkillStep(res), null, "UNCHECKED never becomes a verification step, so never a pass");
});

test("search order: --ffmpeg-skill alone, else the env variables, ~/.claude/skills, ./vendor, the sibling checkout", () => {
  const a = stubSkill(probeDoc());
  const b = stubSkill(probeDoc());
  const home = tmp();
  mkdirSync(join(home, ".claude", "skills", "ffmpeg-skill", "scripts"), { recursive: true });
  writeFileSync(join(home, ".claude", "skills", "ffmpeg-skill", "scripts", "probe.py"), "");
  const search = { env: { HYPERFRAMES_SKILL_FFMPEG_SKILL_DIR: a, VIDEO_AGENT_FFMPEG_SKILL_DIR: b }, home, cwd: NOWHERE.cwd, root: NOWHERE.root };
  assert.equal(locateFfmpegSkill(undefined, search).source, "env:HYPERFRAMES_SKILL_FFMPEG_SKILL_DIR");
  assert.equal(locateFfmpegSkill(undefined, { ...search, env: { VIDEO_AGENT_FFMPEG_SKILL_DIR: b } }).dir, b);
  assert.equal(locateFfmpegSkill(undefined, { ...search, env: {} }).source, "claude-skills");
  // an explicit directory that is not a checkout is not silently replaced by a fallback
  const miss = locateFfmpegSkill(NOWHERE.home, search);
  assert.equal(miss.dir, null);
  assert.equal(miss.tried.length, 1);
});

test("corrupt or empty output: ffmpeg-skill refusing the file is FAILED, not a crash", () => {
  // the failure document ffmpeg-skill 2.x prints for an empty file / random bytes (exit 1)
  const refused = { status: "failed", exit_code: 1, error: { kind: "input", message: "ffprobe failed on x:\nmoov atom not found", code: "INPUT_INVALID", retryable: false }, commands: [] };
  const { ctx, res } = verify(stubSkill(refused, { code: 1 }), tinyFile());
  assert.equal(res.status, "FAILED");
  assert.equal(res.reason, "ffmpeg-skill/probe refused the file (input): ffprobe failed on x:");
  assert.equal(res.error.code, "INPUT_INVALID");
  assert.equal(ctx.commands[0].exit_code, 1);
  // a document without a video stream is FAILED too
  assert.equal(verify(stubSkill({ ...probeDoc(), video: null }), tinyFile()).res.status, "FAILED");
});

test("an ffmpeg-skill that gives no usable result is UNCHECKED, never PASSED or a crash", () => {
  assert.match(verify(stubSkill(null, { raw: "Traceback (most recent call last):\n", code: 1 }), tinyFile()).res.reason, /no usable result \(exit 1/);
  assert.match(verify(stubSkill(null, { raw: "not json" }), tinyFile()).res.reason, /no JSON probe document/);
  assert.equal(verify(stubSkill(null, { raw: "[1, 2]" }), tinyFile()).res.status, "UNCHECKED");
  const ctx = new Context({ json: true });
  const res = verifyWithFfmpegSkill(ctx, { file: tinyFile(), expected: EXPECTED, codec: "h264", explicit: stubSkill(probeDoc()), search: NOWHERE, env: { HYPERFRAMES_SKILL_PYTHON: "/nonexistent/python3" } });
  assert.equal(res.status, "UNCHECKED");
  assert.match(res.reason, /no Python|Python is not/);
  assert.deepEqual(ctx.commands, []);
  // no package.json: the version is "unknown", not guessed
  const skill = stubSkill(probeDoc());
  writeFileSync(join(skill, "package.json"), "{");
  assert.equal(verify(skill, tinyFile()).res.skill.version, "unknown");
});

test("alpha is checked when the codec carries it: ProRes from pix_fmt; VP9 alpha is not measurable through ffmpeg-skill", () => {
  assert.deepEqual(["h264", "vp9", "prores"].map(expectsAlpha), [false, true, true]);
  const prores = { ...EXPECTED, codec: "prores" };
  const ok = verify(stubSkill(probeDoc({ codec: "prores", pix_fmt: "yuva444p12le" })), tinyFile(), { expected: prores, codec: "prores" }).res;
  assert.equal(ok.status, "PASSED");
  assert.deepEqual(ok.checks.at(-1), { check: "alpha", ok: true, expected: true, actual: true, pix_fmt: "yuva444p12le" });
  const lost = verify(stubSkill(probeDoc({ codec: "prores", pix_fmt: "yuv422p10le" })), tinyFile(), { expected: prores, codec: "prores" }).res;
  assert.equal(lost.status, "FAILED");
  assert.match(lost.reason, /alpha/);
  const vp9 = verify(stubSkill(probeDoc({ codec: "vp9", pix_fmt: "yuv420p" })), tinyFile(), { expected: { ...EXPECTED, codec: "vp9" }, codec: "vp9" }).res;
  assert.equal(vp9.status, "UNCHECKED");
  assert.equal(vp9.reason, "ffmpeg-skill/probe cannot measure: alpha");
  assert.equal(vp9.checks.at(-1).ok, null);
  // h264 has no alpha row at all
  assert.equal(compare(EXPECTED, "h264", measuredFrom(probeDoc())).some((c) => c.check === "alpha"), false);
});

test("render: --ffmpeg-skill that is not a checkout is an input error; a dry run reports UNCHECKED and runs nothing", () => {
  const dir = tmp();
  const s = tool("scene", [join(FIXTURES, "two-line.json"), "-o", join(dir, "scene"), "--json"]);
  assert.equal(s.code, 0, s.stderr);
  const bad = tool("render", [join(dir, "scene"), "-o", join(dir, "a.mp4"), "--ffmpeg-skill", join(dir, "nope"), "--json"]);
  assert.equal(bad.code, 1);
  assert.equal(bad.doc.error.kind, "input");
  assert.match(bad.doc.error.message, /not an ffmpeg-skill checkout/);
  const skill = stubSkill(probeDoc());
  const dry = tool("render", [join(dir, "scene"), "-o", join(dir, "a.mp4"), "--ffmpeg-skill", skill, "--dry-run", "--json"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dry.doc.verified, false);
  assert.equal(dry.doc.ffmpeg_skill.status, "UNCHECKED");
  assert.equal(dry.doc.ffmpeg_skill.skill.version, "9.9.9");
  assert.deepEqual(dry.doc.ffmpeg_skill.planned_command.slice(1), [join(skill, "scripts", "probe.py"), "--json", "--", join(dir, "a.mp4")]);
  assert.ok(!existsSync(join(skill, "scripts", "argv.json")), "the dry run did not run ffmpeg-skill");
});

test("doctor reports the optional ffmpeg-skill capability without changing ok", () => {
  const skill = stubSkill(probeDoc(), { version: "2.23.1" });
  const r = tool("doctor", ["--json", "--no-chromium-probe"], { env: { HYPERFRAMES_SKILL_FFMPEG_SKILL_DIR: skill } });
  const cap = r.doc.capabilities["ffmpeg-skill"];
  assert.equal(cap.status, "available", JSON.stringify(cap));
  assert.equal(cap.version, "2.23.1");
  assert.equal(cap.source, "env:HYPERFRAMES_SKILL_FFMPEG_SKILL_DIR");
  assert.ok(!r.doc.required.includes("ffmpeg-skill"));
  assert.ok(!existsSync(join(skill, "scripts", "argv.json")), "doctor runs nothing of ffmpeg-skill");
});

// ---- the real ffmpeg-skill, on tiny files made here

function made(name, args) {
  const f = join(tmp(), name);
  ffmpeg([...args, f]);
  return f;
}

test("real ffmpeg-skill: a tiny h264 file is PASSED with its measurements and version", { skip: SKIP_REAL }, () => {
  const f = made("t.mp4", ["-f", "lavfi", "-i", "testsrc=s=320x180:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  const ctx = new Context({ json: true });
  const res = verifyWithFfmpegSkill(ctx, { file: f, expected: EXPECTED, codec: "h264", explicit: REAL });
  assert.equal(res.status, "PASSED", JSON.stringify(res));
  assert.equal(res.skill.version, JSON.parse(readFileSync(join(REAL, "package.json"), "utf8")).version);
  assert.deepEqual([res.measured.width, res.measured.height, res.measured.fps, res.measured.codec, res.measured.duration, res.measured.frames], [320, 180, 30, "h264", 1, 30]);
  // and the same file against a different request is FAILED
  const wrong = verifyWithFfmpegSkill(ctx, { file: f, expected: { ...EXPECTED, width: 1920, height: 1080, fps: 25 }, codec: "h264", explicit: REAL });
  assert.equal(wrong.status, "FAILED");
  assert.match(wrong.reason, /resolution, fps/);
});

test("real ffmpeg-skill: an empty file and random bytes are FAILED, not a crash", { skip: SKIP_REAL }, () => {
  const dir = tmp();
  writeFileSync(join(dir, "empty.mp4"), "");
  writeFileSync(join(dir, "junk.mp4"), Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37 + 11) % 256)));
  for (const name of ["empty.mp4", "junk.mp4"]) {
    const res = verifyWithFfmpegSkill(new Context({ json: true }), { file: join(dir, name), expected: EXPECTED, codec: "h264", explicit: REAL });
    assert.equal(res.status, "FAILED", `${name}: ${JSON.stringify(res)}`);
    assert.match(res.reason, /refused the file/);
  }
});

test("real ffmpeg-skill: ProRes 4444 alpha is seen; VP9 alpha is UNCHECKED (the recorded gap)", { skip: SKIP_REAL }, () => {
  const src = ["-f", "lavfi", "-i", "color=c=red@0.5:s=320x180:r=30:d=1,format=yuva444p10le"];
  const mov = made("t.mov", [...src, "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"]);
  const p = verifyWithFfmpegSkill(new Context({ json: true }), { file: mov, expected: { ...EXPECTED, codec: "prores" }, codec: "prores", explicit: REAL });
  assert.equal(p.status, "PASSED", JSON.stringify(p));
  assert.equal(p.measured.alpha, true);
  const webm = made("t.webm", ["-f", "lavfi", "-i", "color=c=red@0.5:s=320x180:r=30:d=1,format=yuva420p", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-metadata:s:v:0", "alpha_mode=1"]);
  const v = verifyWithFfmpegSkill(new Context({ json: true }), { file: webm, expected: { ...EXPECTED, codec: "vp9" }, codec: "vp9", explicit: REAL });
  assert.equal(v.status, "UNCHECKED", JSON.stringify(v));
  assert.equal(v.reason, "ffmpeg-skill/probe cannot measure: alpha");
  assert.ok(v.checks.filter((c) => c.check !== "alpha").every((c) => c.ok === true), "everything else it can measure matched");
});

// ---- a real render whose ffmpeg-skill read-back disagrees

test("render: an ffmpeg-skill mismatch fails the render with kind verification and reports it", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const s = tool("scene", [join(FIXTURES, "two-line.json"), "-o", join(dir, "scene"), "--json"]);
  assert.equal(s.code, 0, s.stderr);
  const skill = stubSkill(probeDoc({ width: 640, height: 360 }));
  const out = join(dir, "o.mp4");
  const r = tool("render", [join(dir, "scene"), "-o", out, "--ffmpeg-skill", skill, "--json"]);
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.doc.status, "failed");
  assert.equal(r.doc.error.kind, "verification");
  assert.match(r.doc.error.message, /ffmpeg_skill/);
  assert.equal(r.doc.verified, false);
  assert.equal(r.doc.ffmpeg_skill.status, "FAILED");
  assert.deepEqual(r.doc.verification.at(-1).step, "ffmpeg_skill");
  assert.equal(r.doc.verification.at(-1).ok, false);
  // this skill's own checks still passed: only ffmpeg-skill disagreed
  assert.ok(r.doc.verification.slice(0, -1).every((x) => x.ok), JSON.stringify(r.doc.verification));
  assert.equal(r.doc.commands.at(-1).role, "ffmpeg-skill/probe");
  assert.deepEqual(argvOf(skill), ["--json", "--", out]);
});
