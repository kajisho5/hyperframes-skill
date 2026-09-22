// ffprobe wrapper: reads back what a file really is. Used by the probe tool and by render's
// own verification step, so "verified" always rests on this one reader.
import { existsSync, statSync } from "node:fs";
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
    };
  }
  if (a) {
    out.audio = { codec: a.codec_name ?? null, channels: num(a.channels), sample_rate: num(a.sample_rate) };
  }
  return out;
}
