import { addOpt, baseCommand } from "../cli.mjs";
import { DEFAULT_TIMEOUT_S, executeRender, hyperframesArgv, planRender } from "../render-core.mjs";
import { resolveHyperframes } from "../deps.mjs";
import { emit, fail, ToolError } from "../result.mjs";
import { checkFps, checkTimeout } from "./render.mjs";

export const PREVIEW_PRESET = "draft";

export const meta = {
  name: "preview",
  role: "execution",
  description: "Fast proxy render of a scene directory for checking layout and timing before the full render: lower frame rate, HyperFrames' draft encoder preset, optionally only the first N seconds. Same resolution as the scene.",
  capabilities: { required: ["node", "hyperframes", "chromium:headless", "ffmpeg", "ffprobe", "encoder:libx264", "disk:tmp"], optional: [] },
  inputs: ["a scene directory with index.html"],
  outputs: ["an .mp4 proxy (h264, draft quality)"],
  produces_artifact: true,
  supports_dry_run: true,
  dry_run: "same as render: validates and reports the planned command and expected frame count; launches neither Chrome nor ffmpeg and writes nothing",
  verification: { required: true, tools: ["probe"] },
  deterministic_inputs: true,
  idempotency_hint: "bit_exact",
  output_schema: "same as render, plus truncated (true when --max-duration cut the scene short)",
};

export function command() {
  const cmd = baseCommand("preview", meta.description).argument("<scene_dir>", "scene directory containing index.html");
  addOpt(cmd, "-o, --output <file>", "proxy .mp4 to write", { required: true });
  addOpt(cmd, "--fps <n>", "proxy frame rate, integer 1-240", { type: "integer", default: 10 });
  addOpt(cmd, "--max-duration <seconds>", "render only the first N seconds (a staged copy of the scene is shortened; the scene itself is untouched)", { type: "number" });
  addOpt(cmd, "--workers <n>", "parallel capture workers: auto or 1-8", { type: "workers", default: "auto" });
  addOpt(cmd, "--timeout <seconds>", "kill the render after this long; 0 disables", { type: "number", default: DEFAULT_TIMEOUT_S });
  addOpt(cmd, "--overwrite", "replace an existing output file", { type: "boolean" });
  return cmd;
}

export async function run(ctx, [sceneDir], opts) {
  checkFps(opts.fps);
  checkTimeout(opts.timeout);
  if (opts.maxDuration !== undefined && !(opts.maxDuration > 0)) throw new ToolError("input", "--max-duration must be > 0 seconds");
  const plan = planRender({ sceneDir, output: opts.output, codec: "h264", fps: opts.fps, workers: opts.workers, overwrite: !!opts.overwrite, maxDuration: opts.maxDuration });
  const extra = { truncated: plan.truncated, preset: PREVIEW_PRESET };
  if (ctx.dryRun) {
    const hf = resolveHyperframes();
    ctx.info(`wrote ${plan.output}`);
    return emit(ctx, { output: plan.output, expected: plan.expected, ...extra, planned_commands: [hyperframesArgv(hf.path ?? "hyperframes", plan, plan.truncated ? "<staged copy>" : plan.sceneDir, { preset: PREVIEW_PRESET })] });
  }
  const r = await executeRender(ctx, plan, { timeoutS: opts.timeout, preset: PREVIEW_PRESET });
  const result = { output: plan.output, expected: plan.expected, ...extra, probe: r.probe, hyperframes: r.hyperframes };
  if (!r.verification.every((s) => s.ok)) {
    return fail(ctx, new ToolError("verification", `preview rendered, but it does not match the plan: ${r.verification.filter((s) => !s.ok).map((s) => s.step).join(", ")}`), { ...result, verification: r.verification });
  }
  ctx.info(`wrote ${plan.output}`);
  return emit(ctx, { ...result, verification: r.verification });
}
