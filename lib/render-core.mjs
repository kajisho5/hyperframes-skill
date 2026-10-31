// Scene directory -> video, through the pinned HyperFrames CLI. Shared by render and preview.
//
// HyperFrames launches Chrome and ffmpeg itself. To report the argv that actually ran (not the
// argv we think it probably used), HyperFrames runs with a preload, lib/argv-recorder.cjs
// (`node --require`), that writes the argv of every chrome / ffmpeg / ffprobe process it starts to
// a log directory before starting it (docs/design-decisions.md D10). HyperFrames is pointed at the
// real binaries through its own documented variables (HYPERFRAMES_BROWSER_PATH,
// HYPERFRAMES_FFMPEG_PATH, HYPERFRAMES_FFPROBE_PATH). No shell script is generated, so the same
// path runs on Linux, macOS and Windows.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChromium, resolveFfTool, resolveHyperframes } from "./deps.mjs";
import { probeFile } from "./probe.mjs";
import { runChild, tail } from "./proc.mjs";
import { DEFAULT_FPS, expectedFrames, readDeclared, setRootAttr } from "./scene-spec.mjs";
import { ToolError } from "./result.mjs";

export const CODECS = Object.freeze({
  h264: { format: "mp4", ext: ".mp4", probe: "h264", crf: [0, 51] },
  vp9: { format: "webm", ext: ".webm", probe: "vp9", crf: [0, 63] },
  prores: { format: "mov", ext: ".mov", probe: "prores", crf: null },
});

export const DEFAULT_TIMEOUT_S = 1800;

// Environment every HyperFrames invocation gets: no telemetry, no update check, no auto
// install. PRODUCER_HEADLESS_SHELL_PATH is removed because HyperFrames lets it override
// HYPERFRAMES_BROWSER_PATH, which would bypass the shim (and the browser doctor checked).
export function hyperframesEnv(extra = {}) {
  const env = { ...process.env };
  delete env.PRODUCER_HEADLESS_SHELL_PATH;
  delete env.GEMINI_API_KEY;
  return {
    ...env,
    HYPERFRAMES_NO_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    HYPERFRAMES_NO_UPDATE_CHECK: "1",
    HYPERFRAMES_NO_AUTO_INSTALL: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...extra,
  };
}

// The preload HyperFrames runs with (docs/design-decisions.md D10).
export const ARGV_RECORDER = join(dirname(fileURLToPath(import.meta.url)), "argv-recorder.cjs");

/**
 * The recorder's configuration: which executables to record, under which role, and whether to
 * record the exit status. chrome's is not: HyperFrames ends the browser itself at the end of
 * every render, so its exit status says nothing about the render (docs/contract.md, commands[]).
 */
export function recorderEnv(logDir, tools) {
  const table = {};
  for (const [role, path, rc] of [["chrome", tools.chrome.path, false], ["ffmpeg", tools.ffmpeg, true], ["ffprobe", tools.ffprobe, true]]) {
    table[path] = { role, rc };
    try {
      const real = realpathSync(path);   // HyperFrames may start the resolved path of a symlink
      if (real !== path) table[real] = { role, rc };
    } catch {
      /* recorded under the given path only */
    }
  }
  // in NODE_OPTIONS as well as on HyperFrames' own command line, so a Node process HyperFrames starts records too
  const nodeOptions = [process.env.NODE_OPTIONS, `--require ${JSON.stringify(ARGV_RECORDER)}`].filter(Boolean).join(" ");
  return { HYPERFRAMES_SKILL_ARGV_LOG: logDir, HYPERFRAMES_SKILL_ARGV_TOOLS: JSON.stringify(table), NODE_OPTIONS: nodeOptions };
}

function readArgvLog(logDir) {
  const entries = readdirSync(logDir)
    .filter((f) => f.endsWith(".argv"))
    .map((f) => {
      const full = join(logDir, f);
      const st = statSync(full, { bigint: true });
      const argv = readFileSync(full, "utf8").split("\0");
      argv.pop();
      const rcFile = full.replace(/\.argv$/, ".rc");
      const rc = existsSync(rcFile) ? Number(readFileSync(rcFile, "utf8")) : null;
      const role = f.replace(/\.argv$/, "").split("-").pop();
      return { t: st.mtimeNs, f, argv, rc, role };
    });
  entries.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.f.localeCompare(b.f)));
  return entries;
}

/** Every file under dir: name, size, mtime; plus sha256 of the markup/script/style files. */
export function snapshotDir(dir) {
  const out = {};
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      const rel = relative(dir, full);
      if (ent.isDirectory()) {
        out[rel + sep] = "dir";
        walk(full);
      } else {
        const st = statSync(full);
        let h = null;
        if (/\.(html?|css|m?js|json|svg)$/i.test(ent.name)) h = createHash("sha256").update(readFileSync(full)).digest("hex");
        out[rel] = `${st.size}:${st.mtimeMs}:${h ?? ""}`;
      }
    }
  };
  walk(dir);
  return out;
}

function diffSnapshots(a, b) {
  const changed = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) changed.push(k);
  return changed.sort();
}

// Real paths on both sides, so a symlinked output directory cannot point back into the scene.
function realish(p) {
  let head = p;
  const rest = [];
  while (!existsSync(head) && dirname(head) !== head) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  return join(realpathSync(head), ...rest);
}

function isInside(file, dir) {
  const f = realish(file);
  const d = realpathSync(dir);
  return f === d || f.startsWith(d.endsWith(sep) ? d : d + sep);
}

function requireTools() {
  const hf = resolveHyperframes();
  if (!hf.path) throw new ToolError("missing_tool", "the hyperframes package is not installed", { hint: "run npm install in the hyperframes-skill directory" });
  const ffmpeg = resolveFfTool("ffmpeg");
  if (!ffmpeg.path) throw new ToolError("missing_tool", `ffmpeg not found (${ffmpeg.source}: ${ffmpeg.requested})`, { hint: "install FFmpeg >= 5.0 and put it on PATH, or set HYPERFRAMES_SKILL_FFMPEG" });
  const ffprobe = resolveFfTool("ffprobe");
  if (!ffprobe.path) throw new ToolError("missing_tool", `ffprobe not found (${ffprobe.source}: ${ffprobe.requested})`, { hint: "install FFmpeg >= 5.0 (it ships ffprobe) and put it on PATH, or set HYPERFRAMES_SKILL_FFPROBE" });
  const chrome = resolveChromium();
  if (!chrome.path || !chrome.exists) {
    throw new ToolError("missing_tool", chrome.path ? `Chromium not found at ${chrome.path} (${chrome.source})` : "no headless-capable Chromium found", {
      hint: "run `npx hyperframes browser ensure` to download chrome-headless-shell, or set HYPERFRAMES_BROWSER_PATH; `hyperframes-skill doctor` lists what was searched",
    });
  }
  return { hf, ffmpeg: ffmpeg.path, ffprobe: ffprobe.path, chrome };
}

/**
 * Validate everything that can be validated without Chrome or ffmpeg, and work out what the
 * artifact must look like. Pure: reads files, writes nothing.
 */
export function planRender({ sceneDir, output, codec = "h264", quality, fps, workers = "auto", overwrite = false, maxDuration }) {
  const dir = resolve(sceneDir);
  const index = join(dir, "index.html");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ToolError("input", `scene directory not found: ${sceneDir}`);
  if (!existsSync(index)) throw new ToolError("input", `${sceneDir} has no index.html`, { hint: "pass the directory `scene` wrote" });
  if (!output) throw new ToolError("input", "-o/--output is required");
  const out = resolve(output);
  const spec = CODECS[codec];
  if (!spec) throw new ToolError("input", `--codec must be one of ${Object.keys(CODECS).join(", ")}`);
  if (extname(out).toLowerCase() !== spec.ext) throw new ToolError("input", `--codec ${codec} writes ${spec.ext}; the output ${basename(out)} has a different extension`);
  if (isInside(out, dir)) throw new ToolError("input", "the output must be outside the scene directory (the scene is an input and is never written to)");
  if (existsSync(out) && !overwrite) throw new ToolError("input", `output exists: ${output}`, { hint: "pass --overwrite to replace it" });
  if (quality !== undefined) {
    if (!spec.crf) throw new ToolError("input", `--quality is not supported with --codec ${codec} (fixed ProRes 4444 profile)`);
    const [lo, hi] = spec.crf;
    if (!Number.isInteger(quality) || quality < lo || quality > hi) throw new ToolError("input", `--quality for ${codec} must be an integer ${lo}..${hi} (CRF scale: lower is better)`);
  }
  if (workers !== "auto" && !(Number.isInteger(workers) && workers >= 1 && workers <= 8)) throw new ToolError("input", "--workers must be auto or an integer 1..8");
  const html = readFileSync(index, "utf8");
  const declared = readDeclared(html, index);
  const resolvedFps = fps ?? declared.fps ?? DEFAULT_FPS;
  let duration = declared.duration;
  if (maxDuration !== undefined && maxDuration < duration) duration = maxDuration;
  return {
    sceneDir: dir,
    index,
    html,
    declared,
    output: out,
    codec,
    spec,
    quality,
    workers,
    expected: {
      width: declared.width,
      height: declared.height,
      duration,
      fps: resolvedFps,
      frames: expectedFrames(duration, resolvedFps),
      codec: spec.probe,
      fps_source: fps !== undefined ? "--fps" : declared.fps !== null ? "data-fps" : "default",
    },
    truncated: duration < declared.duration,
  };
}

export function hyperframesArgv(hfBin, plan, renderDir, { preset } = {}) {
  const argv = [process.execPath, "--require", ARGV_RECORDER, hfBin, "render", renderDir, "-o", plan.output, "--fps", String(plan.expected.fps), "--format", plan.spec.format, "--workers", String(plan.workers), "--no-browser-gpu", "--no-best-effort", "--sdr", "--quiet"];
  if (preset) argv.push("--quality", preset);
  if (plan.quality !== undefined) argv.push("--crf", String(plan.quality));
  return argv;
}

/** Run a plan for real. Returns {probe, verification, hyperframes}; throws ToolError on failure. */
export async function executeRender(ctx, plan, { timeoutS = DEFAULT_TIMEOUT_S, preset } = {}) {
  const tools = requireTools();
  const before = snapshotDir(plan.sceneDir);
  const work = mkdtempSync(join(tmpdir(), "hyperframes-skill-"));
  const logDir = join(work, "log");
  mkdirSync(logDir);
  let renderDir = plan.sceneDir;
  try {
    if (plan.truncated) {
      // preview --max-duration: render a staged copy whose root duration is shortened. The
      // scene directory itself is never modified.
      renderDir = join(work, "scene");
      cpSync(plan.sceneDir, renderDir, { recursive: true });
      const staged = setRootAttr(plan.html, plan.declared, "data-duration", String(plan.expected.duration));
      writeFileSync(join(renderDir, "index.html"), staged.html);
    }
    const env = hyperframesEnv({
      HYPERFRAMES_BROWSER_PATH: tools.chrome.path,
      HYPERFRAMES_FFMPEG_PATH: tools.ffmpeg,
      HYPERFRAMES_FFPROBE_PATH: tools.ffprobe,
      ...recorderEnv(logDir, tools),
    });
    mkdirSync(dirname(plan.output), { recursive: true });
    const argv = hyperframesArgv(tools.hf.path, plan, renderDir, { preset });
    const hfEntry = ctx.record(argv, { exit_code: null });
    ctx.info(`rendering ${plan.index} -> ${plan.output} (${plan.expected.frames} frames @ ${plan.expected.fps} fps)`);
    let r;
    try {
      r = await runChild(argv, { env, cwd: work, timeoutMs: timeoutS * 1000 });
    } finally {
      for (const e of readArgvLog(logDir)) ctx.record(e.argv, { via: "hyperframes", role: e.role, exit_code: e.rc });
    }
    hfEntry.exit_code = r.status;
    const hyperframes = { version: tools.hf.version, chromium: { path: tools.chrome.path, source: tools.chrome.source } };
    if (r.status !== 0) {
      const failure = classifyFailure(ctx.commands, r.stderr + "\n" + r.stdout);
      throw new ToolError(failure.kind, `hyperframes render exited ${r.status ?? r.signal}: ${failure.message}`, {
        details: { hyperframes, classification: failure.evidence, hyperframes_error: failure.message, stderr_tail: tail(r.stderr + "\n" + r.stdout) },
      });
    }
    return { hyperframes, ...verifyArtifact(ctx, plan, before) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** HyperFrames' own failure text: its last "✗ <title>" line and the lines under it. */
export function hyperframesFailureMessage(text) {
  const lines = String(text).split(/\r?\n/);
  let i = -1;
  lines.forEach((l, n) => {
    if (/^\s*✗\s/.test(l)) i = n;
  });
  if (i < 0) return null;
  const title = lines[i].replace(/^\s*✗\s*/, "").trim();
  const body = lines
    .slice(i + 1)
    .map((l) => l.trim())
    .filter((l) => l && !/^Try --docker/.test(l) && !l.startsWith("["))
    .slice(0, 6);
  return [title, ...body].join(" | ");
}

/**
 * render vs encode. HyperFrames captures and encodes concurrently, and when capture dies it
 * tears the encoder down too, so "an ffmpeg process exited non-zero" alone does not mean the
 * encode failed. `encode` needs two pieces of evidence that agree: HyperFrames' own failure
 * message names FFmpeg / the encode, and a recorded ffmpeg process exited non-zero.
 * Anything else is `render` (page load / capture). docs/contract.md, "error.kind".
 */
export function classifyFailure(commands, output) {
  const message = hyperframesFailureMessage(output) ?? "no failure message from hyperframes";
  const ffmpegFailed = commands.filter((c) => c.via === "hyperframes" && c.role === "ffmpeg" && c.exit_code !== null && c.exit_code !== 0);
  const saysEncode = /ffmpeg|encod/i.test(message);
  const kind = saysEncode && ffmpegFailed.length > 0 ? "encode" : "render";
  return {
    kind,
    message,
    evidence: {
      hyperframes_message_names_encode: saysEncode,
      ffmpeg_nonzero_exits: ffmpegFailed.map((c) => c.exit_code),
    },
  };
}

/** The checks behind `verified`. Each step says what was compared and whether it held. */
export function verifyArtifact(ctx, plan, before) {
  const steps = [];
  const exists = existsSync(plan.output) && statSync(plan.output).size > 0;
  steps.push({ step: "exists", ok: exists, detail: exists ? `${statSync(plan.output).size} bytes` : "output missing or empty" });
  let probe = null;
  if (exists) {
    try {
      probe = probeFile(ctx, plan.output);
    } catch (e) {
      steps.push({ step: "probe", ok: false, detail: e.message });
    }
  }
  if (probe) {
    const v = probe.video;
    const E = plan.expected;
    const tol = 1 / E.fps + 0.001;
    steps.push({ step: "probe", ok: !!v, detail: v ? "video stream read" : "no video stream" });
    if (v) {
      steps.push({ step: "codec", ok: v.codec === E.codec, expected: E.codec, actual: v.codec });
      steps.push({ step: "resolution", ok: v.width === E.width && v.height === E.height, expected: `${E.width}x${E.height}`, actual: `${v.width}x${v.height}` });
      steps.push({ step: "fps", ok: v.fps !== null && Math.abs(v.fps - E.fps) < 0.01, expected: E.fps, actual: v.fps });
      steps.push({ step: "frames", ok: v.frames === E.frames, expected: E.frames, actual: v.frames, source: v.frames_source });
      steps.push({ step: "duration", ok: probe.duration !== null && Math.abs(probe.duration - E.duration) <= tol, expected: E.duration, actual: probe.duration, tolerance: Number(tol.toFixed(4)) });
    }
  }
  const changed = diffSnapshots(before, snapshotDir(plan.sceneDir));
  steps.push({ step: "input_preserved", ok: changed.length === 0, detail: changed.length ? `changed: ${changed.slice(0, 20).join(", ")}` : "scene directory unchanged (names, sizes, mtimes; sha256 of markup files)" });
  return { probe, verification: steps };
}
