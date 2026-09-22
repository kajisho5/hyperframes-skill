// Templates: scene requests shipped with the skill, with named {{placeholders}} the caller fills.
// Filling is mechanical: every value comes from the caller (or the template's declared default),
// is type-checked, and is substituted; a layer marked `"when": "<value>"` is kept only when that
// optional value was given. The result must pass the same validateRequest() a hand-written
// request does, so a template can never produce something `scene` would refuse.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/** Template + resolved values -> a validated scene request (plain JSON). */
export function fillTemplate(template, values, omitted) {
  const req = structuredClone(template.request);
  req.layers = req.layers.filter((L) => !(L.when && omitted.includes(L.when)));
  for (const L of req.layers) delete L.when;
  const filled = substitute(req, values, "request");
  validateRequest(filled, TEMPLATE_DIR);
  return filled;
}
