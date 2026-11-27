// Generative layers (roadmap step 10, docs/design-decisions.md D23): bundled three.js programs and a
// user's fragment shader, driven frame by frame by HyperFrames' hf-seek event, on SwiftShader.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readShader } from "../lib/generative.mjs";
import { renderHtml, validateRequest } from "../lib/scene-spec.mjs";
import { ffmpeg, FIXTURES, SKIP_RENDER, tmp, tool, writeJson } from "./helpers.mjs";

const FIXTURE = join(FIXTURES, "generative-particles.json");
const SHADER = join(FIXTURES, "shaders", "rings.frag");
const FONT = join(FIXTURES, "fonts", "hfs-test-blocks.ttf");
const base = () => JSON.parse(readFileSync(FIXTURE, "utf8"));
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

function problems(req, dir = FIXTURES) {
  try {
    validateRequest(req, dir);
    return [];
  } catch (e) {
    assert.equal(e.kind, "input", e.message);
    return e.details.problems;
  }
}
const withLayer = (extra) => {
  const req = base();
  Object.assign(req.layers[0], extra);
  return req;
};

test("generative layers are typed: program, seed, palette and the program's params", () => {
  assert.deepEqual(problems(base()), []);
  assert.ok(problems(withLayer({ program: "fire" })).some((m) => m.includes(".program must be one of particles, noise_field, shader_gradient, type3d, shader")));
  assert.ok(problems(withLayer({ seed: -1 })).some((m) => m.includes(".seed must be an integer")));
  assert.ok(problems(withLayer({ params: { count: 0 } })).some((m) => m.includes("params.count must be an integer 1..20000")));
  assert.ok(problems(withLayer({ params: { glsl: "x" } })).some((m) => m.includes('unknown key "glsl" for particles')));
  assert.ok(problems(withLayer({ program: "noise_field", palette: ["#000000"], params: {} })).some((m) => m.includes("a noise_field program needs at least 2 colour(s)")));
  assert.ok(problems(withLayer({ program: "type3d", params: {}, text: "Hi", font: "Nope" })).some((m) => m.includes('.font "Nope" is not a family shipped in fonts[]')));
  assert.ok(problems(withLayer({ text: "Hi" })).some((m) => m.includes(".text is for the type3d program")));
  assert.ok(problems(withLayer({ src: "x.frag" })).some((m) => m.includes(".src is for the shader program")));
});

test("a user's shader is a local GLSL file with no script, network or DOM words in it", () => {
  const dir = tmp();
  const put = (name, text) => {
    writeFileSync(join(dir, name), text);
    return readShader(name, dir);
  };
  assert.ok(readShader(SHADER, FIXTURES).source.includes("void main"));
  assert.match(readShader("https://example.com/a.frag", dir).error, /not a URL/);
  assert.match(readShader("a.js", dir).error, /must end in \.frag, \.glsl, \.fs/);
  assert.match(put("inc.frag", "#include <x>\nvoid main(){gl_FragColor=vec4(1);}").error, /#include/);
  assert.match(put("net.frag", "void main(){ /* fine */ float fetch = 1.0; gl_FragColor=vec4(fetch);}").error, /contains "fetch"/);
  assert.match(put("dom.glsl", "void main(){ gl_FragColor = vec4(1); } // document is in a comment only").error ?? "ok", /ok/);
  assert.match(put("nomain.frag", "precision highp float;").error, /no void main/);
  assert.match(put("nocolour.frag", "void main(){ float x = 1.0; }").error, /writes no colour/);
  // it reaches the page as a JSON string: </script> cannot close the tag
  const req = withLayer({ program: "shader", src: SHADER, palette: [], params: {} });
  const html = renderHtml(validateRequest(req, FIXTURES));
  assert.ok(html.includes('"program":"shader"') && html.includes("void main"));
});

test("markup: a canvas per layer, its config as inline JSON, and the runtime module only when needed", () => {
  const req = base();
  req.duration = 2;
  req.layers[0].start = 0.5;
  req.layers[0].time_start = 3;
  const html = renderHtml(validateRequest(req, FIXTURES));
  assert.ok(html.includes('<div id="p" class="clip" data-start="0.5" data-duration="1" data-track-index="0"><canvas id="p-cv" width="320" height="180" style="display:block;width:100%;height:100%"></canvas></div>'));
  const cfg = JSON.parse(/<script type="application\/json" class="hfs-gen" id="hfs-gen-p">(.*)<\/script>/.exec(html)[1]);
  // program time = composition time + offset: 3 s at the layer's first frame (0.5 s)
  assert.deepEqual([cfg.program, cfg.seed, cfg.offset, cfg.params.count], ["particles", 11, 2.5, 600]);
  assert.ok(html.includes('<script type="module" src="assets/hfs-generative.js"></script>'));
  assert.ok(html.includes("window.__hf.buildReady.hfsGenerative=d.p"));
  const plain = renderHtml(validateRequest(JSON.parse(readFileSync(join(FIXTURES, "two-line.json"), "utf8")), FIXTURES));
  assert.ok(!plain.includes("<script"), "no script in a scene without generative layers");
  // a generative layer cannot run through a seamless loop: its time does not repeat
  const seg = base();
  seg.segments = { in: 0.2, loop: 0.6, out: 0.2 };
  assert.ok(problems(seg).some((m) => m.includes("is a generative layer running through the loop segment")));
});

test("scene ships three.js and the runtime; type3d carries the text's outlines from the font", () => {
  const dir = tmp();
  const r = tool("scene", [FIXTURE, "-o", join(dir, "s"), "--json"]);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(readdirSync(join(dir, "s", "assets")).sort(), ["hfs-generative.js", "three.core.js", "three.module.js"]);
  assert.match(readFileSync(join(dir, "s", "assets", "three.module.js"), "utf8").slice(0, 200), /SPDX-License-Identifier: MIT/);
  const t = withLayer({ program: "type3d", text: "AB", font: "Blocks", params: { depth: 0.3 }, palette: ["#ffaa00"] });
  t.fonts = [{ family: "Blocks", src: FONT }];
  const html = renderHtml(validateRequest(t, FIXTURES));
  const cfg = JSON.parse(/class="hfs-gen" id="hfs-gen-p">(.*)<\/script>/.exec(html)[1]);
  // two block glyphs, 0.6 em apart, each one closed rectangle
  assert.equal(cfg.outlines.glyphs.length, 2);
  assert.deepEqual(cfg.outlines.glyphs.map((g) => g.x), [0, 0.6]);
  assert.equal(cfg.outlines.width, 1.2);
  assert.deepEqual(cfg.outlines.glyphs[0].cmds[0], ["moveTo", 0.15, 0]);
});

// the colour planes of each frame of a PNG sequence, one md5 per frame
function pngFrames(dir) {
  return readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => ffmpeg(["-i", join(dir, f), "-f", "rawvideo", "-pix_fmt", "rgba", "-"]).toString("base64")).map((b) => createHash("md5").update(b).digest("hex"));
}

test("a particles layer renders bit-identical twice, and frame N rendered alone equals frame N of the full render", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  assert.equal(tool("scene", [FIXTURE, "-o", join(dir, "scene"), "--json"]).code, 0);
  const a = join(dir, "a.mp4");
  const b = join(dir, "b.mp4");
  for (const out of [a, b]) {
    const r = tool("render", [join(dir, "scene"), "-o", out, "--json"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.doc.verified, true, JSON.stringify(r.doc.verification));
  }
  assert.equal(sha(a), sha(b), "byte-identical files");
  // lossless frames: the full render, and frame 7 alone (a one-frame scene whose program starts at 0.7 s)
  const full = join(dir, "full");
  assert.equal(tool("render", [join(dir, "scene"), "-o", full, "--codec", "png", "--json"]).code, 0);
  const one = base();
  one.duration = 0.1;
  one.layers[0].duration = 0.1;
  one.layers[0].time_start = 0.7;
  assert.equal(tool("scene", [writeJson(join(dir, "one.json"), one), "-o", join(dir, "one-scene"), "--json"]).code, 0);
  const alone = join(dir, "alone");
  assert.equal(tool("render", [join(dir, "one-scene"), "-o", alone, "--codec", "png", "--json"]).code, 0);
  const F = pngFrames(full);
  assert.equal(F.length, 10);
  assert.notEqual(F[6], F[7], "the particles move");
  assert.deepEqual(pngFrames(alone), [F[7]]);
});

test("noise field, shader gradient, type3d and a user shader draw on their canvases", { skip: SKIP_RENDER }, () => {
  const dir = tmp();
  const req = {
    scene_version: 1, width: 320, height: 180, duration: 0.3, fps: 10, background: "#000000",
    fonts: [{ family: "Blocks", src: FONT }],
    layers: [
      { type: "generative", id: "n", start: 0, duration: 0.3, box: { x: 0, y: 0, width: 160, height: 90 }, program: "noise_field", seed: 2, palette: ["#000000", "#ffffff"] },
      { type: "generative", id: "g", start: 0, duration: 0.3, box: { x: 160, y: 0, width: 160, height: 90 }, program: "shader_gradient", seed: 2, palette: ["#ff0000", "#0000ff"] },
      { type: "generative", id: "t", start: 0, duration: 0.3, box: { x: 0, y: 90, width: 160, height: 90 }, program: "type3d", seed: 2, palette: ["#ffffff"], text: "HI", font: "Blocks" },
      { type: "generative", id: "s", start: 0, duration: 0.3, box: { x: 160, y: 90, width: 160, height: 90 }, program: "shader", seed: 2, src: SHADER },
    ],
  };
  assert.equal(tool("scene", [writeJson(join(dir, "r.json"), req), "-o", join(dir, "scene"), "--json"]).code, 0);
  const out = join(dir, "seq");
  const r = tool("render", [join(dir, "scene"), "-o", out, "--codec", "png", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const quad = (x, y) => {
    const px = ffmpeg(["-i", join(out, "frame_000002.png"), "-vf", `crop=160:90:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
    let lit = 0;
    for (let i = 0; i < px.length; i += 3) if (px[i] + px[i + 1] + px[i + 2] > 60) lit++;
    return lit / (160 * 90);
  };
  assert.ok(quad(0, 0) > 0.5, "the noise field covers its box");
  assert.ok(quad(160, 0) > 0.95, "the gradient covers its box");
  const t = quad(0, 90);
  assert.ok(t > 0.02 && t < 0.8, `the extruded text covers part of its box: ${t}`);
  assert.ok(quad(160, 90) > 0.95, "the user's shader covers its box");
});

test("doctor reports the WebGL backend", { skip: SKIP_RENDER }, () => {
  const r = tool("doctor", ["--json"]);
  const w = r.doc.capabilities.webgl;
  assert.equal(w.status, "available", JSON.stringify(w));
  assert.match(w.version, /WebGL/);
  assert.ok(["swiftshader", "other"].includes(w.backend));
  assert.ok(w.renderer.length > 0);
  assert.equal(existsSync(SHADER), true);
});
