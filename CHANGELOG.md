# Changelog

All notable changes. The stability guarantee and deprecation policy are in
[docs/contract.md](docs/contract.md).

## Unreleased
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
