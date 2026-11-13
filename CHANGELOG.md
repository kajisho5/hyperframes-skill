# Changelog

All notable changes. The stability guarantee and deprecation policy are in
[docs/contract.md](docs/contract.md).

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
