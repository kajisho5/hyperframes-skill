// Cross-check of a rendered file through ffmpeg-skill's own probe, when an ffmpeg-skill checkout
// is present. HyperFrames encodes with its own ffmpeg pipeline (the "engine bypass",
// docs/design-decisions.md D3), so this is the point where the ecosystem's media engine reads the
// artifact back and either agrees with what was requested or says it does not.
//
// The result is one of three statuses, never inferred:
//   PASSED     ffmpeg-skill/probe read the file and every requested property matched
//   FAILED     ffmpeg-skill/probe refused the file (corrupt, empty, no video stream) or a
//              measured property differs from what was requested
//   UNCHECKED  nothing was compared, or not everything could be: no ffmpeg-skill, no Python,
//              ffmpeg-skill did not run or printed no readable result, or a requested property
//              is one ffmpeg-skill/probe does not report (VP9 alpha). `reason` says which.
// UNCHECKED is never reported as a pass: it adds no step to `verification[]`.
//
// ffmpeg-skill is never modified and never imported: it is run as
//   [python3, <dir>/scripts/probe.py, --json, --, <file>]
// with no shell, and its JSON document is parsed.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ROOT, which } from "./deps.mjs";
import { runSync } from "./proc.mjs";
import { ToolError } from "./result.mjs";

export const FFMPEG_SKILL_ENV = Object.freeze(["HYPERFRAMES_SKILL_FFMPEG_SKILL_DIR", "VIDEO_AGENT_FFMPEG_SKILL_DIR"]);
export const FFMPEG_SKILL_TOOL = "ffmpeg-skill/probe";
export const FFMPEG_SKILL_TIMEOUT_MS = 120000;
/** The ffmpeg-skill releases this was checked against (informational; not a gate, see D3). */
export const FFMPEG_SKILL_RANGE = ">=2.0.0 <4.0.0";   // 3.0.0 checked too (D11): probe's keys read here are unchanged

// The pixel formats HyperFrames encodes alpha into (yuva420p for VP9, yuva444p10le for ProRes
// 4444; prores_ks reads back as yuva444p12le). Same family test HyperFrames itself applies.
const ALPHA_PIX_FMT = /^(yuva|rgba|argb|bgra|abgr|gbrap|ya|ayuv)/i;

/** Does a render with this codec carry an alpha channel? h264 never; vp9 and prores always. */
export function expectsAlpha(codec) {
  return codec === "vp9" || codec === "prores";
}

/**
 * Where an ffmpeg-skill checkout is looked for, in order. An explicit directory (--ffmpeg-skill)
 * is the only candidate when given: it is never silently replaced by a fallback.
 * `search` overrides the environment, home, working directory and this checkout's root (tests).
 */
export function ffmpegSkillCandidates(explicit, search = {}) {
  if (explicit) return [{ path: resolve(explicit), source: "--ffmpeg-skill" }];
  const env = search.env ?? process.env;
  const out = [];
  for (const key of FFMPEG_SKILL_ENV) if (env[key]) out.push({ path: resolve(env[key]), source: `env:${key}` });
  out.push({ path: join(search.home ?? homedir(), ".claude", "skills", "ffmpeg-skill"), source: "claude-skills" });
  out.push({ path: join(search.cwd ?? process.cwd(), "vendor", "ffmpeg-skill"), source: "vendor" });
  out.push({ path: join(dirname(search.root ?? ROOT), "ffmpeg-skill"), source: "sibling" });
  return out;
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The first candidate holding scripts/probe.py: {dir, source, tried}; dir null when none does. */
export function locateFfmpegSkill(explicit, search = {}) {
  const tried = [];
  for (const c of ffmpegSkillCandidates(explicit, search)) {
    tried.push(`${c.source}: ${c.path}`);
    if (isFile(join(c.path, "scripts", "probe.py"))) return { dir: c.path, source: c.source, tried };
  }
  return { dir: null, source: null, tried };
}

/** For render's input check: an explicit --ffmpeg-skill that is not a checkout is an input error. */
export function requireExplicitFfmpegSkill(explicit) {
  if (!explicit) return;
  const loc = locateFfmpegSkill(explicit);
  if (!loc.dir) throw new ToolError("input", `--ffmpeg-skill ${explicit} is not an ffmpeg-skill checkout (no scripts/probe.py)`, { hint: "pass the directory that contains scripts/probe.py, or leave the flag out to use the default search" });
}

/** python3 for ffmpeg-skill: HYPERFRAMES_SKILL_PYTHON, else python3, else python on PATH. */
export function resolvePython(env = process.env) {
  if (env.HYPERFRAMES_SKILL_PYTHON) return { path: existsSync(env.HYPERFRAMES_SKILL_PYTHON) ? env.HYPERFRAMES_SKILL_PYTHON : null, source: "env:HYPERFRAMES_SKILL_PYTHON", requested: env.HYPERFRAMES_SKILL_PYTHON };
  const p = which("python3") ?? which("python");
  return { path: p, source: "PATH", requested: "python3" };
}

/**
 * ffmpeg-skill's version, read from its package.json (its probe document does not carry one).
 * "unknown" when the checkout has no readable package.json; never guessed.
 */
export function ffmpegSkillVersion(dir) {
  try {
    const v = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
    if (typeof v === "string" && v) return { version: v, version_source: "package.json" };
  } catch {
    /* fall through */
  }
  return { version: "unknown", version_source: null };
}

export function probeArgv(python, dir, file) {
  return [python, join(dir, "scripts", "probe.py"), "--json", "--", file];
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** What ffmpeg-skill/probe measured, in the shape the render result reports. */
export function measuredFrom(doc) {
  const v = doc.video;
  const pixFmt = typeof v?.pix_fmt === "string" ? v.pix_fmt : null;
  let alpha = null;
  if (pixFmt && ALPHA_PIX_FMT.test(pixFmt)) alpha = true;
  // VP9 keeps alpha in a side channel flagged by the stream tag alpha_mode=1, and ffmpeg-skill's
  // probe neither reports stream tags nor an alpha field: a VP9 file reads as yuv420p either way.
  else if (pixFmt && v?.codec !== "vp9") alpha = false;
  return {
    duration: num(doc.duration),
    width: num(v?.width),
    height: num(v?.height),
    fps: num(v?.fps),
    codec: v?.codec ?? null,
    pix_fmt: pixFmt,
    alpha,
    frames: num(v?.nb_frames),
  };
}

/** Requested vs measured, one row per property. ok: true / false / null (not measurable). */
export function compare(expected, codec, measured) {
  const tol = 1 / expected.fps + 0.001;
  const checks = [
    { check: "codec", ok: measured.codec === null ? null : measured.codec === expected.codec, expected: expected.codec, actual: measured.codec },
    { check: "resolution", ok: measured.width === null || measured.height === null ? null : measured.width === expected.width && measured.height === expected.height, expected: `${expected.width}x${expected.height}`, actual: measured.width === null ? null : `${measured.width}x${measured.height}` },
    { check: "fps", ok: measured.fps === null ? null : Math.abs(measured.fps - expected.fps) < 0.01, expected: expected.fps, actual: measured.fps },
    { check: "duration", ok: measured.duration === null ? null : Math.abs(measured.duration - expected.duration) <= tol, expected: expected.duration, actual: measured.duration, tolerance: Number(tol.toFixed(4)) },
  ];
  if (expectsAlpha(codec)) {
    const row = { check: "alpha", ok: measured.alpha === null ? null : measured.alpha === true, expected: true, actual: measured.alpha, pix_fmt: measured.pix_fmt };
    if (measured.alpha === null) row.detail = codec === "vp9" ? "ffmpeg-skill/probe does not report VP9 alpha (the alpha_mode stream tag); not measurable through it" : "no pixel format reported";
    checks.push(row);
  }
  return checks;
}

function statusOf(checks) {
  if (checks.some((c) => c.ok === false)) return { status: "FAILED", reason: `ffmpeg-skill/probe measured a mismatch: ${checks.filter((c) => c.ok === false).map((c) => c.check).join(", ")}` };
  const open = checks.filter((c) => c.ok === null);
  if (open.length) return { status: "UNCHECKED", reason: `ffmpeg-skill/probe cannot measure: ${open.map((c) => c.check).join(", ")}` };
  return { status: "PASSED" };
}

/** Dry run: what would be run, and that nothing was checked. */
export function planFfmpegSkill({ file, explicit, search, env = process.env } = {}) {
  const loc = locateFfmpegSkill(explicit, search);
  if (!loc.dir) return { status: "UNCHECKED", reason: "dry run: nothing was rendered; ffmpeg-skill not found", tool: FFMPEG_SKILL_TOOL, skill: null, tried: loc.tried };
  const py = resolvePython(env);
  return {
    status: "UNCHECKED",
    reason: "dry run: nothing was rendered",
    tool: FFMPEG_SKILL_TOOL,
    skill: { dir: loc.dir, source: loc.source, ...ffmpegSkillVersion(loc.dir) },
    planned_command: probeArgv(py.path ?? "python3", loc.dir, file),
  };
}

/**
 * Read `file` back through ffmpeg-skill/probe and compare it with `expected` (render's plan:
 * width, height, duration, fps, codec). Never throws for anything about the file or ffmpeg-skill;
 * the answer is in `status`. Records the probe in ctx.commands.
 */
export function verifyWithFfmpegSkill(ctx, { file, expected, codec, explicit, search, env = process.env, timeoutMs = FFMPEG_SKILL_TIMEOUT_MS }) {
  const base = { tool: FFMPEG_SKILL_TOOL };
  const loc = locateFfmpegSkill(explicit, search);
  if (!loc.dir) return { status: "UNCHECKED", reason: "ffmpeg-skill not found", ...base, skill: null, tried: loc.tried };
  const skill = { dir: loc.dir, source: loc.source, ...ffmpegSkillVersion(loc.dir) };
  const py = resolvePython(env);
  if (!py.path) return { status: "UNCHECKED", reason: `ffmpeg-skill found but Python is not (${py.source}: ${py.requested})`, ...base, skill };
  const argv = probeArgv(py.path, loc.dir, file);
  const entry = ctx.record(argv, { exit_code: null, role: FFMPEG_SKILL_TOOL });
  const r = runSync(argv, { timeoutMs });
  entry.exit_code = r.status;
  if (r.timedOut) return { status: "UNCHECKED", reason: `ffmpeg-skill/probe timed out after ${timeoutMs / 1000}s`, ...base, skill };
  if (r.error && r.status === null) return { status: "UNCHECKED", reason: `ffmpeg-skill/probe did not run: ${r.error}`, ...base, skill };
  let doc = null;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    /* handled below */
  }
  if (doc && typeof doc === "object" && doc.status === "failed") {
    // ffmpeg-skill read the file and refused it: corrupt, empty, not media.
    const msg = String(doc.error?.message ?? "no message").split("\n")[0];
    return { status: "FAILED", reason: `ffmpeg-skill/probe refused the file (${doc.error?.kind ?? "error"}): ${msg}`, ...base, skill, error: doc.error ?? null };
  }
  if (r.status !== 0 || !doc || typeof doc !== "object" || Array.isArray(doc)) {
    const why = r.status !== 0 ? `exit ${r.status}: ${(r.stderr || "").trim().split("\n").slice(-2).join(" | ").slice(0, 300)}` : "no JSON probe document on stdout";
    return { status: "UNCHECKED", reason: `ffmpeg-skill/probe gave no usable result (${why})`, ...base, skill };
  }
  const measured = measuredFrom(doc);
  if (!doc.video) return { status: "FAILED", reason: "ffmpeg-skill/probe found no video stream", ...base, skill, measured, checks: [] };
  const checks = compare(expected, codec, measured);
  return { ...statusOf(checks), ...base, skill, measured, checks };
}

/** The verification[] step a checked result adds; null for UNCHECKED (no step, never a pass). */
export function ffmpegSkillStep(res) {
  if (res.status === "UNCHECKED") return null;
  return { step: "ffmpeg_skill", ok: res.status === "PASSED", detail: res.status === "PASSED" ? `${FFMPEG_SKILL_TOOL} ${res.skill.version} agrees: ${res.checks.map((c) => c.check).join(", ")}` : res.reason };
}
