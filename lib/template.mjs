// Templates: scene requests shipped with the skill, with named {{placeholders}} the caller fills.
// Filling is mechanical: every value comes from the caller (or the template's declared default),
// is type-checked, and is substituted; a layer marked `"when": "<value>"` is kept only when that
// optional value was given. The result must pass the same validateRequest() a hand-written
// request does, so a template can never produce something `scene` would refuse.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT } from "./deps.mjs";
import { ToolError } from "./result.mjs";
import { COLOR_RE, validateRequest } from "./scene-spec.mjs";

export const TEMPLATE_VERSION = 1;
export const TEMPLATE_DIR = join(ROOT, "templates");
const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const PLACEHOLDER = /\{\{([a-z_][a-z0-9_]*)\}\}/g;
const VALUE_TYPES = ["string", "number", "color"];

export function listTemplates() {
  return readdirSync(TEMPLATE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => loadTemplate(f.slice(0, -5)));
}

export function loadTemplate(name) {
  if (!NAME_RE.test(name ?? "")) throw new ToolError("input", `template name must match ${NAME_RE}`);
  const file = join(TEMPLATE_DIR, `${name}.json`);
  if (!existsSync(file)) {
    const known = readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    throw new ToolError("input", `no template named "${name}" (templates: ${known.join(", ")})`);
  }
  const t = JSON.parse(readFileSync(file, "utf8"));
  if (t.template_version !== TEMPLATE_VERSION || t.name !== name) throw new ToolError("internal", `templates/${name}.json is malformed (template_version / name)`);
  return t;
}

function coerce(key, spec, raw, fromCli) {
  if (spec.type === "number") {
    const n = typeof raw === "number" ? raw : fromCli && typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return { error: `${key} must be a number` };
    if (spec.min !== undefined && n < spec.min) return { error: `${key} must be >= ${spec.min}` };
    if (spec.max !== undefined && n > spec.max) return { error: `${key} must be <= ${spec.max}` };
    return { value: n };
  }
  if (typeof raw !== "string") return { error: `${key} must be a string` };
  if (spec.type === "color") return COLOR_RE.test(raw) ? { value: raw } : { error: `${key} must be a colour (#rgb, #rrggbb, #rrggbbaa, rgb(), rgba(), transparent)` };
  if (raw.trim() === "") return { error: `${key} must not be empty (leave an optional value out instead)` };
  if (spec.max_length !== undefined && [...raw].length > spec.max_length) return { error: `${key} is ${[...raw].length} characters; this template allows ${spec.max_length}` };
  return { value: raw };
}

/**
 * Resolve the caller's values against the template's declared ones. `given` is an object;
 * `fromCli` marks values that arrived as --set strings (numbers are then parsed).
 * Returns {values, omitted} or throws ToolError(input) listing every problem.
 */
export function resolveValues(template, given, cliKeys = new Set()) {
  const errs = [];
  const values = {};
  const omitted = [];
  for (const k of Object.keys(given)) if (!(k in template.values)) errs.push(`unknown value "${k}" (this template takes: ${Object.keys(template.values).join(", ")})`);
  for (const [k, spec] of Object.entries(template.values)) {
    if (!VALUE_TYPES.includes(spec.type)) throw new ToolError("internal", `templates/${template.name}.json: value ${k} has unknown type ${spec.type}`);
    if (given[k] === undefined) {
      if (spec.default !== undefined) values[k] = spec.default;
      else if (spec.required) errs.push(`${k} is required: ${spec.description}`);
      else omitted.push(k);
      continue;
    }
    const r = coerce(k, spec, given[k], cliKeys.has(k));
    if (r.error) errs.push(r.error);
    else values[k] = r.value;
  }
  if (errs.length) throw new ToolError("input", `invalid template values:\n  - ${errs.join("\n  - ")}`, { details: { problems: errs } });
  return { values, omitted };
}

function substitute(node, values, where) {
  if (typeof node === "string") {
    const whole = /^\{\{([a-z_][a-z0-9_]*)\}\}$/.exec(node);
    if (whole) {
      if (!(whole[1] in values)) throw new ToolError("internal", `template placeholder {{${whole[1]}}} at ${where} has no value`);
      return values[whole[1]];
    }
    return node.replace(PLACEHOLDER, (_, k) => {
      if (!(k in values)) throw new ToolError("internal", `template placeholder {{${k}}} at ${where} has no value`);
      return String(values[k]);
    });
  }
  if (Array.isArray(node)) return node.map((v, i) => substitute(v, values, `${where}[${i}]`));
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substitute(v, values, `${where}.${k}`)]));
  return node;
}

export const CUSTOM_FONT_FAMILY = "HFS Custom";

/**
 * --font: ship one font file with the scene and put it first in every text layer's font list,
 * so the template's text renders with it on any machine. The file serves every weight.
 */
export function applyFont(request, fontPath) {
  request.fonts = [...(request.fonts ?? []), { family: CUSTOM_FONT_FAMILY, src: resolve(fontPath) }];
  for (const L of request.layers) {
    if (L.type !== "text") continue;
    L.style = { ...(L.style ?? {}), font_family: `${CUSTOM_FONT_FAMILY}, ${L.style?.font_family ?? "sans-serif"}` };
  }
  return request;
}

/**
 * Derived values: timings a template computes from the caller's values, such as the loop segment
 * of a title (`duration` minus the in and out transitions) or the exit of a stinger (`duration`
 * minus `cut_point` and `hold`). Only sums and differences, and in whole frames at the template's
 * fps: each operand (a value name or a number of seconds) is rounded to frames, so 1.2 - 0.5 - 0.2
 * is 15 frames (0.5 s), never 0.49999999999999994. A result of 0 frames or less is refused.
 */
export function deriveValues(template, values) {
  const fps = template.request.fps;
  const all = { ...values };
  const errs = [];
  for (const [name, D] of Object.entries(template.derived ?? {})) {
    if (name in template.values) throw new ToolError("internal", `templates/${template.name}.json: derived value ${name} shadows a value`);
    const op = D.add ? "add" : D.sub ? "sub" : null;
    if (!op || !Array.isArray(D[op]) || D[op].length === 0) throw new ToolError("internal", `templates/${template.name}.json: derived value ${name} needs add or sub`);
    const frames = D[op].map((x) => {
      const v = typeof x === "number" ? x : all[x];
      if (typeof v !== "number") throw new ToolError("internal", `templates/${template.name}.json: derived value ${name} uses ${x}, which is not a number value`);
      return Math.round(v * fps);
    });
    const f = op === "add" ? frames.reduce((a, b) => a + b, 0) : frames.slice(1).reduce((a, b) => a - b, frames[0]);
    if (f <= 0) errs.push(`${name} (${D.description ?? `${op} of ${D[op].join(", ")}`}) comes to ${f} frames at ${fps} fps; it must be at least 1 frame`);
    all[name] = f / fps;
  }
  if (errs.length) throw new ToolError("input", `invalid template values:\n  - ${errs.join("\n  - ")}`, { details: { problems: errs } });
  return all;
}

// A layer `src` in a template is either one of the template's own files (`assets/...`, under
// templates/) or a value the caller gives (`{{logo}}`, a path relative to where the caller runs).
// Both become absolute in the written request, so `scene` finds them from the request's directory.
function resolveSources(req) {
  for (const L of req.layers) {
    if (typeof L.src !== "string") continue;
    L.srcFrom = L.src.includes("{{") ? "value" : "template";
  }
}

/** Template + resolved values (+ optional font file) -> a validated scene request (plain JSON). */
export function fillTemplate(template, values, omitted, { font } = {}) {
  const req = structuredClone(template.request);
  req.layers = req.layers.filter((L) => !(L.when && omitted.includes(L.when)));
  for (const L of req.layers) delete L.when;
  resolveSources(req);
  const filled = substitute(req, deriveValues(template, values), "request");
  for (const L of filled.layers) {
    if (!L.srcFrom) continue;
    L.src = L.srcFrom === "template" ? join(TEMPLATE_DIR, L.src) : resolve(L.src);
    delete L.srcFrom;
  }
  if (font) applyFont(filled, font);
  validateRequest(filled, TEMPLATE_DIR);
  return filled;
}
