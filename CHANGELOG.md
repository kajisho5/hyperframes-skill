# Changelog

All notable changes. The stability guarantee and deprecation policy are in
[docs/contract.md](docs/contract.md).

## 0.3.0 (unreleased)

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
