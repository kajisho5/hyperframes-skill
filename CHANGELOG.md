# Changelog

All notable changes. The stability guarantee and deprecation policy are in
[docs/contract.md](docs/contract.md).

## Unreleased
### Added

- Audio and beat lock (roadmap step 11, design-decisions D24). An `audio` layer (local `.wav`, `.mp3`,
  `.m4a`, `.aac`, `.ogg`, `.opus` or `.flac`; `media_start`, `volume`, `fade_in`, `fade_out`) is mixed into
  the output by HyperFrames: AAC in .mp4 / .mov, Opus in .webm. `render` then verifies an `audio` step:
  an audio stream as long as the scene, within one frame. `probe`'s `audio` gains `duration` and
  `duration_source`. A PNG sequence cannot carry sound, so `--codec png` refuses a scene with audio. A
  stinger with sound writes `audio: true` in `stinger.json`.
- A top-level `beat` (`bpm` with `offset`, or `grid`: ffmpeg-skill `scenes --beats --json`, whose
  `beat_grid.supported_beats` are used, a sound-design-skill `beats.json` / `tempo_map`, or an array of
  seconds; `division`, `snap`) moves every visual layer's start to the nearest beat, on a frame, keeping
  its end. A unit
  transition's stagger becomes a whole number of beats when the beats are evenly spaced. `scene`
  reports every given and snapped time in `beat_lock`. An audio layer, and a layer inside a seamless
  loop that is not on the beat, are never moved.

- Generative layers (roadmap step 10, design-decisions D23). `type: generative` runs one of the programs
  this skill ships: `particles`, `noise_field`, `shader_gradient` and `type3d` (extruded 3D text from a
  font in `fonts[]`). Or it runs `shader`, a user's fragment shader from a local `.frag` / `.glsl` / `.fs`
  file, which is checked to be one self-contained GLSL file with no word for script, network or DOM access.
  Each takes a `seed`, a `palette`, typed `params` and `time_start`. three.js 0.187.0 (MIT) is copied into
  the scene, never fetched. The bundled runtime is the frame adapter: HyperFrames' `hf-seek` sets the
  program's time from the frame being captured, so frame N renders the same whether or not frames
  0..N-1 were rendered. Rendering stays on SwiftShader. `doctor` reports the WebGL backend (`webgl`:
  version, vendor, renderer, `backend: swiftshader`). A generative layer is refused inside a seamless
  loop segment. New dependency: `three` 0.187.0 (MIT).

- Shape and pattern layers (roadmap step 9, design-decisions D22). `type: shape` draws a `rect`,
  `rounded_rect` (`radius`), `circle`, `line` (`points`) or `polygon` (`points` or `sides`), with `fill` (a
  colour or a `linear` / `radial` gradient), `stroke` and `rotation`. Its `keyframes` move, scale, turn
  and fade it (`position`, `scale`, `rotation`, `opacity`). `type: pattern` draws one of the presets
  `grid`, `lines`, `dots`, `rings` and `polygons` from a `seed`, with `speed` (cycles per second),
  `palette` and the preset's typed `params` (`count`, `line_width`, `angle`, `size`, `sides`). There is
  no raw CSS. A cycle ends on the picture it started with, so a pattern can run in a seamless loop
  segment when its cycle divides the loop. The same seed draws the same picture, and another seed changes
  only the pattern's own markup.

- International typesetting and text fit (roadmap step 8, design-decisions D21). A text layer takes its
  own `lang` (BCP 47), and its direction follows it: Arabic, Hebrew, Persian, Urdu and the other
  right-to-left languages get `dir="rtl"`. `style.direction` (`auto`, `ltr`, `rtl`) states it, and
  `style.align` also takes `start` / `end`. `style.line_break` (`normal`, `strict`, `loose`) is CSS
  `line-break`, so `strict` is strict kinsoku. `style.phrases: true` breaks Japanese, Chinese and Thai
  only between BudouX phrases (Apache-2.0, run locally).
- `fit: {"mode": "shrink", "min_font_size": N}` finds the largest font size, from `style.font_size`
  down to the minimum, at which the text fits its box. It lays the text out in the headless Chromium
  the render uses. The size used is written into the HTML and reported in `text_fit` with the measured
  line breaks. A text that does not fit at the minimum is an input error with the overflow in pixels,
  and no scene is written. Text is never cut or ellipsised.
- Opt-in regional profiles: `style.writing_mode: vertical` (vertical-rl) and `style.ruby: true`
  (`{東京|とうきょう}` becomes ruby).
- `template --fit` / `batch --fit` give every caller text of a title template (and the logo reveal's
  text) a fit down to the template's own minimum. It needs `--font` or a kit's `font_file`.
- Title material (`title.json`) carries each text layer's own `lang`, the font size used, and, for a
  fitted layer, the text with its measured line breaks; ruby readings are left out of `text`.
- New dependencies: `budoux` 0.10.3 (Apache-2.0) and `puppeteer-core` 25.11.0 (Apache-2.0). puppeteer-core
  is already installed with HyperFrames.

### Changed

- A scene whose `lang` is a right-to-left language now writes `dir="rtl"` on its text layers. Its text
  was laid out left to right before, which put punctuation on the wrong side.

- Kinetic typography (roadmap step 7, #37, design-decisions D20). A text layer's `transition_in` /
  `transition_out` may be `chars`, `words` or `lines` with `duration` (each unit), `stagger` (from one
  unit's start to the next), `easing` and `effect` (`fade`, `slide` with `direction` + `distance`, `zoom`
  with `scale`): the units appear or leave one after another. Characters are extended grapheme clusters
  (Unicode UAX #29), so a base with its combining marks, an emoji sequence or an Indic / Thai cluster
  moves whole; words come from the segmenter for the scene's `lang` (Japanese included) and take their
  punctuation; lines are the text's own lines. Whitespace is never a unit.
- `wipe` transition on any layer: a mask whose edge travels `left`, `right`, `up` or `down`.
- `keyframes` on a text layer: `tracking` (letter-spacing, px), `scale`, and `font_variation`
  (`{AXIS: [{t, value}]}`), linear between stops. The axes are read from the font file the layer's family
  names in `fonts[]`; an axis the font does not have is refused with the font's real axes listed, and a
  value outside the axis range is refused.
- `scene` reports `text_units` (`layer`, `edge`, `type`, `units`, `span`) for each unit transition.
  Additive: a request without these keys renders byte-identical markup. A seamless loop refuses a unit
  reveal that runs into it and keyframes that change inside it. New dependency: `fontkit` (MIT, already
  installed with HyperFrames) to read a font's variation axes.

## 0.11.1

- fix: declare ffmpeg-skill 4.x (>=2.0.0 <5.0.0) (#36) (18b6826)

## 0.11.0
### Added

- NTSC and other non-integer frame rates (#33, velisa/timebase@1, D18). A scene request's `fps` and
  `render --fps` take an integer, an exact `N/D` (`"30000/1001"`), or an NTSC decimal (`23.976`, `29.97`,
  `59.94`), read as the exact N/1001 rate and never as 2997/100. The scene writes `data-fps="30000/1001"`,
  HyperFrames renders with `--fps 30000/1001`, and frame counts multiply by the exact rate.
- `expected.frames` is the count HyperFrames renders: every started frame of a duration that is not within
  1/1000 of a whole number of frames (a 30 s scene at 30000/1001 is 900 frames; 1.01 s at 30 fps is 31), where
  `Math.round` planned one frame fewer and verification failed.
  Additive contract change: `render --fps` is a string (an integer still works), and every `expected` gains
  `frame_rate` (`"30"`, `"30000/1001"`). A stinger or title sidecar's `frame_rate` is the exact rate.
  The timebase conformance vectors (copied from Velisa, commit in `tests/fixtures/timebase/manifest.json`)
  run in `tests/timebase.test.mjs`.

## 0.10.4

- fix(release): a CHANGELOG section for every release; test the release commit before pushing; no release for chore/ci/docs-only PRs (#31) (faaa409)

## 0.10.3
### Changed

- CI only: pull requests that change the contract are checked by Velisa's reusable contract-diff
  workflow, one run per pull request (#28). The tools and the contract are unchanged. This section
  was missing from the release commit: that pull request wrote no `## Unreleased` entry, so the
  bump had nothing to rename (fixed in the release script, design-decisions D17).

## 0.10.2
### Fixed

- Tests no longer leave `hfs-*` directories in the OS temp directory: every directory made by
  `tmp()` in `tests/helpers.mjs` is removed when the test file's process ends (normal exit, failure,
  SIGINT or SIGTERM). One full run used to leave about 110 directories behind.
  `HYPERFRAMES_SKILL_TEST_TMPDIR=DIR` moves them, `HYPERFRAMES_SKILL_KEEP_TEST_TMP=1` keeps them
  for debugging (design-decisions D16). Test-only; the tools and the contract are unchanged.

## 0.10.1
### Changed

- `contract/contract.json`: the contract committed as a file (`contract --json` as one line with sorted
  keys, compact separators and a final newline), so a release's contract is
  `git show vX.Y.Z:contract/contract.json` without running the code. `node contract/generate.mjs`
  regenerates it; a test fails when it is stale, and the release commit regenerates it after the bump.
  The contract itself is unchanged.

## 0.10.0
### Added

- Brand input (roadmap step 16, design-decisions D15): `--kit FILE` on `template` and `batch` takes a
  Velisa `kit@1` file or an ffmpeg-skill `brand.json` and fills the template values it maps:
  `colors.background` -> `background`, `colors.accent` -> `accent`, `colors.text` -> `text_color`,
  `logo` -> `logo`, and `font_file` as `--font` for templates whose text comes from the caller. Only what
  the kit states is used; an explicit value and `--font` win. The result gains `kit` (`applied` with the
  values used, `overridden`, `unused` with the reason for every other field the kit has), and
  `template --list` shows each template's `kit` map. Templates may declare `kit` (value -> kit field).
  Additive: no existing flag, value or result key changes.

## 0.9.1

- Roadmap step 18 ticked (the agent runs `render` for `rendered_layer`); no code change.

## 0.9.0
### Added

- Stinger templates with a cut point (roadmap step 15, design-decisions D14): `stinger-geometric`,
  `stinger-glitch`, `stinger-particles`, `stinger-brush` and `stinger-logo-reveal`, each taking `duration`,
  `cut_point` and `hold` (`--set duration=1.2 --set cut_point=0.5`): the graphic enters until the cut point,
  covers the whole frame for the hold and exits. A scene request may declare `stinger: {cut_point, cover:
  {start, end}}` (on frames, the cut point inside the cover). `render` refuses a stinger without an alpha codec,
  decodes the alpha plane of every frame of the cover (`stinger_cover`: every pixel >= 253/255, qc-skill's
  threshold; the result gains `stinger`) and writes `<stem>.stinger.json` beside the output: `cut_point` and
  `cover` (what video-editing-skill's stinger transition and qc-skill's stinger check read) plus the spec's
  proposed fields (`cut_point_frame`, `cover_frames`, `frame_rate`, `alpha`, `sha256`, ...). Times are written
  as `frame / frame_rate`, never rounded. No audio yet: `audio: false`.
- `title.json` beside title material (roadmap step 17): the four title templates now declare IN / LOOP / OUT
  `segments` (in and out are their transitions; `break` loops whole) and a `title: {safe_area}` that every text
  box must lie inside. `render` writes `<stem>.title.json`: `segments` (seconds, as motion-graphics-skill's
  `rendered_layer` takes them) plus the proposed `segment_frames`, `alpha`, `loop_seam` (with `--segments`),
  `safe_area` and `text` (each text layer with its font and font size). `batch` writes the same beside each row.
- Both sidecars follow the Velisa spec for title and stinger metadata and hold only its fields; the result's
  `sidecar.fields` lists which a receiver reads and which are only proposed (docs/contract.md, "Sidecars").
  `scene` writes the facts to `hfs-material.json` in the scene directory (`verification[]` gains `material`).
- Templates may compute timings with `derived` sums and differences in whole frames, and ship their own
  assets under `templates/assets/` (written into the request as absolute paths).

### Changed

- A title template's `duration` is put on the 30 fps frame grid in the request (7.05 becomes 7.066667: the
  render already had 212 frames), so its segments add up.
- A PNG frame with no transparent pixel, which HyperFrames can write as RGB, reads as alpha 255 in the cover
  measurement.

The contract change is additive: two new request keys, new templates, new result keys and verification steps
that appear only for stinger or title material, and no flag added, removed or renamed.

## 0.8.1
### Changed

- docs: the roadmap takes title and stinger material, `kit@1` brand input and `title.json` from the 2026-11-12
  ownership decisions (steps 15-18); the 0.8.0 entry got its own heading. (This heading was added afterwards:
  the release left 0.8.1 without one.)

## 0.8.0
### Added

- Alpha deliveries (roadmap step 13, design-decisions D13): `render --codec png` writes a PNG sequence
  directory (RGBA `frame_000001.png ...`, through HyperFrames' png-sequence format) beside WebM VP9 and ProRes
  4444. Every alpha render decodes its first frame's alpha plane: `verification[]` gains `alpha`, and the result
  gains `alpha: {mode: "straight", channel, first_frame: {min, max, mean, corners, ...}}` (`mode: "none"` for
  h264). `probe --alpha [--sample X,Y]` reads the same from any file or a PNG sequence directory; probe reports
  VP9's `alpha_mode` tag and reads PNG sequence directories. `--overwrite` replaces a PNG sequence directory
  only when it holds nothing but frames. `batch` stays video-only.

The contract change is additive: new flags (`render --segments`, `--codec png`, `probe --alpha` / `--sample`), two new request keys, new result keys and steps that
appear only when they are used.

## 0.7.0
### Added

- IN / LOOP / OUT segments and seamless loops (roadmap step 12, design-decisions D12). A scene request may
  declare `segments: {in, loop, out}` (seconds, whole frames, adding up to `duration`). `scene` writes each
  non-empty segment as its own composition, `segments/<name>.html`, a window of the scene in which every
  layer, transition and video is cut to the same scene time, and reports `segments[]`. The loop is seamless
  by construction: a layer starting or ending inside it, a transition or a video running in it, or a loop
  animation whose period does not divide its length (in frames) is refused, with the periods that fit.
- `loop_animation` on any layer: `pulse` (`scale`), `bob` (`direction`, `distance`), `spin` (`direction`
  `cw|ccw`), each with `period` and `easing`. They animate the individual `scale` / `translate` / `rotate`
  properties, so they compose with the transitions' `transform`.
- `render --segments`: after the full render, each segment is rendered to `<stem>.in|loop|out<ext>` and
  verified; the result gains `segments[]` and `loop_seam`, and `verification[]` gains `segments` (their
  probed frame counts add up to the full render's) and `loop_seam` (the loop file's last-to-first step is
  no larger than its largest step between its own frames, plus 1/255).

## 0.6.7
### Changed

- ci: `CI` runs on pushes to `main` and on pull requests, no longer on every branch push, so a pull request
  commit is tested once instead of twice; a newer commit on a pull request cancels the runs of the one it
  replaces. Runs on `main` are never cancelled. No code change.

## 0.6.6
### Changed

- docs: `ECOSYSTEM_ROADMAP.md` gained steps 7-15 from the 2026-11-05 field review (#18). No code change.
  This section was added after the release: the release commit moved the version without one, so
  `tests/release.test.mjs` failed on `main`.

## 0.6.5
### Changed

- docs: `ECOSYSTEM_ROADMAP.md` brought up to date in the 2026-11-05 ecosystem review: 0.6.4 released by
  its workflow, the agent names `hyperframes-skill/render` in a CONFIRM handoff (video-production-agent#95),
  and the footer names ffmpeg-skill 3.x (#17). No code change.

## 0.6.4
### Changed

- docs: `ECOSYSTEM_ROADMAP.md` step 5 ticked (agent side done in video-production-agent#95) (#16). No code
  change. This section was added after the release (in #17): the release commit moved the version without
  one, so `tests/release.test.mjs` failed on `main`.

## 0.6.3
### Changed

- ffmpeg-skill 3.0.0 is accepted: the contract's `dependencies[0].version_range` is `>=2.0.0 <4.0.0`
  (was `<3.0.0`). The cross-check runs only `probe`, and every key it reads is unchanged in 3.0.0;
  3.0 only adds `timecode` to probe. CI runs the cross-check against 3.0.0 on every OS, and against
  2.23.1 on Linux (docs/design-decisions.md D11).

## 0.6.2
### Changed

- Windows is supported (roadmap step 4): `render` / `preview` no longer generate POSIX `sh` shims to
  record what HyperFrames starts. HyperFrames now runs with a Node preload, `lib/argv-recorder.cjs`
  (`node --require`, also in `NODE_OPTIONS` for any Node process it starts). The preload writes the
  argv of every chrome / ffmpeg / ffprobe process HyperFrames starts, in the same log format as the
  shims, so `commands[]` is unchanged in content ([docs/design-decisions.md D10](docs/design-decisions.md)).
- The contract's `execution.argv_shims` is now `execution.argv_recorder`. The hyperframes entry of
  `commands[]` starts `node --require <lib/argv-recorder.cjs> <hyperframes cli> render ...`.
- `commands[].program` drops Windows' `.exe`, so a command reads the same on every OS.
- On Windows a timeout or an interrupt ends the whole process tree with `taskkill /T` (there are no
  process groups).
- CI runs on `windows-latest` too (ffmpeg from Chocolatey, chrome-headless-shell from
  `hyperframes browser ensure`, the ffmpeg-skill cross-check through the runner's Python).
  The tests' fake chrome / ffmpeg are a Node double (`tests/fixtures/fake-spawn.cjs`) instead of
  sh scripts. The SIGTERM test is POSIX-only: Windows has no signal delivery to a handler.
- `.gitattributes` keeps LF line endings on every checkout, Windows included. The snapshots, JSON fixtures and
  workflow files the tests compare byte for byte would otherwise be checked out with CRLF.

## 0.6.1
### Added

- `render` cross-checks its output with ffmpeg-skill when a checkout is present (roadmap step 3;
  [docs/design-decisions.md D3](docs/design-decisions.md), the engine bypass): it runs
  `ffmpeg-skill/probe` on the file and reports `ffmpeg_skill` in the result: `status`
  `PASSED` / `FAILED` / `UNCHECKED`, the ffmpeg-skill `version`, `measured` duration, resolution,
  fps, codec, pixel format and alpha, and `checks[]` against what the scene asked for (alpha for
  `--codec vp9` / `prores`). `PASSED` and `FAILED` add the `verification[]` step `ffmpeg_skill`
  (`FAILED` fails the render with `kind: verification`); `UNCHECKED` always carries a `reason` and
  adds no step, so it is never a pass. Found through `--ffmpeg-skill DIR`,
  `HYPERFRAMES_SKILL_FFMPEG_SKILL_DIR`, `VIDEO_AGENT_FFMPEG_SKILL_DIR`,
  `~/.claude/skills/ffmpeg-skill`, `./vendor/ffmpeg-skill` or a sibling checkout. Additive:
  without ffmpeg-skill every existing result is unchanged apart from the new `ffmpeg_skill` key.
- `doctor` reports the optional capability `ffmpeg-skill` (never affects `ok`); the contract's
  `dependencies` lists ffmpeg-skill as optional (`required: false`).
- CI checks out ffmpeg-skill v2.23.1 so the cross-check runs against a real checkout.

### Known gaps (ffmpeg-skill, recorded in D3)

- VP9 alpha is reported `UNCHECKED`: ffmpeg-skill's probe reports neither stream tags nor an alpha
  field, and VP9 alpha lives in the `alpha_mode` tag.

## 0.6.0

### Added

- MCP server, `hyperframes-skill mcp` (stdio, newline-delimited JSON-RPC, no new dependency):
  `tools/list` generated from the contract, `tools/call` runs the tool's script with `--json`
  and returns its result document as text and `structuredContent`, `isError` exactly when
  `status` is not `completed`. The MCP surface is frozen by `tests/fixtures/mcp_tools.json`.
  `contract --json` gains `skill.entrypoints.mcp`.
- Releases: `.github/workflows/release.yml` tags `vX.Y.Z`, creates the GitHub Release (notes
  from this file) and publishes to npm when the `NPM` secret is set, after CI passes on a push to
  `main`. The first release tags `package.json`'s version as it stands (0.6.0); after that, the
  labels of the PRs merged since the last tag pick the bump (`.github/release-drafter.yml`,
  applied by `.github/workflows/autolabel.yml`).

## 0.5.0

### Added

- Fonts shipped with the scene: optional top-level `fonts` in a scene request
  (`[{family, src, weight?, style?}]`, local .otf/.ttf/.woff/.woff2), copied to
  `assets/fonts/` and declared with `@font-face`; omitting `weight` makes the file serve every
  weight (no synthesized bold). `--font FILE` on `template` and `batch` ships one font and puts
  it first in every text layer's font list. Additive to `scene_version: 1`.
- `doctor --json` `fonts`: fontconfig coverage and pick per CJK language, with advice when
  Japanese and Chinese get the same font. Informational only.

### Fixed

- Docs said setting `lang` to `ja` gives Japanese glyph forms. It does not when fontconfig serves
  Japanese from a Chinese font (seen on Ubuntu: 直 骨 写 in Chinese forms with `lang=ja`). The docs
  now say to ship the font.

## 0.4.0

### Added

- `batch` tool (tool count 6 → 7): one render per row of a CSV (RFC 4180, header row = template
  value names, empty cell = value left out, UTF-8 with or without BOM, `--encoding shift_jis`)
  or JSON array, through a template. Every row is validated before the first render; outputs are
  `<row>-<--name-field value>.<ext>`, with each row's scene kept under `<output>/scenes/`. Per-row
  `status` / `verified` / `error`, a `summary`, `--fail-fast`, `--overwrite` for the batch's own
  files only. A batch with any failed or skipped row ends `failed`, never `completed`.
- Demo `demos/speakers-batch`.

## 0.3.0

### Added

- `template` tool (tool count 5 → 6): fills a shipped template with caller values (`--values`
  file and/or repeatable `--set key=value`) and writes a `scene_version: 1` request; `--list`
  describes every template and its values. Values are type-checked (string with max length,
  number with range, colour), unknown and missing ones refused together; an optional value
  left out drops the layers marked `"when"` for it. The filled request must pass `scene`'s own
  validation.
- Templates: `lower-third` (transparent background; ProRes 4444 render keeps alpha, verified by
  a render test), `title-card`, `session-slate`, `break`. Each takes `lang`.
- Demo `demos/session-slate` built from a template.

## 0.2.0

### Added

- Layer transitions: optional `transition_in` / `transition_out` on every layer type (`fade`;
  `slide` with `direction` and `distance`; `zoom` with `scale`; `easing` linear / ease_in /
  ease_out / ease_in_out). Rendered as CSS animations that HyperFrames seeks per frame in
  clip-local time: no script, no CDN, deterministic. Additive to `scene_version: 1`: requests
  without transitions render byte-identical markup (pinned by snapshot fixtures).
- Demo `demos/lower-third`: slide-in lower third and a zoomed-in tag.

## 0.1.0

First slice: a working `doctor` → `scene` → `render` → `probe` loop, plus `preview`.

### Added

- `doctor`: probes Node (>= 22), the pinned `hyperframes` package, ffmpeg/ffprobe (>= 5.0) and
  their `libx264` / `libvpx-vp9` / `prores_ks` encoders, a headless Chromium launch, and free
  temp space; each capability `available` / `missing` / `unknown`; exit 0 / 1 / 2.
- `scene`: `scene_version: 1` requests (text, image and video layers with in/out times, pixel
  boxes, paint order) → HyperFrames scene directory with copied assets; `hyperframes lint` as a
  verification step.
- `render`: scene directory → `.mp4` h264, `.webm` vp9 or `.mov` ProRes 4444 through
  hyperframes 0.8.61; `--codec`, `--quality` (CRF), `--fps`, `--workers`, `--timeout`,
  `--overwrite`; verified against the scene's declared size, fps, frame count and duration, and
  checked to leave the scene directory unchanged. GPU capture off and SDR forced, for
  byte-identical repeat renders.
- `preview`: 10 fps draft proxy, `--max-duration` via a staged copy of the scene.
- `probe`: ffprobe read-back including a frame count (decoded when the container has none).
- `contract --json`, generated from each tool's own commander parser; stability guarantee and
  deprecation policy in `docs/contract.md`; CLI surface frozen in `tests/fixtures/cli_surface.json`.
- `commands` in every result lists the argv of each Chrome/ffmpeg/ffprobe process HyperFrames
  started, recorded through generated argv shims.
