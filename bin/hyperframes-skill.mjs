#!/usr/bin/env node
// hyperframes-skill <tool> [args...]   |   hyperframes-skill contract [--json]   |   hyperframes-skill mcp (stdio server)
import { runTool } from "../lib/cli.mjs";
import { buildContract } from "../lib/contract.mjs";
import { printJson } from "../lib/result.mjs";
import { TOOLS, toolByName } from "../lib/registry.mjs";

const [sub, ...rest] = process.argv.slice(2);

if (sub === "mcp") {
  const { serve } = await import("../mcp/server.mjs");
  serve();
} else if (sub === "contract") {
  const c = buildContract();
  if (rest.includes("--json")) printJson(c);
  else for (const t of c.tools) process.stdout.write(`${t.id.padEnd(28)} ${t.role.padEnd(10)} ${t.description}\n`);
  process.exitCode = 0;
} else if (toolByName(sub)) {
  process.exitCode = await runTool(toolByName(sub), rest);
} else {
  const list = TOOLS.map((t) => t.meta.name).join(", ");
  process.stderr.write(sub && sub !== "--help" && sub !== "-h" ? `error: unknown tool "${sub}" (tools: ${list}, contract)\n` : `usage: hyperframes-skill <tool> [args]\ntools: ${list}\n       hyperframes-skill contract [--json]\n`);
  process.exitCode = sub && sub !== "--help" && sub !== "-h" ? 1 : 0;
}
