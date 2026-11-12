import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { addOpt, baseCommand } from "../cli.mjs";
import { resolveHyperframes } from "../deps.mjs";
import { runSync } from "../proc.mjs";
import { hyperframesEnv } from "../render-core.mjs";
import { emit, fail, ToolError } from "../result.mjs";
import { expectedFrames, loadRequest, readDeclared, renderHtml, SCENE_VERSION, segmentHtmlPath, validateRequest } from "../scene-spec.mjs";

export const meta = {
  name: "scene",
  role: "execution",
  description: "Turn a structured scene request (JSON: size, duration, fps, ordered text/image/video layers with in/out times, optional IN / LOOP / OUT segments) into a HyperFrames scene directory (index.html + copied assets, plus one composition per segment).",
  capabilities: { required: ["node", "hyperframes"], optional: [] },
  inputs: ["a scene request JSON file (scene_version 1)", "the local image/video files it names"],
  outputs: ["a scene directory: index.html and assets/ (and segments/<name>.html when the request declares segments)"],
  produces_artifact: true,
  supports_dry_run: true,
  dry_run: "validates the request and every asset path and reports the files it would write; writes nothing and does not run hyperframes lint",
  verification: { required: true, tools: ["preview"] },
  deterministic_inputs: true,
  idempotency_hint: "bit_exact",
  output_schema: "{status, output (scene dir), html, assets[], expected: {width, height, duration, fps, frames}, segments: [{name, start, duration, start_frame, frames, html|null}]|null, lint: {errors, warnings, findings[]}, verified, verification[], commands}",
};

const GENERATOR = `hyperframes-skill scene v${SCENE_VERSION}`;

export function command() {
  const cmd = baseCommand("scene", meta.description).argument("<request>", "scene request JSON file");
  addOpt(cmd, "-o, --output <dir>", "scene directory to write (created; must be empty or absent)", { required: true });
  addOpt(cmd, "--overwrite", "replace index.html, assets/ and segments/ in a directory an earlier `scene` run wrote", { type: "boolean" });
  return cmd;
}

function sha256(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function checkOutputDir(dir, overwrite) {
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) throw new ToolError("input", `output exists and is not a directory: ${dir}`);
  const entries = readdirSync(dir);
  if (entries.length === 0) return;
  const index = join(dir, "index.html");
  const ours = existsSync(index) && readFileSync(index, "utf8").includes(`content="${GENERATOR}"`);
  if (!overwrite) throw new ToolError("input", `output directory is not empty: ${dir}`, { hint: ours ? "pass --overwrite to replace the scene an earlier run wrote" : "choose an empty or new directory" });
  if (!ours) throw new ToolError("input", `--overwrite refused: ${dir} was not written by \`scene\` (no ${GENERATOR} index.html); nothing was touched`);
}

function lint(ctx, dir) {
  const hf = resolveHyperframes();
  if (!hf.path) throw new ToolError("missing_tool", "the hyperframes package is not installed", { hint: "run npm install in the hyperframes-skill directory" });
  const argv = [process.execPath, hf.path, "lint", dir, "--json"];
  const entry = ctx.record(argv, { exit_code: null });
  const r = runSync(argv, { timeoutMs: 120000, env: hyperframesEnv() });
  entry.exit_code = r.status;
  if (r.timedOut) throw new ToolError("timeout", "hyperframes lint timed out");
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    return { ok: false, detail: `hyperframes lint printed no JSON (exit ${r.status}): ${(r.stderr || "").trim().slice(0, 500)}` };
  }
  const findings = (doc.findings ?? []).map((f) => ({ severity: f.severity, code: f.code ?? f.rule ?? null, message: f.message }));
  return { ok: doc.errorCount === 0, errors: doc.errorCount, warnings: doc.warningCount, findings };
}

/**
 * Write index.html, assets/ and (when given) segments/ into dir, replacing only those entries.
 * `files` are extra {path, text} files inside dir (the segment compositions). Used by scene and batch.
 */
export function writeSceneDir(dir, html, assets, files = []) {
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, "index.html"))) rmSync(join(dir, "index.html"));
  for (const d of ["assets", "segments"]) if (existsSync(join(dir, d))) rmSync(join(dir, d), { recursive: true });
  for (const f of files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.text);
  }
  for (const a of assets) {
    mkdirSync(dirname(a.path), { recursive: true });
    copyFileSync(a.source, a.path);
  }
  writeFileSync(join(dir, "index.html"), html);
}

/** The segment compositions a scene with segments gets: segments/<name>.html for each non-empty segment. */
export function sceneSegments(scene, dir) {
  if (!scene.segments) return { segments: null, files: [] };
  const files = [];
  const segments = scene.segments.map((S) => {
    if (S.frames === 0) return { ...S, html: null };
    const path = join(dir, segmentHtmlPath(S.name));
    files.push({ path, text: renderHtml(scene, S) });
    return { ...S, html: path };
  });
  return { segments, files };
}

export async function run(ctx, [requestPath], opts) {
  const req = loadRequest(requestPath);
  const scene = validateRequest(req, dirname(resolve(requestPath)));
  const dir = resolve(opts.output);
  checkOutputDir(dir, !!opts.overwrite);
  const html = renderHtml(scene);
  const expected = { width: scene.width, height: scene.height, duration: scene.duration, fps: scene.fps, frames: expectedFrames(scene.duration, scene.fps) };
  const media = scene.layers.filter((L) => L.srcAbs);
  const assets = [
    ...media.map((L) => ({ layer: L.id, source: L.srcAbs, path: join(dir, "assets", L.assetName) })),
    ...scene.fonts.map((F) => ({ font: F.family, source: F.srcAbs, path: join(dir, "assets", F.assetName) })),
  ];
  const html_path = join(dir, "index.html");
  const { segments, files } = sceneSegments(scene, dir);

  if (ctx.dryRun) {
    ctx.info(`wrote ${html_path}`);
    for (const f of files) ctx.info(`wrote ${f.path}`);
    for (const a of assets) ctx.info(`wrote ${a.path}`);
    return emit(ctx, { output: dir, html: html_path, assets, expected, segments, layers: scene.layers.length });
  }

  writeSceneDir(dir, html, assets, files);
  ctx.info(`wrote ${html_path}`);
  for (const f of files) ctx.info(`wrote ${f.path}`);

  const steps = [];
  const written = readFileSync(html_path, "utf8");
  steps.push({ step: "exists", ok: written === html, detail: `${Buffer.byteLength(written)} bytes` });
  if (assets.length) {
    const copies = assets.map((a) => existsSync(a.path) && sha256(a.path) === sha256(a.source));
    steps.push({ step: "assets_copied", ok: copies.every(Boolean), detail: `${copies.filter(Boolean).length}/${assets.length} byte-identical to their sources` });
  }
  const back = readDeclared(written, html_path);
  const roundTrip = back.width === expected.width && back.height === expected.height && back.duration === expected.duration && back.fps === expected.fps;
  steps.push({ step: "declared_values", ok: roundTrip, expected: { width: expected.width, height: expected.height, duration: expected.duration, fps: expected.fps }, actual: { width: back.width, height: back.height, duration: back.duration, fps: back.fps } });
  if (segments) {
    // each segment's composition declares its own window, and together they cover the scene
    const back = segments.filter((S) => S.html).map((S) => [S, readDeclared(readFileSync(S.html, "utf8"), S.html)]);
    const ok = back.every(([S, d]) => Math.abs(d.duration - S.duration) < 1e-6 && d.fps === scene.fps && d.width === scene.width && d.height === scene.height);
    const total = segments.reduce((n, S) => n + S.frames, 0);
    steps.push({ step: "segments", ok: ok && total === expected.frames, expected: { frames: expected.frames }, actual: { frames: total, files: back.map(([S, d]) => `${S.name}: ${d.duration}s`) } });
  }
  const l = lint(ctx, dir);
  steps.push({ step: "hyperframes_lint", ok: l.ok, detail: l.detail ?? `${l.errors} errors, ${l.warnings} warnings` });

  const result = { output: dir, html: html_path, assets, expected, segments, layers: scene.layers.length, lint: l };
  if (!steps.every((s) => s.ok)) {
    return fail(ctx, new ToolError("verification", `scene written but not verified: ${steps.filter((s) => !s.ok).map((s) => s.step).join(", ")}`), { ...result, verification: steps });
  }
  return emit(ctx, { ...result, verification: steps });
}
