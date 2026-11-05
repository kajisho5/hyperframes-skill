# Roadmap — hyperframes-skill

Part of the [AI Video Production OS](https://github.com/kajisho5/AI-video-production-OS/blob/main/docs/ecosystem/ROADMAP.md) ecosystem: department **映像 (Visual)**, status `active`.
Written from a read-only audit of this repository on 2026-10-30. Each step below is meant to be one pull request; tick it off by linking the PR.

## Where it stands

v0.6.4, released by its workflow (step 2). Node 22. batch, doctor, preview, probe, render (h264/vp9/ProRes 4444 alpha), scene, template. 76 tests, CI on Ubuntu + macOS, and Windows since [#14](https://github.com/kajisho5/hyperframes-skill/pull/14).

## What this repository owns

`ecosystem.json` gives each job to exactly one repository. Work outside this list belongs to its owner and is handed over, not re-implemented.

| Owned job | Status | Note |
|---|---|---|
| HTMLシーンの動画化(HyperFrames) | done | audio is a later theme |

## Wiring

The agent names `hyperframes-skill/render` in a CONFIRM handoff from a pinned contract (step 5, video-production-agent#95); it does not run it yet. Calls ffmpeg/ffprobe directly, bypassing ffmpeg-skill (the engine bypass, [docs/design-decisions.md D3](docs/design-decisions.md)); `render` reads its output back through ffmpeg-skill/probe when a checkout is present and reports `ffmpeg_skill.status`.

## Steps

- [x] **1. provides[] + dependencies in the contract**
  - Done when: OS conformance
- [x] **2. Release workflow; cut 0.6.0** — npm + tag ([#12](https://github.com/kajisho5/hyperframes-skill/pull/12))
  - Done when: tag produces a release
- [x] **3. Verify outputs with ffmpeg-skill when present** — probe/check; ADR on the engine bypass ([#13](https://github.com/kajisho5/hyperframes-skill/pull/13))
  - Done when: render result reports ffmpeg-skill verification
- [x] **4. Windows** — replace sh argv shims with Node; Windows CI ([#14](https://github.com/kajisho5/hyperframes-skill/pull/14), design-decisions D10)
  - Done when: CI green on Windows
- [x] **5. (agent side) SkillSpec html_scene_render** — output to video-editing concat or ffmpeg-skill overlay (alpha) ([video-production-agent#95](https://github.com/kajisho5/video-production-agent/pull/95))
  - Done when: tracked in video-production-agent
- [x] **6. ffmpeg-skill 3.0.0** — declared range `>=2.0.0 <4.0.0`; CI cross-check against 3.0.0 on every OS and 2.23.1 on Linux ([#15](https://github.com/kajisho5/hyperframes-skill/pull/15), D11)
- [ ] **7. Text animation (kinetic typography)** — text layers animate per character, word or line: staggered reveal (`transition_in.type: chars|words|lines` with `stagger` and `easing`), mask wipes, tracking (letter-spacing) and scale animation, and variable-font axis keyframes (`font_variation`). Units are grapheme clusters (Unicode UAX #29), so combining marks, emoji and Indic / Thai clusters animate whole. CSS animations only, seeked frame by frame as the three transitions are today, so renders stay `bit_exact` on one machine. Field review 2026-11-05 (Velisa ROADMAP, third round)
  - Why: kinetic type for text-only promos, openings and speaker intros comes from a JSON request alone（なぜ要るか：文字だけのPV・オープニングの文字の動きを指定だけで作れる）
  - Done when: a fixture with a per-character reveal renders the expected grapheme count per frame (framemd5 stable across two runs); an unknown axis is refused with the font's real axes listed
- [ ] **8. International typesetting and text fit** — language-aware layout from the layer's `lang`: right-to-left and bidirectional text (Arabic, Hebrew), CJK line breaking, line-break rules per language (Unicode UAX #14; phrase breaks with BudouX, Apache-2.0, run locally, where it supports the language), and `fit: shrink`, which reduces the font size inside the box down to a stated minimum and reports the size used. Text is never cut or ellipsised; a line that does not fit at the minimum is an error with the overflow in pixels. Regional profiles, opt-in and never the default: vertical writing (`writing_mode: vertical`) and ruby annotations for Japanese and Chinese, strict kinsoku
  - Why: long names, affiliations and talk titles in any language shrink and break cleanly, so a lower third never overflows（なぜ要るか：長い氏名・所属・演題を多言語で自動縮小・改行できる）
  - Done when: fixtures in English, Arabic (RTL), Hindi and Japanese render inside their boxes with the reported sizes; the vertical-writing and ruby profiles render as expected; the reported size equals the one in the HTML
- [ ] **9. Shape and pattern layers** — `shape` layers (rect, rounded rect, circle, line, polygon; stroke, gradient, rotation) with keyframed position / scale / rotation / opacity, and `pattern` presets drawn in SVG / CSS from a seed: grid, lines, dots, concentric rings, morphing polygons. Parameters are typed (count, speed, palette), never raw CSS
  - Why: geometric looks and logo backgrounds without any footage, reproducible from a seed（なぜ要るか：幾何学模様の映像を素材なしで再現性よく作れる）
  - Done when: each preset renders twice to the same framemd5; a changed seed changes the picture and nothing else
- [ ] **10. Generative layer (Three.js / GLSL)** — `type: generative` runs one of the programs this skill ships (particles, noise field, shader gradient, 3D type from a font file) with a seed and typed parameters, through a HyperFrames custom frame adapter that sets the program's time from the frame number. three (MIT) is bundled, never fetched from a CDN; rendering stays on SwiftShader as today, so the output is deterministic on one machine. A user's own fragment shader is accepted only as a local file, checked to contain no network or DOM access. Reference: @hyperframes/core frame adapters (Apache-2.0), three.js (MIT)
  - Why: particles, shaders and 3D type in the same scene, with no separate tool（なぜ要るか：パーティクルやシェーダー、3Dタイポを同じシーンに重ねられる）
  - Done when: a particles fixture renders bit-identical twice; frame N rendered alone equals frame N of the full render; doctor reports the WebGL backend
- [ ] **11. Audio and beat lock** — an `audio` layer (local file; HyperFrames has audio support upstream) so the output carries sound, and `bpm` or a beat grid file (ffmpeg-skill `scenes --beats`, or sound-design-skill's tempo map) to which layer starts and staggers snap. The snapped times are written in the result
  - Why: "neon, 120 BPM, 15 s, vertical" lands every move on the beat, with the music in the file（なぜ要るか：BPM に動きを合わせ、音入りで書き出せる）
  - Done when: at 120 BPM every snapped start is a multiple of 0.5 s within one frame; the output's audio duration equals the scene's
- [ ] **12. IN / LOOP / OUT segments and seamless loops** — a scene declares `segments` (in, loop, out); `render --segments` writes one file per segment plus the full preview, and the loop segment is built so its last frame leads into its first (every animation in it has a period that divides the loop length; a layer that does not is refused). Frame counts per segment are in the result
  - Note: ffmpeg-skill's seamless-loop work (Velisa ROADMAP proposal 10, accepted, top priority: [ffmpeg-skill#422](https://github.com/kajisho5/ffmpeg-skill/issues/422)) smooths a loop after the fact; this step makes the loop seamless by construction
  - Why: an operator takes a lower third's IN and OUT separately on air, and standby screens loop without a visible seam（なぜ要るか：ライブ送出で IN と OUT を別に打ち、待機画面を途切れなくループできる）
  - Done when: a lower third with in 0.5 s / loop 4 s / out 0.5 s gives three files whose frame counts add up to the full render; qc-skill's loop seam check passes on the loop
- [ ] **13. Alpha deliveries** — besides ProRes 4444: WebM VP9 with alpha, PNG sequence, and a stated `alpha: straight|premultiplied` recorded in the result; transparent background checked on an output frame
  - Why: OBS stingers take WebM, After Effects and NLEs take PNG sequences or ProRes 4444（なぜ要るか：送出機・NLE ごとに求められるアルファ形式で出せる）
  - Done when: each format's first frame has alpha 0 in an empty corner and 255 on a solid layer, read back by probe
- [ ] **14. Style presets and recipe gallery** — preset templates built on the steps above: swiss, minimal, neon, glitch, corporate logo reveal, and regional styles as options (for example wafu, Japanese), each a template with typed values (copy, colours, font, bpm, aspect) and a brand kit as input; `template --gallery` renders one still per preset for choosing. Each preset has a fixed check scene rendered in CI. Reference, ideas only, no code used: video-shotcraft recipe cards (Apache-2.0), motion-video-kit's Gauntlet (MIT), the official Remotion and HyperFrames templates (each template's licence checked in an ADR)
  - Why: start from "make it neon" and compare stills before rendering（なぜ要るか：一言のスタイル指定から始め、静止画で比べて選べる）
  - Done when: six presets, each with a CI check scene; a preset given a brand kit uses only the kit's colours and font

## Boundaries

title-card / lower-third templates overlap motion-graphics titles.

---
Engine for every media operation: [ffmpeg-skill](https://github.com/kajisho5/ffmpeg-skill) (3.x, 42 tools, contract_version 2.0; treated as complete, proposals go to Velisa's ROADMAP). Orchestrator: [video-production-agent](https://github.com/kajisho5/video-production-agent).
