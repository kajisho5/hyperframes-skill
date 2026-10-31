// Test double for chrome / ffmpeg / ffprobe that works on every OS (tests only, never shipped behaviour).
// Earlier tests wrote POSIX sh scripts and pointed the tools at them; a Windows process cannot spawn those. Instead a
// test sets NODE_OPTIONS="--require <this file>" and HYPERFRAMES_SKILL_TEST_FAKES to a JSON list of rules:
//   {"name": "chrome", "path": "<executable>", "when": "<an argument that must be present>"?, "log": "<file>"?,
//    "exit": <code>?, "stderr": "<text>"?}
// In every Node process of the run (the skill and the HyperFrames process it starts, which inherit NODE_OPTIONS),
// a child process started with a matching executable (and, with "when", that argument) is
//   logged: "<name> <args...>" appended to "log", when given;
//   replaced, when "exit" is given: a Node process that reads and discards its stdin, writes "stderr" and exits with
//   "exit" runs instead, with the same options (the caller sees an ordinary child process);
//   otherwise started as asked.
// It wraps spawn / spawnSync / execFile / execFileSync, like lib/argv-recorder.cjs, and is loaded first (NODE_OPTIONS
// preloads come before command-line ones), so the recorder still records the call as HyperFrames made it.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

let rules = [];
try {
  rules = JSON.parse(process.env.HYPERFRAMES_SKILL_TEST_FAKES || "[]");
} catch {
  rules = [];
}
const win = process.platform === "win32";
const norm = (p) => {
  const r = path.resolve(String(p));
  return win ? r.toLowerCase() : r;
};

function match(file, args) {
  if (typeof file !== "string") return null;
  const f = norm(file);
  return rules.find((r) => norm(r.path) === f && (!r.when || args.includes(r.when))) || null;
}

function replacement(rule) {
  const code = `process.stdin.on("data",()=>{});process.stdin.on("end",()=>{});process.stdin.resume();` +
    `process.stderr.write(${JSON.stringify(rule.stderr ? rule.stderr + "\n" : "")});` +
    `setTimeout(()=>process.exit(${Number(rule.exit)}),50);`;
  return [process.execPath, ["-e", code]];
}

function handle(file, rest) {
  const args = Array.isArray(rest[0]) ? rest[0].map(String) : [];
  const rule = match(file, args);
  if (!rule) return null;
  if (rule.log) fs.appendFileSync(rule.log, [rule.name, ...args].join(" ") + "\n");
  if (rule.exit === undefined || rule.exit === null) return null;
  const [exe, eargs] = replacement(rule);
  return [exe, eargs, ...(Array.isArray(rest[0]) ? rest.slice(1) : rest)];
}

if (rules.length && !globalThis.__hyperframesSkillTestFakes) {
  globalThis.__hyperframesSkillTestFakes = true;
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
    const original = cp[name];
    cp[name] = function wrapped(file, ...rest) {
      const swapped = handle(file, rest);
      return swapped ? original.call(this, ...swapped) : original.call(this, file, ...rest);
    };
  }
  syncBuiltinESMExports();
}
