import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const FIXTURES = join(ROOT, "tests", "fixtures");

/** Real renders need Chrome + ffmpeg; set HYPERFRAMES_SKILL_SKIP_RENDER_TESTS=1 to skip them. CI runs them. */
export const SKIP_RENDER = process.env.HYPERFRAMES_SKILL_SKIP_RENDER_TESTS === "1" ? "HYPERFRAMES_SKILL_SKIP_RENDER_TESTS=1" : false;

export function tmp(prefix = "hfs-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Run scripts/<tool>.mjs; returns {code, doc (parsed stdout JSON or null), stdout, stderr}. */
export function tool(name, args, { env = {}, timeout = 600000 } = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", `${name}.mjs`), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  let doc = null;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, signal: r.signal, doc, stdout: r.stdout, stderr: r.stderr };
}

export function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "hyperframes-skill.mjs"), ...args], { encoding: "utf8", ...opts });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2));
  return path;
}

export function writeExe(path, text) {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  return path;
}

export function listTree(dir) {
  const out = [];
  const walk = (d, pre) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      out.push(pre + e.name + (e.isDirectory() ? "/" : ""));
      if (e.isDirectory()) walk(join(d, e.name), pre + e.name + "/");
    }
  };
  walk(dir, "");
  return out.sort();
}

export function ffmpeg(args) {
  const r = spawnSync(process.env.HYPERFRAMES_SKILL_FFMPEG || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** Decode frame n of a video to raw RGB24; returns {w, h, data}. */
export function frameRgb(file, n, w, h) {
  const data = ffmpeg(["-i", file, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  if (data.length !== w * h * 3) throw new Error(`frame ${n}: got ${data.length} bytes, expected ${w * h * 3}`);
  return { w, h, data };
}

/** Count pixels matching a predicate on (r, g, b). */
export function countPixels({ data }, pred) {
  let n = 0;
  for (let i = 0; i < data.length; i += 3) if (pred(data[i], data[i + 1], data[i + 2])) n++;
  return n;
}
