#!/usr/bin/env node
// Write or check contract/contract.json, this Skill's machine-readable contract as a committed file.
//
// The file is the output of `node bin/hyperframes-skill.mjs contract --json`, as one line with sorted
// keys, compact separators, no ASCII escapes and a final newline, so the contract of any commit or
// release tag can be read with `git show <tag>:contract/contract.json`, without installing or running
// this repository's code.
//
//   node contract/generate.mjs           # regenerate the file after changing the contract
//   node contract/generate.mjs --check   # exit 1 when the committed file is out of date (CI)
//
// The release workflow regenerates it after the version bump, so every tag's file is that tag's own
// contract output.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.join(ROOT, "contract", "contract.json");

/** Keys sorted at every level (by code point, like Python's sort_keys); arrays keep their order. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

export function render() {
  const out = execFileSync(process.execPath, [path.join(ROOT, "bin", "hyperframes-skill.mjs"), "contract", "--json"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.stringify(sortKeys(JSON.parse(out))) + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const want = render();
  if (process.argv.includes("--check")) {
    const have = existsSync(TARGET) ? readFileSync(TARGET, "utf8") : "";
    if (have !== want) {
      console.error("contract/contract.json is out of date; run: node contract/generate.mjs");
      process.exit(1);
    }
    console.log("contract/contract.json: up to date");
  } else {
    writeFileSync(TARGET, want);
    console.log("wrote contract/contract.json");
  }
}
