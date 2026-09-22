// MCP server: tools/list is the contract, tools/call returns the tool's own result document.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildContract } from "../lib/contract.mjs";
import { mcpTools, toArgv } from "../mcp/server.mjs";
import { FIXTURES, ROOT, tmp } from "./helpers.mjs";

/** Send JSON-RPC messages to a fresh server over stdio; resolves with the replies by id. */
function session(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, "bin", "hyperframes-skill.mjs"), "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (out += c));
    child.on("error", reject);
    child.on("close", () => {
      const replies = out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      resolve(Object.fromEntries(replies.map((r) => [r.id, r])));
    });
    for (const m of messages) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    child.stdin.end();
  });
}

test("initialize, tools/list from the contract, notifications unanswered, unknown methods refused", async () => {
  const r = await session([
    { id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { method: "notifications/initialized" },
    { id: 2, method: "tools/list" },
    { id: 3, method: "ping" },
    { id: 4, method: "resources/list" },
  ]);
  assert.equal(r[1].result.protocolVersion, "2025-03-26");
  assert.equal(r[1].result.serverInfo.name, "hyperframes-skill");
  assert.deepEqual(r[2].result.tools.map((t) => t.name).sort(), buildContract().tools.map((t) => t.name).sort());
  assert.deepEqual(r[3].result, {});
  assert.equal(r[4].error.code, -32601);
  assert.equal(Object.keys(r).length, 4, "the notification got no reply");
});

test("tools/call returns the tool's own result document; isError exactly when status is not completed", async () => {
  const dir = tmp();
  const r = await session([
    { id: 1, method: "tools/call", params: { name: "template", arguments: { name: "break", set: ["message=Break", "duration=2"], output: join(dir, "req.json") } } },
    { id: 2, method: "tools/call", params: { name: "scene", arguments: { request: join(dir, "req.json"), output: join(dir, "scene"), dryRun: true } } },
    { id: 3, method: "tools/call", params: { name: "render", arguments: { scene_dir: join(dir, "missing"), output: join(dir, "o.mp4") } } },
    { id: 4, method: "tools/call", params: { name: "render", arguments: { bogus: 1 } } },
    { id: 5, method: "tools/call", params: { name: "nope", arguments: {} } },
  ]);
  assert.equal(r[1].result.isError, false);
  assert.equal(r[1].result.structuredContent.status, "completed");
  assert.equal(r[1].result.structuredContent.verified, true);
  assert.deepEqual(JSON.parse(r[1].result.content[0].text), r[1].result.structuredContent);
  assert.equal(JSON.parse(readFileSync(join(dir, "req.json"), "utf8")).duration, 2);
  assert.equal(r[2].result.structuredContent.dry_run, true);
  assert.equal(r[3].result.isError, true);
  assert.equal(r[3].result.structuredContent.error.kind, "input");
  assert.equal(r[4].result.isError, true);
  assert.match(r[4].result.content[0].text, /unknown argument\(s\) for render: bogus/);
  assert.equal(r[5].error.code, -32602);
});

test("argv mapping: positionals first, booleans as flags, negated flags, repeatables, --json appended", () => {
  const c = buildContract();
  const spec = (n) => c.tools.find((t) => t.name === n);
  assert.deepEqual(toArgv(spec("render"), { scene_dir: "s", output: "o.mp4", codec: "vp9", quality: 30, overwrite: true, dryRun: false }), ["s", "--output", "o.mp4", "--codec", "vp9", "--quality", "30", "--overwrite", "--json"]);
  assert.deepEqual(toArgv(spec("doctor"), { chromiumProbe: false }), ["--no-chromium-probe", "--json"]);
  assert.deepEqual(toArgv(spec("doctor"), { chromiumProbe: true }), ["--json"]);
  assert.deepEqual(toArgv(spec("template"), { name: "break", set: ["a=1", "b=2"] }), ["break", "--set", "a=1", "--set", "b=2", "--json"]);
  assert.throws(() => toArgv(spec("render"), { overwrite: "yes" }), /must be a boolean/);
  assert.throws(() => toArgv(spec("render"), { json: false }), /unknown argument/);
});

// Frozen MCP surface, like the CLI one: tool names, property names, required. Regenerate with
// UPDATE_SNAPSHOT=1 after a deliberate addition; removals and renames fail.
test("MCP tool surface matches the frozen snapshot", () => {
  const surface = Object.fromEntries(
    mcpTools()
      .map((t) => [t.name, { properties: Object.keys(t.inputSchema.properties).sort(), required: [...t.inputSchema.required].sort() }])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const file = join(FIXTURES, "mcp_tools.json");
  if (process.env.UPDATE_SNAPSHOT === "1") writeFileSync(file, JSON.stringify(surface, null, 2) + "\n");
  const frozen = JSON.parse(readFileSync(file, "utf8"));
  for (const [name, f] of Object.entries(frozen)) {
    assert.ok(surface[name], `MCP tool ${name} was removed or renamed`);
    for (const p of f.properties) assert.ok(surface[name].properties.includes(p), `${name}: property ${p} was removed or renamed`);
    for (const p of surface[name].required) assert.ok(f.required.includes(p), `${name}: ${p} became required`);
  }
  assert.deepEqual(surface, frozen, "an addition: regenerate with UPDATE_SNAPSHOT=1 and commit the fixture diff");
});
