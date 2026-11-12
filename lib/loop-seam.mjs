// The loop seam, measured on the rendered loop file: does its last frame lead into its first?
//
// Every frame is decoded to 64x64 grey (area-averaged, so the measure does not depend on the
// output's size) and compared with the next one: the mean absolute difference per pixel, 0..255.
// The wrap is the same measure from the last frame back to the first, which is what a player
// shows when it repeats the file. A seamless loop's wrap is no larger than the largest step the
// loop already takes between two of its own frames (plus `tolerance` for encoder noise); a loop
// that jumps at the wrap is not. The loop segment is built to be seamless (scene refuses anything
// else, docs/design-decisions.md D12); this is the read-back that it is.
import { spawnSync } from "node:child_process";
import { resolveFfTool } from "./deps.mjs";

export const SEAM_SIZE = 64;
export const SEAM_TOLERANCE = 1;

/** Mean absolute difference of two equal-length byte buffers. */
function diff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** Pure part: frames (Buffers of equal length) -> the seam document. */
export function seamFromFrames(frames, tolerance = SEAM_TOLERANCE) {
  if (frames.length < 2) return { measured: true, frames: frames.length, wrap_diff: 0, max_step_diff: 0, mean_step_diff: 0, tolerance, ok: true };
  const steps = [];
  for (let i = 1; i < frames.length; i++) steps.push(diff(frames[i - 1], frames[i]));
  const wrap = diff(frames.at(-1), frames[0]);
  const max = Math.max(...steps);
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  const r = (v) => Number(v.toFixed(4));
  return { measured: true, frames: frames.length, wrap_diff: r(wrap), max_step_diff: r(max), mean_step_diff: r(mean), tolerance, ok: wrap <= max + tolerance };
}

/** Decode `file` and measure its wrap. Records the ffmpeg command in ctx. */
export function measureLoopSeam(ctx, file, { tolerance = SEAM_TOLERANCE } = {}) {
  const ff = resolveFfTool("ffmpeg");
  if (!ff.path) return { measured: false, reason: `ffmpeg not found (${ff.source}: ${ff.requested})`, ok: false };
  const argv = [ff.path, "-hide_banner", "-nostdin", "-v", "error", "-i", file, "-an", "-vf", `scale=${SEAM_SIZE}:${SEAM_SIZE}:flags=area,format=gray`, "-f", "rawvideo", "-"];
  const entry = ctx.record(argv, { exit_code: null });
  const r = spawnSync(argv[0], argv.slice(1), { timeout: 600000, maxBuffer: 1024 * 1024 * 1024 });
  entry.exit_code = r.status;
  if (r.error || r.status !== 0) return { measured: false, reason: `ffmpeg could not decode ${file}: ${String(r.error?.message ?? r.stderr ?? "").trim().slice(0, 300)}`, ok: false };
  const size = SEAM_SIZE * SEAM_SIZE;
  const frames = [];
  for (let o = 0; o + size <= r.stdout.length; o += size) frames.push(r.stdout.subarray(o, o + size));
  return seamFromFrames(frames, tolerance);
}
