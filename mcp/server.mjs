#!/usr/bin/env node
// MCP server over stdio (newline-delimited JSON-RPC 2.0), with no dependency beyond this package.
// tools/list is generated from the contract (so from each tool's own parser); tools/call builds
// the tool's argv from the structured arguments, runs scripts/<tool>.mjs --json (never a shell,
// never any other executable) and returns its result document unchanged: as text, as
// structuredContent, and with isError set exactly when the document's status is not "completed".
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContract } from "../lib/contract.mjs";
import { PKG, ROOT } from "../lib/deps.mjs";

export const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

function jsonType(p) {
  if (p.type === "integer|auto") return { anyOf: [{ type: "integer" }, { type: "string", enum: ["auto"] }] };
  if (p.type === "string[]") return { type: "array", items: { type: "string" } };
  return { type: p.type };
}

/** MCP tool list, derived from the contract. `json` is set by the transport, so it is not offered. */
export function mcpTools(contract = buildContract()) {
  return contract.tools.map((t) => {
    const properties = {};
    for (const [k, p] of Object.entries(t.input_schema.properties)) {
      if (k === "json") continue;
      const prop = { ...jsonType(p), description: p.description };
      if (p.enum) prop.enum = p.enum;
      if (p.default !== undefined && !p.negated_flag) prop.default = p.default;
      if (p.negated_flag) prop.default = true;
      properties[k] = prop;
    }
    return {
      name: t.name,
      title: t.id,
      description: `${t.description} Returns the tool's JSON result document (status, verified, verification, commands, error).`,
      inputSchema: { type: "object", properties, required: t.input_schema.required, additionalProperties: false },
      annotations: { readOnlyHint: !t.produces_artifact, destructiveHint: false, openWorldHint: false },
    };
  });
}

/** Structured arguments -> argv for scripts/<tool>.mjs (positionals first, in schema order). */
export function toArgv(spec, args) {
  const schema = spec.input_schema;
  const argv = [];
  const unknown = Object.keys(args).filter((k) => !(k in schema.properties) || k === "json");
  if (unknown.length) throw new Error(`unknown argument(s) for ${spec.name}: ${unknown.join(", ")}`);
  for (const k of schema.positional) if (args[k] !== undefined) argv.push(String(args[k]));
  for (const [k, p] of Object.entries(schema.properties)) {
    if (p.positional || k === "json" || args[k] === undefined) continue;
    const v = args[k];
    if (p.type === "boolean") {
      if (typeof v !== "boolean") throw new Error(`${k} must be a boolean`);
      if (p.negated_flag) {
        if (v === false) argv.push(p.cli);
      } else if (v) argv.push(p.cli);
    } else if (p.type === "string[]") {
      if (!Array.isArray(v)) throw new Error(`${k} must be an array of strings`);
      for (const item of v) argv.push(p.cli, String(item));
    } else {
      argv.push(p.cli, String(v));
    }
  }
  argv.push("--json");
  return argv;
}

function runTool(name, argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "scripts", `${name}.mjs`), ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (out += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (err += c));
    child.on("close", (code, signal) => resolve({ code, signal, out, err }));
  });
}

export async function handle(msg, contract) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const error = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (id === undefined) return null; // a notification (e.g. notifications/initialized) is never answered
  if (method === "initialize") {
    const asked = params?.protocolVersion;
    return reply({
      protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: PKG.name, version: PKG.version },
      instructions: "Local HyperFrames rendering. Decide the scene yourself; every tool returns a result document whose status/verified/error.kind are authoritative. See `contract` in the repository for the full contract.",
    });
  }
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: mcpTools(contract) });
  if (method === "tools/call") {
    const spec = contract.tools.find((t) => t.name === params?.name);
    if (!spec) return error(-32602, `unknown tool: ${params?.name}`);
    let argv;
    try {
      argv = toArgv(spec, params.arguments ?? {});
    } catch (e) {
      return reply({ content: [{ type: "text", text: e.message }], isError: true });
    }
    const r = await runTool(spec.name, argv);
    let doc;
    try {
      doc = JSON.parse(r.out);
    } catch {
      return reply({ content: [{ type: "text", text: `${spec.name} printed no result document (exit ${r.code ?? r.signal}): ${r.err.trim().slice(-2000)}` }], isError: true });
    }
    return reply({ content: [{ type: "text", text: JSON.stringify(doc, null, 2) }], structuredContent: doc, isError: doc.status !== "completed" });
  }
  return error(-32601, `method not found: ${method}`);
}

export function serve(input = process.stdin, output = process.stdout) {
  const contract = buildContract();
  const rl = createInterface({ input });
  let pending = 0;
  let closed = false;
  const write = (obj) => output.write(JSON.stringify(obj) + "\n");
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    pending++;
    try {
      const res = await handle(msg, contract);
      if (res) write(res);
    } catch (e) {
      if (msg.id !== undefined) write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } });
    } finally {
      pending--;
      if (closed && pending === 0) process.exit(0);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (pending === 0) process.exit(0);
  });
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) serve();
