import { statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { addOpt, baseCommand } from "../cli.mjs";
import { MIN_FFMPEG_MAJOR, MIN_NODE_MAJOR, parseFfVersion, PKG, REQUIREMENTS, resolveChromium, resolveFfTool, resolveHyperframes } from "../deps.mjs";
import { runSync } from "../proc.mjs";
import { EXIT, printJson } from "../result.mjs";
import { hyperframesEnv } from "../render-core.mjs";

export const meta = {
  name: "doctor",
  role: "analysis",
  description: "Probe this machine now: Node version, the pinned hyperframes package, ffmpeg/ffprobe and their encoders, a working headless Chromium, free temp space. Each capability is available, missing or unknown; nothing is reported that was not probed.",
  capabilities: { required: [], optional: [] },
  inputs: [],
  outputs: ["a JSON report (stdout only)"],
  produces_artifact: false,
  supports_dry_run: true,
  dry_run: "lists the probes it would run (argv) and runs none of them",
  verification: { required: false, tools: [] },
  deterministic_inputs: false,
  idempotency_hint: "environment_dependent",
  output_schema: "{status, ok, exit_code, capabilities: {<name>: {status: available|missing|unknown, detail, ...}}, tools: {<tool>: {usable: yes|no|unknown, missing?, unknown?}}, requirements, commands}",
};

export const MIN_FREE_BYTES = 1024 ** 3;

export function command() {
  const cmd = baseCommand("doctor", meta.description);
  addOpt(cmd, "--no-chromium-probe", "skip launching Chromium (chromium:headless is then unknown, never available)", { type: "boolean" });
  return cmd;
}

const PROBE_HTML = "data:text/html,<p>hyperframes-skill-headless-ok</p>";

function nodeCap() {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= MIN_NODE_MAJOR
    ? { status: "available", version: process.versions.node, detail: `node ${process.versions.node} (need ${REQUIREMENTS.node})` }
    : { status: "missing", version: process.versions.node, detail: `node ${process.versions.node} is older than ${REQUIREMENTS.node}` };
}

function probeRun(ctx, argv, opts) {
  const entry = ctx.record(argv, { exit_code: null });
  const r = runSync(argv, opts);
  entry.exit_code = r.status;
  return r;
}

function hyperframesCap(ctx) {
  const hf = resolveHyperframes();
  if (!hf.path) return { status: "missing", detail: "the hyperframes package is not installed (run npm install)" };
  const want = REQUIREMENTS.hyperframes;
  const r = probeRun(ctx, [process.execPath, hf.path, "--version"], { timeoutMs: 60000, env: hyperframesEnv() });
  if (!r.ok) return { status: "unknown", version: hf.version, detail: `installed ${hf.version} but \`hyperframes --version\` failed: ${(r.stderr || r.error || "").trim().slice(0, 300)}` };
  const reported = (r.stdout.match(/\d+\.\d+\.\d+\S*/) || [null])[0];
  if (hf.version !== want) return { status: "missing", version: hf.version, detail: `installed ${hf.version}, this release is pinned to ${want}` };
  return { status: "available", version: hf.version, reported, path: hf.path, detail: `hyperframes ${hf.version}` };
}

function ffCap(ctx, name) {
  const t = resolveFfTool(name);
  if (!t.path) return { status: "missing", detail: `${name} not found (${t.source}: ${t.requested})` };
  const r = probeRun(ctx, [t.path, "-hide_banner", "-version"], { timeoutMs: 30000 });
  if (!r.ok) return { status: "unknown", path: t.path, detail: `${name} -version failed: ${(r.stderr || r.error || "").trim().slice(0, 300)}` };
  const v = parseFfVersion(r.stdout);
  if (!v) return { status: "unknown", path: t.path, detail: `cannot parse a version from: ${r.stdout.split("\n")[0]}` };
  if (v.major < MIN_FFMPEG_MAJOR) return { status: "missing", path: t.path, version: `${v.major}.${v.minor}`, detail: `${name} ${v.major}.${v.minor} is older than ${REQUIREMENTS[name]}` };
  return { status: "available", path: t.path, version: `${v.major}.${v.minor}`, detail: v.raw };
}

const ENCODERS = ["libx264", "libvpx-vp9", "prores_ks"];

function encoderCaps(ctx, ffmpeg) {
  const out = {};
  if (ffmpeg.status !== "available") {
    for (const e of ENCODERS) out[`encoder:${e}`] = { status: ffmpeg.status === "missing" ? "missing" : "unknown", detail: `ffmpeg is ${ffmpeg.status}` };
    return out;
  }
  const r = probeRun(ctx, [ffmpeg.path, "-hide_banner", "-encoders"], { timeoutMs: 30000 });
  const names = new Set();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*[VAS][F.][S.][X.][B.][D.]\s+(\S+)/.exec(line);
    if (m) names.add(m[1]);
  }
  for (const e of ENCODERS) {
    if (!r.ok || names.size === 0) out[`encoder:${e}`] = { status: "unknown", detail: "ffmpeg -encoders could not be read" };
    else out[`encoder:${e}`] = names.has(e) ? { status: "available", detail: "listed by ffmpeg -encoders" } : { status: "missing", detail: "not in this ffmpeg build's -encoders list" };
  }
  return out;
}

function chromiumCap(ctx, probe) {
  const c = resolveChromium();
  const searched = c.candidates.map((x) => ({ path: x.path, source: x.source }));
  if (!c.path) return { status: "missing", detail: "no Chromium found in any searched location", searched };
  if (!c.exists) return { status: "missing", path: c.path, source: c.source, detail: `${c.source} points at ${c.path}, which does not exist`, searched };
  if (!probe) return { status: "unknown", path: c.path, source: c.source, detail: "found; not launched (--no-chromium-probe)", searched };
  const argv = [c.path, "--headless", "--no-sandbox", "--disable-gpu", "--no-first-run", "--dump-dom", PROBE_HTML];
  const r = probeRun(ctx, argv, { timeoutMs: 60000 });
  if (r.ok && r.stdout.includes("hyperframes-skill-headless-ok")) {
    return { status: "available", path: c.path, source: c.source, detail: "launched headless and rendered a probe page (--dump-dom)", searched };
  }
  return {
    status: "unknown",
    path: c.path,
    source: c.source,
    detail: `found, but the headless probe did not succeed (${r.timedOut ? "timed out" : `exit ${r.status}`}): ${(r.stderr || r.error || "").trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`,
    searched,
  };
}

function diskCap() {
  const dir = tmpdir();
  try {
    const s = statfsSync(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    const gib = (free / 1024 ** 3).toFixed(1);
    return free >= MIN_FREE_BYTES
      ? { status: "available", path: dir, free_bytes: free, detail: `${gib} GiB free in ${dir}` }
      : { status: "missing", path: dir, free_bytes: free, detail: `only ${gib} GiB free in ${dir}; renders stage frames and segments in temp space (need >= 1 GiB)` };
  } catch (e) {
    return { status: "unknown", path: dir, detail: `statfs failed: ${e.message}` };
  }
}

/** Tool requirement table, read from each tool's own meta (so it cannot drift). */
async function toolUsability(caps) {
  const { TOOLS } = await import("../registry.mjs");
  const out = {};
  for (const t of TOOLS) {
    const req = t.meta.capabilities.required;
    const missing = req.filter((c) => caps[c]?.status === "missing");
    const unknown = req.filter((c) => !caps[c] || caps[c].status === "unknown");
    out[t.meta.name] = { usable: missing.length ? "no" : unknown.length ? "unknown" : "yes", ...(missing.length ? { missing } : {}), ...(unknown.length ? { unknown } : {}) };
  }
  return out;
}

export const REQUIRED_CAPS = ["node", "hyperframes", "ffmpeg", "ffprobe", "chromium:headless", "encoder:libx264", "disk:tmp"];

export async function run(ctx, _args, opts) {
  if (ctx.dryRun) {
    const hf = resolveHyperframes();
    const c = resolveChromium();
    const ff = resolveFfTool("ffmpeg");
    const fp = resolveFfTool("ffprobe");
    const planned = [
      [process.execPath, hf.path ?? "hyperframes", "--version"],
      [ff.path ?? "ffmpeg", "-hide_banner", "-version"],
      [ff.path ?? "ffmpeg", "-hide_banner", "-encoders"],
      [fp.path ?? "ffprobe", "-hide_banner", "-version"],
      ...(opts.chromiumProbe === false ? [] : [[c.path ?? "chromium", "--headless", "--no-sandbox", "--disable-gpu", "--no-first-run", "--dump-dom", PROBE_HTML]]),
    ];
    const doc = { status: "completed", exit_code: EXIT.ok, dry_run: true, ok: null, planned_commands: planned, commands: ctx.commands, requirements: REQUIREMENTS };
    if (ctx.json) printJson(doc);
    else for (const p of planned) process.stdout.write(p.join(" ") + "\n");
    return EXIT.ok;
  }
  const caps = {};
  caps.node = nodeCap();
  caps.hyperframes = hyperframesCap(ctx);
  caps.ffmpeg = ffCap(ctx, "ffmpeg");
  caps.ffprobe = ffCap(ctx, "ffprobe");
  Object.assign(caps, encoderCaps(ctx, caps.ffmpeg));
  caps["chromium:headless"] = chromiumCap(ctx, opts.chromiumProbe !== false);
  caps["disk:tmp"] = diskCap();
  const missing = REQUIRED_CAPS.filter((c) => caps[c].status === "missing");
  const unknown = REQUIRED_CAPS.filter((c) => caps[c].status === "unknown");
  const code = missing.length ? EXIT.failure : unknown.length ? EXIT.unknown : EXIT.ok;
  const doc = {
    status: code === EXIT.ok ? "completed" : "failed",
    exit_code: code,
    ok: code === EXIT.ok,
    dry_run: false,
    skill: { id: PKG.name, version: PKG.version },
    platform: `${process.platform}-${process.arch}`,
    required: REQUIRED_CAPS,
    missing,
    unknown,
    capabilities: caps,
    tools: await toolUsability(caps),
    requirements: REQUIREMENTS,
    commands: ctx.commands,
  };
  if (ctx.json) printJson(doc);
  else {
    for (const [k, v] of Object.entries(caps)) process.stdout.write(`${v.status.padEnd(9)} ${k.padEnd(20)} ${v.detail}\n`);
    process.stdout.write(code === EXIT.ok ? "ok\n" : `not ok: missing [${missing.join(", ")}] unknown [${unknown.join(", ")}]\n`);
  }
  return code;
}
