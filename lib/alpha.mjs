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
