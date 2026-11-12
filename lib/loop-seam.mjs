// The loop seam, measured on the rendered loop file: does its last frame lead into its first?
//
// Every frame is decoded to 64x64 grey (area-averaged, so the measure does not depend on the
// output's size) and compared with the next one: the mean absolute difference per pixel, 0..255.
// The wrap is the same measure from the last frame back to the first, which is what a player
// shows when it repeats the file. A seamless loop's wrap is no larger than the largest step the
// loop already takes between two of its own frames (plus `tolerance` for encoder noise); a loop
// that jumps at the wrap is not. The loop segment is built to be seamless (scene refuses anything
// else, docs/design-decisions.md D12); this is the read-back that it is.
import { spawn } from "node:child_process";
import { resolveFfTool } from "./deps.mjs";

export const SEAM_SIZE = 64;
export const SEAM_TOLERANCE = 1;

/** Mean absolute difference of two equal-length byte buffers. */
function diff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** Running seam measure: feed frames in order, then read the document. Holds two frames, not the file. */
export function seamMeter(tolerance = SEAM_TOLERANCE) {
  let first = null;
  let prev = null;
  let n = 0;
  let max = 0;
  let sum = 0;
  return {
    push(frame) {
      if (first === null) first = Buffer.from(frame);
      else {
        const d = diff(prev, frame);
        if (d > max) max = d;
        sum += d;
      }
      prev = Buffer.from(frame);
      n++;
    },
    result() {
      if (n === 0) return { measured: false, reason: "no frame was decoded", frames: 0, tolerance, ok: false };
      const wrap = n < 2 ? 0 : diff(prev, first);
      const r = (v) => Number(v.toFixed(4));
      return { measured: true, frames: n, wrap_diff: r(wrap), max_step_diff: r(max), mean_step_diff: r(n < 2 ? 0 : sum / (n - 1)), tolerance, ok: wrap <= max + tolerance };
    },
  };
}

/** Pure part: frames (Buffers of equal length) -> the seam document. */
export function seamFromFrames(frames, tolerance = SEAM_TOLERANCE) {
  const m = seamMeter(tolerance);
  for (const f of frames) m.push(f);
  return m.result();
}

/**
 * Decode `file` and measure its wrap, frame by frame as ffmpeg writes them (a long loop is never
 * held in memory). Records the ffmpeg command in ctx.
 */
export function measureLoopSeam(ctx, file, { tolerance = SEAM_TOLERANCE } = {}) {
  const ff = resolveFfTool("ffmpeg");
  if (!ff.path) return Promise.resolve({ measured: false, reason: `ffmpeg not found (${ff.source}: ${ff.requested})`, ok: false });
  const argv = [ff.path, "-hide_banner", "-nostdin", "-v", "error", "-i", file, "-an", "-vf", `scale=${SEAM_SIZE}:${SEAM_SIZE}:flags=area,format=gray`, "-f", "rawvideo", "-"];
  const entry = ctx.record(argv, { exit_code: null });
  const size = SEAM_SIZE * SEAM_SIZE;
  const meter = seamMeter(tolerance);
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let pending = Buffer.alloc(0);
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let o = 0;
      for (; o + size <= pending.length; o += size) meter.push(pending.subarray(o, o + size));
      pending = pending.subarray(o);
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 4096) stderr += d;
    });
    child.on("error", (e) => {
      entry.exit_code = null;
      done({ measured: false, reason: `ffmpeg did not start: ${e.message}`, ok: false });
    });
    child.on("close", (code) => {
      entry.exit_code = code;
      if (code !== 0) return done({ measured: false, reason: `ffmpeg could not decode ${file}: ${stderr.trim().slice(0, 300)}`, ok: false });
      done(meter.result());
    });
  });
}
