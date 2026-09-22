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
| `skill.version` | package.json version (`0.6.0`) | any release |

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
| Scene request `scene_version: 1` | a request that validates today keeps validating and renders the same markup; a new request shape gets a new `scene_version`. New optional keys may be added (0.2.0: `transition_in` / `transition_out`; 0.5.0: top-level `fonts`); a request without them renders byte-identical markup, pinned by `tests/fixtures/*.index.html` |
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
  "contract_version": "0.1",
  "deprecated": [],
  "skill": {"id": "hyperframes-skill", "version": "0.6.0", "execution_mode": "local", "kind": "execution",
            "entrypoints": {"cli": "...", "scripts": "...", "contract": "...", "doctor": "..."},
            "not_provided": ["AI reasoning", "creative or compositional decisions", "..."]},
  "requirements": {"node": ">=22", "hyperframes": "0.8.61", "chromium": "...", "ffmpeg": ">=5.0", "ffprobe": ">=5.0"},
  "execution": {"shell": false, "arbitrary_executables": false, "network": false, "input_mutation": false, "telemetry": false, "argv_shims": "..."},
  "exit_codes": {...}, "error": {"kinds": {...}, "retryable": false},
  "tools": [ToolSpec, ...]
}
```

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

`execution.argv_shims`: `render` and `preview` point HyperFrames at generated POSIX `sh` shims
for chrome, ffmpeg and ffprobe that write their argv to a log and run the real binary with
`"$@"`. That is how `commands` carries the argv that actually ran. No user string is evaluated
by a shell.

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
`encoder:libvpx-vp9`, `encoder:prores_ks`, `disk:tmp`. The encoder names are the ones
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
| `verification[]` | `{step, ok, expected?, actual?, detail?}`: render/preview: `exists`, `probe`, `codec`, `resolution`, `fps`, `frames`, `duration`, `input_preserved`; scene: `exists`, `assets_copied` (only with assets), `declared_values`, `hyperframes_lint` | a step listed that did not run |
| `error.kind` | see below | a generic catch-all |
| `error.retryable` | always `false` | `true` invites a blind retry loop |
| `commands[]` | `{program, argv, exit_code, via?, role?}` for every process that ran, in start order: the hyperframes CLI, then each chrome/ffmpeg/ffprobe process it started (`via: "hyperframes"`, `role` = which shim), then this skill's own ffprobe | a command that wasn't the one executed |

`exit_code` inside `commands` is `null` for chrome: its shim `exec`s the browser so HyperFrames
can manage the process directly, which leaves no place to observe its exit status.

`error.kind`:

| kind | exit | when |
|---|---|---|
| `input` | 1 | bad request, flag, path; output exists without `--overwrite`; output inside the scene |
| `render` | 1 | HyperFrames failed and the evidence does not show an encode failure: Chrome did not start, page load or capture failed |
| `encode` | 1 | HyperFrames' own failure message names FFmpeg/the encode **and** a recorded ffmpeg process exited non-zero (both required; `details.classification` shows the evidence) |
| `missing_tool` | 127 | ffmpeg, ffprobe, Chromium or the hyperframes package not found |
| `timeout` | 124 | `--timeout` elapsed; the whole process group (Chrome, ffmpeg) was killed |
| `verification` | 1 | the artifact was written but a verification step failed; the document still carries `verification[]` and `probe` |
| `interrupted` | 128+signal | SIGINT/SIGTERM/SIGHUP; the process group was killed |
| `internal` | 1 | a bug in this skill (an exception that is not a ToolError) |
