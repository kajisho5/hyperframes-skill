# hyperframes-skill execution contract

`hyperframes-skill contract --json` (or `node bin/hyperframes-skill.mjs contract --json`) prints a
machine-readable description of this skill: which tools exist, what each one needs, takes and
writes, how its result is verified, and what an agent may assume about dry-run, input
preservation and repeatability. It is the interface a planning agent consumes instead of
reading `SKILL.md`, which stays written for a coding agent that follows the workflow by hand.

The contract is derived from the code that runs, not maintained beside it:

- the tool list is `lib/registry.mjs`, and each tool's entry script is `scripts/<name>.mjs`;
- every `input_schema` is generated from the tool's own commander `Command` (the object that
  parses its argv) at the moment the contract is printed, so a new flag appears in the
  contract with no other edit; each option's JSON type is attached to the commander `Option`
  itself by `lib/cli.mjs`'s `addOpt()`;
- the facts a parser cannot express (role, capabilities, verification policy, dry-run
  behaviour, repeatability) live in each tool module's `meta` object, next to the code they
  describe, and are checked against the implementation and the docs by `tests/contract.test.mjs`.

There are 7 tools. README, `SKILL.md`, `references/scripts.md` and this file restate the
contract; `tests/contract.test.mjs` checks every one of them against it (tool ids, every flag,
the tool count, the requirement list), so a stale restatement fails CI instead of drifting.

## Versions

| Field | Meaning | Changes when |
|---|---|---|
| `contract_version` | shape of this document (`0.1`) | a key is renamed, removed or changes meaning |
| `skill.version` | package.json version (`0.9.1`) | any release |

## Stability guarantee

Written at v0.1, before anything shipped, so the shape of the promise is decided before the
first breaking temptation arrives. While the major version is 0 a minor release may break it
only when the CHANGELOG lists the break under "Breaking"; from 1.0.0 on it holds for the whole
major.

| Surface | Promise |
|---|---|
| Tool ids (`hyperframes-skill/<name>`) and script names (`scripts/<name>.mjs`) | never removed or renamed |
| CLI arguments (option names, flags, positionals) | never removed, renamed, or made newly required; new optional arguments may be added |
| `--json` output keys, and the keys of `contract --json` / `doctor --json` | never removed or given a different type; new keys may be added |
| Exit codes (0 success, 1 failure, 2 `doctor` undecidable, 124 timeout, 127 missing tool, 128+signal interrupted) | unchanged |
| `error.kind` values (`input`, `render`, `encode`, `missing_tool`, `timeout`, `verification`, `interrupted`, `internal`) | never removed or renamed; new kinds may be added |
| `contract_version` | unchanged; a ToolSpec shape change bumps it and is a major |
| Scene request `scene_version: 1` | a request that validates today keeps validating and renders the same markup; a new request shape gets a new `scene_version`. New optional keys may be added (0.2.0: `transition_in` / `transition_out`; 0.5.0: top-level `fonts`; 0.7.0: `segments`; 0.9.0: `stinger`, `title`); a request without them renders byte-identical markup, pinned by `tests/fixtures/*.index.html` |
| MCP `tools/list` names and `inputSchema` property names (`mcp/server.mjs`, 0.6.0) | derived from the above, so covered by the same promise; frozen by `tests/fixtures/mcp_tools.json` |
| Behaviour of a tool for the same input and arguments | may change only to fix a defect or to track a HyperFrames / Chrome / FFmpeg change, and every such change gets a CHANGELOG line |

Not covered: the wording of `--help`, descriptions, stderr messages and free-text fields
(`detail`, `message`, `hint`, `details.stderr_tail`); the argv HyperFrames chooses for Chrome
and ffmpeg (reported in `commands`, never promised); the internals under `lib/`.

The promise is enforced, not remembered: `tests/contract.test.mjs` pins every tool's argument
names, types and which are required against `tests/fixtures/cli_surface.json`. A removal,
rename or newly required argument fails CI; an addition fails until the snapshot is
regenerated (`UPDATE_SNAPSHOT=1 node --test tests/contract.test.mjs`), so the fixture diff
shows a reviewer exactly what grew.

## Deprecation policy

1. **Deprecate** in a minor release: the old form keeps working unchanged, a one-line warning
   naming the replacement is printed to stderr when it is used, the CHANGELOG entry says
   "deprecated", and `--help` marks it `(deprecated: use ...)`. `lib/cli.mjs`'s `addOpt(...,
   {deprecated: {replacement}})` does the warning and the `--help` mark; the contract's
   top-level `deprecated` list carries `{what, since, replacement, removed_in, where}`.
2. **Keep** it for at least two further minor releases or 90 days, whichever is longer.
3. **Remove** it only in the next major, listed in that release's CHANGELOG under "Removed",
   together with the version that first deprecated it.

A defect fix that changes behaviour is not a deprecation: it ships in a patch with a
CHANGELOG line.

## Skill

```json
{
  "skill_id": "hyperframes-skill", "version": "0.9.1",
  "provides": [{"id": "html_scene.render", "lifecycle": "EXPERIMENTAL", "tool_id": "hyperframes-skill/render"}, "..."],
  "dependencies": [],
  "contract_version": "0.1",
  "deprecated": [],
  "skill": {"id": "hyperframes-skill", "version": "0.9.1", "execution_mode": "local", "kind": "execution",
            "entrypoints": {"cli": "...", "scripts": "...", "contract": "...", "doctor": "..."},
            "not_provided": ["AI reasoning", "creative or compositional decisions", "..."]},
  "requirements": {"node": ">=22", "hyperframes": "0.8.61", "chromium": "...", "ffmpeg": ">=5.0", "ffprobe": ">=5.0"},
  "execution": {"shell": false, "arbitrary_executables": false, "network": false, "input_mutation": false, "telemetry": false, "argv_recorder": "..."},
  "exit_codes": {...}, "error": {"kinds": {...}, "retryable": false},
  "tools": [ToolSpec, ...]
}
```

`skill_id`, `version`, `provides` and `dependencies` are the AI Video Production OS registry's
keys: `provides` names one capability per tool except `doctor` (`html_scene.<tool>`, with its
`tool_id`), and `dependencies` lists other Skills this one calls, none today (ffmpeg and ffprobe
are run directly; the engines it needs are under `requirements`).

`requirements.node` is `>=22` because the pinned `hyperframes` package declares
`engines.node >=22`. `hyperframes` is pinned to an exact version: a HyperFrames upgrade is a
deliberate change with its own CHANGELOG line and a full render test run, never a silent
`npm install` drift.

`execution.network: false`: every HyperFrames invocation runs with telemetry, the update check
and auto-install turned off (`HYPERFRAMES_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`,
`HYPERFRAMES_NO_UPDATE_CHECK=1`, `HYPERFRAMES_NO_AUTO_INSTALL=1`), Chromium is always given
explicitly (so HyperFrames never downloads one), and scene requests refuse URL sources. Checked
on Linux by rendering inside a network namespace with only loopback up (`unshare -n`): the
render succeeds and is byte-identical to the networked one. CI repeats that on Linux
(`.github/workflows/ci.yml`, "Render with no network"); macOS is not checked.

`execution.argv_recorder`: `render` and `preview` run HyperFrames as
`node --require lib/argv-recorder.cjs <hyperframes cli> render ...` (and put the same preload in
`NODE_OPTIONS`). Inside HyperFrames the preload wraps `child_process`: for each chrome, ffmpeg or
ffprobe process HyperFrames starts, it writes the argv to a log, then starts the process unchanged.
That is how `commands` carries the argv that actually ran, on Linux, macOS and Windows alike
(design-decisions D10). No user string is evaluated by a shell, and no script is generated.

## ToolSpec

One entry per tool under `tools`, sorted by id.

| Field | Meaning |
|---|---|
| `id`, `name`, `version`, `executable` | `hyperframes-skill/render`, `render`, skill version, `scripts/render.mjs` |
| `role` | `analysis` (measures, writes nothing: doctor, probe), `analysis_and_execution` (none yet), `execution` (writes an artifact: template, scene, render, preview, batch) |
| `capabilities.required` | capabilities (names below) the tool always needs |
| `capabilities.optional[]` | `{capability, when}`: needed only for that flag, e.g. `{capability: "encoder:libvpx-vp9", when: "--codec vp9"}` |
| `inputs`, `outputs` | in words |
| `input_schema` | from commander: `properties` keyed by option attribute name with `type`, `cli`, `short`, `enum`, `default`, `description`, `negated_flag`; `required`; `positional` (order) |
| `output_schema` | what `--json` prints, in words |
| `supports_dry_run`, `dry_run` | whether `--dry-run` exists and exactly what it still does |
| `supports_json` | whether `--json` exists (always true) |
| `mutates_input` | always `false` |
| `produces_artifact` | writes a file or directory |
| `verification` | `{required, tools}`: which tools to run on the output afterwards |
| `deterministic_inputs`, `idempotency_hint` | see Repeatability |

### Capabilities

`node`, `hyperframes`, `chromium:headless`, `ffmpeg`, `ffprobe`, `encoder:libx264`,
`encoder:libvpx-vp9`, `encoder:prores_ks`, `disk:tmp`, and the optional `ffmpeg-skill`. The encoder names are the ones
HyperFrames 0.8.61 was observed passing to ffmpeg for each `--codec` (recorded in `commands`).

`doctor` reports each as `available`, `missing` or `unknown`, and never folds them together:

| Capability | available | missing | unknown |
|---|---|---|---|
| `node` | running Node >= 22 | older Node | – |
| `hyperframes` | installed version == pinned and `hyperframes --version` ran | not installed, or a different version | installed but `--version` failed |
| `ffmpeg`, `ffprobe` | found, `-version` parsed, major >= 5 | not found, or major < 5 | found but `-version` failed or did not parse |
| `encoder:*` | listed by `ffmpeg -encoders` | not listed | the listing could not be read |
| `chromium:headless` | found and a headless `--dump-dom` of a probe page printed the marker | nothing found in any searched location, or `HYPERFRAMES_BROWSER_PATH` names a missing file | found but the probe failed or timed out, or `--no-chromium-probe` |
| `disk:tmp` | >= 1 GiB free in the temp dir | less | `statfs` failed |
| `ffmpeg-skill` (optional, never affects `ok`) | a checkout with `scripts/probe.py` found (same search as `render`) and a Python to run it; nothing is run | no checkout, or no Python | – |

Chromium search order (the first existing one is what `render` uses, so doctor and a render
always talk about the same binary): `HYPERFRAMES_BROWSER_PATH`; HyperFrames' own download
(`~/.cache/hyperframes/chrome`, source `bundled`); `~/.cache/puppeteer`; Playwright
(`$PLAYWRIGHT_BROWSERS_PATH` or `~/.cache/ms-playwright`); `chromium`, `chromium-browser`,
`google-chrome`, `google-chrome-stable`, `chrome` on PATH; the macOS app bundles. ffmpeg and
ffprobe: `HYPERFRAMES_SKILL_FFMPEG` / `HYPERFRAMES_SKILL_FFPROBE`, else PATH.

`doctor --json` also carries `fonts`: per CJK language (`ja`, `zh-cn`, `ko`) the fontconfig
coverage (`fc-list :lang=X`) and pick (`fc-match :lang=X`), `available` / `missing` / `unknown`
(no fontconfig on PATH is `unknown`, never `missing`), and an `advice` line when Japanese and
Chinese get the same font. Informational: it never changes `ok` or any tool's `usable`, because
a scene that ships its font does not use the machine's fonts.

`doctor` exits 0 when every required capability is available, 1 when one is missing, 2 when
none is missing but one is unknown; `ok` is true only for 0. Its `tools` field folds that per
tool: `{"render": {"usable": "yes"|"no"|"unknown", "missing": [...], "unknown": [...]}}`.

### Roles and verification policy

| Tool | Role | After it wrote an artifact, run |
|---|---|---|
| doctor | analysis | – |
| probe | analysis | – (it is the verification) |
| template | execution | scene (validates the request again and writes the markup) |
| scene | execution | preview (the markup is only proven by rendering it) |
| render | execution | probe (already run inside; `verified` carries it) |
| preview | execution | probe (already run inside) |
| batch | execution | probe (already run inside, per row; `verified` is true only when every row is) |

### Dry run

Measured, not declared: `tests/dryrun.test.mjs` runs every tool with `--dry-run` behind fake
chrome/ffmpeg/ffprobe binaries that record any call, and asserts no call happened and no file
appeared. `scene` validates the request and every asset path; `render`/`preview` read
`index.html`, check the declared values and the output path, and report `planned_commands`
and `expected` (including the frame count); `doctor` lists the probes it would run. The
exception is `probe`: read-only, ffprobe still runs. `commands` under `--dry-run` is always
the empty list: it only ever lists what ran.

### Repeatability

No tool keeps state or uses randomness. `idempotency_hint`:

| Hint | Tools |
|---|---|
| `bit_exact` | scene (same request, same bytes), probe, render and preview **on the same machine and toolchain** |
| `environment_dependent` | doctor |

`render` is `bit_exact` because HyperFrames renders are deterministic and this skill removes
the two machine-state inputs it controls: GPU capture is always off (`--no-browser-gpu`,
SwiftShader) and SDR is always forced (`--sdr`). `tests/render.test.mjs` renders the fixture
twice and compares sha256 of the files and ffmpeg framemd5 of every frame. Across machines,
fonts, the Chrome build and the ffmpeg build can all differ; the hint does not cover that.

## Result documents

Every tool ends in exactly one success or failure document (`--json`), with the same shape
from the CLI or any later MCP server.

| Key | Source | A wrong value would look like |
|---|---|---|
| `status` | `"completed"` only from `emit()`; every failure path goes through `fail()` | a Chrome capture error reported as success |
| `exit_code` | the process exit code, repeated | – |
| `verified` | computed inside `emit()` as the conjunction of the `verification[]` steps this run performed; never passed in; `false` on a dry run and on every failure | `true` for a file never probed |
| `verification[]` | `{step, ok, expected?, actual?, detail?}`: render/preview: `exists`, `probe`, `codec`, `resolution`, `fps`, `frames`, `duration` (a PNG sequence: `exists`, `probe`, `codec`, `resolution`, `frames`), `alpha` (vp9, prores, png: the first frame's alpha plane decoded), `input_preserved`, then for render `ffmpeg_skill` only when `ffmpeg_skill.status` is `PASSED` or `FAILED`, then with `render --segments` `segments` and `loop_seam`, then for a stinger `stinger_cover` and for stinger or title material `sidecar` (written only when every earlier step held); scene: `exists`, `assets_copied` (only with assets), `declared_values`, `segments` (only with segments), `material` (only with `stinger` or `title`), `hyperframes_lint` | a step listed that did not run |
| `error.kind` | see below | a generic catch-all |
| `error.retryable` | always `false` | `true` invites a blind retry loop |
| `commands[]` | `{program, argv, exit_code, via?, role?}` for every process that ran, in start order: the hyperframes CLI, then each chrome/ffmpeg/ffprobe process it started (`via: "hyperframes"`, `role` = `chrome` / `ffmpeg` / `ffprobe`); `program` is the executable's file name without a Windows `.exe`, then this skill's own ffprobe, then (render, when present) ffmpeg-skill's probe (`role: "ffmpeg-skill/probe"`) | a command that wasn't the one executed |
| `segments` (scene; render with `--segments`) | scene: each segment's `start`, `duration`, `start_frame`, `frames` from the validated request and the composition it wrote (`html`, `null` for a 0-frame segment); render: the same plus each segment file's own `probe`, `verification[]` and `ffmpeg_skill`, rendered from `segments/<name>.html` (design-decisions D12) | frame counts computed rather than probed |
| `alpha` (render; probe with `--alpha`) | the first frame's alpha plane, decoded by ffmpeg `alphaextract` (`lib/alpha.mjs`): `min`, `max`, `corners`, `samples`; `mode` is stated, `straight` for every alpha output (HyperFrames pipes straight-alpha PNG captures into the encoder; pinned by a 50% layer whose colour keeps full blue, design-decisions D13), `none` for h264 | an alpha value reported without the frame being decoded |
| `loop_seam` (render with `--segments`) | the loop file decoded to 64x64 grey: `wrap_diff` (last frame → first) against `max_step_diff` (largest step between consecutive frames) + `tolerance`; `measured: false` with a `reason` when it could not be decoded, which fails the step | a seam reported without the file being decoded |
| `stinger` (render, stinger material) | the alpha plane of every frame in the stated cover window `[cover.start, cover.end)`, decoded by ffmpeg `alphaextract` (`lib/alpha.mjs`): per frame `min` and `below` (pixels under 253/255, qc-skill's opaque threshold), and `cut_point_min_alpha`; `stinger_cover` fails when any pixel of any of those frames is below | a cover reported without the frames being decoded |
| `sidecar` (render and batch rows, stinger or title material) | `{kind, path, schema, fields: {read, proposed}, content}`: `<stem>.stinger.json` / `<stem>.title.json` as written beside the output (`lib/sidecar.mjs`, design-decisions D14); `fields.read` are the ones a receiver reads today (`cut_point`, `cover`; `segments`), `fields.proposed` the ones the Velisa spec marks PROPOSED; `written: false` when a verification step failed, since a sidecar only describes a verified file | a sidecar for a file that failed verification |
| `kit` (template and batch rows, with `--kit`) | `{file, schema, applied: [{field, to, value}], overridden: [{field, to, by}], unused: [{field, reason}]}` from `lib/kit.mjs`: every field the kit file has is in exactly one list (`schema` is checked, not listed); `applied` values are the ones written into `values` (colours as `#RRGGBB`, paths absolute); the template's `kit` map (`template --list`) decides what can be applied (design-decisions D15) | a kit colour silently dropped, or a brand.json default filled in |
| `ffmpeg_skill` (render) | `PASSED` / `FAILED` / `UNCHECKED` from reading the output back through ffmpeg-skill/probe (`lib/ffmpeg-skill.mjs`, design-decisions D3), with `skill.version`, `measured`, `checks[]`; `UNCHECKED` always has a `reason` and adds no `verification[]` step | `PASSED` without ffmpeg-skill having run |

`exit_code` inside `commands` is `null` for chrome: HyperFrames ends the browser itself at the end
of every render, so its exit status says nothing about the render and is not recorded.

`error.kind`:

| kind | exit | when |
|---|---|---|
| `input` | 1 | bad request, flag, path; output exists without `--overwrite`; output inside the scene |
| `render` | 1 | HyperFrames failed and the evidence does not show an encode failure: Chrome did not start, page load or capture failed |
| `encode` | 1 | HyperFrames' own failure message names FFmpeg/the encode **and** a recorded ffmpeg process exited non-zero (both required; `details.classification` shows the evidence) |
| `missing_tool` | 127 | ffmpeg, ffprobe, Chromium or the hyperframes package not found |
| `timeout` | 124 | `--timeout` elapsed; the whole process group (Chrome, ffmpeg) was killed |
| `verification` | 1 | the artifact was written but a verification step failed (including `ffmpeg_skill` when ffmpeg-skill measured a mismatch or refused the file); the document still carries `verification[]`, `probe` and, for render, `ffmpeg_skill` |
| `interrupted` | 128+signal | SIGINT/SIGTERM/SIGHUP; the process group was killed |
| `internal` | 1 | a bug in this skill (an exception that is not a ToolError) |

## Sidecars: `stinger.json` and `title.json`

`render` (and each `batch` row) writes one beside the output when the scene is stinger or title
material: `final.mov` → `final.stinger.json` / `final.title.json` (a PNG sequence directory
`frames/` → `frames.stinger.json`). The shape is the Velisa spec for title and stinger metadata
(AI-video-production-OS `docs/specs/title-and-stinger.md`). No receiver opens the file; the
caller reads it and passes the values on as request fields, unrounded. Nothing outside the spec
is written. Every field is one of two kinds, and the result's `sidecar.fields` lists which:

- **read**: a receiver reads it today;
- **proposed**: the spec marks it PROPOSED; no receiver reads it yet, and a caller must not rely
  on a receiver checking it.

Times are seconds on the file's own timeline, written as `frame / frame_rate` exactly (at 24 fps
frame 25 is `1.0416666666666667`, never `1.042`), so a receiver's "on a frame within 1/1000"
check holds.

`stinger.json`:

| Field | Kind | Value |
|---|---|---|
| `cut_point` | read (video-editing-skill, qc-skill, the agent) | the frame the edit cuts at, seconds |
| `cover` | read (video-editing-skill, qc-skill, the agent) | `{start, end}`, seconds: every pixel of every frame at `start <= t < end` is at alpha >= 253/255, measured by `stinger_cover` |
| `schema` | proposed | `"velisa/stinger@1"` |
| `file` | proposed | the output's file name (a PNG sequence: its directory name) |
| `sha256` | proposed | the output file's content; absent for a PNG sequence directory |
| `frame_rate` | proposed | `"<fps>/1"` |
| `duration`, `frames` | proposed | as probed |
| `cut_point_frame` | proposed | `cut_point * frame_rate` |
| `cover_frames` | proposed | `{start, end}` in frames |
| `alpha` | proposed | `"straight"` (every alpha output of this skill) |
| `audio` | proposed | `false`: a render carries no sound in this release |

`title.json`:

| Field | Kind | Value |
|---|---|---|
| `segments` | read (hyperframes-skill's own `scene` / `render --segments`; the caller maps it to motion-graphics-skill `rendered_layer` `in_duration` / `out_duration` / `loop`) | `{in, loop, out}` seconds, whole frames, adding up to the clip |
| `schema` | proposed | `"velisa/title@1"` |
| `file`, `sha256`, `frame_rate` | proposed | as in `stinger.json` |
| `alpha` | proposed | `"straight"`; absent for h264 (no alpha plane) |
| `segment_frames` | proposed | `{in, loop, out}` in frames |
| `loop_seam` | proposed | the result's `loop_seam`, copied; only with `--segments` |
| `safe_area` | proposed | the request's `title.safe_area`: every text box is inside it |
| `text` | proposed | `[{role, text, lang, font, font_size}]` per text layer: the layer id, the text, the scene's `lang`, `style.font_family` and `style.font_size` (no text is fitted yet, so the size used is the size given) |
