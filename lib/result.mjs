// Result documents. Every tool ends in exactly one of emit() (success) or fail() (failure).
// Under --json each prints one JSON document on stdout; the exit code is the same either way.
//
// The claim-bearing fields and where their values come from (docs/contract.md, "Result documents"):
//   status        "completed" only from emit(); fail() always says "failed"
//   verified      the conjunction of the verification steps this run actually performed
//   error.kind    input | render | encode | missing_tool | timeout | verification | interrupted | internal
//   error.retryable  always false (nothing here can tell a transient failure from a deterministic one)
//   commands      argv of every process that actually ran, in the order they started

export const EXIT = Object.freeze({ ok: 0, failure: 1, unknown: 2, timeout: 124, missing_tool: 127 });

export const ERROR_KINDS = Object.freeze({
  input: "INPUT_INVALID",
  render: "RENDER_FAILED",
  encode: "ENCODE_FAILED",
  missing_tool: "DEPENDENCY_MISSING",
  timeout: "TIMEOUT",
  verification: "VERIFICATION_FAILED",
  interrupted: "INTERRUPTED",
  internal: "INTERNAL_ERROR",
});

export const ERROR_RETRYABLE = false;

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

export function signalExitCode(signal) {
  return 128 + (SIGNALS[signal] ?? 15);
}

export class ToolError extends Error {
  constructor(kind, message, { exitCode, hint, details } = {}) {
    super(message);
    if (!(kind in ERROR_KINDS)) throw new Error(`unknown error kind: ${kind}`);
    this.kind = kind;
    this.exitCode = exitCode ?? defaultExit(kind);
    this.hint = hint;
    this.details = details;
  }
}

function defaultExit(kind) {
  if (kind === "missing_tool") return EXIT.missing_tool;
  if (kind === "timeout") return EXIT.timeout;
  if (kind === "interrupted") return signalExitCode("SIGTERM");
  return EXIT.failure;
}

/** Per-invocation state: flags every tool shares and the commands it ran. */
export class Context {
  constructor({ json = false, dryRun = false } = {}) {
    this.json = json;
    this.dryRun = dryRun;
    this.commands = [];
  }

  record(argv, extra = {}) {
    const entry = { program: programName(argv[0]), argv: [...argv], ...extra };
    this.commands.push(entry);
    return entry;
  }

  /** stderr progress line; under --dry-run "wrote X" becomes "[dry-run] would write X". */
  info(msg) {
    if (this.dryRun && msg.startsWith("wrote ")) msg = "[dry-run] would write " + msg.slice("wrote ".length);
    process.stderr.write(msg + "\n");
  }
}

function programName(p) {
  return String(p).split(/[\\/]/).pop();
}

export function printJson(doc) {
  process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
}

/**
 * Success. `verification` is the list of steps this run performed; `verified` is derived from
 * it here, never passed in, so no call site can claim a check it did not make. A dry run
 * performed no checks on an artifact and is never verified.
 */
export function emit(ctx, { output = null, verification = [], humanLine, ...extra }) {
  const steps = ctx.dryRun ? [] : verification;
  const doc = {
    status: "completed",
    exit_code: EXIT.ok,
    output,
    dry_run: ctx.dryRun,
    verified: !ctx.dryRun && steps.length > 0 && steps.every((s) => s.ok === true),
    verification: steps,
    commands: ctx.commands,
    ...extra,
  };
  if (doc.verified === false && !ctx.dryRun && steps.length > 0) {
    // emit() is only for runs whose verification passed or that have nothing to verify;
    // a failed step must go through fail(kind: "verification").
    throw new Error("emit() called with a failed verification step; use fail()");
  }
  if (ctx.json) printJson(doc);
  else if (humanLine !== undefined) process.stdout.write(humanLine + "\n");
  else if (output) process.stdout.write(output + "\n");
  return EXIT.ok;
}

/** Failure. Prints the failure document under --json and returns the exit code. */
export function fail(ctx, err, extra = {}) {
  const e = err instanceof ToolError ? err : new ToolError("input", String(err?.message ?? err));
  process.stderr.write(`error: ${e.message}\n` + (e.hint ? `hint: ${e.hint}\n` : ""));
  if (ctx.json) {
    const doc = {
      status: "failed",
      exit_code: e.exitCode,
      error: {
        kind: e.kind,
        code: ERROR_KINDS[e.kind],
        message: e.message,
        retryable: ERROR_RETRYABLE,
        ...(e.hint ? { hint: e.hint } : {}),
      },
      dry_run: ctx.dryRun,
      verified: false,
      commands: ctx.commands,
      ...(e.details ? { details: e.details } : {}),
      ...extra,
    };
    printJson(doc);
  }
  return e.exitCode;
}
