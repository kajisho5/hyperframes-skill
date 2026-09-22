# hyperframes-skill

A contract-first CLI toolset and agent skill around [HyperFrames](https://hyperframes.heygen.com)
([source](https://github.com/heygen-com/hyperframes)): HTML scenes rendered frame by frame in
headless Chrome and encoded to video by ffmpeg. It is modelled on
[ffmpeg-skill](https://github.com/kajisho5/ffmpeg-skill): the calling agent decides what a scene
says; this toolset turns that already-decided, structured description into valid HyperFrames
markup, renders it, verifies the result and reports back. 7 tools, v0.6.0.

```
template + values --template--> scene request (JSON) --scene--> scene dir (index.html + assets)
                                                                    --render--> video --probe--> verified numbers
                                                                    \--preview--> fast proxy
```

## Requirements

Declared, pinned, and checked by `doctor` before anything claims it can run. Nothing is assumed
present.

```json
{"node":">=22","hyperframes":"0.8.61","chromium":"headless-capable Chrome/Chromium or chrome-headless-shell: bundled or system, detected","ffmpeg":">=5.0","ffprobe":">=5.0"}
```

- **Node >= 22**: the pinned `hyperframes` package declares `engines.node >=22` (so this is not `>=20`).
- **hyperframes 0.8.61**, pinned exactly in `package.json`; installed by `npm install`.
- **Chromium**: HyperFrames' own `chrome-headless-shell` (`npx hyperframes browser ensure`), a
  Playwright/Puppeteer download, a system Chrome/Chromium, or `HYPERFRAMES_BROWSER_PATH`.
  `doctor` launches it headless to prove it works.
- **ffmpeg and ffprobe >= 5.0** on PATH (or `HYPERFRAMES_SKILL_FFMPEG` / `HYPERFRAMES_SKILL_FFPROBE`),
  with `libx264` (default codec); `libvpx-vp9` for `--codec vp9`, `prores_ks` for `--codec prores`.

## Install and first run

```bash
git clone https://github.com/kajisho5/hyperframes-skill
cd hyperframes-skill
npm ci
node scripts/doctor.mjs            # every capability: available / missing / unknown
node scripts/scene.mjs tests/fixtures/two-line.json -o /tmp/two-line --json
node scripts/render.mjs /tmp/two-line -o /tmp/two-line.mp4 --json
node scripts/probe.mjs /tmp/two-line.mp4
```

From a template instead of a hand-written request (a transparent lower third to key over a live
feed; `--codec prores` keeps the alpha channel):

```bash
node scripts/template.mjs --list
node scripts/template.mjs lower-third --set "name=Hanako Sato" --set "affiliation=Imaging Center" -o /tmp/lt.json
node scripts/scene.mjs /tmp/lt.json -o /tmp/lt
node scripts/render.mjs /tmp/lt -o /tmp/lt.mov --codec prores --json
```

Every speaker at once, from the programme spreadsheet saved as CSV (header row = the template's
value names; a CSV saved by Excel on Japanese Windows needs `--encoding shift_jis`):

```bash
node scripts/batch.mjs speakers.csv --template lower-third --name-field name --codec prores -o out/ --json
# out/001-佐藤-花子.mov, out/002-..., and each row's scene under out/scenes/
```

For Japanese names add `--font NotoSansJP-Bold.otf` (any .otf/.ttf/.woff2): the font is copied
into every scene, so the glyphs do not depend on the machine's fonts (see "What is verified").

Every row is validated before the first render, so a typo in row 30 stops the batch before
anything is written.

As an agent skill, point the agent at `SKILL.md` (it names the scripts relative to itself).

## Tools

| Tool | Id | Role | What it does |
|---|---|---|---|
| `doctor` | `hyperframes-skill/doctor` | analysis | probes Node, hyperframes, ffmpeg/ffprobe + encoders, a headless Chromium launch, temp space |
| `template` | `hyperframes-skill/template` | execution | fills a shipped template (lower-third, title-card, session-slate, break) with caller values → scene request |
| `scene` | `hyperframes-skill/scene` | execution | structured scene request → HyperFrames scene directory (index.html + copied assets), linted |
| `render` | `hyperframes-skill/render` | execution | scene directory → .mp4 (h264) / .webm (vp9) / .mov (ProRes 4444), probed and verified |
| `probe` | `hyperframes-skill/probe` | analysis | ffprobe read-back: duration, resolution, fps, frame count, codecs |
| `batch` | `hyperframes-skill/batch` | execution | one verified render per row of a CSV/JSON through a template (every speaker's lower third from the programme sheet) |
| `preview` | `hyperframes-skill/preview` | execution | fast proxy render: 10 fps, draft encoder preset, optionally the first N seconds |

Every flag of every tool: [`references/scripts.md`](references/scripts.md). Every tool takes
`--json` (one result document) and `--dry-run`.

## Scene request

```json
{
  "scene_version": 1, "id": "intro", "width": 1920, "height": 1080, "duration": 5, "fps": 30,
  "background": "#000000",
  "layers": [
    {"type": "image", "id": "logo", "start": 0, "duration": 5, "src": "logo.png", "box": {"x": 1600, "y": 60, "width": 256, "height": 128}},
    {"type": "text", "id": "title", "start": 1, "duration": 3, "text": "Annual Meeting 2026", "style": {"font_size": 96, "font_weight": 700}}
  ]
}
```

Optional top-level `fonts` ships font files with the scene (`[{"family", "src", "weight"?,
"style"?}]`), so text does not depend on the machine's fonts. Layers: `text`, `image`, `video` (muted), each with `start`/`duration` in seconds, an optional
pixel `box`, painted in array order, and optional `transition_in` / `transition_out` (`fade`,
`slide` with `direction` + `distance`, `zoom` with `scale`; `easing` linear / ease_in / ease_out /
ease_in_out). Transitions are CSS animations that HyperFrames seeks frame by frame, so they
stay deterministic and need no script or CDN. The full schema is in `SKILL.md`. Unknown keys, URLs,
missing files, layers running past the scene's end and values that could escape the style
block are refused with every problem listed at once (`kind: input`).

## Contract

`node bin/hyperframes-skill.mjs contract --json` describes every tool: id, role, required and
optional capabilities, `input_schema` generated from the tool's own parser, dry-run behaviour,
verification policy, repeatability. [`docs/contract.md`](docs/contract.md) explains it, with
the stability guarantee and the deprecation policy.

| Promise | |
|---|---|
| Result document | exactly one per run: `status` `completed`/`failed`, `verified` = conjunction of the checks actually run, `error.kind` + `retryable: false`, `commands` = argv of every process that actually ran (including the Chrome and ffmpeg processes HyperFrames started) |
| Exit codes | 0 ok, 1 failure, 2 `doctor` undecidable, 124 timeout, 127 missing tool, 128+signal interrupted |
| Error kinds | `input`, `render` (Chrome/capture), `encode` (ffmpeg, after capture), `missing_tool`, `timeout`, `verification`, `interrupted`, `internal` |
| Input files | never written; `render` checks the scene directory is unchanged after every run |
| Network | none: telemetry, update check and auto-install are off, Chromium is always given explicitly, URL sources are refused |
| Determinism | same scene + flags on the same machine → byte-identical file (GPU capture off, SDR forced) |

## What is verified, and what is not

Run locally on Linux (Ubuntu 24.04, Node 22.22, ffmpeg 6.1.1, Playwright's
chrome-headless-shell 141.0.7390.37); `.github/workflows/ci.yml` runs the same suite on Linux
and macOS:

- the full loop `scene` → `render` → `probe` on a two-line fixture with real Chrome and ffmpeg,
  including the pixels (line one white in the first half, line two yellow in the second);
- determinism: the fixture rendered twice, sha256 and per-frame md5 identical;
- image and video layers with timing and `media_start`; fade and slide transitions landing on the
  expected frames (per-frame luma), in clip-local time; `--codec vp9`, `--codec prores`, `--quality`;
- `preview` with `--max-duration`; every failure kind above except `internal`, including a
  real timeout and a real SIGTERM;
- every shipped template fills into a valid request (with only its required values and with all of
  them); the lower third renders to ProRes 4444 with alpha exactly 0 outside the bar and the bar at
  the 75% opacity the template sets (read from the raw alpha plane, FFmpeg 6.1 and 7.0);
- `batch`: RFC 4180 CSV (quotes, CRLF, BOM), Shift_JIS refused as UTF-8 with a hint and read with
  `--encoding shift_jis`, all rows validated before any render, one verified file per row, per-row
  failure and `--fail-fast` reporting with a real failing Chrome;
- fonts shipped with the scene: `@font-face` on a copied file, accepted by `hyperframes lint`, and
  a render whose glyphs differ from the default font's and repeat exactly; `--font` on `template`
  and `batch`; `doctor`'s fontconfig report is `unknown` (never `missing`) without fontconfig;
- the MCP server over real stdio: initialize, tools/list equal to the contract, tools/call results
  equal to the tools' own documents, `isError` on failures, notifications unanswered, unknown
  arguments refused;
- `--dry-run` of every tool behind recording fake binaries;
- docs ↔ contract consistency and the frozen CLI surface.

Not verified (said plainly rather than claimed):

- **Windows**: not supported in this release (the argv shims are POSIX sh); no Windows CI.
- **Offline rendering** is checked on Linux only (by hand, and by a CI step that renders inside a
  network namespace with only loopback up and compares the file with a networked render); not on macOS.
- **macOS**: covered only by CI (installs ffmpeg with Homebrew and chrome-headless-shell with
  `hyperframes browser ensure`); never run on a macOS machine by hand.
- Determinism **across machines** is not promised (fonts, Chrome build, ffmpeg build).
- **Japanese / CJK glyph forms from system fonts are not guaranteed**, and `lang` does not fix it:
  on the Ubuntu machine used for testing, fontconfig picked the Chinese font WenQuanYi for
  `:lang=ja` although IPAGothic was installed, and 直 骨 写 rendered in Chinese forms with
  `lang=ja`. Ship the font with the scene instead (request `fonts`, `--font` on `template` /
  `batch`): with IPAGothic shipped that way the same text rendered in Japanese forms (checked by
  eye). `doctor` reports what fontconfig picks per language and warns when Japanese and Chinese
  get the same font.
- Audio, free-form animation (anything beyond fade / slide / zoom transitions), sub-compositions
  and captions are not implemented. `zoom` is checked in the markup and by lint only,
  not by a pixel test.

## MCP server

`hyperframes-skill mcp` (or `node bin/hyperframes-skill.mjs mcp`) is a stdio MCP server with no
extra dependency. `tools/list` is generated from the contract (one MCP tool per tool, input
properties = the contract's `input_schema` names); `tools/call` runs the tool's own script with
`--json` and returns its result document unchanged, as text and as `structuredContent`, with
`isError` true exactly when `status` is not `completed`. Relative paths resolve against the
server's working directory. Example client entry (Claude Desktop `claude_desktop_config.json`):

```json
{"mcpServers": {"hyperframes": {"command": "node", "args": ["/path/to/hyperframes-skill/bin/hyperframes-skill.mjs", "mcp"]}}}
```

The tool names and property names are frozen by `tests/fixtures/mcp_tools.json`, the same way
the CLI surface is.

## Development

```bash
npm test                     # everything, including real renders (~1 min)
npm run test:fast            # skips the tests that launch Chrome
UPDATE_SNAPSHOT=1 node --test tests/contract.test.mjs   # after deliberately adding a flag
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for scope, the docs-surfaces rule and the SKILL.md byte
budget, and [CHANGELOG.md](CHANGELOG.md).

## License

MIT
