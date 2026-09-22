import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { addOpt, baseCommand } from "../cli.mjs";
import { emit, fail, printJson, ToolError, EXIT } from "../result.mjs";
import { expectedFrames, validateRequest } from "../scene-spec.mjs";
import { fillTemplate, listTemplates, loadTemplate, resolveValues, TEMPLATE_DIR } from "../template.mjs";

export const meta = {
  name: "template",
  role: "execution",
  description: "Fill one of the skill's scene templates (lower-third, title-card, session-slate, break) with caller-given values and write the resulting scene request JSON for `scene`. --list shows every template and the values it takes.",
  capabilities: { required: ["node"], optional: [] },
  inputs: ["a template name", "values: a JSON file (--values) and/or key=value pairs (--set)"],
  outputs: ["a scene request JSON file (scene_version 1)"],
  produces_artifact: true,
  supports_dry_run: true,
  dry_run: "resolves and validates the values and the filled request and reports it; writes nothing",
  verification: { required: true, tools: ["scene"] },
  deterministic_inputs: true,
  idempotency_hint: "bit_exact",
  output_schema: "{status, output, template, values (resolved, defaults included), omitted (optional values not given; their layers are left out), request, expected: {width, height, duration, fps, frames}, verified, verification[]} | --list: {status, templates: [{name, description, values}]}",
};

export function command() {
  const cmd = baseCommand("template", meta.description).argument("[name]", "template name (see --list)");
  addOpt(cmd, "-o, --output <file>", "scene request JSON to write");
  addOpt(cmd, "--values <file>", "JSON object of template values");
  addOpt(cmd, "--set <key=value>", "one template value; repeatable; overrides --values", { type: "repeatable" });
  addOpt(cmd, "--font <file>", "font file (.otf/.ttf/.woff2) shipped with the scene and used first for all text, e.g. a Japanese font for Japanese glyph forms");
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
    const templates = listTemplates().map((t) => ({ name: t.name, description: t.description, values: t.values }));
    if (ctx.json) printJson({ status: "completed", exit_code: EXIT.ok, dry_run: ctx.dryRun, templates, commands: [] });
    else for (const t of templates) process.stdout.write(`${t.name.padEnd(16)} ${t.description}\n${Object.entries(t.values).map(([k, v]) => `  ${k}${v.required ? " (required)" : v.default !== undefined ? ` (default ${JSON.stringify(v.default)})` : " (optional)"}: ${v.description}`).join("\n")}\n`);
    return EXIT.ok;
  }
  if (!name) throw new ToolError("input", "a template name is required (or --list)");
  if (!opts.output) throw new ToolError("input", "-o/--output is required");
  const template = loadTemplate(name);
  const { given, cliKeys } = readValues(opts);
  const { values, omitted } = resolveValues(template, given, cliKeys);
  const request = fillTemplate(template, values, omitted, { font: opts.font });
  const out = resolve(opts.output);
  if (existsSync(out) && !opts.overwrite) throw new ToolError("input", `output exists: ${opts.output}`, { hint: "pass --overwrite to replace it" });
  const expected = { width: request.width, height: request.height, duration: request.duration, fps: request.fps, frames: expectedFrames(request.duration, request.fps) };
  const result = { output: out, template: name, values, omitted, request, expected };
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
