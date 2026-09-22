// The contract is generated from the code; every doc that restates it is checked against it here.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildContract, CONTRACT_VERSION } from "../lib/contract.mjs";
import { PKG, REQUIREMENTS } from "../lib/deps.mjs";
import { ERROR_KINDS } from "../lib/result.mjs";
import { TOOLS } from "../lib/registry.mjs";
import { cli, FIXTURES, ROOT, tool } from "./helpers.mjs";

const read = (f) => readFileSync(join(ROOT, f), "utf8");
const contract = buildContract();
const SKILL_MD_BUDGET = 12000;

function flagsOf(spec) {
  return Object.values(spec.input_schema.properties)
    .filter((p) => !p.positional)
    .map((p) => p.cli)
    .sort();
}

test("contract --json from the CLI is the generated contract", () => {
  const r = cli(["contract", "--json"]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), JSON.parse(JSON.stringify(contract)));
  assert.equal(contract.contract_version, CONTRACT_VERSION);
});

test("every ToolSpec carries the fields the contract promises", () => {
  const keys = ["id", "name", "version", "executable", "description", "role", "capabilities", "inputs", "outputs", "input_schema", "output_schema", "supports_dry_run", "dry_run", "supports_json", "mutates_input", "produces_artifact", "verification", "deterministic_inputs", "idempotency_hint"];
  for (const t of contract.tools) {
    for (const k of keys) assert.ok(k in t, `${t.name}: ${k}`);
    assert.equal(t.id, `hyperframes-skill/${t.name}`);
    assert.ok(existsSync(join(ROOT, t.executable)), t.executable);
    assert.ok(["analysis", "analysis_and_execution", "execution"].includes(t.role));
    assert.equal(t.mutates_input, false);
    assert.equal(t.supports_json, true);
    assert.ok(Array.isArray(t.capabilities.required) && Array.isArray(t.capabilities.optional));
    for (const o of t.capabilities.optional) assert.deepEqual(Object.keys(o).sort(), ["capability", "when"]);
    assert.ok(t.input_schema.properties.json && t.input_schema.properties.dryRun, `${t.name} has --json and --dry-run`);
  }
  assert.deepEqual(contract.tools.map((t) => t.id), [...contract.tools.map((t) => t.id)].sort());
});

test("input_schema is the parser: every schema flag is accepted and nothing else is", () => {
  for (const t of TOOLS) {
    const spec = contract.tools.find((s) => s.name === t.meta.name);
    const parserFlags = t.command().options.map((o) => o.long).sort();
    assert.deepEqual(flagsOf(spec), parserFlags, t.meta.name);
    const r = tool(t.meta.name, ["--definitely-not-a-flag", "--json"]);
    assert.equal(r.code, 1);
    assert.equal(r.doc.error.kind, "input");
  }
});

test("capability names used by tools are the ones doctor reports", () => {
  const r = tool("doctor", ["--json", "--no-chromium-probe"]);
  const names = Object.keys(r.doc.capabilities);
  for (const t of contract.tools) {
    for (const c of [...t.capabilities.required, ...t.capabilities.optional.map((o) => o.capability)]) assert.ok(names.includes(c), `${t.name}: ${c}`);
  }
  assert.equal(r.doc.capabilities["chromium:headless"].status === "available", false, "--no-chromium-probe never claims available");
});

test("README's tool table, SKILL.md and docs/contract.md's role table name exactly the real tools", () => {
  const readme = read("README.md");
  const rows = [...readme.matchAll(/^\| `([a-z]+)` \| `(hyperframes-skill\/[a-z]+)` \| (\w+) \|/gm)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(
    rows.sort(),
    contract.tools.map((t) => [t.name, t.id, t.role]).sort(),
  );
  const skill = read("SKILL.md");
  for (const t of contract.tools) assert.ok(skill.includes(`\`${t.name}\``), `SKILL.md: ${t.name}`);
  const roles = [...read("docs/contract.md").matchAll(/^\| ([a-z]+) \| (analysis|analysis_and_execution|execution) \|/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(roles.sort(), contract.tools.map((t) => [t.name, t.role]).sort(), "docs/contract.md roles table");
});

test("references/scripts.md lists exactly each tool's real flags", () => {
  const md = read("references/scripts.md");
  const sections = md.split(/^## /m).slice(1);
  const byName = Object.fromEntries(sections.map((s) => [s.split("\n")[0].trim(), s]));
  assert.deepEqual(Object.keys(byName).sort(), contract.tools.map((t) => t.name).sort());
  for (const t of contract.tools) {
    const documented = [...byName[t.name].matchAll(/^\| `(?:-\w, )?(--[a-z-]+)[^`]*` \|/gm)].map((m) => m[1]).sort();
    assert.deepEqual(documented, flagsOf(t), `references/scripts.md ## ${t.name}`);
  }
});

test("the tool count stated in prose matches the real count", () => {
  const n = String(contract.tools.length);
  const words = { 5: "five" };
  assert.match(read("README.md"), new RegExp(`\\b${n} tools\\b`));
  assert.match(read("SKILL.md"), new RegExp(`There are ${n} tools`));
  assert.match(read("SKILL.md"), new RegExp(`all ${words[n] ?? n}\\b`));
  assert.match(read("docs/contract.md"), new RegExp(`There are ${n} tools`));
  assert.match(read("references/scripts.md"), new RegExp(`all ${n} tools`));
  assert.match(PKG.description, new RegExp(`\\b${n} tools\\b`));
});

test("the requirement list in README is the one the code declares, and matches package.json", () => {
  assert.ok(read("README.md").includes(JSON.stringify(REQUIREMENTS)), "README requirements JSON");
  assert.equal(REQUIREMENTS.node, PKG.engines.node);
  const hfPkg = JSON.parse(readFileSync(join(ROOT, "node_modules", "hyperframes", "package.json"), "utf8"));
  assert.equal(REQUIREMENTS.hyperframes, hfPkg.version, "hyperframes is pinned to exactly the installed version");
  assert.equal(PKG.engines.node, hfPkg.engines.node, "our Node floor is hyperframes' Node floor");
  for (const [name, v] of Object.entries(PKG.dependencies)) assert.match(v, /^\d+\.\d+\.\d+$/, `${name} pinned exactly`);
});

test("docs/contract.md states every error kind, exit code and the stability table", () => {
  const md = read("docs/contract.md");
  for (const k of Object.keys(ERROR_KINDS)) assert.ok(md.includes(`\`${k}\``), k);
  for (const code of ["124", "127", "128+signal"]) assert.ok(md.includes(code), code);
  assert.match(md, /## Stability guarantee/);
  assert.match(md, /## Deprecation policy/);
  assert.ok(existsSync(join(ROOT, "docs", "design-decisions.md")));
});

test(`SKILL.md stays under its ${SKILL_MD_BUDGET}-byte budget`, () => {
  const bytes = Buffer.byteLength(read("SKILL.md"));
  assert.ok(bytes <= SKILL_MD_BUDGET, `SKILL.md is ${bytes} bytes; trim a line for every line added`);
  assert.match(read("CONTRIBUTING.md"), new RegExp(SKILL_MD_BUDGET.toLocaleString("en-US")));
});

test("the scene example in SKILL.md is a valid request shape", async () => {
  const { validateRequest } = await import("../lib/scene-spec.mjs");
  const json = /```json\n([\s\S]*?)```/.exec(read("SKILL.md"))[1];
  const req = JSON.parse(json);
  try {
    validateRequest(req, FIXTURES);
    assert.fail("expected missing-file problems only");
  } catch (e) {
    assert.ok(e.details.problems.length > 0);
    for (const p of e.details.problems) assert.match(p, /no such file/, "only the example's asset paths may fail");
  }
});

// Frozen CLI surface: argument names, types, required. Removals and renames fail; additions
// fail until the snapshot is regenerated with UPDATE_SNAPSHOT=1, so the diff shows what grew.
test("CLI surface matches the frozen snapshot", () => {
  const surface = {};
  for (const t of contract.tools) {
    surface[t.id] = {
      positional: t.input_schema.positional,
      required: [...t.input_schema.required].sort(),
      args: Object.fromEntries(Object.entries(t.input_schema.properties).map(([k, p]) => [k, { cli: p.cli, type: p.type }]).sort(([a], [b]) => a.localeCompare(b))),
    };
  }
  const file = join(FIXTURES, "cli_surface.json");
  if (process.env.UPDATE_SNAPSHOT === "1") writeFileSync(file, JSON.stringify(surface, null, 2) + "\n");
  const frozen = JSON.parse(readFileSync(file, "utf8"));
  for (const [id, f] of Object.entries(frozen)) {
    assert.ok(surface[id], `tool ${id} was removed or renamed`);
    assert.deepEqual(surface[id].positional, f.positional, `${id}: positional arguments changed`);
    for (const [k, a] of Object.entries(f.args)) {
      assert.ok(surface[id].args[k], `${id}: argument ${k} (${a.cli}) was removed or renamed`);
      assert.deepEqual(surface[id].args[k], a, `${id}: argument ${k} changed`);
    }
    for (const k of surface[id].required) assert.ok(f.required.includes(k), `${id}: ${k} became required`);
  }
  assert.deepEqual(surface, frozen, "an addition: regenerate with UPDATE_SNAPSHOT=1 and commit the fixture diff");
});
