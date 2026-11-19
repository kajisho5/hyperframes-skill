#!/usr/bin/env node
// Release helper for .github/workflows/release.yml. Node standard library only, like the rest of
// the repo's scripts. Every value it prints comes from package.json, git, semver arithmetic or the
// labels on merged PRs mapped through .github/release-drafter.yml's `version-resolver`; no PR title
// or body is ever turned into a version or spliced into a shell command.
//
//   node .github/scripts/release.mjs plan          decide what this push releases (key=value lines,
//                                                  also appended to $GITHUB_OUTPUT when set)
//   node .github/scripts/release.mjs bump X.Y.Z    write X.Y.Z to every place the version is stated
//   node .github/scripts/release.mjs notes X.Y.Z   print the release notes for X.Y.Z
//
// The rule (docs/design-decisions.md, D1):
//   - package.json's version is not tagged yet (first release, or bumped by hand in a PR):
//     release it unchanged ("manual"). This is how the first release comes out as 0.6.0.
//   - package.json's version equals the newest vX.Y.Z tag and commits landed since: the labels on
//     the PRs merged since that tag decide the bump ("auto"); the release commit writes it back.
//   - otherwise nothing is released ("none").
//   - in auto mode, also "none" when every PR merged since the tag is labelled only chore / ci /
//     documentation / docs / test or similar (Velisa ADR-023, imagemagick-skill's rule; D17). A PR with
//     a release-level label, or with no label at all, releases. release-drafter's `default` accepts
//     only major / minor / patch, so it cannot say "no release" itself.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(v) {
  const m = SEMVER.exec(String(v ?? "").trim());
  if (!m) throw new Error(`not a X.Y.Z version: ${JSON.stringify(v)}`);
  return m.slice(1, 4).map(Number);
}

export function bumpVersion(v, level) {
  const [ma, mi, pa] = parseVersion(v);
  if (level === "major") return `${ma + 1}.0.0`;
  if (level === "minor") return `${ma}.${mi + 1}.0`;
  if (level === "patch") return `${ma}.${mi}.${pa + 1}`;
  throw new Error(`unknown bump level: ${level}`);
}

/** Newest vX.Y.Z tag by version order (not date), or null. */
export function latestTag(tags) {
  let best = null;
  for (const t of tags) {
    if (!/^v\d+\.\d+\.\d+$/.test(t)) continue;
    if (!best || compareVersions(t.slice(1), best.slice(1)) > 0) best = t;
  }
  return best;
}

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * The `version-resolver` block of .github/release-drafter.yml: {major: [...], minor: [...],
 * patch: [...], default}. The file keeps each label list inline (`labels: ['a', 'b']`), which is
 * all this reads; tests/release.test.mjs fails if the block stops parsing.
 */
export function parseResolver(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const start = lines.findIndex((l) => /^version-resolver:\s*$/.test(l));
  if (start < 0) throw new Error("release-drafter.yml has no version-resolver block");
  const out = { major: [], minor: [], patch: [], default: null };
  let level = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const lv = /^ {2}(major|minor|patch):\s*$/.exec(line);
    if (lv) { level = lv[1]; continue; }
    const def = /^ {2}default:\s*(major|minor|patch)\s*$/.exec(line);
    if (def) { out.default = def[1]; level = null; continue; }
    const labels = /^ {4}labels:\s*\[(.*)\]\s*$/.exec(line);
    if (labels && level) out[level] = labels[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  }
  if (!out.default) throw new Error("release-drafter.yml version-resolver has no default");
  return out;
}

/** Labels that make a merged PR worth a release (every label `version-resolver` maps). */
export function releaseLabels(resolver) {
  return new Set([...resolver.major, ...resolver.minor, ...resolver.patch]);
}

/** One merged PR is worth a release: a release-level label, or no label at all (D17). */
export function pullReleases(labels, resolver) {
  if (labels.length === 0) return true;
  const rel = releaseLabels(resolver);
  return labels.some((l) => rel.has(l));
}

/** The bump for a set of PR labels: the highest level any label maps to, else the default. */
export function resolveLevel(labels, resolver) {
  const set = new Set(labels);
  for (const level of ["major", "minor", "patch"]) if (resolver[level].some((l) => set.has(l))) return level;
  return resolver.default;
}

/**
 * Pure decision. current: package.json version; tags: every tag name; commitsSinceTag: commits
 * between the newest tag and HEAD (0 when HEAD is the tagged commit); labels: labels of the PRs
 * merged since that tag (only read in auto mode); pulls: the same, one label list per merged PR
 * (when given, auto mode releases only if one of them is worth a release, D17).
 */
export function plan({ current, tags, commitsSinceTag, labels, resolver, pulls }) {
  parseVersion(current);
  const latest = latestTag(tags);
  const tagSet = new Set(tags);
  if (latest === null || latest.slice(1) !== current) {
    if (tagSet.has(`v${current}`)) return { mode: "none", version: current, latest_tag: latest ?? "", tag_needed: false, reason: `v${current} is already tagged` };
    return { mode: "manual", version: current, latest_tag: latest ?? "", tag_needed: true, reason: `package.json says ${current}, not tagged yet` };
  }
  if (commitsSinceTag === 0) return { mode: "none", version: current, latest_tag: latest, tag_needed: false, reason: `nothing landed since ${latest}` };
  if (pulls && !pulls.some((p) => pullReleases(p, resolver))) return { mode: "none", version: current, latest_tag: latest, tag_needed: false, reason: `only chore/ci/docs/test PRs merged since ${latest}` };
  const level = resolveLevel(labels, resolver);
  return { mode: "auto", version: bumpVersion(current, level), latest_tag: latest, tag_needed: true, level, reason: `${level} bump from the labels of PRs merged since ${latest}` };
}

/** CHANGELOG.md section for a version: `## X.Y.Z` (any suffix), else `## Unreleased`, else null. */
export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const find = (re) => lines.findIndex((l) => re.test(l));
  const esc = version.replace(/\./g, "\\.");
  let i = find(new RegExp(`^## v?${esc}(\\s|$)`));
  if (i < 0) i = find(/^## Unreleased\s*$/i);
  if (i < 0) return null;
  let j = i + 1;
  while (j < lines.length && !/^## /.test(lines[j])) j++;
  const body = lines.slice(i + 1, j).join("\n").trim();
  return body || null;
}

/**
 * Every place the release version is written. Returns {path: newText} for files that change.
 * CHANGELOG.md: `## Unreleased` becomes `## <to>`; without one (a PR that wrote no CHANGELOG entry),
 * a `## <to>` section with `notes` (the commit subjects since the previous tag) goes above the
 * newest section, so the release always has a section in this file's `## X.Y.Z` form.
 */
export function bumpFiles(files, from, to, notes = "") {
  const out = {};
  const pkg = JSON.parse(files["package.json"]);
  pkg.version = to;
  out["package.json"] = JSON.stringify(pkg, null, 2) + "\n";
  if (files["package-lock.json"] !== undefined) {
    const lock = JSON.parse(files["package-lock.json"]);
    lock.version = to;
    if (lock.packages && lock.packages[""]) lock.packages[""].version = to;
    out["package-lock.json"] = JSON.stringify(lock, null, 2) + "\n";
  }
  if (files["docs/contract.md"] !== undefined) {
    out["docs/contract.md"] = files["docs/contract.md"]
      .split(`package.json version (\`${from}\`)`).join(`package.json version (\`${to}\`)`)
      .split(`"version": "${from}"`).join(`"version": "${to}"`);
  }
  if (files["CHANGELOG.md"] !== undefined) {
    const text = files["CHANGELOG.md"];
    if (/^## Unreleased\s*$/im.test(text)) {
      out["CHANGELOG.md"] = text.replace(/^## Unreleased\s*$/im, `## ${to}`);
    } else if (from !== to && !changelogSection(text, to)) {
      const section = `## ${to}\n\n${notes.trim() || "_No changes recorded._"}\n\n`;
      const i = text.search(/^## /m);
      out["CHANGELOG.md"] = i < 0 ? `${text.replace(/\s*$/, "")}\n\n${section}` : text.slice(0, i) + section + text.slice(i);
    }
  }
  for (const k of Object.keys(out)) if (out[k] === files[k]) delete out[k];
  return out;
}

// ---- I/O glue (only what the workflow runs) ----

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** One label list per PR merged since `tag` (each PR once). */
function prLabelsSince(tag) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is required to read PR labels");
  const shas = git(["rev-list", `${tag}..HEAD`]).split("\n").filter(Boolean);
  const pulls = new Map();
  for (const sha of shas) {
    const json = execFileSync("gh", ["api", `repos/${repo}/commits/${sha}/pulls`], { encoding: "utf8" });
    for (const pr of JSON.parse(json)) {
      if (!pr.merged_at) continue;
      pulls.set(pr.number, (pr.labels || []).map((l) => l.name));
    }
  }
  return [...pulls.values()];
}

/** The release notes of a section that no PR wrote: commit subjects since the previous tag. */
function subjectsSince(tag) {
  return git(["log", "--no-merges", "--pretty=format:- %s (%h)", tag ? `${tag}..HEAD` : "HEAD"]);
}

const VERSION_FILES = ["package.json", "package-lock.json", "docs/contract.md", "CHANGELOG.md"];

function main(argv) {
  const [cmd, arg] = argv;
  if (cmd === "plan") {
    const current = JSON.parse(readFileSync("package.json", "utf8")).version;
    const tags = git(["tag", "--list"]).split("\n").filter(Boolean);
    const latest = latestTag(tags);
    const commitsSinceTag = latest ? Number(git(["rev-list", "--count", `${latest}..HEAD`])) : null;
    const resolver = parseResolver(readFileSync(".github/release-drafter.yml", "utf8"));
    const needLabels = latest && latest.slice(1) === current && commitsSinceTag > 0;
    const pulls = needLabels ? prLabelsSince(latest) : undefined;
    const p = plan({ current, tags, commitsSinceTag, labels: pulls ? pulls.flat() : [], resolver, pulls });
    const text = Object.entries(p).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
    process.stdout.write(text);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
    return 0;
  }
  if (cmd === "bump") {
    parseVersion(arg);
    const files = {};
    for (const f of VERSION_FILES) { try { files[f] = readFileSync(f, "utf8"); } catch { /* optional */ } }
    const from = JSON.parse(files["package.json"]).version;
    const tags = git(["tag", "--list"]).split("\n").filter(Boolean);
    for (const [f, t] of Object.entries(bumpFiles(files, from, arg, subjectsSince(latestTag(tags))))) writeFileSync(f, t);
    return 0;
  }
  if (cmd === "notes") {
    parseVersion(arg);
    const section = changelogSection(readFileSync("CHANGELOG.md", "utf8"), arg);
    if (section) { process.stdout.write(section + "\n"); return 0; }
    const tags = git(["tag", "--list"]).split("\n").filter(Boolean).filter((t) => t !== `v${arg}`);
    const prev = latestTag(tags);
    const log = git(["log", "--no-merges", "--pretty=format:- %s (%h)", prev ? `${prev}..HEAD` : "HEAD"]);
    process.stdout.write((log || "_No changes recorded._") + "\n");
    return 0;
  }
  process.stderr.write("usage: release.mjs plan | bump X.Y.Z | notes X.Y.Z\n");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`release.mjs: ${e.message}\n`); process.exitCode = 1; }
}
