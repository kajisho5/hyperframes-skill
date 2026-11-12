// ffprobe wrapper: reads back what a file really is. Used by the probe tool and by render's
// own verification step, so "verified" always rests on this one reader.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveFfTool } from "./deps.mjs";
import { runSync } from "./proc.mjs";
import { ToolError } from "./result.mjs";

function num(v) {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? null : n;
}

function rate(v) {
  if (!v || v === "0/0") return null;
  const [a, b] = String(v).split("/").map(Number);
  if (!b) return num(a);
  return a / b;
}

function ffprobePath() {
  const t = resolveFfTool("ffprobe");
  if (!t.path) {
    throw new ToolError("missing_tool", `ffprobe not found (${t.source}: ${t.requested})`, {
      hint: "install FFmpeg >= 5.0 (it ships ffprobe) and put it on PATH, or set HYPERFRAMES_SKILL_FFPROBE",
    });
  }
  return t.path;
}

// HyperFrames' PNG sequence: frame_000001.png, frame_000002.png, ...
export const SEQUENCE_FRAME_RE = /^frame_(\d{6,})\.png$/;

/** The frame files of a PNG sequence directory, in order. */
export function sequenceFrames(dir) {
  return readdirSync(dir)
    .filter((f) => SEQUENCE_FRAME_RE.test(f))
    .sort((a, b) => Number(SEQUENCE_FRAME_RE.exec(a)[1]) - Number(SEQUENCE_FRAME_RE.exec(b)[1]));
}

/**
 * Probe a PNG sequence directory: the first frame's stream, the number of frames, and whether
 * they are numbered 1..N without a gap. A sequence has no frame rate or duration of its own.
 */
export function probeSequence(ctx, dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ToolError("input", `not a directory: ${dir}`);
  const frames = sequenceFrames(dir);
  if (frames.length === 0) throw new ToolError("input", `${dir} holds no frame_NNNNNN.png files`);
  const first = probeFile(ctx, join(dir, frames[0]), { countFrames: false });
  const numbers = frames.map((f) => Number(SEQUENCE_FRAME_RE.exec(f)[1]));
  const contiguous = numbers.every((n, i) => n === i + 1);
  return {
    file: dir,
    format: "png-sequence",
    duration: null,
    size_bytes: frames.reduce((n, f) => n + statSync(join(dir, f)).size, 0),
    bitrate: null,
    first_frame: first.file,
    contiguous,
    video: first.video ? { ...first.video, fps: null, r_frame_rate: null, frames: frames.length, frames_source: "files" } : null,
    audio: null,
  };
}

/**
 * Probe one file. `countFrames` decodes the video stream to count frames when the container
 * does not state nb_frames (never assumed from duration x fps).
 */
export function probeFile(ctx, file, { countFrames = true } = {}) {
  if (!existsSync(file) || !statSync(file).isFile()) throw new ToolError("input", `not a file: ${file}`);
  const exe = ffprobePath();
  const argv = [exe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "--", file];
  const entry = ctx.record(argv, { exit_code: null });
  const r = runSync(argv, { timeoutMs: 120000 });
  entry.exit_code = r.status;
  if (r.timedOut) throw new ToolError("timeout", `ffprobe timed out on ${file}`);
  if (!r.ok) throw new ToolError("input", `ffprobe cannot read ${file}: ${(r.stderr || r.error || "").trim()}`);
  let raw;
  try {
    raw = JSON.parse(r.stdout);
  } catch (e) {
    throw new ToolError("input", `ffprobe printed unreadable JSON for ${file}: ${e.message}`);
  }
  const fmt = raw.format ?? {};
  const streams = raw.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");
  const out = {
    file,
    format: fmt.format_name ?? null,
    duration: num(fmt.duration) ?? num(v?.duration) ?? num(a?.duration),
    size_bytes: num(fmt.size),
    bitrate: num(fmt.bit_rate),
    video: null,
    audio: null,
  };
  if (v) {
    let frames = num(v.nb_frames);
    let framesSource = frames === null ? null : "container";
    if (frames === null && countFrames) {
      const cargv = [exe, "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "json", "--", file];
      const centry = ctx.record(cargv, { exit_code: null });
      const c = runSync(cargv, { timeoutMs: 600000 });
      centry.exit_code = c.status;
      if (c.ok) {
        try {
          frames = num(JSON.parse(c.stdout).streams?.[0]?.nb_read_frames);
          framesSource = frames === null ? null : "decoded";
        } catch {
          /* stays null: unknown, not guessed */
        }
      }
    }
    out.video = {
      codec: v.codec_name ?? null,
      profile: v.profile ?? null,
      width: num(v.width),
      height: num(v.height),
      fps: rate(v.avg_frame_rate) ?? rate(v.r_frame_rate),
      r_frame_rate: v.r_frame_rate ?? null,
      frames,
      frames_source: framesSource,
      pix_fmt: v.pix_fmt ?? null,
      // VP9 alpha is a tagged side stream: the main stream reads as yuv420p
      alpha_mode: v.tags?.ALPHA_MODE ?? v.tags?.alpha_mode ?? null,
    };
  }
  if (a) {
    out.audio = { codec: a.codec_name ?? null, channels: num(a.channels), sample_rate: num(a.sample_rate) };
  }
  return out;
}
