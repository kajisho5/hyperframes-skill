// Records the argv of the browser / ffmpeg / ffprobe processes HyperFrames starts, from inside the HyperFrames
// process (docs/design-decisions.md D10). render-core.mjs starts HyperFrames as
//   node --require <this file> <hyperframes cli> render ...
// and passes two environment variables:
//   HYPERFRAMES_SKILL_ARGV_LOG    the directory the records go to
//   HYPERFRAMES_SKILL_ARGV_TOOLS  JSON {"<real binary path>": {"role": "chrome|ffmpeg|ffprobe", "rc": true|false}}
// For every child process started with one of those paths as its executable, it writes
//   <log>/<ns>-<pid>-<seq>-<role>.argv   the executable and each argument, NUL-terminated
//   <log>/<ns>-<pid>-<seq>-<role>.rc     the exit code, when "rc" is true and the process exits
// before the process starts, exactly the files the POSIX sh shims of earlier releases wrote, so readShimLog() reads
// both. Nothing is changed about the call itself: the same function is called with the same arguments.
//
// It is plain Node (no shell, no executable shim), so it works on Windows, where a generated sh script cannot be
// spawned. It wraps child_process.spawn / spawnSync / execFile / execFileSync / fork (the functions that take an
// executable and an argv array), then syncBuiltinESMExports() so ES-module imports of node:child_process see the
// wrapped functions. exec / execSync (a shell command line) are not wrapped: a shell string is not an argv, and
// HyperFrames does not start these binaries that way (tests/argv-recorder.test.mjs checks the real render).
// render-core.mjs also puts it in NODE_OPTIONS, so every Node process HyperFrames starts (forked or spawned) records
// too; a process that gets it twice installs it once.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

const logDir = process.env.HYPERFRAMES_SKILL_ARGV_LOG;
let tools = {};
try {
  tools = JSON.parse(process.env.HYPERFRAMES_SKILL_ARGV_TOOLS || "{}");
} catch {
  tools = {};
}

const win = process.platform === "win32";
const norm = (p) => {
  const r = path.resolve(String(p));
  return win ? r.toLowerCase() : r;
};
const table = new Map(Object.entries(tools).map(([p, spec]) => [norm(p), spec]));
let seq = 0;

function lookup(file) {
  if (!logDir || typeof file !== "string" || file === "") return null;
  return table.get(norm(file)) || null;
}

function record(file, args, spec) {
  const stamp = process.hrtime.bigint().toString().padStart(20, "0");
  const base = path.join(logDir, `${stamp}-${process.pid}-${String(seq++).padStart(6, "0")}-${spec.role}`);
  const argv = [file, ...(Array.isArray(args) ? args.map(String) : [])];
  try {
    fs.writeFileSync(base + ".argv", argv.map((a) => a + "\0").join(""));
  } catch {
    return null;   // a log that cannot be written never breaks the render
  }
  return base;
}

function writeRc(base, code, signal) {
  if (!base) return;
  // the sh shim wrote $?, which is 128 + n for a signal
  const rc = code !== null && code !== undefined ? code : signal ? 128 + (require("node:os").constants.signals[signal] || 0) : null;
  if (rc === null) return;
  try {
    fs.writeFileSync(base + ".rc", String(rc));
  } catch {
    /* ignore */
  }
}

// (file, args?, options?, callback?) -> args array or []
function argsOf(rest) {
  return Array.isArray(rest[0]) ? rest[0] : [];
}

function wrapAsync(name) {
  const original = cp[name];
  if (typeof original !== "function") return;
  cp[name] = function wrapped(file, ...rest) {
    const spec = lookup(file);
    const base = spec ? record(file, argsOf(rest), spec) : null;
    const child = original.call(this, file, ...rest);
    if (base && spec.rc && child && typeof child.once === "function") child.once("exit", (code, signal) => writeRc(base, code, signal));
    return child;
  };
}

function wrapSync(name) {
  const original = cp[name];
  if (typeof original !== "function") return;
  cp[name] = function wrapped(file, ...rest) {
    const spec = lookup(file);
    const base = spec ? record(file, argsOf(rest), spec) : null;
    try {
      const out = original.call(this, file, ...rest);
      if (base && spec.rc) writeRc(base, name === "spawnSync" ? out.status : 0, name === "spawnSync" ? out.signal : null);
      return out;
    } catch (e) {
      if (base && spec.rc) writeRc(base, typeof e.status === "number" ? e.status : null, e.signal || null);
      throw e;
    }
  };
}

if (logDir && table.size > 0 && !globalThis.__hyperframesSkillArgvRecorder) {
  globalThis.__hyperframesSkillArgvRecorder = true;
  for (const n of ["spawn", "execFile", "fork"]) wrapAsync(n);
  for (const n of ["spawnSync", "execFileSync"]) wrapSync(n);
  syncBuiltinESMExports();
}
