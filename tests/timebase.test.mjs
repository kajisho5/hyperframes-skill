// The ecosystem timebase spec's conformance vectors (velisa/timebase@1) against lib/timebase.mjs (D18).
// tests/fixtures/timebase/timebase-vectors.json is a byte-for-byte copy of Velisa's docs/specs/timebase-vectors.json;
// manifest.json records the Velisa commit and the sha256. This skill offers parse_rate, rate_str, same_rate,
// parse_seconds, frames_at (nearest and down) and seconds_of; every vector of those must pass. The others (timecode,
// formatting, seeks, transitions, joins, nominal) and the optional p / i suffix are counted as not offered.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { framesAt, parseRate, parseSeconds, rateStr, sameRate, secondsOf, TimebaseError } from "../lib/timebase.mjs";
import { FIXTURES } from "./helpers.mjs";

const DIR = join(FIXTURES, "timebase");
const raw = readFileSync(join(DIR, "timebase-vectors.json"));
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8"));
const doc = JSON.parse(raw.toString("utf8"));
const OFFERED = 61;

const fracText = ([n, d]) => (d === 1n ? String(n) : `${n}/${d}`);
const FUNCTIONS = {
  parse_rate: ({ value }) => rateStr(parseRate(value)),
  rate_str: ({ rate }) => rateStr(rate),
  same_rate: ({ a, b }) => sameRate(a, b),
  parse_seconds: ({ value }) => fracText(parseSeconds(value)),
  frames_at: ({ seconds, rate, mode }) => framesAt(seconds, rate, mode),
  seconds_of: ({ frames, rate }) => secondsOf(frames, rate),
};
const offered = (v) => Object.hasOwn(FUNCTIONS, v.fn) && !v.optional;

test("the vectors are Velisa's file at the recorded commit", () => {
  assert.equal(doc.spec, "velisa/timebase@1");
  assert.equal(manifest.source.repository, "kajisho5/Velisa");
  assert.match(manifest.source.commit, /^[0-9a-f]{40}$/);
  assert.equal(createHash("sha256").update(raw).digest("hex"), manifest.sha256);
});

test("every offered conformance vector passes", () => {
  const vecs = doc.vectors.filter(offered);
  for (const v of vecs) {
    let got;
    try {
      got = FUNCTIONS[v.fn](v.args);
    } catch (e) {
      assert.ok(e instanceof TimebaseError, `${v.id}: ${e}`);
      assert.equal(e.code, v.error, `${v.id}: ${e.message}`);
      continue;
    }
    assert.ok(!("error" in v), `${v.id}: gave ${JSON.stringify(got)}, expected ${v.error}`);
    assert.deepEqual(got, v.expect, v.id);
  }
  assert.equal(vecs.length, OFFERED);
  assert.equal(doc.vectors.length - vecs.length, 73);
});

test("NTSC rates are exact: frame counts multiply by 30000/1001, not by 29.97", () => {
  assert.deepEqual(parseRate(29.97), { num: 30000, den: 1001 });
  assert.deepEqual(parseRate("59.94"), { num: 60000, den: 1001 });
  assert.equal(framesAt("1.001", "30000/1001"), 30);
  assert.equal(framesAt(10, "24000/1001"), 240); // 239.76
  // 417 s: 12497.49 frames at 2997/100 (a rounded 29.97), 12497.50 at the exact rate
  assert.equal(framesAt(417, "30000/1001"), 12498);
  assert.equal(framesAt(417, "2997/100"), 12497);
  assert.equal(framesAt(0.35, 30), 11); // a half up, as Math.round
});

test("the rendered frame count is HyperFrames' rule: nearest within 1/1000 of a frame, else every started frame", async () => {
  const { renderedFrames } = await import("../lib/timebase.mjs");
  assert.equal(renderedFrames(30, "30000/1001"), 900); // 899.1 frames: HyperFrames renders 900
  assert.equal(renderedFrames(1, "30000/1001"), 30); // 29.97
  assert.equal(renderedFrames("1.001", "30000/1001"), 30); // exactly 30
  assert.equal(renderedFrames(1, 30), 30);
  assert.equal(renderedFrames(1.01, 30), 31); // 30.3: the started frame is rendered
  assert.equal(renderedFrames(0.0333, 30), 1); // 0.999, within 1/1000 of a frame of 1
  assert.throws(() => parseRate("30499999999999999/1000000000000000"), /too large to keep exact/);
});
