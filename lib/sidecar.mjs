// stinger.json / title.json: the metadata file render writes beside stinger and title material
// (roadmap steps 15 and 17), in the shape of the Velisa spec for title and stinger metadata
// (docs/specs/title-and-stinger.md in AI-video-production-OS). No receiver opens the file: the
// caller (the agent, or a person) reads it and passes the values on as request fields, so this is
// the contract between this skill and that caller. Each sidecar holds only fields the spec names:
// the ones a receiver reads today (`read`) and the ones the spec marks PROPOSED (`proposed`),
// which no receiver reads yet. The result lists both, so a caller knows which are which.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import { ALPHA_MODE, readAlphaFrames } from "./alpha.mjs";
import { codecHasAlpha } from "./render-core.mjs";
import { ToolError } from "./result.mjs";
import { MATERIAL_FILE, MATERIAL_VERSION, readSegments } from "./scene-spec.mjs";

export const SIDECAR = Object.freeze({
  stinger: {
    schema: "velisa/stinger@1",
    read: ["cut_point", "cover"],
    proposed: ["schema", "file", "sha256", "frame_rate", "cut_point_frame", "cover_frames", "alpha", "duration", "frames", "audio"],
  },
  title: {
    schema: "velisa/title@1",
    read: ["segments"],
    proposed: ["schema", "file", "sha256", "frame_rate", "alpha", "segment_frames", "loop_seam", "safe_area", "text"],
  },
});

/** The material facts `scene` wrote into the scene directory, or null for a scene that is neither. */
export function readMaterial(sceneDir) {
  const file = join(sceneDir, MATERIAL_FILE);
  if (!existsSync(file)) return null;
  let m;
  try {
    m = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ToolError("input", `${file} is not valid JSON: ${e.message}`, { hint: "run scene again on the request" });
  }
  if (m?.material_version !== MATERIAL_VERSION || !Object.hasOwn(SIDECAR, m.kind) || !Number.isInteger(m.fps)) {
    throw new ToolError("input", `${file} is not a material file this version reads (material_version ${MATERIAL_VERSION}, kind stinger or title)`, { hint: "run scene again on the request" });
  }
  return m;
}

/** `<dir>/<stem>.<kind>.json` beside the output (a PNG sequence directory: its whole name is the stem). */
export function sidecarPath(output, kind, sequence = false) {
  const stem = sequence ? basename(output) : basename(output, extname(output));
  return join(dirname(output), `${stem}.${kind}.json`);
}

// A frame number of the scene's fps at the render's fps; refused when it does not land on a frame.
function atFps(frame, from, to, what) {
  const f = (frame * to) / from;
  if (!Number.isInteger(f)) throw new ToolError("input", `the scene's ${what} (frame ${frame} at ${from} fps) is not on a frame at --fps ${to}`, { hint: `render at ${from} fps or a multiple of it` });
  return f;
}

/**
 * Plan the sidecar of a render, or null when the scene is not material. Throws ToolError(input)
 * when the sidecar exists without --overwrite, a stinger is rendered without alpha (every receiver
 * of a stinger needs the alpha plane: video-editing-skill refuses it as stinger_no_alpha), or a
 * stated frame does not land on a frame at the render's fps.
 */
export function planSidecar(plan, { overwrite = false } = {}) {
  const material = readMaterial(plan.sceneDir);
  if (!material) return null;
  const fps = plan.expected.fps;
  const path = sidecarPath(plan.output, material.kind, !!plan.spec.sequence);
  if (existsSync(path) && !overwrite) throw new ToolError("input", `output exists: ${path} (the ${material.kind}.json beside the render)`, { hint: "pass --overwrite to replace it" });
  const sc = { kind: material.kind, path, material, fps };
  if (material.kind === "stinger") {
    if (!codecHasAlpha(plan.codec)) throw new ToolError("input", `a stinger needs an alpha channel; --codec ${plan.codec} has none`, { hint: "render it with --codec prores (.mov), vp9 (.webm) or png" });
    sc.cut_point_frame = atFps(material.cut_point_frame, material.fps, fps, "cut point");
    sc.cover_frames = { start: atFps(material.cover_frames.start, material.fps, fps, "cover start"), end: atFps(material.cover_frames.end, material.fps, fps, "cover end") };
  } else {
    const segs = readSegments(plan.declared, plan.index);
    if (!segs) throw new ToolError("input", `${plan.index}: title material declares no segments`, { hint: "run scene again on the request" });
    sc.segment_frames = Object.fromEntries(
      segs.map((S) => {
        const f = S.duration * fps;
        // the declaration carries seconds to six decimals, so a frame count within 1/1000 is whole
        if (Math.abs(f - Math.round(f)) > 1e-3) throw new ToolError("input", `the ${S.name} segment (${S.duration}s) is not a whole number of frames at ${fps} fps`);
        return [S.name, Math.round(f)];
      }),
    );
  }
  return sc;
}

/** What the result reports before anything is written (dry run included). */
export function publicSidecar(sc) {
  if (!sc) return undefined;
  const S = SIDECAR[sc.kind];
  return { kind: sc.kind, path: sc.path, schema: S.schema, fields: { read: S.read, proposed: S.proposed } };
}

/**
 * The stinger's stated cover, measured: every pixel of every frame in [cover.start, cover.end) of
 * the output at alpha >= 253/255 (qc-skill's opaque threshold), the cut point's frame included.
 */
export function stingerCoverStep(ctx, plan, sc, probe) {
  const { start, end } = sc.cover_frames;
  const video = probe?.video;
  const frameFile = plan.spec.sequence ? (n) => join(plan.output, `frame_${String(n + 1).padStart(6, "0")}.png`) : null;
  const m = video ? readAlphaFrames(ctx, plan.output, video, start, end, { frameFile }) : { measured: false, reason: "the output was not probed" };
  const bad = m.measured ? m.frames.filter((f) => f.below > 0) : [];
  const cut = m.measured ? m.frames.find((f) => f.frame === sc.cut_point_frame) : null;
  const cover = { measured: m.measured, ...(m.measured ? { threshold: m.threshold, cut_point_frame: sc.cut_point_frame, cut_point_min_alpha: cut?.min ?? null, frames: m.frames } : { reason: m.reason }) };
  return {
    cover,
    step: {
      step: "stinger_cover",
      ok: m.measured && bad.length === 0 && !!cut,
      expected: `every pixel at alpha >= ${m.threshold ?? 253}/255 in frames ${start}..${end - 1} (cut point: frame ${sc.cut_point_frame})`,
      actual: m.measured ? (bad.length ? { not_covered: bad.slice(0, 10) } : { frames: m.frames.length, min_alpha: Math.min(...m.frames.map((f) => f.min)) }) : m.reason,
    },
  };
}

function sha256File(file) {
  const h = createHash("sha256");
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

/**
 * The sidecar document. Seconds are frame / frame_rate exactly (the spec's precision rule: at 24 fps
 * frame 25 is 1.0416666666666667 s, never a rounded 1.042), so a receiver's on-a-frame check holds.
 * A PNG sequence is a directory: `file` names it and there is no `sha256`.
 */
export function buildSidecar(sc, plan, { probe, loopSeam = null }) {
  const fps = sc.fps;
  const t = (frame) => frame / fps;
  const isFile = !plan.spec.sequence && existsSync(plan.output) && statSync(plan.output).isFile();
  const head = { schema: SIDECAR[sc.kind].schema, file: basename(plan.output), ...(isFile ? { sha256: sha256File(plan.output) } : {}), frame_rate: `${fps}/1` };
  const frames = probe?.video?.frames ?? plan.expected.frames;
  const alpha = codecHasAlpha(plan.codec) ? { alpha: ALPHA_MODE } : {};
  if (sc.kind === "stinger") {
    return {
      ...head,
      duration: probe?.duration ?? t(frames),
      frames,
      cut_point: t(sc.cut_point_frame),
      cut_point_frame: sc.cut_point_frame,
      cover: { start: t(sc.cover_frames.start), end: t(sc.cover_frames.end) },
      cover_frames: { ...sc.cover_frames },
      ...alpha,
      audio: false,
    };
  }
  const F = sc.segment_frames;
  return {
    ...head,
    ...alpha,
    segments: { in: t(F.in), loop: t(F.loop), out: t(F.out) },
    segment_frames: { ...F },
    ...(loopSeam ? { loop_seam: loopSeam } : {}),
    safe_area: sc.material.safe_area,
    text: sc.material.text,
  };
}

/** Write the sidecar, read it back, and return the verification step. */
export function writeSidecar(ctx, sc, doc) {
  const text = JSON.stringify(doc, null, 2) + "\n";
  writeFileSync(sc.path, text);
  ctx.info(`wrote ${sc.path}`);
  let back = null;
  try {
    back = readFileSync(sc.path, "utf8");
  } catch {
    /* reported below */
  }
  return { step: "sidecar", ok: back === text, detail: `${basename(sc.path)}: ${SIDECAR[sc.kind].schema}, ${Buffer.byteLength(text)} bytes, read back` };
}

/**
 * After a render: measure a stinger's cover, then, when every step so far held, write the sidecar.
 * Appends the steps to `verification` and returns the result keys ({stinger?, sidecar}).
 */
export function finishSidecar(ctx, plan, sc, probe, verification, { loopSeam = null } = {}) {
  const out = {};
  if (sc.kind === "stinger") {
    const { cover, step } = stingerCoverStep(ctx, plan, sc, probe);
    verification.push(step);
    out.stinger = cover;
  }
  // the sidecar describes a verified file only, so it is written after every other step held
  if (verification.every((s) => s.ok)) {
    const doc = buildSidecar(sc, plan, { probe, loopSeam });
    verification.push(writeSidecar(ctx, sc, doc));
    out.sidecar = { ...publicSidecar(sc), content: doc };
  } else out.sidecar = { ...publicSidecar(sc), written: false };
  return out;
}
