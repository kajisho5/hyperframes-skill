// The tests' temporary directories are removed when a test file's process ends (design-decisions D16).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./helpers.mjs";

const HELPERS = pathToFileURL(join(ROOT, "tests", "helpers.mjs")).href;

/** A fresh, empty root for one check, made and removed here (not through tmp(), which is under test). */
function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "hfs-tmpcheck-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function child(root, body, extraEnv = {}) {
  const code = `import { tmp } from ${JSON.stringify(HELPERS)};\nimport { writeFileSync } from "node:fs";\n${body}`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { ...process.env, HYPERFRAMES_SKILL_TEST_TMPDIR: root, ...extraEnv },
  });
}

test("tmp(): every directory is removed when the process exits normally", () => {
  withRoot((root) => {
    const r = child(root, `for (const p of ["hfs-a-", "hfs-b-", "hfs-c-"]) writeFileSync(tmp(p) + "/f.bin", "x");`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(root), []);
  });
});

test("tmp(): removed after an uncaught error too", () => {
  withRoot((root) => {
    const r = child(root, `writeFileSync(tmp() + "/f", "x"); throw new Error("boom");`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /boom/);
    assert.deepEqual(readdirSync(root), []);
  });
});

test("tmp(): removed on SIGTERM, and the process still ends by that signal", { skip: process.platform === "win32" ? "Windows delivers no SIGTERM to a handler" : false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hfs-tmpcheck-"));
  try {
    const code = `import { tmp } from ${JSON.stringify(HELPERS)};\nconst d = tmp(); console.log(d); setInterval(() => {}, 1000);`;
    const c = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, HYPERFRAMES_SKILL_TEST_TMPDIR: root } });
    const dir = await new Promise((resolve) => c.stdout.once("data", (b) => resolve(String(b).trim())));
    assert.ok(existsSync(dir));
    const ended = new Promise((resolve) => c.on("exit", (status, signal) => resolve({ status, signal })));
    c.kill("SIGTERM");
    assert.deepEqual(await ended, { status: null, signal: "SIGTERM" });
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HYPERFRAMES_SKILL_KEEP_TEST_TMP=1 keeps them and prints where", () => {
  withRoot((root) => {
    const r = child(root, `writeFileSync(tmp("hfs-kept-") + "/f", "x");`, { HYPERFRAMES_SKILL_KEEP_TEST_TMP: "1" });
    assert.equal(r.status, 0, r.stderr);
    const left = readdirSync(root);
    assert.equal(left.length, 1);
    assert.match(left[0], /^hfs-kept-/);
    assert.ok(r.stderr.includes(join(root, left[0])));
    assert.equal(readFileSync(join(root, left[0], "f"), "utf8"), "x");
  });
});

test("whole test files leave nothing behind (kit, dryrun, ffmpeg-skill)", () => {
  withRoot((root) => {
    const files = ["kit", "dryrun", "ffmpeg-skill"].map((n) => join(ROOT, "tests", `${n}.test.mjs`));
    // NODE_TEST_CONTEXT would make the nested runner report to this one instead of running on its own
    const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", ...files], {
      encoding: "utf8",
      env: { ...env, HYPERFRAMES_SKILL_TEST_TMPDIR: root, HYPERFRAMES_SKILL_SKIP_RENDER_TESTS: "1", HYPERFRAMES_SKILL_KEEP_TEST_TMP: "" },
      timeout: 300000,
    });
    assert.equal(r.status, 0, r.stdout.slice(-4000) + r.stderr.slice(-2000));
    const passed = Number(/^# pass (\d+)$/m.exec(r.stdout)?.[1] ?? 0);
    assert.ok(passed >= 20, `expected the three files' tests to run, got ${passed} passing`);
    assert.deepEqual(readdirSync(root), []);
  });
});

test("test files make temporary directories only through tmp()", () => {
  for (const f of readdirSync(join(ROOT, "tests")).filter((n) => n.endsWith(".test.mjs") && n !== "tmp-dirs.test.mjs")) {
    const src = readFileSync(join(ROOT, "tests", f), "utf8");
    assert.doesNotMatch(src, /mkdtemp|os\.tmpdir|tmpdir\(\)/, `${f}: use tmp() from tests/helpers.mjs`);
  }
});
