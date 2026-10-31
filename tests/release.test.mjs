// The release workflow: its version decision (.github/scripts/release.mjs) and the hardening rules
// of .github/workflows/*.yml that a typo would silently undo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bumpFiles, bumpVersion, changelogSection, latestTag, parseResolver, plan, resolveLevel } from "../.github/scripts/release.mjs";
import { ROOT, tmp } from "./helpers.mjs";

const read = (f) => readFileSync(join(ROOT, f), "utf8");
const resolver = parseResolver(read(".github/release-drafter.yml"));
const SCRIPT = join(ROOT, ".github", "scripts", "release.mjs");

test("release-drafter.yml version-resolver parses: labels decide the bump, default patch", () => {
  assert.deepEqual(resolver.major, ["major", "breaking"]);
  assert.deepEqual(resolver.minor, ["minor", "feature", "enhancement"]);
  assert.ok(resolver.patch.includes("fix") && resolver.patch.includes("documentation"));
  assert.equal(resolver.default, "patch");
  assert.equal(resolveLevel(["documentation", "feature"], resolver), "minor");
  assert.equal(resolveLevel(["fix", "major"], resolver), "major");
  assert.equal(resolveLevel(["chore"], resolver), "patch");
  assert.equal(resolveLevel([], resolver), "patch");
});

test("every label the autolabeler applies maps to a bump", () => {
  const applied = [...read(".github/release-drafter.yml").matchAll(/^ {2}- label: '([^']+)'/gm)].map((m) => m[1]);
  assert.ok(applied.length >= 5, applied.join());
  const mapped = new Set([...resolver.major, ...resolver.minor, ...resolver.patch]);
  for (const l of applied) assert.ok(mapped.has(l), `autolabeler label ${l} is not in version-resolver`);
  assert.ok(!applied.includes("major") && !applied.includes("breaking"), "major is applied by hand only");
});

test("semver bumps and newest tag by version order", () => {
  assert.equal(bumpVersion("0.6.0", "patch"), "0.6.1");
  assert.equal(bumpVersion("0.6.3", "minor"), "0.7.0");
  assert.equal(bumpVersion("0.6.3", "major"), "1.0.0");
  assert.equal(latestTag(["v0.9.0", "v0.10.0", "v0.2.1", "nightly", "v1.0.0-rc.1"]), "v0.10.0");
  assert.equal(latestTag([]), null);
});

test("first release: no tag yet, package.json's version is released unchanged (0.6.0, not a bump)", () => {
  const p = plan({ current: "0.6.0", tags: [], commitsSinceTag: null, labels: ["feature"], resolver });
  assert.deepEqual([p.mode, p.version, p.tag_needed], ["manual", "0.6.0", true]);
});

test("the version on main today is what the first release tags", () => {
  const current = JSON.parse(read("package.json")).version;
  const p = plan({ current, tags: [], commitsSinceTag: null, labels: [], resolver });
  assert.equal(p.version, current);
  assert.ok(changelogSection(read("CHANGELOG.md"), current), `CHANGELOG.md has a section for ${current} to be the release notes`);
  assert.doesNotMatch(read("CHANGELOG.md"), new RegExp(`^## ${current.replace(/\./g, "\\.")} \\(unreleased\\)`, "m"));
});

test("after a release: labels of PRs merged since the tag pick the bump; nothing new, nothing released", () => {
  const tags = ["v0.6.0"];
  assert.deepEqual(plan({ current: "0.6.0", tags, commitsSinceTag: 2, labels: ["fix"], resolver }).version, "0.6.1");
  assert.deepEqual(plan({ current: "0.6.0", tags, commitsSinceTag: 2, labels: ["fix", "feature"], resolver }).version, "0.7.0");
  const none = plan({ current: "0.6.0", tags, commitsSinceTag: 0, labels: [], resolver });
  assert.deepEqual([none.mode, none.tag_needed], ["none", false]);
});

test("a hand bump in a PR is released as written, and an already-tagged older version is not re-tagged", () => {
  const p = plan({ current: "1.0.0", tags: ["v0.6.0", "v0.6.1"], commitsSinceTag: 3, labels: ["fix"], resolver });
  assert.deepEqual([p.mode, p.version], ["manual", "1.0.0"]);
  const old = plan({ current: "0.6.0", tags: ["v0.6.0", "v0.6.1"], commitsSinceTag: 3, labels: [], resolver });
  assert.deepEqual([old.mode, old.tag_needed], ["none", false]);
});

test("bump writes every place the version is stated, and leaves the rest of the lockfile byte-identical", () => {
  const files = Object.fromEntries(["package.json", "package-lock.json", "docs/contract.md", "CHANGELOG.md"].map((f) => [f, read(f)]));
  // The repo's own CHANGELOG.md has an `## Unreleased` section whenever merged work awaits a
  // release (CONTRIBUTING.md asks every PR to add one); start from the released state so the
  // assertions below are about bumpFiles, not about what happens to be unreleased today.
  files["CHANGELOG.md"] = files["CHANGELOG.md"].replace(/^## Unreleased\s*\n[\s\S]*?(?=^## )/m, "");
  assert.doesNotMatch(files["CHANGELOG.md"], /^## Unreleased/m);
  // the repository's own version, whatever release it is at (it moves with every release), and the next patch
  const from = JSON.parse(files["package.json"]).version;
  const [maj, min, pat] = from.split(".").map(Number);
  const to = `${maj}.${min}.${pat + 1}`;
  // round trip: same version in, nothing changes
  assert.deepEqual(bumpFiles(files, from, from), {});
  const withUnreleased = { ...files, "CHANGELOG.md": files["CHANGELOG.md"].replace(`## ${from}\n`, `## Unreleased\n\n- something\n\n## ${from}\n`) };
  assert.match(withUnreleased["CHANGELOG.md"], /^## Unreleased$/m, "the CHANGELOG has a section for the current version");
  const out = bumpFiles(withUnreleased, from, to);
  assert.equal(JSON.parse(out["package.json"]).version, to);
  const lock = JSON.parse(out["package-lock.json"]);
  assert.equal(lock.version, to);
  assert.equal(lock.packages[""].version, to);
  const changed = out["package-lock.json"].split("\n").filter((l, i) => l !== files["package-lock.json"].split("\n")[i]);
  assert.deepEqual(changed, [`  "version": "${to}",`, `      "version": "${to}",`], "only the two root version lines change");
  assert.ok(out["docs/contract.md"].includes(`package.json version (\`${to}\`)`));
  assert.ok(!out["docs/contract.md"].includes(`"version": "${from}"`));
  assert.ok(out["CHANGELOG.md"].split("\n").includes(`## ${to}`));
  assert.equal(changelogSection(out["CHANGELOG.md"], to), "- something");
});

test("plan and notes against a throwaway git repository", () => {
  const dir = tmp("hfs-release-");
  const git = (...a) => {
    const r = spawnSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "" } });
  git("init", "-q");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.6.0" }, null, 2) + "\n");
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## 0.6.0\n\n### Added\n\n- the thing\n\n## 0.5.0\n\n- old\n");
  mkdirSync(join(dir, ".github"));
  writeFileSync(join(dir, ".github", "release-drafter.yml"), read(".github/release-drafter.yml"));
  git("add", "-A");
  git("commit", "-q", "-m", "feat: first");

  let r = run("plan");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^mode=manual$/m);
  assert.match(r.stdout, /^version=0\.6\.0$/m);
  assert.match(r.stdout, /^tag_needed=true$/m);

  r = run("notes", "0.6.0");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "### Added\n\n- the thing\n");

  git("tag", "-a", "v0.6.0", "-m", "v0.6.0");
  r = run("plan");
  assert.match(r.stdout, /^mode=none$/m);
  assert.match(r.stdout, /^tag_needed=false$/m);

  // no CHANGELOG section for the version: the commit subjects since the previous tag
  writeFileSync(join(dir, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "fix: second");
  r = run("notes", "0.6.1");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^- fix: second \([0-9a-f]+\)\n$/);

  assert.equal(run("bump", "not-a-version").status, 1);
  assert.equal(run("nonsense").status, 2);
});

// ---- workflow hardening ----

const WORKFLOWS = [".github/workflows/release.yml", ".github/workflows/autolabel.yml"];

test("release and autolabel pin every action to a full commit SHA", () => {
  for (const f of WORKFLOWS) {
    const uses = [...read(f).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
    assert.ok(uses.length > 0, f);
    for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${f}: ${u} is not pinned to a commit SHA`);
  }
});

test("release and autolabel never put ${{ }} inside a run: block", () => {
  for (const f of WORKFLOWS) {
    const lines = read(f).split("\n");
    let runIndent = -1;
    for (const [i, line] of lines.entries()) {
      const indent = line.search(/\S/);
      if (runIndent >= 0 && line.trim() && indent <= runIndent) runIndent = -1;
      const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
      if (m) {
        runIndent = m[1].length;
        assert.doesNotMatch(m[2], /\$\{\{/, `${f}:${i + 1}`);
        continue;
      }
      if (runIndent >= 0) assert.doesNotMatch(line, /\$\{\{/, `${f}:${i + 1}: ${line.trim()}`);
    }
  }
});

test("release: read-only by default, contents: write on the job only, push-to-main-in-this-repo guard", () => {
  const y = read(".github/workflows/release.yml").replace(/^\s*#.*$/gm, "");
  const top = y.slice(0, y.indexOf("\njobs:"));
  assert.match(top, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(top, /write/);
  assert.equal((y.match(/contents: write/g) || []).length, 1);
  assert.match(y, /^ {4}permissions:\n {6}contents: write/m);
  assert.match(y, /^ {2}workflow_run:\n {4}workflows: \["CI"\]/m);
  for (const cond of [
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_repository.full_name == github.repository",
    "github.event.workflow_run.head_branch == 'main'",
  ]) assert.ok(y.includes(cond), `release.yml job if: lacks ${cond}`);
  assert.match(y, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(read(".github/workflows/ci.yml"), /^name: CI$/m, "release.yml waits on the workflow named CI");
});

test("autolabel never checks out the PR's code", () => {
  const y = read(".github/workflows/autolabel.yml");
  assert.match(y, /pull_request_target/);
  assert.doesNotMatch(y, /actions\/checkout/);
  assert.doesNotMatch(y, /contents: write/);
});
