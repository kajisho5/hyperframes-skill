import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const FIXTURES = join(ROOT, "tests", "fixtures");

/** Real renders need Chrome + ffmpeg; set HYPERFRAMES_SKILL_SKIP_RENDER_TESTS=1 to skip them. CI runs them. */
export const SKIP_RENDER = process.env.HYPERFRAMES_SKILL_SKIP_RENDER_TESTS === "1" ? "HYPERFRAMES_SKILL_SKIP_RENDER_TESTS=1" : false;

/**
 * Temporary directories of the tests (docs/design-decisions.md D16). Every directory tmp() makes is
 * removed when the test file's process ends: a normal exit, a failed assertion, or SIGINT / SIGTERM
 * (a CI cancel, the test runner's timeout). SIGKILL cannot be caught.
 *   HYPERFRAMES_SKILL_TEST_TMPDIR=DIR   make them under DIR instead of the OS temp directory
 *   HYPERFRAMES_SKILL_KEEP_TEST_TMP=1   keep them for debugging; their paths are printed on stderr
 */
export const TMP_ROOT = process.env.HYPERFRAMES_SKILL_TEST_TMPDIR || tmpdir();
const KEEP_TMP = process.env.HYPERFRAMES_SKILL_KEEP_TEST_TMP === "1";
const madeTmp = new Set();

export function removeTmpDirs() {
  for (const dir of madeTmp) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  madeTmp.clear();
}

let cleanupHooked = false;
function hookCleanup() {
  if (cleanupHooked) return;
  cleanupHooked = true;
  if (KEEP_TMP) {
    process.on("exit", () => {
      for (const dir of madeTmp) process.stderr.write(`kept test temp dir: ${dir}\n`);
    });
    return;
  }
  process.on("exit", removeTmpDirs);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    // remove, then end the way the signal would have (the listener is gone after once())
    process.once(sig, () => {
      removeTmpDirs();
      process.kill(process.pid, sig);
    });
  }
}

export function tmp(prefix = "hfs-test-") {
  hookCleanup();
  const dir = mkdtempSync(join(TMP_ROOT, prefix));
  madeTmp.add(dir);
  return dir;
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

/**
 * Fake chrome / ffmpeg / ffprobe on every OS (tests/fixtures/fake-spawn.cjs): `rules` are
 * {name, path, when?, log?, exit?, stderr?}. Returns the environment that loads the double into the
 * skill and every HyperFrames process it starts. A rule without `path` gets a placeholder file
 * (it exists, so the skill accepts the setting, and is never executed: the double runs instead).
 */
export function fakeTools(rules, dir = tmp("hfs-fake-")) {
  const done = rules.map((r) => {
    if (r.path) return r;
    const path = join(dir, r.name + (process.platform === "win32" ? ".exe" : ""));
    writeFileSync(path, "placeholder: tests/fixtures/fake-spawn.cjs runs instead\n");
    return { ...r, path };
  });
  const hook = join(FIXTURES, "fake-spawn.cjs");
  const nodeOptions = [process.env.NODE_OPTIONS, `--require ${JSON.stringify(hook)}`].filter(Boolean).join(" ");
  return { rules: done, env: { NODE_OPTIONS: nodeOptions, HYPERFRAMES_SKILL_TEST_FAKES: JSON.stringify(done) } };
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
