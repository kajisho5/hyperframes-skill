// The one place a tool's command line is built and run. The contract's input_schema is read
// from the same Command objects this file builds, so a flag exists in exactly one place.
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { installInterruptHandlers, interrupted } from "./interrupt.mjs";
import { Context, fail, signalExitCode, ToolError } from "./result.mjs";

function parseInteger(v) {
  if (!/^-?\d+$/.test(v)) throw new InvalidArgumentError("expected an integer");
  return Number(v);
}

function parseNumber(v) {
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n)) throw new InvalidArgumentError("expected a number");
  return n;
}

function parseWorkers(v) {
  if (v === "auto") return v;
  return parseInteger(v);
}

function collect(v, prev) {
  return [...(prev ?? []), v];
}

const PARSERS = { integer: parseInteger, number: parseNumber, workers: parseWorkers, repeatable: collect };
const JSON_TYPES = { workers: "integer|auto", repeatable: "string[]" };

/**
 * Add an option whose JSON type is known. `type` is what the contract reports; it is attached
 * to the commander Option itself, so parser and contract cannot disagree.
 */
export function addOpt(cmd, flags, description, { type = "string", choices, default: def, required = false, deprecated } = {}) {
  const desc = deprecated ? `${description} (deprecated: use ${deprecated.replacement})` : description;
  const o = new Option(flags, desc);
  if (choices) o.choices(choices);
  if (PARSERS[type]) o.argParser(PARSERS[type]);
  if (def !== undefined) o.default(def);
  if (required) o.makeOptionMandatory();
  o.jsonType = JSON_TYPES[type] ?? type;
  if (deprecated) o.deprecated = deprecated;
  cmd.addOption(o);
  return cmd;
}

/** A tool's Command with the flags every tool has. */
export function baseCommand(name, description) {
  const cmd = new Command(name).description(description).allowExcessArguments(false);
  addOpt(cmd, "--json", "print one JSON result document on stdout", { type: "boolean" });
  addOpt(cmd, "--dry-run", "validate and plan without launching Chrome or ffmpeg or writing files", { type: "boolean" });
  return cmd;
}

/** Run a tool module ({meta, command, run}) against argv (without node and script). */
export async function runTool(tool, argv) {
  const json = argv.includes("--json");
  const dryRun = argv.includes("--dry-run");
  const cmd = tool.command();
  cmd.exitOverride();
  cmd.configureOutput({ writeErr: (s) => process.stderr.write(s), writeOut: (s) => process.stdout.write(s), outputError: () => {} });
  try {
    cmd.parse(argv, { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version") return 0;
      return fail(new Context({ json, dryRun }), new ToolError("input", e.message.replace(/^error: /, "")));
    }
    throw e;
  }
  const opts = cmd.opts();
  const ctx = new Context({ json: !!opts.json, dryRun: !!opts.dryRun });
  for (const o of cmd.options) {
    if (o.deprecated && cmd.getOptionValueSource(o.attributeName()) === "cli") {
      process.stderr.write(`warning: ${o.long} is deprecated; use ${o.deprecated.replacement}\n`);
    }
  }
  installInterruptHandlers((sig) => {
    // no child running: nothing to kill; report and stop here
    process.exit(fail(ctx, new ToolError("interrupted", `interrupted by ${sig}`, { exitCode: signalExitCode(sig) })));
  });
  try {
    const code = await tool.run(ctx, cmd.processedArgs, opts);
    if (interrupted()) return fail(ctx, new ToolError("interrupted", `interrupted by ${interrupted()}`, { exitCode: signalExitCode(interrupted()) }));
    return code;
  } catch (e) {
    if (e instanceof ToolError) return fail(ctx, e);
    return fail(ctx, new ToolError("internal", `internal error (a bug in hyperframes-skill): ${e.stack ?? e}`));
  }
}

/** Entry point used by scripts/<tool>.mjs. */
export async function main(tool) {
  const code = await runTool(tool, process.argv.slice(2));
  process.exitCode = code;
}
