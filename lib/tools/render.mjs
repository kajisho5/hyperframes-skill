import { addOpt, baseCommand } from "../cli.mjs";
import { CODECS, DEFAULT_TIMEOUT_S, executeRender, hyperframesArgv, planRender, planSegments } from "../render-core.mjs";
import { measureLoopSeam } from "../loop-seam.mjs";
import { resolveHyperframes } from "../deps.mjs";
import { ffmpegSkillStep, planFfmpegSkill, requireExplicitFfmpegSkill, verifyWithFfmpegSkill } from "../ffmpeg-skill.mjs";
import { emit, fail, ToolError } from "../result.mjs";

export const meta = {
  name: "render",
  role: "execution",
  description: "Render a HyperFrames scene directory to video: headless Chrome captures every frame, ffmpeg encodes them; the result is probed and compared with the scene's declared size, duration and fps, and cross-checked with ffmpeg-skill's probe when an ffmpeg-skill checkout is present.",
  capabilities: {
    required: ["node", "hyperframes", "chromium:headless", "ffmpeg", "ffprobe", "encoder:libx264", "disk:tmp"],
    optional: [
      { capability: "encoder:libvpx-vp9", when: "--codec vp9" },
      { capability: "encoder:prores_ks", when: "--codec prores" },
      { capability: "ffmpeg-skill", when: "present: the output is cross-checked with ffmpeg-skill/probe (ffmpeg_skill.status PASSED / FAILED); absent: ffmpeg_skill.status UNCHECKED" },
    ],
  },
  inputs: ["a scene directory with index.html (from `scene`, or any HyperFrames composition whose root declares data-width, data-height and data-duration)"],
  outputs: ["a video file (.mp4 h264, .webm vp9 or .mov prores)", "with --segments, also one file per segment next to it: <stem>.in<ext>, <stem>.loop<ext>, <stem>.out<ext>"],
  produces_artifact: true,
  supports_dry_run: true,
  dry_run: "reads index.html, checks the root's declared size/duration/fps and the output path, and reports the hyperframes command it would run and the expected frame count (with --segments, every segment's output and frame count too); launches neither Chrome nor ffmpeg and writes nothing",
  verification: { required: true, tools: ["probe", "ffmpeg-skill/probe (when present)"] },
  deterministic_inputs: true,
  idempotency_hint: "bit_exact",
  output_schema: "{status, output, expected: {width, height, duration, fps, frames, codec, fps_source}, probe, hyperframes: {version, chromium: {path, source}}, verified, verification[], ffmpeg_skill: {status: PASSED|FAILED|UNCHECKED, reason?, tool, skill: {dir, source, version, version_source}|null, measured?: {duration, width, height, fps, codec, pix_fmt, alpha, frames}, checks?: [{check, ok, expected, actual}], tried?}, segments (--segments only): [{name, start, duration, start_frame, frames, output|null, probe, verified, verification[], ffmpeg_skill}], loop_seam (--segments only): {measured, frames, wrap_diff, max_step_diff, mean_step_diff, tolerance, ok}, commands[] (hyperframes, then every chrome/ffmpeg/ffprobe process it started, then this skill's ffprobe, then ffmpeg-skill/probe when present; with --segments the same again per segment, then the loop seam's ffmpeg)}",
};

export function command() {
  const cmd = baseCommand("render", meta.description).argument("<scene_dir>", "scene directory containing index.html");
  addOpt(cmd, "-o, --output <file>", "video file to write; its extension must match --codec", { required: true });
  addOpt(cmd, "--codec <codec>", "h264 (.mp4), vp9 (.webm) or prores (.mov, ProRes 4444)", { choices: Object.keys(CODECS), default: "h264" });
  addOpt(cmd, "--quality <n>", "CRF, codec-neutral scale (lower is better): h264 0-51, vp9 0-63; not for prores. Default: HyperFrames' own default (CRF 16)", { type: "integer" });
  addOpt(cmd, "--fps <n>", "frame rate, integer 1-240 (default: the root's data-fps, else 30)", { type: "integer" });
  addOpt(cmd, "--workers <n>", "parallel capture workers: auto or 1-8", { type: "workers", default: "auto" });
  addOpt(cmd, "--timeout <seconds>", "kill the render (Chrome and ffmpeg included) after this long; 0 disables", { type: "number", default: DEFAULT_TIMEOUT_S });
  addOpt(cmd, "--segments", "also render each segment the scene declares (request `segments`: in, loop, out) to <stem>.<segment><ext> next to the output, and measure the loop file's seam", { type: "boolean" });
  addOpt(cmd, "--overwrite", "replace an existing output file", { type: "boolean" });
  addOpt(cmd, "--ffmpeg-skill <dir>", "ffmpeg-skill checkout to cross-check the output with (default: HYPERFRAMES_SKILL_FFMPEG_SKILL_DIR, VIDEO_AGENT_FFMPEG_SKILL_DIR, ~/.claude/skills/ffmpeg-skill, ./vendor/ffmpeg-skill, ../ffmpeg-skill next to this checkout; none found: ffmpeg_skill.status UNCHECKED)");
  return cmd;
}

export function checkFps(fps) {
  if (fps !== undefined && !(Number.isInteger(fps) && fps >= 1 && fps <= 240)) throw new ToolError("input", "--fps must be an integer 1..240");
}

export function checkTimeout(t) {
  if (!(t >= 0)) throw new ToolError("input", "--timeout must be >= 0 seconds");
}

export async function run(ctx, [sceneDir], opts) {
  checkFps(opts.fps);
  checkTimeout(opts.timeout);
  const plan = planRender({ sceneDir, output: opts.output, codec: opts.codec, quality: opts.quality, fps: opts.fps, workers: opts.workers, overwrite: !!opts.overwrite });
  const segments = opts.segments ? planSegments(plan, { overwrite: !!opts.overwrite }) : null;
  requireExplicitFfmpegSkill(opts.ffmpegSkill);
  if (ctx.dryRun) {
    const hf = resolveHyperframes();
    ctx.info(`wrote ${plan.output}`);
    const planned = [hyperframesArgv(hf.path ?? "hyperframes", plan, plan.sceneDir)];
    for (const S of segments ?? []) {
      if (!S.plan) continue;
      ctx.info(`wrote ${S.output}`);
      planned.push(hyperframesArgv(hf.path ?? "hyperframes", S.plan, "<staged copy>"));
    }
    return emit(ctx, { output: plan.output, expected: plan.expected, ...(segments ? { segments: segments.map(publicSegment) } : {}), planned_commands: planned, ffmpeg_skill: planFfmpegSkill({ file: plan.output, explicit: opts.ffmpegSkill }) });
  }
  const r = await executeRender(ctx, plan, { timeoutS: opts.timeout });
  // The engine bypass (docs/design-decisions.md D3): HyperFrames encoded this file with its own
  // ffmpeg pipeline, so ffmpeg-skill reads it back here. UNCHECKED adds no step and is never a pass.
  const ffmpegSkill = verifyWithFfmpegSkill(ctx, { file: plan.output, expected: plan.expected, codec: plan.codec, explicit: opts.ffmpegSkill });
  const step = ffmpegSkillStep(ffmpegSkill);
  const verification = step ? [...r.verification, step] : r.verification;
  const result = { output: plan.output, expected: plan.expected, probe: r.probe, hyperframes: r.hyperframes, ffmpeg_skill: ffmpegSkill };
  if (segments) {
    const done = [];
    for (const S of segments) {
      if (!S.plan) {
        done.push({ ...publicSegment(S), probe: null, verified: true, verification: [], ffmpeg_skill: null });
        continue;
      }
      const sr = await executeRender(ctx, S.plan, { timeoutS: opts.timeout });
      const sf = verifyWithFfmpegSkill(ctx, { file: S.output, expected: S.plan.expected, codec: plan.codec, explicit: opts.ffmpegSkill });
      const sstep = ffmpegSkillStep(sf);
      const sv = sstep ? [...sr.verification, sstep] : sr.verification;
      done.push({ ...publicSegment(S), probe: sr.probe, verified: sv.every((s) => s.ok), verification: sv, ffmpeg_skill: sf });
      ctx.info(`wrote ${S.output} (${S.name}: ${S.frames} frames)`);
    }
    const total = done.reduce((n, S) => n + (S.probe?.video?.frames ?? 0), 0);
    verification.push({
      step: "segments",
      ok: done.every((S) => S.verified) && total === r.probe?.video?.frames,
      expected: { frames: plan.expected.frames },
      actual: { frames: total, per_segment: Object.fromEntries(done.map((S) => [S.name, S.probe?.video?.frames ?? 0])) },
      detail: "every segment file verified, and their probed frame counts add up to the full render's",
    });
    const loop = done.find((S) => S.name === "loop");
    const seam = await measureLoopSeam(ctx, loop.output);
    verification.push({ step: "loop_seam", ok: seam.ok, expected: `wrap_diff <= max_step_diff + ${seam.tolerance ?? "?"}`, actual: seam.measured ? { wrap_diff: seam.wrap_diff, max_step_diff: seam.max_step_diff } : seam.reason });
    result.segments = done;
    result.loop_seam = seam;
  }
  if (!verification.every((s) => s.ok)) {
    return fail(ctx, new ToolError("verification", `rendered, but the output does not match the scene: ${verification.filter((s) => !s.ok).map((s) => s.step).join(", ")}`), { ...result, verification });
  }
  ctx.info(`wrote ${plan.output}` + (ffmpegSkill.status === "UNCHECKED" ? ` (ffmpeg-skill: UNCHECKED, ${ffmpegSkill.reason})` : ` (ffmpeg-skill ${ffmpegSkill.skill.version}: ${ffmpegSkill.status})`));
  return emit(ctx, { ...result, verification });
}

// A segment as the result reports it: its timing and file, without the internal render plan.
function publicSegment(S) {
  return { name: S.name, start: S.start, duration: S.duration, start_frame: S.start_frame, frames: S.frames, output: S.output };
}
