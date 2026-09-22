import { baseCommand, addOpt } from "../cli.mjs";
import { probeFile } from "../probe.mjs";
import { emit } from "../result.mjs";

export const meta = {
  name: "probe",
  role: "analysis",
  description: "Read a media file back with ffprobe: duration, resolution, fps, frame count, codecs.",
  capabilities: { required: ["ffprobe"], optional: [] },
  inputs: ["a media file"],
  outputs: ["a JSON description of the file (stdout only; nothing is written)"],
  produces_artifact: false,
  supports_dry_run: true,
  dry_run: "read-only: ffprobe still runs under --dry-run (measuring is the tool's whole job); nothing is written either way",
  verification: { required: false, tools: [] },
  deterministic_inputs: true,
  idempotency_hint: "bit_exact",
  output_schema: "{status, probe: {file, format, duration, size_bytes, bitrate, video: {codec, profile, width, height, fps, r_frame_rate, frames, frames_source, pix_fmt} | null, audio: {codec, channels, sample_rate} | null}, commands}",
};

export function command() {
  const cmd = baseCommand("probe", meta.description).argument("<file>", "media file to inspect");
  addOpt(cmd, "--no-count-frames", "do not decode to count frames when the container does not state them (frames is then null)", { type: "boolean" });
  return cmd;
}

export async function run(ctx, [file], opts) {
  const probe = probeFile(ctx, file, { countFrames: opts.countFrames !== false });
  return emit(ctx, { output: null, probe, humanLine: JSON.stringify(probe, null, 2) });
}
