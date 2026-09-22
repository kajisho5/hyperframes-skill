#!/usr/bin/env node
// Before/after demos: each demos/<name>/request.json (before) goes through
// scene -> preview -> render -> probe, and a contact sheet of the render (after) is written to
// demos/out/<name>/. Any step that does not end completed + verified fails the run, so a broken
// flag fails CI instead of the reader.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, "demos", "out");

function step(tool, args) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", `${tool}.mjs`), ...args, "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let doc = null;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    /* reported below */
  }
  const ok = r.status === 0 && doc?.status === "completed" && (tool === "probe" || doc.verified === true);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${tool} ${ok ? "" : `(exit ${r.status}: ${doc?.error?.message ?? r.stderr.trim().split("\n").pop()})`}`);
  if (!ok) process.exitCode = 1;
  return ok ? doc : null;
}

// A demo is demos/<name>/request.json (a hand-written request) or demos/<name>/template.json
// ({template, values}: the request is made by the template tool first).
const hasInput = (name) => ["request.json", "template.json"].some((f) => existsSync(join(ROOT, "demos", name, f)));
const demos = readdirSync(join(ROOT, "demos"), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "out" && hasInput(d.name));
for (const d of demos) {
  const out = join(OUT, d.name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  console.log(d.name);
  let request = join(ROOT, "demos", d.name, "request.json");
  const tpl = join(ROOT, "demos", d.name, "template.json");
  if (existsSync(tpl)) {
    const { template, values } = JSON.parse(readFileSync(tpl, "utf8"));
    writeFileSync(join(out, "values.json"), JSON.stringify(values));
    request = join(out, "request.json");
    if (!step("template", [template, "--values", join(out, "values.json"), "-o", request])) continue;
  }
  if (!step("scene", [request, "-o", join(out, "scene")])) continue;
  if (!step("preview", [join(out, "scene"), "-o", join(out, "preview.mp4")])) continue;
  const r = step("render", [join(out, "scene"), "-o", join(out, "render.mp4")]);
  if (!r) continue;
  const p = step("probe", [join(out, "render.mp4")]);
  if (!p) continue;
  const v = p.probe.video;
  console.log(`  ${d.name}/render.mp4: ${p.probe.duration.toFixed(3)} s, ${v.width}x${v.height}, ${v.fps} fps, ${v.frames} frames, ${v.codec}`);
  // after: one frame per half second, tiled
  const n = Math.max(1, Math.round(p.probe.duration * 2));
  const sheet = spawnSync(process.env.HYPERFRAMES_SKILL_FFMPEG || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", join(out, "render.mp4"), "-vf", `fps=2,scale=320:-2,tile=${n}x1`, "-frames:v", "1", join(out, "sheet.png")]);
  console.log(sheet.status === 0 ? `  sheet: ${join(out, "sheet.png")}` : "  sheet: not written (ffmpeg failed)");
}
