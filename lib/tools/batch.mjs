import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { addOpt, baseCommand } from "../cli.mjs";
import { interrupted } from "../interrupt.mjs";
import { CODECS, DEFAULT_TIMEOUT_S, executeRender, planRender } from "../render-core.mjs";
import { emit, fail, ToolError } from "../result.mjs";
import { ENCODINGS, loadRows, slug } from "../rows.mjs";
import { expectedFrames, renderHtml, validateRequest } from "../scene-spec.mjs";
import { fillTemplate, loadTemplate, resolveValues, TEMPLATE_DIR } from "../template.mjs";
import { checkTimeout } from "./render.mjs";
import { writeSceneDir } from "./scene.mjs";

export const meta = {
  name: "batch",
  role: "execution",
  description: "Render one video per row of a CSV or JSON file through a template (e.g. every speaker's lower third from the programme sheet). Every row is validated before the first render; each output is verified like render's.",
  capabilities: {
    required: ["node", "hyperframes", "chromium:headless", "ffmpeg", "ffprobe", "encoder:libx264", "disk:tmp"],
    optional: [
      { capability: "encoder:libvpx-vp9", when: "--codec vp9" },
      { capability: "encoder:prores_ks", when: "--codec prores" },
    ],
  },
  inputs: ["a .csv (header row = template value names) or .json (array of objects) file", "a template name"],
  outputs: ["one video per row in the output directory", "the scene directory of each row under <output>/scenes/"],
  produces_artifact: true,
  supports_dry_run: true,
  dry_run: "reads and validates every row against the template and reports each planned output, its expected frame count and name; launches neither Chrome nor ffmpeg and writes nothing",
  verification: { required: true, tools: ["probe"] },
  deterministic_inputs: true,
  idempotency_hint: "bit_exact",
  output_schema: "{status, output (dir), template, rows: [{index, name, output, status: completed|failed|skipped, verified, expected, error?}], summary: {total, completed, failed, skipped}, verified, verification[] (one step per row), commands}",
};

export function command() {
  const cmd = baseCommand("batch", meta.description).argument("<rows>", "rows file: .csv (UTF-8 or --encoding shift_jis) or .json");
  addOpt(cmd, "--template <name>", "template every row fills (see `template --list`); the columns are its value names", { required: true });
  addOpt(cmd, "-o, --output <dir>", "output directory (created)", { required: true });
  addOpt(cmd, "--name-field <column>", "column whose value names each file (<row number>-<value>); default: the row number only");
  addOpt(cmd, "--font <file>", "font file shipped with every row's scene and used first for all text (see template --font)");
  addOpt(cmd, "--encoding <encoding>", "text encoding of a CSV file", { choices: ENCODINGS, default: "utf-8" });
  addOpt(cmd, "--codec <codec>", "h264 (.mp4), vp9 (.webm) or prores (.mov, keeps alpha)", { choices: Object.keys(CODECS), default: "h264" });
  addOpt(cmd, "--quality <n>", "CRF, as render's --quality", { type: "integer" });
  addOpt(cmd, "--workers <n>", "parallel capture workers per render: auto or 1-8", { type: "workers", default: "auto" });
  addOpt(cmd, "--timeout <seconds>", "per-row render timeout; 0 disables", { type: "number", default: DEFAULT_TIMEOUT_S });
  addOpt(cmd, "--fail-fast", "stop at the first row that fails (the rest are reported as skipped)", { type: "boolean" });
  addOpt(cmd, "--overwrite", "replace this batch's own outputs and scene directories if they exist", { type: "boolean" });
  return cmd;
}

/** Validate every row and work out every output. Throws ToolError(input) listing all problems. */
export function planBatch({ rowsFile, templateName, outDir, nameField, encoding, codec, overwrite, font }) {
  const template = loadTemplate(templateName);
  const { columns, rows } = loadRows(rowsFile, { encoding });
  const isCsv = rowsFile.toLowerCase().endsWith(".csv");
  const problems = [];
  if (nameField !== undefined && !columns.includes(nameField)) problems.push(`--name-field "${nameField}" is not a column (columns: ${columns.join(", ")})`);
  const width = String(rows.length).length < 3 ? 3 : String(rows.length).length;
  const ext = CODECS[codec].ext;
  const planned = [];
  const names = new Map();
  for (const row of rows) {
    const at = `row ${row.index}`;
    let request;
    try {
      const { values, omitted } = resolveValues(template, row.values, isCsv ? new Set(Object.keys(row.values)) : new Set());
      request = fillTemplate(template, values, omitted, { font });
    } catch (e) {
      if (!(e instanceof ToolError) || e.kind !== "input") throw e;
      for (const p of e.details?.problems ?? [e.message]) problems.push(`${at}: ${p}`);
      continue;
    }
    const num = String(row.index).padStart(width, "0");
    const label = nameField !== undefined && row.values[nameField] !== undefined ? slug(row.values[nameField]) : "";
    const name = label ? `${num}-${label}` : num;
    if (names.has(name)) problems.push(`${at}: file name ${name} is also row ${names.get(name)}'s`);
    names.set(name, row.index);
    const output = join(outDir, name + ext);
    const sceneDir = join(outDir, "scenes", name);
    if (!overwrite && existsSync(output)) problems.push(`${at}: output exists: ${output} (pass --overwrite to replace it)`);
    if (!overwrite && existsSync(sceneDir)) problems.push(`${at}: scene directory exists: ${sceneDir} (pass --overwrite to replace it)`);
    planned.push({ index: row.index, name, output, sceneDir, request, expected: { width: request.width, height: request.height, duration: request.duration, fps: request.fps, frames: expectedFrames(request.duration, request.fps) } });
  }
  if (problems.length) throw new ToolError("input", `batch not started: ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`, { details: { problems } });
  return { template, planned };
}

export async function run(ctx, [rowsFile], opts) {
  checkTimeout(opts.timeout);
  const outDir = resolve(opts.output);
  const plan = planBatch({ rowsFile, templateName: opts.template, outDir, nameField: opts.nameField, encoding: opts.encoding, codec: opts.codec, overwrite: !!opts.overwrite, font: opts.font });
  if (opts.quality !== undefined && !CODECS[opts.codec].crf) throw new ToolError("input", `--quality is not supported with --codec ${opts.codec}`);
  const summaryRows = plan.planned.map((p) => ({ index: p.index, name: p.name, output: p.output, expected: p.expected }));
  if (ctx.dryRun) {
    for (const p of plan.planned) ctx.info(`wrote ${p.output}`);
    return emit(ctx, { output: outDir, template: opts.template, rows: summaryRows.map((r) => ({ ...r, status: "planned" })), summary: { total: summaryRows.length } });
  }
  const results = [];
  let stop = false;
  for (const p of plan.planned) {
    if (stop) {
      results.push({ index: p.index, name: p.name, output: p.output, expected: p.expected, status: "skipped", verified: false });
      continue;
    }
    ctx.info(`[${p.index}/${plan.planned.length}] ${p.name}`);
    const r = { index: p.index, name: p.name, output: p.output, expected: p.expected };
    try {
      const scene = validateRequest(p.request, TEMPLATE_DIR);
      if (opts.overwrite) rmSync(p.sceneDir, { recursive: true, force: true });
      writeSceneDir(p.sceneDir, renderHtml(scene), scene.fonts.map((F) => ({ source: F.srcAbs, path: join(p.sceneDir, "assets", F.assetName) })));
      const rp = planRender({ sceneDir: p.sceneDir, output: p.output, codec: opts.codec, quality: opts.quality, workers: opts.workers, overwrite: !!opts.overwrite });
      const done = await executeRender(ctx, rp, { timeoutS: opts.timeout });
      r.verification = done.verification;
      r.verified = done.verification.every((s) => s.ok);
      r.status = r.verified ? "completed" : "failed";
      if (!r.verified) r.error = { kind: "verification", message: `does not match the scene: ${done.verification.filter((s) => !s.ok).map((s) => s.step).join(", ")}` };
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      if (e.kind === "interrupted") throw e;
      r.status = "failed";
      r.verified = false;
      r.error = { kind: e.kind, message: e.message };
    }
    results.push(r);
    if (r.status === "failed" && opts.failFast) stop = true;
    if (interrupted()) stop = true;
  }
  const summary = {
    total: results.length,
    completed: results.filter((r) => r.status === "completed").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
  };
  const steps = results.map((r) => ({ step: `row ${r.index} (${r.name})`, ok: r.status === "completed", detail: r.error?.message ?? r.status }));
  const doc = { output: outDir, template: opts.template, rows: results, summary };
  if (summary.completed !== summary.total) {
    const first = results.find((r) => r.status === "failed");
    return fail(ctx, new ToolError(first?.error.kind ?? "verification", `${summary.failed} of ${summary.total} rows failed, ${summary.skipped} skipped; first: row ${first?.index}: ${first?.error.message}`), { ...doc, verification: steps });
  }
  return emit(ctx, { ...doc, verification: steps });
}
