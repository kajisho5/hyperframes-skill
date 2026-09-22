// `hyperframes-skill contract --json`: a machine-readable description of every tool, generated
// from the code that runs. input_schema comes from each tool's own commander Command; the facts
// a parser cannot express come from the tool module's `meta`. Nothing here is a second copy.
import { PKG, REQUIREMENTS } from "./deps.mjs";
import { ERROR_KINDS, ERROR_RETRYABLE, EXIT } from "./result.mjs";
import { TOOLS } from "./registry.mjs";

export const CONTRACT_VERSION = "0.1";

/** Things deprecated and scheduled for removal: {what, since, replacement, removed_in, where}. */
export const DEPRECATED = [];

export function inputSchema(cmd) {
  const properties = {};
  const required = [];
  const positional = [];
  for (const a of cmd.registeredArguments) {
    properties[a.name()] = { type: "string", cli: `<${a.name()}>`, positional: true, description: a.description };
    positional.push(a.name());
    if (a.required) required.push(a.name());
  }
  for (const o of cmd.options) {
    const key = o.attributeName();
    const p = {
      type: o.jsonType ?? (o.isBoolean() ? "boolean" : "string"),
      cli: o.long,
      ...(o.short ? { short: o.short } : {}),
      description: o.description,
    };
    if (o.argChoices) p.enum = [...o.argChoices];
    if (o.defaultValue !== undefined) p.default = o.defaultValue;
    if (o.negate) {
      p.default = true;
      p.negated_flag = true;
    }
    if (o.deprecated) p.deprecated = o.deprecated;
    properties[key] = p;
    if (o.mandatory) required.push(key);
  }
  return { type: "object", properties, required, positional };
}

export function toolSpec(tool) {
  const m = tool.meta;
  const cmd = tool.command();
  return {
    id: `${PKG.name}/${m.name}`,
    name: m.name,
    version: PKG.version,
    executable: `scripts/${m.name}.mjs`,
    description: m.description,
    role: m.role,
    capabilities: m.capabilities,
    inputs: m.inputs,
    outputs: m.outputs,
    input_schema: inputSchema(cmd),
    output_schema: m.output_schema,
    supports_dry_run: m.supports_dry_run,
    dry_run: m.dry_run,
    supports_json: cmd.options.some((o) => o.long === "--json"),
    mutates_input: false,
    produces_artifact: m.produces_artifact,
    verification: m.verification,
    deterministic_inputs: m.deterministic_inputs,
    idempotency_hint: m.idempotency_hint,
  };
}

export function buildContract() {
  return {
    contract_version: CONTRACT_VERSION,
    deprecated: DEPRECATED,
    skill: {
      id: PKG.name,
      version: PKG.version,
      execution_mode: "local",
      kind: "execution",
      entrypoints: { cli: "bin/hyperframes-skill.mjs <tool> [args]", scripts: "scripts/<tool>.mjs", contract: "bin/hyperframes-skill.mjs contract --json", doctor: "scripts/doctor.mjs --json", mcp: "bin/hyperframes-skill.mjs mcp" },
      not_provided: ["AI reasoning", "creative or compositional decisions", "scene content (copy, pacing, asset choice)", "network access", "cloud rendering", "audio mixing (later theme)", "free-form animation (only fade / slide / zoom layer transitions)"],
    },
    requirements: REQUIREMENTS,
    execution: { shell: false, arbitrary_executables: false, network: false, input_mutation: false, telemetry: false, argv_shims: "render and preview reach chrome, ffmpeg and ffprobe through generated POSIX sh shims that record argv and pass \"$@\" through unevaluated" },
    exit_codes: { ok: EXIT.ok, failure: EXIT.failure, doctor_unknown: EXIT.unknown, timeout: EXIT.timeout, missing_tool: EXIT.missing_tool, interrupted: "128+signal" },
    error: { kinds: ERROR_KINDS, retryable: ERROR_RETRYABLE },
    tools: TOOLS.map(toolSpec).sort((a, b) => a.id.localeCompare(b.id)),
  };
}
