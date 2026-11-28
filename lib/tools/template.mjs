import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeRender, planRender } from "../render-core.mjs";
import { probeFile } from "../probe.mjs";
import { runSync } from "../proc.mjs";
import { resolveFfTool } from "../deps.mjs";
import { sceneAssets, sceneSegments, writeSceneDir } from "./scene.mjs";
import { renderHtml } from "../scene-spec.mjs";
import { addOpt, baseCommand } from "../cli.mjs";
import { emit, fail, printJson, ToolError, EXIT } from "../result.mjs";
import { DEFAULT_FPS, expectedFrames, sceneRate, validateRequest } from "../scene-spec.mjs";
import { applyKit, loadKit, takesFont } from "../kit.mjs";
import { fillTemplate, listTemplates, loadTemplate, resolveValues, TEMPLATE_DIR } from "../template.mjs";

export const meta = {
  name: "template",
  role: "execution",
  description: "Fill one of the skill's scene templates (titles: lower-third, title-card, session-slate, break; stingers: stinger-geometric, stinger-glitch, stinger-particles, stinger-brush, stinger-logo-reveal; style presets: style-swiss, style-minimal, style-neon, style-glitch, style-corporate, style-wafu) with caller-given values and write the resulting scene request JSON for `scene`. --list shows every template and the values it takes; --gallery renders one still per style preset for choosing.",
  capabilities: {
    required: ["node"],
    optional: [
      { capability: "hyperframes", when: "--gallery" },
      { capability: "chromium:headless", when: "--gallery" },
      { capability: "ffmpeg", when: "--gallery" },
      { capability: "ffprobe", when: "--gallery" },
    ],
  },
  inputs: ["a template name", "values: a JSON file (--values) and/or key=value pairs (--set)", "optional: a brand kit (--kit, Velisa kit@1 or ffmpeg-skill brand.json)"],
  outputs: ["a scene request JSON file (scene_version 1)"],
  produces_artifact: true,
  supports_dry_run: true,
  dry_run: "resolves and validates the values and the filled request and reports it; writes nothing",
  verification: { required: true, tools: ["scene"] },
  deterministic_inputs: true,
  idempotency_hint: "bit_exact",
  output_schema: "{status, output, template, values (resolved, defaults included), omitted (optional values not given; their layers are left out), kit? (with --kit): {file, schema, applied: [{field, to, value}], overridden: [{field, to, by}], unused: [{field, reason}]}, request, expected: {width, height, duration, fps, frame_rate, frames}, verified, verification[]} | --list: {status, templates: [{name, description, values, kit: {values: {value: kit field}, font_file}, gallery?: {at}}]} | --gallery: {status, output (dir), gallery: [{template, still (png), at (s), values, omitted, kit?, width, height, verified}], verified, verification[] (one step per still)}",
};

export function command() {
  const cmd = baseCommand("template", meta.description).argument("[name]", "template name (see --list)");
  addOpt(cmd, "-o, --output <file>", "scene request JSON to write");
  addOpt(cmd, "--values <file>", "JSON object of template values");
  addOpt(cmd, "--set <key=value>", "one template value; repeatable; overrides --values", { type: "repeatable" });
  addOpt(cmd, "--font <file>", "font file (.otf/.ttf/.woff2) shipped with the scene and used first for all text, e.g. a Japanese font for Japanese glyph forms");
  addOpt(cmd, "--kit <file>", "brand kit (Velisa kit@1 or ffmpeg-skill brand.json): fills the values the template maps to it (colours, logo) and font_file as --font; explicit values and --font win; unused kit fields are reported");
  addOpt(cmd, "--fit", "shrink each caller text to fit its box, down to the template's minimum size (needs --font or a kit's font_file); the size used is in scene's text_fit", { type: "boolean" });
  addOpt(cmd, "--gallery", "render one still per style preset (or of the named one) into the -o directory, with --set / --values / --kit / --font applied to each, for choosing before a full render", { type: "boolean" });
  addOpt(cmd, "--list", "list the templates and the values each takes", { type: "boolean" });
  addOpt(cmd, "--overwrite", "replace an existing output file", { type: "boolean" });
  return cmd;
}

function readValues(opts) {
  let given = {};
  if (opts.values) {
    let text;
    try {
      text = readFileSync(opts.values, "utf8");
    } catch (e) {
      throw new ToolError("input", `cannot read --values ${opts.values}: ${e.code ?? e.message}`);
    }
    try {
      given = JSON.parse(text);
    } catch (e) {
      throw new ToolError("input", `--values ${opts.values} is not valid JSON: ${e.message}`);
    }
    if (typeof given !== "object" || given === null || Array.isArray(given)) throw new ToolError("input", "--values must contain a JSON object");
  }
  const cliKeys = new Set();
  for (const pair of opts.set ?? []) {
    const i = pair.indexOf("=");
    if (i <= 0) throw new ToolError("input", `--set expects key=value, got "${pair}"`);
    given[pair.slice(0, i)] = pair.slice(i + 1);
    cliKeys.add(pair.slice(0, i));
  }
  return { given, cliKeys };
}

export async function run(ctx, [name], opts) {
  if (opts.list) {
    const templates = listTemplates().map((t) => ({ name: t.name, description: t.description, values: t.values, kit: { values: t.kit ?? {}, font_file: takesFont(t) }, ...(t.gallery ? { gallery: t.gallery } : {}) }));
    if (ctx.json) printJson({ status: "completed", exit_code: EXIT.ok, dry_run: ctx.dryRun, templates, commands: [] });
    else for (const t of templates) process.stdout.write(`${t.name.padEnd(16)} ${t.description}\n${Object.entries(t.values).map(([k, v]) => `  ${k}${v.required ? " (required)" : v.default !== undefined ? ` (default ${JSON.stringify(v.default)})` : " (optional)"}: ${v.description}`).join("\n")}\n`);
    return EXIT.ok;
  }
  if (opts.gallery) return gallery(ctx, name, opts);
  if (!name) throw new ToolError("input", "a template name is required (or --list)");
  if (!opts.output) throw new ToolError("input", "-o/--output is required");
  const template = loadTemplate(name);
  const read = readValues(opts);
  let given = read.given;
  let font = opts.font;
  let kit;
  if (opts.kit) ({ given, font, report: kit } = applyKit(template, loadKit(opts.kit), given, { font }));
  const { values, omitted } = resolveValues(template, given, read.cliKeys);
  const request = fillTemplate(template, values, omitted, { font, fit: !!opts.fit });
  const out = resolve(opts.output);
  if (existsSync(out) && !opts.overwrite) throw new ToolError("input", `output exists: ${opts.output}`, { hint: "pass --overwrite to replace it" });
  const rate = sceneRate(request.fps ?? DEFAULT_FPS);
  const expected = { width: request.width, height: request.height, duration: request.duration, fps: rate ? rate.fps : request.fps, frame_rate: rate?.frame_rate ?? null, frames: rate ? expectedFrames(request.duration, rate.frame_rate) : null };
  const result = { output: out, template: name, values, omitted, ...(kit ? { kit } : {}), request, expected };
  const text = JSON.stringify(request, null, 2) + "\n";
  if (ctx.dryRun) {
    ctx.info(`wrote ${out}`);
    return emit(ctx, result);
  }
  writeFileSync(out, text);
  ctx.info(`wrote ${out}`);
  const back = readFileSync(out, "utf8");
  const steps = [{ step: "exists", ok: back === text, detail: `${Buffer.byteLength(back)} bytes` }];
  try {
    validateRequest(JSON.parse(back), TEMPLATE_DIR);
    steps.push({ step: "request_valid", ok: true, detail: "the written file passes scene's request validation" });
  } catch (e) {
    steps.push({ step: "request_valid", ok: false, detail: e.message });
  }
  if (!steps.every((s) => s.ok)) return fail(ctx, new ToolError("verification", "request written but not verified"), { ...result, verification: steps });
  return emit(ctx, { ...result, verification: steps });
}

// a scene colour (#rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(), transparent) as ffmpeg's 0xRRGGBBAA
function ffColor(c) {
  if (c === "transparent") return "0x00000000";
  let m = /^#([0-9a-f]{3,4})$/i.exec(c);
  if (m) c = "#" + [...m[1]].map((x) => x + x).join("");
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (m) return `0x${m[1]}${m[2] ?? "ff"}`;
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(c);
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `0x${h(m[1])}${h(m[2])}${h(m[3])}${h(255 * (m[4] === undefined ? 1 : Number(m[4])))}`;
}

/**
 * --gallery (roadmap step 14): one still per style preset (templates that declare `gallery: {at}`), each
 * filled with the same --values / --set / --kit / --font, rendered through the same scene and render path
 * as a full render (a PNG frame at the preset's `at`, at 10 fps) and written as <dir>/<template>.png.
 */
async function gallery(ctx, name, opts) {
  if (!opts.output) throw new ToolError("input", "-o/--output is required: the directory the stills go into");
  const out = resolve(opts.output);
  if (existsSync(out) && !statSync(out).isDirectory()) throw new ToolError("input", `--gallery writes a directory of stills; ${opts.output} is a file`);
  const presets = name ? [loadTemplate(name)] : listTemplates().filter((t) => t.gallery);
  if (name && !presets[0].gallery) throw new ToolError("input", `template ${name} is not a style preset (it declares no gallery still)`);
  const read = readValues(opts);
  const plans = presets.map((template) => {
    let given = { ...read.given };
    let font = opts.font;
    let kit;
    if (opts.kit) ({ given, font, report: kit } = applyKit(template, loadKit(opts.kit), given, { font }));
    const { values, omitted } = resolveValues(template, given, read.cliKeys);
    const request = fillTemplate(template, values, omitted, { font, fit: !!opts.fit });
    const at = template.gallery.at;
    const still = join(out, `${template.name}.png`);
    if (existsSync(still) && !opts.overwrite) throw new ToolError("input", `output exists: ${still}`, { hint: "pass --overwrite to replace it" });
    return { template: template.name, still, at, values, omitted, ...(kit ? { kit } : {}), request, width: request.width, height: request.height };
  });
  if (ctx.dryRun) {
    for (const p of plans) ctx.info(`wrote ${p.still}`);
    return emit(ctx, { output: out, gallery: plans.map(({ request, ...p }) => ({ ...p, verified: false })) });
  }
  mkdirSync(out, { recursive: true });
  const steps = [];
  const rows = [];
  for (const p of plans) {
    const work = mkdtempSync(join(tmpdir(), "hyperframes-skill-gallery-"));
    try {
      const scene = validateRequest(p.request, TEMPLATE_DIR);
      const dir = join(work, "scene");
      writeSceneDir(dir, renderHtml(scene), sceneAssets(scene, dir), sceneSegments(scene, dir).files);
      // the frame at `at`: a PNG sequence at 10 fps up to and including it
      const frames = join(work, "frames");
      const plan = planRender({ sceneDir: dir, output: frames, codec: "png", fps: 10, maxDuration: p.at + 0.1 });
      const done = await executeRender(ctx, plan, {});
      const last = join(frames, `frame_${String(plan.expected.frames).padStart(6, "0")}.png`);
      let rendered = done.verification.every((s) => s.ok) && existsSync(last);
      // a PNG sequence is captured with a transparent page; the still is that frame over the scene's
      // background, as an opaque render shows it
      if (rendered) {
        const argv = [resolveFfTool("ffmpeg").path, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", `color=c=${ffColor(scene.background)}:s=${p.width}x${p.height}`, "-i", last, "-filter_complex", "[0][1]overlay=format=auto", "-frames:v", "1", p.still];
        const entry = ctx.record(argv, { exit_code: null });
        const r = runSync(argv, { timeoutMs: 120000 });
        entry.exit_code = r.status;
        rendered = r.ok;
      }
      const v = rendered ? probeFile(ctx, p.still).video : null;
      const ok = rendered && v && v.width === p.width && v.height === p.height;
      steps.push({ step: `still ${p.template}`, ok: !!ok, detail: ok ? `${p.still}: ${v.width}x${v.height}, frame at ${p.at}s` : `not rendered: ${done.verification.filter((s) => !s.ok).map((s) => s.step).join(", ") || "frame missing"}` });
      const { request, ...row } = p;
      rows.push({ ...row, verified: !!ok });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  const doc = { output: out, gallery: rows };
  if (!steps.every((s) => s.ok)) return fail(ctx, new ToolError("verification", `gallery: ${steps.filter((s) => !s.ok).map((s) => s.step).join(", ")} not verified`), { ...doc, verification: steps });
  return emit(ctx, { ...doc, verification: steps });
}
