// Brand input (roadmap step 16): a Velisa `kit@1` file (a superset of ffmpeg-skill's brand.json)
// mapped onto a template's typed values. Mechanical, like the rest of template filling:
//   - a template declares which of its values a kit field fills (`kit` in templates/<name>.json),
//     and only fields with one clear meaning there are mapped (colours by role, logo, font_file);
//   - only what the kit states is used: nothing is filled from ffmpeg-skill's brand.json defaults;
//   - an explicit value (--values / --set / a batch row, or --font) wins over the kit;
//   - every kit field that is present and not used is reported with the reason, never dropped silently.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ToolError } from "./result.mjs";

export const KIT_SCHEMA = "velisa/kit@1";
const HEX6 = /^#?[0-9a-fA-F]{6}$/;
const PLACEHOLDER = /\{\{[a-z_][a-z0-9_]*\}\}/;

// Why a present kit field is not used, for the fields no template maps.
const UNUSED = {
  name: "kit metadata; no template value takes it",
  font: "templates take a font file (font_file), not a family name; the family is not looked up on the machine",
  logo_position: "no template value places a logo; stinger-logo-reveal centres its logo",
  logo_scale: "no template value sizes a logo; stinger-logo-reveal's logo box is fixed",
  logo_opacity: "no template value sets a logo's opacity",
  safe_margin: "template layouts are fixed; no template value takes a margin",
  lang: "not mapped: a template's lang is a BCP 47 tag of its text; pass it as a template value",
  styles: "caption styles; templates draw no captions",
  caption: "caption burn-in defaults; templates draw no captions",
  loudness: "templates have no audio",
  fonts: "not mapped (kit@1 PROPOSED field); pass the file as font_file",
  logo_variants: "not mapped (kit@1 PROPOSED field)",
  contrast: "not mapped (kit@1 PROPOSED field)",
};

/** Read and check a kit file. Returns {file, dir, kit, colors, colorsKey}. */
export function loadKit(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ToolError("input", `cannot read --kit ${path}: ${e.code ?? e.message}`);
  }
  let kit;
  try {
    kit = JSON.parse(text);
  } catch (e) {
    throw new ToolError("input", `--kit ${path} is not valid JSON: ${e.message}`);
  }
  if (typeof kit !== "object" || kit === null || Array.isArray(kit)) throw new ToolError("input", "--kit must contain a JSON object (a kit@1 or brand.json file)");
  if (kit.schema !== undefined && kit.schema !== KIT_SCHEMA) throw new ToolError("input", `--kit schema is ${JSON.stringify(kit.schema)}; this version reads ${KIT_SCHEMA} (or a brand.json without schema)`);
  if (kit.colors !== undefined && kit.colours !== undefined) throw new ToolError("input", "--kit has both colors and colours; keep one");
  const colorsKey = kit.colours !== undefined ? "colours" : "colors";
  const colors = kit[colorsKey];
  if (colors !== undefined && (typeof colors !== "object" || colors === null || Array.isArray(colors))) throw new ToolError("input", `--kit ${colorsKey} must be an object of colour roles`);
  const file = resolve(path);
  return { file, dir: dirname(file), kit, colors: colors ?? {}, colorsKey };
}

/**
 * Whether the template draws caller-given text, so a font file changes what it renders. With
 * `given`, a layer kept only `when` an optional value is given counts only if that value is given.
 */
export function takesFont(template, given) {
  return template.request.layers.some((L) => L.type === "text" && PLACEHOLDER.test(L.text ?? "") && (!given || !L.when || given[L.when] !== undefined));
}

function kitValue(K, field) {
  if (field === "logo") return K.kit.logo;
  const [, role] = field.split(".");
  return K.colors[role];
}

function convert(K, field, raw) {
  if (field === "logo") {
    if (typeof raw !== "string" || raw === "") return { error: "kit logo must be a path (relative to the kit file)" };
    return { value: resolve(K.dir, raw) };
  }
  if (typeof raw !== "string" || !HEX6.test(raw)) return { error: `kit ${K.colorsKey}.${field.split(".")[1]} must be RRGGBB (got ${JSON.stringify(raw)})` };
  return { value: raw.startsWith("#") ? raw : `#${raw}` };
}

/**
 * Fill `given` from the kit for the template. `given` keys are explicit values and win.
 * `font` is an explicit --font and wins over font_file.
 * Returns {given (kit values merged in), font, report: {file, schema, applied, overridden, unused}}.
 */
export function applyKit(template, K, given, { font } = {}) {
  const map = template.kit ?? {};
  const out = { ...given };
  const applied = [];
  const overridden = [];
  const unused = [];
  const errs = [];
  const used = new Set();
  for (const [key, field] of Object.entries(map)) {
    const raw = kitValue(K, field);
    if (raw === undefined) continue;
    const name = field === "logo" ? "logo" : `${K.colorsKey}.${field.split(".")[1]}`;
    used.add(name);
    if (given[key] !== undefined) {
      overridden.push({ field: name, to: key, by: "value" });
      continue;
    }
    const r = convert(K, field, raw);
    if (r.error) errs.push(r.error);
    else {
      out[key] = r.value;
      applied.push({ field: name, to: key, value: r.value });
    }
  }
  let fontOut = font;
  if (K.kit.font_file !== undefined) {
    used.add("font_file");
    if (typeof K.kit.font_file !== "string" || K.kit.font_file === "") errs.push("kit font_file must be a path (relative to the kit file)");
    else if (!takesFont(template, out)) unused.push({ field: "font_file", reason: "no text this template draws comes from the caller (an optional text value left out draws nothing)" });
    else if (font !== undefined) overridden.push({ field: "font_file", to: "--font", by: "--font" });
    else {
      fontOut = resolve(K.dir, K.kit.font_file);
      applied.push({ field: "font_file", to: "--font", value: fontOut });
    }
  }
  if (errs.length) throw new ToolError("input", `invalid kit:\n  - ${errs.join("\n  - ")}`, { details: { problems: errs } });
  for (const role of Object.keys(K.colors)) {
    const name = `${K.colorsKey}.${role}`;
    if (!used.has(name)) unused.push({ field: name, reason: `template ${template.name} has no value for this colour role` });
  }
  if (K.kit.logo !== undefined && !used.has("logo")) unused.push({ field: "logo", reason: `template ${template.name} has no logo value` });
  for (const k of Object.keys(K.kit)) {
    if (["schema", "colors", "colours", "logo", "font_file"].includes(k)) continue;
    unused.push({ field: k, reason: UNUSED[k] ?? "not a kit@1 field" });
  }
  return { given: out, font: fontOut, report: { file: K.file, schema: K.kit.schema ?? null, applied, overridden, unused } };
}
