---
name: hyperframes-skill
description: 'Render video from HTML scenes with HyperFrames (headless Chrome captures every frame, local ffmpeg encodes them): turn an already-decided scene description (size, duration, fps, ordered text/image/video layers with in/out times) into HyperFrames markup, render it to MP4/WebM/MOV, make a fast proxy preview, and read the result back with ffprobe. Use when a job needs title cards, text slates, simple timed layouts of stills and clips rendered to a video file deterministically, or when asked to render an existing HyperFrames composition. Local only: Node >= 22, ffmpeg/ffprobe >= 5, a headless Chromium; no cloud, no API keys.'
---

# hyperframes-skill

Tools live in `scripts/` next to this file: `node <skill-dir>/scripts/<name>.mjs` (or `npx hyperframes-skill <name>`). There are 7 tools: `doctor`, `template`, `scene`, `render`, `probe`, `preview`, `batch`. `--help` on the tool about to run is the cheapest full flag list; `references/scripts.md` has every flag of all seven.

Shared flags, on every tool: `--json` (one result document on stdout: `status`, `verified`, `verification[]`, `commands[]`, `error.kind` on failure) and `--dry-run` (validate and plan; `scene`, `render`, `preview` and `doctor` run nothing and write nothing; `probe` is read-only and still runs ffprobe). Contract: `node <skill-dir>/bin/hyperframes-skill.mjs contract --json`.

## Workflow (always in this order)

0. **Environment, only on failure.** Don't start a job with `doctor`. After a `kind: missing_tool` failure, or when asked what the machine can do, run `doctor --json` and report the capability that is `missing` or `unknown` (they are different: `unknown` means the probe itself failed, not that the thing is absent).
1. **Decide the scene yourself, then write it as a request.** Copy, pacing, which asset goes where, colours, sizes: all yours (or the user's). This skill never invents or changes any of it. Write a `scene_version: 1` JSON request (schema below).
   For a stock layout use a template instead: `template --list`, then `template NAME --set key=value ... -o REQUEST.json` (or `--values values.json`). Templates: `lower-third` (transparent: render with `--codec prores` to key over a live feed), `title-card`, `session-slate`, `break`. Only the values change; the layout is the template's. Japanese (any CJK) text: pass `--font FILE` (e.g. a Noto Sans JP .otf); see Gotchas.
   Many items of the same template (every speaker, every session): `batch ROWS.csv --template NAME [--name-field COLUMN] -o OUT_DIR --json` renders one file per row (header row = value names; empty cell = value left out; `--encoding shift_jis` for a Japanese-Windows Excel CSV). All rows are validated first; report `summary` and every row whose `status` is not `completed`.
2. **`scene REQUEST.json -o SCENE_DIR --json`.** It validates every field (all problems at once), copies the assets into `SCENE_DIR/assets/`, writes `SCENE_DIR/index.html`, and runs `hyperframes lint` on it. Fix the request, never the generated HTML.
3. **`preview SCENE_DIR -o preview.mp4 --json`** (10 fps, draft encode; `--max-duration S` for the first S seconds) and look at it before the expensive render when layout or timing is new.
4. **`render SCENE_DIR -o final.mp4 --json`** (`--codec h264|vp9|prores`, `--quality N` CRF). It is done only when `status` is `completed` and `verified` is `true`: the output was probed and its codec, resolution, fps, frame count and duration match what the scene declares, and the scene directory was left unchanged.
5. **Report the probed numbers**, e.g. "final.mp4: 5.000 s, 1920x1080, 30 fps, 150 frames, h264", from `probe` in the result. A non-zero exit, `status: failed` or `verified: false` is a failure: report `error.kind` and `error.message`; do not retry blindly (`retryable` is always false).
6. **Look at the picture** when it matters: extract a frame from the output (e.g. with ffmpeg-skill's `look`) and view it. A probe cannot see a wrong colour or overlapping text. Without vision, say the pixels were not inspected.

## Scene request (scene_version 1)

```json
{
  "scene_version": 1, "id": "intro", "width": 1920, "height": 1080, "duration": 5, "fps": 30,
  "background": "#000000", "lang": "en",
  "layers": [
    {"type": "video", "id": "bg", "start": 0, "duration": 5, "src": "clips/bg.mp4", "fit": "cover", "media_start": 2},
    {"type": "image", "id": "logo", "start": 0.5, "duration": 4.5, "src": "logo.png", "box": {"x": 1600, "y": 60, "width": 256, "height": 128}, "fit": "contain"},
    {"type": "text", "id": "title", "start": 1, "duration": 3, "text": "Annual Meeting 2026",
     "style": {"font_family": "sans-serif", "font_size": 96, "font_weight": 700, "color": "#ffffff", "align": "center", "valign": "middle", "line_height": 1.2, "background": "transparent"},
     "transition_in": {"type": "slide", "duration": 0.5, "direction": "down", "distance": 60, "easing": "ease_out"},
     "transition_out": {"type": "fade", "duration": 0.5}}
  ]
}
```

- Times are seconds; a layer shows for `[start, start+duration)` and must end within `duration`. Later layers paint on top.
- `box` is pixels, default the full frame. `fit`: `contain` (default), `cover`, `fill`.
- `src` is a local path (relative to the request file). URLs are refused: this skill never fetches.
- Colours: `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, `transparent`. Text is escaped, `\n` breaks lines.
- `transition_in` / `transition_out` (optional, any layer): `fade`; `slide` with `direction` (`left|right|up|down`: the side it enters from / leaves towards) and `distance` (px); `zoom` with `scale` (the scale it starts from / ends at). `duration` in seconds, `easing` `linear` (default), `ease_in`, `ease_out`, `ease_in_out`. In starts at the layer's start, out ends at the layer's end; the two together may not exceed the layer. Slide and zoom also fade.
- Video layers are muted: the output has no audio in this release.
- `fonts` (optional, top level): `[{"family": "JP Gothic", "src": "fonts/NotoSansJP-Bold.otf", "weight": 700, "style": "normal"}]`; `.otf/.ttf/.woff/.woff2`, local file, copied into the scene; a layer uses it by `style.font_family`. Omit `weight` to use the file for every weight.
- Unknown keys are errors, not ignored.

## What this skill does and does not decide

It turns an explicit scene into markup, renders it, and reports what came out. It does not write copy, choose timing, pick or crop to a subject, choose fonts or colours you did not give it, judge whether a frame looks good, or add a transition you did not ask for. Same request + same flags on the same machine gives byte-identical output; anything that depends on taste belongs to the caller.

If a request needs something the five tools do not expose (audio, animation beyond the three transitions, captions, a layout no template has), say so. Never fall back to calling Chrome, ffmpeg or the `hyperframes` CLI directly: that bypasses every check here.

## Gotchas

- `render` needs `-o` with the extension of `--codec`: `.mp4` h264 (default), `.webm` vp9, `.mov` prores (ProRes 4444, no `--quality`).
- An existing output is refused without `--overwrite`; the output may not be inside the scene directory.
- `--fps` default: the scene's `data-fps`, else 30. Integer fps only in this release.
- Fonts: HyperFrames injects `@font-face` rules for families it bundles (it did for `sans-serif` in testing); any other family depends on the machine's fonts. Byte-identical output is promised on the same machine and toolchain, not across machines.
- `kind: render` = page load or capture failed; `kind: encode` = HyperFrames reported the ffmpeg encode failed and a recorded ffmpeg exited non-zero; `timeout` (exit 124) = `--timeout` hit, Chrome and ffmpeg were killed.
- CJK text: ship the font. `lang` alone does **not** pick Japanese glyph forms: with system fonts, fontconfig may give Japanese the same (Chinese) font it gives Chinese, and 直 骨 写 then render in Chinese forms (seen on Ubuntu with WenQuanYi + IPAGothic installed). Use `--font FILE` on `template` / `batch`, or the request's `fonts`; `doctor` reports what fontconfig picks per language and warns about this. One font file serves every weight (no synthesized bold): pass a Bold file for bold text.
- Windows is not supported in this release (the argv-recording shims are POSIX sh).
