# Tool reference

Every flag of all 7 tools. `tests/contract.test.mjs` checks this file against each tool's real parser: a flag missing here, or listed here but not accepted, fails CI.

All tools: `--json` prints one result document; `--dry-run` validates and plans without launching Chrome or ffmpeg or writing files (`probe` still runs ffprobe).

## batch

`hyperframes-skill/batch` · role `execution`

Render one video per row of a CSV or JSON file through a template (e.g. every speaker's lower third from the programme sheet). Every row is validated before the first render; each output is verified like render's.

Usage: `node scripts/batch.mjs <rows> [options]`

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--json` | boolean |  | print one JSON result document on stdout |
| `--dry-run` | boolean |  | validate and plan without launching Chrome or ffmpeg or writing files |
| `--template` | string | required | template every row fills (see `template --list`); the columns are its value names |
| `-o, --output` | string | required | output directory (created) |
| `--name-field` | string |  | column whose value names each file (<row number>-<value>); default: the row number only |
| `--encoding` | utf-8 \| shift_jis | `utf-8` | text encoding of a CSV file |
| `--codec` | h264 \| vp9 \| prores | `h264` | h264 (.mp4), vp9 (.webm) or prores (.mov, keeps alpha) |
| `--quality` | integer |  | CRF, as render's --quality |
| `--workers` | integer\|auto | `auto` | parallel capture workers per render: auto or 1-8 |
| `--timeout` | number | `1800` | per-row render timeout; 0 disables |
| `--fail-fast` | boolean |  | stop at the first row that fails (the rest are reported as skipped) |
| `--overwrite` | boolean |  | replace this batch's own outputs and scene directories if they exist |

Dry run: reads and validates every row against the template and reports each planned output, its expected frame count and name; launches neither Chrome nor ffmpeg and writes nothing.

## doctor

`hyperframes-skill/doctor` · role `analysis`

Probe this machine now: Node version, the pinned hyperframes package, ffmpeg/ffprobe and their encoders, a working headless Chromium, free temp space. Each capability is available, missing or unknown; nothing is reported that was not probed.

Usage: `node scripts/doctor.mjs [options]`

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--json` | boolean |  | print one JSON result document on stdout |
| `--dry-run` | boolean |  | validate and plan without launching Chrome or ffmpeg or writing files |
| `--no-chromium-probe` | boolean |  | skip launching Chromium (chromium:headless is then unknown, never available) |

Dry run: lists the probes it would run (argv) and runs none of them.

## preview

`hyperframes-skill/preview` · role `execution`

Fast proxy render of a scene directory for checking layout and timing before the full render: lower frame rate, HyperFrames' draft encoder preset, optionally only the first N seconds. Same resolution as the scene.

Usage: `node scripts/preview.mjs <scene_dir> [options]`

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--json` | boolean |  | print one JSON result document on stdout |
| `--dry-run` | boolean |  | validate and plan without launching Chrome or ffmpeg or writing files |
| `-o, --output` | string | required | proxy .mp4 to write |
| `--fps` | integer | `10` | proxy frame rate, integer 1-240 |
| `--max-duration` | number |  | render only the first N seconds (a staged copy of the scene is shortened; the scene itself is untouched) |
| `--workers` | integer\|auto | `auto` | parallel capture workers: auto or 1-8 |
| `--timeout` | number | `1800` | kill the render after this long; 0 disables |
| `--overwrite` | boolean |  | replace an existing output file |

Dry run: same as render: validates and reports the planned command and expected frame count; launches neither Chrome nor ffmpeg and writes nothing.

## probe

`hyperframes-skill/probe` · role `analysis`

Read a media file back with ffprobe: duration, resolution, fps, frame count, codecs.

Usage: `node scripts/probe.mjs <file> [options]`

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--json` | boolean |  | print one JSON result document on stdout |
| `--dry-run` | boolean |  | validate and plan without launching Chrome or ffmpeg or writing files |
| `--no-count-frames` | boolean |  | do not decode to count frames when the container does not state them (frames is then null) |

Dry run: read-only: ffprobe still runs under --dry-run (measuring is the tool's whole job); nothing is written either way.

## render

`hyperframes-skill/render` · role `execution`

Render a HyperFrames scene directory to video: headless Chrome captures every frame, ffmpeg encodes them; the result is probed and compared with the scene's declared size, duration and fps.

Usage: `node scripts/render.mjs <scene_dir> [options]`

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--json` | boolean |  | print one JSON result document on stdout |
| `--dry-run` | boolean |  | validate and plan without launching Chrome or ffmpeg or writing files |
| `-o, --output` | string | required | video file to write; its extension must match --codec |
| `--codec` | h264 \| vp9 \| prores | `h264` | h264 (.mp4), vp9 (.webm) or prores (.mov, ProRes 4444) |
| `--quality` | integer |  | CRF, codec-neutral scale (lower is better): h264 0-51, vp9 0-63; not for prores. Default: HyperFrames' own default (CRF 16) |
| `--fps` | integer |  | frame rate, integer 1-240 (default: the root's data-fps, else 30) |
| `--workers` | integer\|auto | `auto` | parallel capture workers: auto or 1-8 |
| `--timeout` | number | `1800` | kill the render (Chrome and ffmpeg included) after this long; 0 disables |
| `--overwrite` | boolean |  | replace an existing output file |

Dry run: reads index.html, checks the root's declared size/duration/fps and the output path, and reports the hyperframes command it would run and the expected frame count; launches neither Chrome nor ffmpeg and writes nothing.

## scene

`hyperframes-skill/scene` · role `execution`

Turn a structured scene request (JSON: size, duration, fps, ordered text/image/video layers with in/out times) into a HyperFrames scene directory (index.html + copied assets).

Usage: `node scripts/scene.mjs <request> [options]`

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--json` | boolean |  | print one JSON result document on stdout |
| `--dry-run` | boolean |  | validate and plan without launching Chrome or ffmpeg or writing files |
| `-o, --output` | string | required | scene directory to write (created; must be empty or absent) |
| `--overwrite` | boolean |  | replace index.html and assets/ in a directory an earlier `scene` run wrote |

Dry run: validates the request and every asset path and reports the files it would write; writes nothing and does not run hyperframes lint.

## template

`hyperframes-skill/template` · role `execution`

Fill one of the skill's scene templates (lower-third, title-card, session-slate, break) with caller-given values and write the resulting scene request JSON for `scene`. --list shows every template and the values it takes.

Usage: `node scripts/template.mjs [name] [options]`

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--json` | boolean |  | print one JSON result document on stdout |
| `--dry-run` | boolean |  | validate and plan without launching Chrome or ffmpeg or writing files |
| `-o, --output` | string |  | scene request JSON to write |
| `--values` | string |  | JSON object of template values |
| `--set` | string[] |  | one template value; repeatable; overrides --values |
| `--list` | boolean |  | list the templates and the values each takes |
| `--overwrite` | boolean |  | replace an existing output file |

Dry run: resolves and validates the values and the filled request and reports it; writes nothing.
