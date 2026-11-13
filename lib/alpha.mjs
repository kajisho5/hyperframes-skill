// The alpha channel of a rendered file, read back from its first frame.
//
// Which files carry alpha: ProRes 4444 (a yuva pixel format), VP9 in WebM (the stream reads as
// yuv420p; the alpha is a second stream flagged by the ALPHA_MODE=1 tag, and only the libvpx-vp9
// decoder returns it) and PNG (rgba). The first frame is decoded with ffmpeg's alphaextract to one
// byte per pixel, 0 = fully transparent, 255 = opaque.
//
// The mode is stated, not measured: every alpha output of this skill is straight (unassociated)
// alpha. HyperFrames captures each frame as a PNG screenshot, which is straight by definition, and
// pipes those PNGs into ffmpeg (`-f image2pipe -vcodec png`); ProRes 4444 and VP9 store the alpha
// plane beside the colour planes, and nothing in between premultiplies. tests/alpha.test.mjs pins
// it: a 50% blue layer reads back with blue near 255, not near 128 (docs/design-decisions.md D13).
import { spawnSync } from "node:child_process";
import { resolveFfTool } from "./deps.mjs";

export const ALPHA_MODE = "straight";
const ALPHA_PIX_FMT = /^(yuva|rgba|argb|bgra|abgr|gbrap|ya|ayuv|pal8)/i;

/** Does the probed video stream carry an alpha channel? */
export function hasAlpha(video) {
  if (!video) return false;
  return ALPHA_PIX_FMT.test(video.pix_fmt ?? "") || (video.codec === "vp9" && video.alpha_mode === "1");
}

/** "X,Y" -> {x, y}; throws on anything else (the caller turns it into kind: input). */
export function parseSample(s) {
  const m = /^(\d+),(\d+)$/.exec(String(s).trim());
  if (!m) throw new Error(`--sample must be X,Y in pixels (got ${s})`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/**
 * Read the first frame's alpha plane of `file` (a video file or one PNG). Returns
 * {mode, channel, first_frame: {min, max, mean, transparent_fraction, opaque_fraction, corners}, samples}
 * or {mode: "none", channel: false} for a stream without alpha, or {channel: null, reason} when
 * the frame could not be decoded. Records the ffmpeg command in ctx.
 */
export function readAlpha(ctx, file, video, { samples = [] } = {}) {
  if (!hasAlpha(video)) return { mode: "none", channel: false, reason: `${video?.codec ?? "no video"} ${video?.pix_fmt ?? ""} carries no alpha channel`.trim() };
  const ff = resolveFfTool("ffmpeg");
  if (!ff.path) return { mode: ALPHA_MODE, channel: null, reason: `ffmpeg not found (${ff.source}: ${ff.requested})` };
  const { width: W, height: H } = video;
  const argv = [ff.path, "-hide_banner", "-nostdin", "-v", "error", ...(video.codec === "vp9" ? ["-c:v", "libvpx-vp9"] : []), "-i", file, "-frames:v", "1", "-vf", "alphaextract,format=gray", "-f", "rawvideo", "-"];
  const entry = ctx.record(argv, { exit_code: null, role: "alpha" });
  const r = spawnSync(argv[0], argv.slice(1), { timeout: 120000, maxBuffer: 512 * 1024 * 1024 });
  entry.exit_code = r.status;
  if (r.error || r.status !== 0 || r.stdout.length !== W * H) {
    return { mode: ALPHA_MODE, channel: null, reason: `could not decode the alpha plane of ${file}: ${String(r.error?.message ?? r.stderr ?? `${r.stdout?.length} bytes, expected ${W * H}`).trim().slice(0, 300)}` };
  }
  const a = r.stdout;
  let min = 255;
  let max = 0;
  let sum = 0;
  let zero = 0;
  let full = 0;
  for (const v of a) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    if (v === 0) zero++;
    if (v === 255) full++;
  }
  const at = (x, y) => a[y * W + x];
  const n = a.length;
  const out = [];
  for (const s of samples) out.push({ x: s.x, y: s.y, alpha: s.x < W && s.y < H ? at(s.x, s.y) : null });
  return {
    mode: ALPHA_MODE,
    channel: true,
    first_frame: {
      min,
      max,
      mean: Number((sum / n).toFixed(3)),
      transparent_fraction: Number((zero / n).toFixed(4)),
      opaque_fraction: Number((full / n).toFixed(4)),
      corners: { top_left: at(0, 0), top_right: at(W - 1, 0), bottom_left: at(0, H - 1), bottom_right: at(W - 1, H - 1) },
    },
    samples: out,
  };
}

// qc-skill's video.stinger_opaque_at_cut_point threshold: a pixel counts as covered at >= 253/255.
export const OPAQUE_MIN = 253;

/**
 * The alpha planes of frames [from, to) of a video file (0-based frame numbers), decoded in one
 * ffmpeg run, or of frame_NNNNNN.png files in a PNG sequence directory (`frameFile(n)` gives the
 * file of frame n). Returns {measured: true, frames: [{frame, min, below}]} where `below` counts the
 * pixels under OPAQUE_MIN, or {measured: false, reason}. Records every ffmpeg command in ctx.
 */
export function readAlphaFrames(ctx, file, video, from, to, { frameFile = null } = {}) {
  if (!hasAlpha(video)) return { measured: false, reason: `${video?.codec ?? "no video"} ${video?.pix_fmt ?? ""} carries no alpha channel`.trim() };
  const ff = resolveFfTool("ffmpeg");
  if (!ff.path) return { measured: false, reason: `ffmpeg not found (${ff.source}: ${ff.requested})` };
  const { width: W, height: H } = video;
  const n = to - from;
  const decode = (input, vf, count) => {
    const argv = [ff.path, "-hide_banner", "-nostdin", "-v", "error", ...(video.codec === "vp9" ? ["-c:v", "libvpx-vp9"] : []), "-i", input, "-vf", vf, "-frames:v", String(count), "-f", "rawvideo", "-"];
    const entry = ctx.record(argv, { exit_code: null, role: "alpha" });
    const r = spawnSync(argv[0], argv.slice(1), { timeout: 300000, maxBuffer: Math.max(64, count) * W * H + 1024 * 1024 });
    entry.exit_code = r.status;
    if (r.error || r.status !== 0 || r.stdout.length !== count * W * H) return { reason: `could not decode the alpha plane of ${input}: ${String(r.error?.message ?? r.stderr ?? "").trim().slice(0, 300) || `${r.stdout?.length} bytes, expected ${count * W * H}`}` };
    return { bytes: r.stdout };
  };
  const stats = (a, offset, frame) => {
    let min = 255;
    let below = 0;
    for (let i = offset; i < offset + W * H; i++) {
      const v = a[i];
      if (v < min) min = v;
      if (v < OPAQUE_MIN) below++;
    }
    return { frame, min, below };
  };
  const frames = [];
  if (frameFile) {
    // a PNG frame with no transparent pixel can be written as RGB without an alpha plane (seen in
    // HyperFrames' PNG sequences): format=rgba gives it the alpha 255 it has
    for (let k = from; k < to; k++) {
      const d = decode(frameFile(k), "format=rgba,alphaextract,format=gray", 1);
      if (d.reason) return { measured: false, reason: d.reason };
      frames.push(stats(d.bytes, 0, k));
    }
  } else {
    // trim by frame number, then restart the timestamps, so exactly frames from..to-1 come out
    const d = decode(file, `trim=start_frame=${from}:end_frame=${to},setpts=PTS-STARTPTS,alphaextract,format=gray`, n);
    if (d.reason) return { measured: false, reason: d.reason };
    for (let k = 0; k < n; k++) frames.push(stats(d.bytes, k * W * H, from + k));
  }
  return { measured: true, threshold: OPAQUE_MIN, frames };
}
