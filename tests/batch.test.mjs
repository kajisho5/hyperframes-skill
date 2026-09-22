// batch: rows files, validation of every row before any render, per-row results that don't lie.
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadRows, parseCsv, slug } from "../lib/rows.mjs";
import { SKIP_RENDER, tmp, tool, writeExe, writeJson } from "./helpers.mjs";

test("CSV: RFC 4180 quoting, CRLF, embedded newlines and commas", () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",\n'), [
    ["a", "b"],
    ["x, y", 'say "hi"'],
    ["two\nlines", ""],
  ]);
  assert.throws(() => parseCsv('a\n"open'), (e) => e.kind === "input" && /not closed/.test(e.message));
  assert.throws(() => parseCsv('a\nx"y'), (e) => e.kind === "input" && /quote inside an unquoted field/.test(e.message));
});

test("rows: a UTF-8 BOM is dropped, an empty cell means 'not given', JSON keeps types", () => {
  const dir = tmp();
  const csv = join(dir, "r.csv");
  writeFileSync(csv, "﻿name,affiliation\n佐藤 花子,\n");
  const { columns, rows } = loadRows(csv);
  assert.deepEqual(columns, ["name", "affiliation"]);
  assert.deepEqual(rows, [{ index: 1, values: { name: "佐藤 花子" } }]);
  const json = writeJson(join(dir, "r.json"), [{ name: "A", duration: 3 }]);
  assert.deepEqual(loadRows(json).rows[0].values, { name: "A", duration: 3 });
  writeFileSync(join(dir, "bad.csv"), "a,b\n1\n");
  assert.throws(() => loadRows(join(dir, "bad.csv")), (e) => e.kind === "input" && /1 cells, the header has 2/.test(e.message));
});

test("rows: Shift_JIS is refused as UTF-8 with a hint, and read with --encoding shift_jis", () => {
  const dir = tmp();
  const f = join(dir, "sjis.csv");
  writeFileSync(f, Buffer.concat([Buffer.from("name\r\n"), Buffer.from([0x8d, 0xb2, 0x93, 0xa1]), Buffer.from("\r\n")]));
  assert.throws(() => loadRows(f), (e) => e.kind === "input" && /shift_jis/.test(e.hint));
  assert.deepEqual(loadRows(f, { encoding: "shift_jis" }).rows[0].values, { name: "佐藤" });
});

test("file names: letters and digits of any script survive, everything else becomes '-'", () => {
  assert.equal(slug("佐藤 花子 (Hanako)"), "佐藤-花子-Hanako");
  assert.equal(slug("../../etc/passwd"), "etc-passwd");
  assert.equal(slug("  "), "");
});

test("every row is validated before anything is rendered or written", () => {
  const dir = tmp();
  const csv = join(dir, "rows.csv");
  writeFileSync(csv, "message,duration,colour\nBreak,5,x\n,0.5,\nLunch,5,\n");
  const out = join(dir, "out");
  const r = tool("batch", [csv, "--template", "break", "-o", out, "--json"]);
  assert.equal(r.code, 1);
  assert.equal(r.doc.error.kind, "input");
  const p = r.doc.details.problems;
  assert.ok(p.some((m) => m.startsWith('row 1: unknown value "colour"')), p.join(" / "));
  assert.ok(p.some((m) => m.startsWith("row 2: message is required")));
  assert.ok(p.some((m) => m.startsWith("row 2: duration must be >= 1")));
  assert.ok(!existsSync(out), "nothing written");
});

test("--dry-run reports every planned output and writes nothing", () => {
  const dir = tmp();
  const csv = join(dir, "rows.csv");
  writeFileSync(csv, "name,affiliation\n佐藤 花子,Imaging Center\nJohn Smith,\n");
  const r = tool("batch", [csv, "--template", "lower-third", "--name-field", "name", "--codec", "prores", "-o", join(dir, "out"), "--dry-run", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.doc.rows.map((x) => [x.name, x.status, x.expected.frames]), [["001-佐藤-花子", "planned", 240], ["002-John-Smith", "planned", 240]]);
  assert.ok(r.doc.rows[0].output.endsWith("001-佐藤-花子.mov"));
  assert.deepEqual(r.doc.commands, []);
  assert.equal(r.doc.verified, false);
  assert.deepEqual(readdirSync(dir), ["rows.csv"]);
  const dup = tool("batch", [csv, "--template", "lower-third", "--name-field", "affiliation", "-o", join(dir, "out"), "--dry-run", "--json"]);
  assert.equal(dup.code, 0, "an empty name cell falls back to the row number");
  assert.deepEqual(dup.doc.rows.map((x) => x.name), ["001-Imaging-Center", "002"]);
});

test("batch renders one verified file per row and refuses to overwrite them", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const rows = writeJson(join(dir, "rows.json"), [{ message: "Coffee Break", duration: 1 }, { message: "Lunch", resume: "Back at 13:00", duration: 1 }]);
  const out = join(dir, "out");
  const r = tool("batch", [rows, "--template", "break", "--name-field", "message", "-o", out, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.doc.status, "completed");
  assert.equal(r.doc.verified, true);
  assert.deepEqual(r.doc.summary, { total: 2, completed: 2, failed: 0, skipped: 0 });
  assert.deepEqual(r.doc.rows.map((x) => [x.name, x.status, x.verified]), [["001-Coffee-Break", "completed", true], ["002-Lunch", "completed", true]]);
  for (const x of r.doc.rows) assert.ok(x.verification.find((s) => s.step === "frames").ok);
  assert.deepEqual(readdirSync(out).sort(), ["001-Coffee-Break.mp4", "002-Lunch.mp4", "scenes"]);
  const again = tool("batch", [rows, "--template", "break", "--name-field", "message", "-o", out, "--json"]);
  assert.equal(again.code, 1);
  assert.equal(again.doc.error.kind, "input");
  assert.match(again.doc.error.message, /output exists/);
  const over = tool("batch", [rows, "--template", "break", "--name-field", "message", "-o", out, "--overwrite", "--json"]);
  assert.equal(over.code, 0, over.stderr);
});

test("a failing row is reported as failed, the batch as failed, and --fail-fast skips the rest", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const rows = writeJson(join(dir, "rows.json"), [{ message: "A", duration: 1 }, { message: "B", duration: 1 }]);
  const chrome = writeExe(join(dir, "chrome"), "#!/bin/sh\nexit 1\n");
  const r = tool("batch", [rows, "--template", "break", "-o", join(dir, "out"), "--fail-fast", "--json"], { env: { HYPERFRAMES_BROWSER_PATH: chrome } });
  assert.equal(r.code, 1);
  assert.equal(r.doc.status, "failed");
  assert.equal(r.doc.error.kind, "render");
  assert.equal(r.doc.verified, false);
  assert.deepEqual(r.doc.summary, { total: 2, completed: 0, failed: 1, skipped: 1 });
  assert.deepEqual(r.doc.rows.map((x) => x.status), ["failed", "skipped"]);
  const all = tool("batch", [rows, "--template", "break", "-o", join(dir, "out2"), "--json"], { env: { HYPERFRAMES_BROWSER_PATH: chrome } });
  assert.deepEqual(all.doc.summary, { total: 2, completed: 0, failed: 2, skipped: 0 }, "without --fail-fast every row is attempted");
});
