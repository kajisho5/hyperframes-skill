import { baseCommand, addOpt } from "../cli.mjs";
import { existsSync, statSync } from "node:fs";
import { hasAlpha, parseSample, readAlpha } from "../alpha.mjs";
import { probeFile, probeSequence } from "../probe.mjs";
import { emit, ToolError } from "../result.mjs";

export const meta = {
  name: "probe",
  role: "analysis",
  description: "Read a media file (or a PNG sequence directory) back with ffprobe: duration, resolution, fps, frame count, codecs; with --alpha, the first frame's alpha channel.",
  capabilities: { required: ["ffprobe"], optional: [] },
  inputs: ["a media file, or a PNG sequence directory (frame_000001.png, ...)"],
  outputs: ["a JSON description of the file (stdout only; nothing is written)"],
  produces_artifact: false,
  supports_dry_run: true,
  dry_run: "read-only: ffprobe still runs under --dry-run (measuring is the tool's whole job); nothing is written either way",
  verification: { required: false, tools: [] },
  deterministic_inputs: true,
  idempotency_hint: "bit_exact",
  output_schema: "{status, probe: {file, format, duration, size_bytes, bitrate, video: {codec, profile, width, height, fps, r_frame_rate, frames, frames_source, pix_fmt, alpha_mode} | null, audio: {codec, channels, sample_rate} | null, contiguous? (sequence), alpha? (--alpha): {mode: straight|none, channel, first_frame: {min, max, mean, transparent_fraction, opaque_fraction, corners}, samples: [{x, y, alpha}]}}, commands}",
};

export function command() {
  const cmd = baseCommand("probe", meta.description).argument("<file>", "media file or PNG sequence directory to inspect");
  addOpt(cmd, "--no-count-frames", "do not decode to count frames when the container does not state them (frames is then null)", { type: "boolean" });
  addOpt(cmd, "--alpha", "decode the first frame's alpha plane: min, max, corners (0 transparent, 255 opaque) and the alpha mode", { type: "boolean" });
  addOpt(cmd, "--sample <x,y>", "with --alpha: also read the alpha at this pixel of the first frame, e.g. --sample 10,20 (repeatable)", { type: "repeatable" });
  return cmd;
}

export async function run(ctx, [file], opts) {
  let samples = [];
  try {
    samples = (opts.sample ?? []).map(parseSample);
  } catch (e) {
    throw new ToolError("input", e.message);
  }
  if (samples.length && !opts.alpha) throw new ToolError("input", "--sample needs --alpha");
  const isDir = existsSync(file) && statSync(file).isDirectory();
  const probe = isDir ? probeSequence(ctx, file) : probeFile(ctx, file, { countFrames: opts.countFrames !== false });
  if (opts.alpha) {
    if (!probe.video) throw new ToolError("input", `${file} has no video stream to read alpha from`);
    probe.alpha = readAlpha(ctx, isDir ? probe.first_frame : file, probe.video, { samples });
    if (hasAlpha(probe.video) && probe.alpha.channel !== true) throw new ToolError("input", probe.alpha.reason);
  }
  return emit(ctx, { output: null, probe, humanLine: JSON.stringify(probe, null, 2) });
}
