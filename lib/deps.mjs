// Locating (not probing) the external programs this skill runs. doctor probes what these find;
// the tools use the same resolution so doctor and a real run always talk about the same binary.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

/** The declared requirement list (README and contract restate this object). */
export const REQUIREMENTS = Object.freeze({
  node: PKG.engines.node,
  hyperframes: PKG.dependencies.hyperframes,
  chromium: "headless-capable Chrome/Chromium or chrome-headless-shell: bundled or system, detected",
  ffmpeg: ">=5.0",
  ffprobe: ">=5.0",
});

export const MIN_NODE_MAJOR = Number(/(\d+)/.exec(REQUIREMENTS.node)[1]);
export const MIN_FFMPEG_MAJOR = 5;

export function which(name) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** ffmpeg/ffprobe: HYPERFRAMES_SKILL_FFMPEG / HYPERFRAMES_SKILL_FFPROBE, else PATH. */
export function resolveFfTool(name) {
  const envName = `HYPERFRAMES_SKILL_${name.toUpperCase()}`;
  const fromEnv = process.env[envName];
  if (fromEnv) return { path: existsSync(fromEnv) ? fromEnv : null, source: `env:${envName}`, requested: fromEnv };
  const p = which(name);
  return { path: p, source: "PATH", requested: name };
}

/** The pinned hyperframes CLI, resolved from this package's own node_modules. */
export function resolveHyperframes() {
  try {
    const pkgPath = require.resolve("hyperframes/package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.hyperframes;
    const binPath = join(dirname(pkgPath), bin);
    return { path: existsSync(binPath) ? binPath : null, version: pkg.version, packageDir: dirname(pkgPath) };
  } catch {
    return { path: null, version: null, packageDir: null };
  }
}

function newestSubdir(dir) {
  try {
    return readdirSync(dir)
      .filter((d) => statSync(join(dir, d)).isDirectory())
      .sort()
      .reverse()
      .map((d) => join(dir, d));
  } catch {
    return [];
  }
}

function headlessShellIn(base) {
  // <cache>/chrome-headless-shell/<platform>-<version>/chrome-headless-shell-<platform>/chrome-headless-shell
  const out = [];
  for (const verDir of newestSubdir(base)) {
    for (const inner of newestSubdir(verDir)) {
      for (const exe of ["chrome-headless-shell", "chrome-headless-shell.exe"]) out.push(join(inner, exe));
    }
  }
  return out;
}

function playwrightCandidates() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(base).sort().reverse();
  } catch {
    return out;
  }
  for (const d of entries.filter((e) => e.startsWith("chromium_headless_shell-"))) {
    out.push(join(base, d, "chrome-linux", "headless_shell"), join(base, d, "chrome-mac", "headless_shell"));
  }
  for (const d of entries.filter((e) => /^chromium-\d+$/.test(e))) {
    out.push(
      join(base, d, "chrome-linux", "chrome"),
      join(base, d, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
    );
  }
  return out;
}

/**
 * Every Chromium candidate in precedence order, with where it came from. The first existing
 * one is what render uses. `bundled` is the browser `hyperframes browser ensure` downloads.
 */
export function chromiumCandidates() {
  const c = [];
  if (process.env.HYPERFRAMES_BROWSER_PATH) c.push({ path: process.env.HYPERFRAMES_BROWSER_PATH, source: "env:HYPERFRAMES_BROWSER_PATH" });
  for (const p of headlessShellIn(join(homedir(), ".cache", "hyperframes", "chrome", "chrome-headless-shell"))) c.push({ path: p, source: "bundled" });
  for (const p of headlessShellIn(join(homedir(), ".cache", "puppeteer", "chrome-headless-shell"))) c.push({ path: p, source: "puppeteer-cache" });
  for (const p of playwrightCandidates()) c.push({ path: p, source: "playwright" });
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"]) {
    const p = which(name);
    if (p) c.push({ path: p, source: "system" });
  }
  if (process.platform === "darwin") {
    for (const p of [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]) c.push({ path: p, source: "system" });
  }
  return c;
}

/** The candidate a render would use: the first that exists. An explicit env path that does not exist is not skipped. */
export function resolveChromium() {
  const all = chromiumCandidates();
  for (const cand of all) {
    if (cand.source.startsWith("env:")) return { ...cand, exists: existsSync(cand.path), candidates: all };
    if (existsSync(cand.path)) return { ...cand, exists: true, candidates: all };
  }
  return { path: null, source: null, exists: false, candidates: all };
}

export function parseFfVersion(text) {
  const m = /version\s+n?(\d+)\.(\d+)/i.exec(text) || /version\s+n?(\d+)/i.exec(text);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), raw: text.split(/\r?\n/)[0].trim() };
}
