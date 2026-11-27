# Design decisions

Behaviour that looks like a bug but is intentional. An entry is added the first time a
reviewer (human or agent) reports something here as a defect and it turns out to be
deliberate: the decision, why, and the test that pins it, so the next review does not report
it again.

Format:

```
## D<n>. <one-line statement of the behaviour>

- **Reported as:** what the reviewer thought was wrong (link the review if there is one)
- **Decision:** what the code does and will keep doing
- **Why:** the reason, including what the alternative would break
- **Pinned by:** the test that fails if it changes
```

## D1. The first release tags package.json's version unchanged; later releases bump from labels

- **Reported as:** the release workflow did not bump the version on the first merge after it
  was added, and it releases a version written by hand in a PR without looking at labels.
- **Decision:** `.github/scripts/release.mjs plan` releases `package.json`'s version as it stands
  whenever that version has no `vX.Y.Z` tag (`mode=manual`). Only when the version already equals
  the newest tag, and commits landed since, do the labels of the PRs merged since that tag pick a
  major / minor / patch bump through `.github/release-drafter.yml`'s `version-resolver`
  (`mode=auto`), and the workflow commits the bump with the tag.
- **Why:** 0.6.0's features (the MCP server) were already in `CHANGELOG.md` and `package.json`
  as 0.6.0 when the workflow arrived, with nothing ever tagged; a label-driven bump on the first
  run would have shipped them as 0.6.1 or 0.7.0 and left a 0.6.0 that never existed. It is also
  the rule audio-production-skill and video-editing-skill use (their `compute_version.sh`), so a
  breaking change can still be released as a deliberate hand bump.
- **Pinned by:** `tests/release.test.mjs` ("first release: no tag yet, ...", "a hand bump in a
  PR is released as written, ...").

## D2. Releases run on workflow_run after CI, and only for pushes to main in this repository

- **Reported as:** `release.yml` could just be `on: push: branches: [main]` like the siblings'.
- **Decision:** it runs on `workflow_run` of `CI` and its job requires `conclusion == 'success'`,
  `event == 'push'`, `head_repository.full_name == github.repository` and
  `head_branch == 'main'`, checks out `head_sha`, and is the only job with `contents: write`
  (workflow default `contents: read`). Actions are pinned to commit SHAs; versions reach `run:`
  blocks only through `env`, never `${{ }}`.
- **Why:** a release should be a commit whose real-Chrome renders already passed on Ubuntu and
  macOS. `head_branch` alone is a PR's source branch name, which a fork can call `main`; without
  the `event` and `head_repository` checks a fork's PR CI run would get its code checked out with
  `contents: write` and the npm token (the artifacts-skill #66 fix).
- **Pinned by:** `tests/release.test.mjs` (the three workflow-hardening tests).

## D3. HyperFrames renders with its own engine, not through ffmpeg-skill; ffmpeg-skill reads the output back

- **Reported as:** the 2026-10-30 ecosystem audit ([ECOSYSTEM_ROADMAP.md](../ECOSYSTEM_ROADMAP.md),
  "Wiring"): this skill "calls ffmpeg/ffprobe directly, bypassing ffmpeg-skill", the ecosystem's
  engine for every media operation.
- **Decision:** the render path stays as it is: the pinned `hyperframes` CLI captures frames in
  headless Chrome and pipes them into the ffmpeg it launches itself (through the argv recorder,
  D10, so `commands` shows the real encode). The gap is closed on the output side instead:
  after every real `render`, when an ffmpeg-skill checkout is present, `lib/ffmpeg-skill.mjs` runs
  ffmpeg-skill's own probe on the file (`python3 <dir>/scripts/probe.py --json -- <output>`, no
  shell, ffmpeg-skill never imported or modified) and compares codec, resolution, fps, duration
  and, for `--codec vp9`/`prores`, alpha with what the scene asked for. The result carries
  `ffmpeg_skill.status`:
  - `PASSED`: every property measured and matched; adds `verification[]` step `ffmpeg_skill`.
  - `FAILED`: ffmpeg-skill refused the file (corrupt, empty, no video stream) or measured a
    mismatch; the step is `ok: false` and the render fails with `kind: verification`.
  - `UNCHECKED` + `reason`: no checkout, no Python, ffmpeg-skill gave no usable result (did not
    start, timed out, printed no JSON), or a property it cannot measure. No step is added, so it
    is never counted as a pass, and an absent optional dependency never fails a render.
  ffmpeg-skill is found the way the other ecosystem skills find it (color-grading-skill's
  adapter): `--ffmpeg-skill DIR` alone when given, else `HYPERFRAMES_SKILL_FFMPEG_SKILL_DIR`,
  `VIDEO_AGENT_FFMPEG_SKILL_DIR`, `~/.claude/skills/ffmpeg-skill`, `./vendor/ffmpeg-skill`, and
  `ffmpeg-skill` next to this checkout. Its version comes from its `package.json`. There is no
  version gate (the declared range `>=2.0.0 <5.0.0` in the contract's `dependencies` is what it was
  checked against): the probe document's keys are read directly and a missing one is `UNCHECKED`.
- **Why:** HyperFrames streams each captured frame into ffmpeg as it is captured (`image2pipe`,
  visible in `commands`). ffmpeg-skill has no tool that takes such a stream: `sequence.py` encodes
  an image sequence already on disk (h264 / hevc / av1 / prores, no VP9) and `render.py` executes
  its own edit plans. Routing HyperFrames through it would mean writing every frame to disk and
  encoding on a second path with a different codec set (no VP9 alpha), or re-implementing
  HyperFrames' capture/encode loop and losing its tested frame-exact timing and byte-identical
  output, or adding a frame-pipe encoder to ffmpeg-skill, which is finished and not changed from
  here. What the ecosystem actually needs from "use the engine" is
  that the engine vouches for the artifact; reading it back with the same probe every other skill
  uses gives that without touching either engine. `check.py` was not used: it is a platform
  compliance check (duration limit, aspect, loudness, file size against a delivery spec), not a
  comparison with exact requested values, and these renders have no audio for its loudness rows.
  `verify.py` runs the whole toolchain against real footage and writes outputs; it is a test kit.
- **Gaps in ffmpeg-skill (2.21.0 / 2.23.1), recorded rather than worked around:**
  `probe.py` reports neither stream tags nor an alpha field, so VP9 alpha (stored as the
  `alpha_mode=1` stream tag; the stream reads as `yuv420p`) cannot be measured through it and is
  `UNCHECKED`; ProRes alpha is visible in `pix_fmt` (`yuva444p12le`). The probe document carries
  no ffmpeg-skill version, so the version is read from the checkout's `package.json` (`unknown`
  when it has none). ffmpeg-skill finds `ffprobe` on PATH itself; `HYPERFRAMES_SKILL_FFPROBE` does
  not reach it, so the read-back may use a different ffprobe than this skill's own probe step.
  `preview` and `batch` do not cross-check yet.
- **Pinned by:** `tests/ffmpeg-skill.test.mjs` (present → measured fields and `PASSED`; a
  mismatch → `FAILED` and a failed `kind: verification` render; absent → `UNCHECKED`; empty and
  corrupt files → `FAILED`, not a crash) and the end-to-end test in `tests/render.test.mjs`.

## D10. What HyperFrames starts is recorded by a Node preload inside HyperFrames, not by generated shell shims

- **Reported as:** the roadmap's step 4 ([ECOSYSTEM_ROADMAP.md](../ECOSYSTEM_ROADMAP.md)): Windows is unsupported
  because the argv-recording shims are POSIX `sh`, and there is no Windows CI.
- **Decision:** `render` / `preview` point HyperFrames at the real chrome / ffmpeg / ffprobe and run it as
  `node --require lib/argv-recorder.cjs <hyperframes cli> render ...`, with the same preload in `NODE_OPTIONS`.
  The preload wraps `child_process.spawn` / `spawnSync` / `execFile` / `execFileSync` / `fork`, then
  `syncBuiltinESMExports()` so HyperFrames' ES-module imports see the wrappers.
  - For a child whose executable is one of the three paths (matched resolved, case-insensitively on Windows, and
    under its real path too), it writes the argv as `<ns>-<pid>-<seq>-<role>.argv`, NUL-separated, before the
    process starts. These are the same files the shims wrote, so `readArgvLog()` and `commands[]` are unchanged.
  - For ffmpeg and ffprobe it also writes `.rc` with the exit status (128 + n for a signal, as the shell's `$?` was).
  - Nothing about the call changes: the same function gets the same arguments.
  - A process that loads the preload twice installs it once.
  - On Windows a timeout or an interrupt ends the tree with `taskkill /T`, and `/F` for the final kill.
  - `commands[].program` drops `.exe`.
- **Why:** a generated `sh` script cannot be started on Windows, and a `.cmd` wrapper cannot either. Node refuses to
  spawn `.bat` / `.cmd` without a shell (the 2024 security fix), and a shell is exactly what this skill never uses.
  A wrapper executable would need a compiler or a copy of Node per tool. The preload needs neither: HyperFrames is
  already a Node process this skill starts, and the record is made where the call is made, from the argv array
  itself, with no quoting layer in between. The alternatives were worse:
  - Keeping the shims on POSIX and the preload on Windows would mean two code paths to keep equal.
  - Recording nothing on Windows would make `commands[]` untrue there.
  - HyperFrames' own logs are not argv.
  The preload sees only processes started through those five functions. `exec` / `execSync` take a shell command
  line, which is not an argv, and HyperFrames does not start these binaries that way: the end-to-end render test
  requires the chrome and the frame-encoding ffmpeg (`image2pipe`) argv in `commands`, on every CI OS.
- **Pinned by:** `tests/render.test.mjs` ("end to end": the hyperframes argv carries `--require <recorder>`, and the
  recorded roles include chrome and the image2pipe ffmpeg with exit 0), `tests/failures.test.mjs` (a failing encode
  is classified from the recorded ffmpeg exit 1), and CI on `ubuntu-latest`, `macos-latest` and `windows-latest`.
  The tests' fake chrome / ffmpeg are `tests/fixtures/fake-spawn.cjs`, a Node double loaded through
  `NODE_OPTIONS`, for the same reason.

## D11. ffmpeg-skill 3.0.0 is inside the declared range; CI cross-checks against 3.0.0 and the last checked 2.x

- **Context:** ffmpeg-skill 3.0.0 (`1dc2f52`) drops Python 3.9 and FFmpeg 5.x, changes `cut.py`'s defaults and adds
  `timecode` to probe. Its `contract_version` became 2.0 for `cut.py`'s key meanings. The declared range
  `>=2.0.0 <3.0.0` (over its package version, `range_of: "version"`) excluded it.
- **Decision:** the range becomes `>=2.0.0 <4.0.0`. The cross-check runs `probe.py` only and reads `video.codec`,
  `width`, `height`, `fps`, `pix_fmt`, `duration` and `audio`. Its 3.x promise keeps those keys and their types
  (ffmpeg-skill `docs/contract.md`). The range stays informational: there is still no version gate (D3).
- **Python / FFmpeg:** the CI runners have Python ≥ 3.10 (3.12 is set up explicitly on Windows) and FFmpeg ≥ 6.1
  (apt / Homebrew / Chocolatey), which are 3.0's floors.
- **CI:** the job is a matrix over the ffmpeg-skill tag. v3.0.0 runs on Linux, macOS and Windows, and v2.23.1, the
  release this was first checked against, runs on Linux.

## D12. Segments are their own compositions, rendered by HyperFrames; the loop is seamless by refusal, and measured

- **Context:** roadmap step 12 ([ECOSYSTEM_ROADMAP.md](../ECOSYSTEM_ROADMAP.md)): a lower third must hold for any length
  in an edit (IN, the loop repeated, OUT), and the loop must run without a visible seam.
- **Decision:**
  - The request declares `segments: {in, loop, out}`. `scene` writes the full scene to `index.html` (its root carries
    `data-hfs-segments="in=0.5 loop=4 out=0.5"`) and each non-empty segment to `segments/<name>.html`: the same scene
    cut to that window, starting at 0. A layer that overlaps the window keeps it; a layer that started before it gets
    every animation delay moved back by the part cut off (a negative CSS delay starts it partway) and its
    `data-media-start` moved on by the same amount.
  - `render --segments` renders the full scene, then stages a copy of the scene directory per segment with that
    segment's composition as `index.html` (as `preview --max-duration` already stages a shortened copy) and renders it
    with the same flags. Every file goes through the same verification, and the frame counts are added up.
  - The loop is made seamless by refusing what could break it, never by adjusting it. Inside the loop window a layer is
    absent or present throughout, no transition runs, no video plays, and every loop animation's period is a whole
    number of frames that divides the loop's frames. Then the picture at the loop's end is the picture at its start.
  - `loop_seam` measures it anyway on the rendered loop file. The file is decoded to 64x64 grey, and the mean
    difference from its last frame back to its first (`wrap_diff`) must be at most its largest step between two
    consecutive frames (`max_step_diff`) plus 1. This is a read-back, not a proof. It catches a loop that jumps,
    such as a hand-edited composition with a 3 s spin in a 4 s loop (`wrap_diff` 25.6 against `max_step_diff` 14.3).
- **Why:** cutting the full render with ffmpeg (`trim` and a re-encode) would encode every segment twice, after
  HyperFrames' own capture-time encode. It would also add a second encoder path beside HyperFrames' (D3), and an
  h264 cut can only land on keyframes without a re-encode. Rendering each window through HyperFrames keeps one encoder
  path. It also makes the segment frames the full render's frames: on ProRes, every segment frame's colour planes are
  identical to the full render's frame at the same scene time (tested). Only the order of the steps is new: the full
  render still comes first, unchanged. qc-skill's loop seam check (1.3.0) measures audio only, so the video seam is
  measured here.
- **Known gap, measured:** HyperFrames' alpha plane for a *scaled* layer over a transparent background is not
  bit-exact between two renders of the same scene. For a `pulse` loop animation, and for the existing `zoom`
  transition, 1 to 16 of 50 ProRes frames differed in alpha (PSNR 37 to 50 dB) while colour stayed identical. With
  `bob`, `spin` and no loop animation, 3 or 4 runs were identical. `will-change` on the layer made repeated renders
  identical, but it made the segments differ from the full render in colour (PSNR about 32 dB), so it is not used.
  The colour comparison in the test excludes alpha for this reason.
- **Pinned by:** `tests/segments.test.mjs`. It covers validation and refusals, the window markup, the dry-run plan,
  the seam measure on synthetic frames, and the real ProRes render (5 + 40 + 5 = 50 frames, colour frame-identical to
  the full render, seam passes). It also covers the edited loop that fails `loop_seam`.

## D13. Alpha deliveries: VP9, ProRes 4444 and PNG sequences, all straight alpha, read back from the first frame

- **Context:** roadmap step 13: web players take WebM with alpha, NLEs and After Effects take PNG sequences or
  ProRes 4444, and the receiver must know whether the alpha is straight or premultiplied.
- **Decision:**
  - `render --codec png` renders through HyperFrames' own `--format png-sequence`. It writes a directory of RGBA
    `frame_000001.png ...` at `-o`. The output may not carry a video extension. `--overwrite` replaces the directory
    only when it holds nothing but such frames: a directory with anything else in it is refused and left untouched.
    It is verified as a sequence: frames numbered 1..N with N the expected frame count, the first frame RGBA at the
    scene's size. It has no fps or duration step, since a sequence has no rate of its own. ffmpeg-skill's probe
    reads one media file, so a sequence is `UNCHECKED` there, with that reason. `batch` stays video-only.
  - Every alpha render (vp9, prores, png) decodes its first frame's alpha plane. It adds the step `alpha` (the plane
    decoded) and the result key `alpha: {mode, channel, first_frame: {min, max, mean, corners, ...}}`. `probe --alpha`
    reads the same thing from any file or sequence, and `--sample X,Y` reads single pixels. VP9 is decoded with
    libvpx-vp9, because ffmpeg's native VP9 decoder drops the alpha side stream. The probe also reports VP9's
    `ALPHA_MODE` tag as `alpha_mode`, since its main stream reads as `yuv420p`.
  - `alpha.mode` is stated, and it is `straight` for all three formats. There is no `--alpha premultiplied`:
    HyperFrames encodes the frames, and premultiplying them would need a second encode of its output (D3, D12).
- **Why straight:** HyperFrames captures every frame as a PNG screenshot, which is straight alpha by definition, and
  pipes the PNGs into ffmpeg (`-f image2pipe -vcodec png`, visible in `commands`). prores_ks and libvpx-vp9 keep the
  alpha as a plane beside the colour planes. Measured on a `rgba(0,0,255,0.5)` layer, the colour read back
  as R,G,B,A = 0,0,255,128 (PNG), 0,0,255,129 (ProRes) and 0,0,254,129 (VP9). Premultiplied alpha would read back with
  a blue near 128.
- **Whether the background is transparent** is checked on the output frame by the test, not inferred by `render`.
  `render` cannot tell an empty corner from a corner a full-frame layer covers, so it reports the corners and
  min/max and leaves the judgement to the caller.
- **Pinned by:** `tests/alpha.test.mjs`. For each format, the first frame reads alpha 0 in both empty corners,
  255 on the solid layer and 128 ± 2 on the 50% layer, read back by `probe --alpha --sample`. The 50% layer's
  colour is full blue. The `--codec png` refusals are covered, and so is a PNG sequence made by ffmpeg alone.

## D14. Stinger and title material write a sidecar of the Velisa spec's fields only; the cover is measured before it is written

- **Reported as:** expected while building roadmap steps 15 and 17: the sidecars could carry more
  (the template name, the colours, per-segment files), `cut_point` could be rounded to
  milliseconds like the other result times, a stinger could be rendered to h264, and a title
  template's `duration` is now put on the frame grid.
- **Decision:** a scene request may declare `stinger: {cut_point, cover: {start, end}}` or
  `title: {safe_area}` (not both). `scene` validates them (each stinger time on a frame, the cut
  point inside `[start, end)`, the cover inside the scene; a title has `segments` and every text box
  inside the safe area) and writes the facts to `hfs-material.json` in the scene directory. `render`
  reads that file, refuses a stinger without an alpha codec, decodes the alpha plane of every frame
  of the stated cover (`stinger_cover`: every pixel >= 253/255, qc-skill's threshold), and only when
  every step held writes `<stem>.stinger.json` / `<stem>.title.json` (`lib/sidecar.mjs`). Each holds
  the fields the spec names and nothing else: the receiver-read ones (`cut_point`, `cover`;
  `segments`) and the ones it marks PROPOSED, listed apart in the result's `sidecar.fields` and in
  docs/contract.md. Times are `frame / frame_rate` exactly. The five stinger templates (geometric,
  glitch, particles, brush, logo reveal) take `duration`, `cut_point` and `hold`: the graphic enters
  over `[0, cut_point)`, covers `[cut_point, cut_point + hold)` and exits over the rest. The four title
  templates declare segments (in and out = their transitions; break: in and out 0). Template timings
  are computed by `derived` sums and differences in whole frames.
- **Why:** no receiver opens the sidecar, so it is a contract with the caller; a field the spec does
  not have would be one nobody checks, and the spec asks for new fields to be proposed to Velisa
  first. Rounding `cut_point` to milliseconds breaks the receivers' 1/1000-of-a-frame rule at 24 fps
  (1.042 s is frame 25.008, refused as `cut_point_not_on_frame`). A stinger with no alpha plane is
  refused by video-editing-skill (`stinger_no_alpha`), so it is refused here before rendering. A
  stated cover that is not measured would be a guess; the measurement is on every frame of the
  window, not just the cut point, since that is what `cover` states. Template arithmetic in frames
  keeps 1.2 - 0.5 - 0.2 at 15 frames instead of 0.49999999999999994 s; a title template's duration
  was already rendered as a whole number of frames, so putting the declared duration on that grid
  changes no frame count. A stinger has no sound until audio lands (roadmap step 11): `audio: false`.
- **Pinned by:** `tests/material.test.mjs` (request validation, derived values, the 24 fps precision,
  the spec's field lists, dry-run sidecar planning and refusals; with renders: the default
  `stinger-geometric` opaque from frame 15 to 20 and not at 14, its `stinger.json`, and a lower third's
  `title.json` with `--segments`, both checked against the spec's rules).

## D15. A brand kit fills only the template values with the same meaning; every other kit field is reported, nothing is defaulted

- **Reported as:** expected while building roadmap step 16: the kit could fill more (`colors.primary`
  as a stinger's `color` or `color_1`, `safe_margin` as a layout margin, `font` by family name, `lang`
  as the template's `lang`, `logo_position` / `logo_scale` for the logo reveal), `scene` could take a kit
  too, and a kit without a colour could fall back to ffmpeg-skill's `brand.json` defaults.
- **Decision:** `--kit FILE` on `template` and `batch` reads a Velisa `kit@1` file or an ffmpeg-skill
  `brand.json` (`schema` absent or `velisa/kit@1`; `colours` read like `colors`, both together refused).
  Each template declares in `templates/<name>.json` which of its values a kit field fills (`kit`:
  value -> `colors.<role>` or `logo`), and only fields with one meaning there are mapped:
  `colors.background` -> `background`, `colors.accent` -> `accent`, `colors.text` -> `text_color`,
  `logo` -> `logo`, and `font_file` as `--font` when the template draws caller-given text. Colours go
  from `RRGGBB` to `#RRGGBB` (the templates' `color` type requires `#`); `logo` and `font_file` resolve
  against the kit file's directory. An explicit value (`--values`, `--set`, a batch row) wins, and
  `--font` wins over `font_file`. The result's `kit` lists every field the kit has once: `applied`
  (with the value used), `overridden`, or `unused` with the reason. A malformed colour or path is
  refused only when it would be applied. `scene` takes no kit.
- **Why:** the Velisa kit spec's hyperframes row has no field-level mapping ("the caller fills
  template values from the kit"), so this skill maps only what has the same meaning in a template and
  reports the rest; a mapping the spec does not state is to be proposed to Velisa before it is added.
  `primary` against `color_1` or a stinger's single `color` is a creative choice, not a translation,
  and the spec's converter rules say only what the kit states is passed on: filling ffmpeg-skill's
  defaults would put colours in the picture the user never chose. A kit's `lang` is a script hint for
  ffmpeg-skill's `--lang`, not necessarily a BCP 47 tag. Template layouts are fixed, so there is no
  margin, logo position or logo size to set. A hand-written scene request has no typed values, so
  there is nothing for a kit to map onto; its colours and fonts are already the caller's. Explicit
  values winning keeps every existing call unchanged: without `--kit` the result has no `kit` key and
  every template default stays as it was.
- **Pinned by:** `tests/kit.test.mjs` (every template's map against its value types; a full kit@1
  with every field reported exactly once; explicit values and `--font` winning; a `brand.json` with
  only `primary` filling nothing; `font_file` unused without caller text; refusals; `template --list`;
  `batch --kit` per row; with renders: a title card from a kit is frame-for-frame identical, per-frame
  md5, to the same values given with `--set` and `--font`, and its background is the kit's colour).

## D16. Test temporary directories are removed when the test process ends, unless kept on purpose

- **Reported as:** a full `npm test` left about 110 `hfs-*` directories in the OS temp directory
  (scene copies, fake tools, fixture renders), and repeated runs filled a shared disk.
- **Decision:** test files make temporary directories only through `tmp()` in `tests/helpers.mjs`.
  It records each one and removes them all when the test file's process ends: a normal exit, a
  failed assertion or uncaught error, SIGINT or SIGTERM (after which the process still ends by that
  signal). `HYPERFRAMES_SKILL_TEST_TMPDIR=DIR` makes them under DIR instead of the OS temp
  directory; `HYPERFRAMES_SKILL_KEEP_TEST_TMP=1` keeps them and prints their paths on stderr. The
  tools themselves already removed their own work directory in a `finally` (`render-core.mjs`).
- **Why:** `node --test` runs each file in its own process, so the end of that process is the one
  point every test of the file has passed through, whether it passed or not. Removing per test
  would need every test to be rewritten and would still miss a timeout. Keeping is opt-in so that a
  debugging session is the only thing that leaves files behind. SIGKILL cannot be handled.
- **Pinned by:** `tests/tmp-dirs.test.mjs` (removed on exit, on an uncaught error and on SIGTERM;
  kept and printed with `HYPERFRAMES_SKILL_KEEP_TEST_TMP=1`; three whole test files leave an empty
  root; no test file calls `mkdtemp` or `tmpdir()` itself).

## D17. The release commit is tested before it is pushed; chore / ci / docs / test PRs release nothing

2026-11-19. The ecosystem rule is Velisa ADR-023 (decision D37).

**Context.** The v0.10.3 release commit (2c02b62) released #28, a `ci:` PR that wrote no `## Unreleased` entry. `release.mjs bump` only renames `## Unreleased`, so CHANGELOG.md got no `## 0.10.3` section. Two tests in `tests/release.test.mjs` failed on main from then on, and #29 could not merge. CI did not see it: the release commit is pushed with `GITHUB_TOKEN`, and GitHub starts no workflow for that push.

**Decision.**
- `bump` writes a `## X.Y.Z` section from the commit subjects since the previous tag when there is no `## Unreleased` section. The missing 0.10.3 section is added. A test checks that every version heading is `## X.Y.Z` and that the current version has one.
- The release job commits and tags locally, runs `tests/release.test.mjs`, `tests/contract.test.mjs` and `tests/contract-file.test.mjs` on that commit, and only then pushes. A failure pushes nothing.
- In auto mode a push releases only if a merged PR carries a release-level label (`version-resolver`'s major / minor / patch lists) or no label at all. PRs labelled only `chore`, `ci`, `documentation`, `docs` or `test` release nothing; those labels no longer map to a patch. This is imagemagick-skill's rule. release-drafter's `default` cannot say "no release", so `release.mjs plan` decides it.

**Consequences.** A hand bump is released whatever the labels. A release that fails these tests is not made; a later push retries.

## D18. Frame rates are exact fractions: NTSC rates render at their own rate

2026-11-20. The ecosystem rule is Velisa ADR-026 (decision D40, spec `velisa/timebase@1`, rule TB-1). Issue #33.

**Context.** `fps` had to be an integer in the scene request (`scene-spec.mjs`), in the root's `data-fps` and in `render --fps`. So a scene for a 23.976, 29.97 or 59.94 programme could only be rendered at 24, 30 or 60 and then conformed, which changes its length by 0.1 %. The rule says that a Skill that writes video at a rate the caller chooses accepts every rate the spec reads. HyperFrames 0.8.61 already renders `--fps 30000/1001` and reads `data-fps="30000/1001"`. It refuses a decimal such as `29.97` as ambiguous.

**Decision.**
- `lib/timebase.mjs` reads a rate by TB-2. An `N/D` is taken as written (`2997/100` stays 2997/100). An integer is N/1. A decimal that is not an integer and lies within 0.005 of base x 1000/1001 (base 24, 30, 48, 60, 120, 240) is that NTSC rate (`29.97` is 30000/1001). Any other decimal is its exact value. This skill renders 1-240 fps of these.
- The scene keeps `fps` (a number) and `frame_rate`, the canonical text (`"30"`, `"30000/1001"`). The HTML carries `data-fps="<frame_rate>"`, HyperFrames gets `--fps <frame_rate>`, and a sidecar's `frame_rate` is `"N/D"`.
- Frame counts use exact fractions (BigInt), so at an NTSC rate they multiply by 30000/1001, not by a rounded 29.97. A position (a template operand) is the nearest frame, `floor(t x rate + 1/2)`, as `Math.round`. The frame count of a render is what HyperFrames renders (its `durationToFrameCount`): the nearest frame when the duration is within 1/1000 of a frame of a whole number of frames, else every started frame (rounded up). A 30 s scene at 30000/1001 is 899.1 frames, and 900 are rendered. Before, `Math.round` planned 899 and the `frames` step would have failed. The same held at integer rates for a duration that is not a whole number of frames, such as 1.01 s at 30 fps: 31 frames are rendered, and `Math.round` planned 30. Whole-frame checks on segments, stinger times and loop periods keep their tolerance, on the exact rate. A stinger's frame at the scene's rate is carried to the render's rate exactly.
- Template-derived values (`deriveValues`) round each operand to the nearest frame of the template's rate the same way.
- Verification is unchanged: the probed fps within 0.01 of the rate, the frame count exactly, the duration within one frame.
- `tests/fixtures/timebase/timebase-vectors.json` is a byte-for-byte copy of Velisa's `docs/specs/timebase-vectors.json`. `manifest.json` beside it records the Velisa commit (`b7df1d82586f0b7c00fed4074aecac75cbadf893`) and the sha256. `tests/timebase.test.mjs` runs the 61 vectors of the functions this skill has (`parse_rate`, `rate_str`, `same_rate`, `parse_seconds`, `frames_at`, `seconds_of`) and counts the other 73.

**Consequences.**
- The contract change is additive. `render --fps` is now `type: string` and still takes an integer. Every `expected` object (scene, template, batch, render, preview) gains `frame_rate`. `preview --fps` stays an integer proxy rate.
- At integer rates the markup, the argv and every frame count are unchanged.

## D19. ffmpeg-skill 4.0.0 is inside the declared range; CI cross-checks against 4.0.0 too

2026-11-20.

- **Context:** ffmpeg-skill 4.0.0 keeps `contract_version` 2.0 and removes no tool or flag. Its breaking changes are in
  `export` (loudness by default on platform presets; `kind: verification` for an unmet required field), `fit`
  (`--method` beyond 1.15x), `join --copy` (AAC drift), `waveform` (conditional audio re-encode) and `--transcribe`
  (`english_only`). The declared range `>=2.0.0 <4.0.0` excluded it.
- **Decision:** the range becomes `>=2.0.0 <5.0.0`. The cross-check still runs `probe.py` only and reads the same keys
  (D11). `probe` is one of 4.x's `stable` tools, so those keys and their types hold for the whole of 4.x. None of the
  changed tools is called. The range stays informational: there is still no version gate (D3). Python ≥ 3.10 and
  FFmpeg ≥ 6.1 are unchanged from 3.x.
- **CI:** the matrix gains v4.0.0 on Linux, macOS and Windows. The v3.0.0 legs (every OS) and v2.23.1 (Linux) stay.
- **Consequences:** the contract's `dependencies[ffmpeg-skill].version_range` changes (the contract file is
  regenerated), so a byte-for-byte pin of this contract needs a re-pin. No tool, argument or output changed.

## D20. Kinetic type is CSS animations on generated spans; a unit runs on the composition's clock

2026-11-27. Roadmap step 7.

**Context.** Kinetic type for text-only promos and openings: text that appears per character, word or line, a mask wipe, and tracking, scale and variable-font axes that move. Renders must stay bit-exact on one machine, as the three transitions are.

**Decision.**
- A text layer's `transition_in` / `transition_out` may be `chars`, `words` or `lines`. `scene` writes the text as one span (the flex item) holding one span per unit. Unit k gets its own `animation-delay` (`stagger` x k after the first), and one shared rule holds the animation (`fade`, `slide` or `zoom`, the same keyframes as the layer transitions). The span of the whole run (duration + stagger x (units - 1)) must fit the layer, the in and out spans together too, and a seamless loop refuses one that runs into it.
- Units are found with `Intl.Segmenter`, with Node's own ICU. `chars` are extended grapheme clusters (UAX #29), so a base with its combining marks, an emoji ZWJ sequence, a flag and an Indic conjunct (GB9c) or Thai cluster each move whole. `words` uses the scene's `lang`, which gives dictionary words for Japanese, Chinese and Thai. Punctuation joins the word before it, or the next one at the start of a line. `lines` are the text's own line breaks: where the browser wraps a line is not known when the markup is written. Whitespace is never a unit and stays plain text, so lines break where they did.
- A unit that moves (`slide`, `zoom`) or is a line is an inline-block, since a transform does not apply to an inline box. In `chars` the graphemes of one word share a `white-space: nowrap` span, because each inline-block would otherwise be a break opportunity. A `fade` unit stays inline.
- **The clock.** HyperFrames' CSS adapter sets each animated element's `currentTime` from its own `data-start`. A unit has none, so it runs on the composition's clock: a layer at 0.3 s showed three units at its first frame. Every unit delay is therefore offset by the layer's start in that composition, less what a segment cut off. `tests/kinetic.test.mjs` pins this: unit k is fully shown from frame 4 + k of a layer that starts at frame 3. Giving the spans `data-start` was not done, because that makes them timed clips with their own visibility. The unit rule also sets `animation-play-state: paused`: the seek sets `currentTime` whatever the play state, and before the first seek a unit rests at its start (the picture at time 0) instead of running on the browser's clock.
- `wipe` (any layer) animates `clip-path: inset()` from fully hidden on the side the edge comes from to fully shown (in), or the reverse towards the side it goes to (out). It composes with the transforms and the opacity.
- `keyframes` (text layers): `tracking` (`letter-spacing`), `scale` (the individual property, as `pulse` uses; so the two are exclusive) and `font_variation` (`font-variation-settings`). Each is one linear animation over the layer, with stops at `t / duration` and the first and last values held. `font-variation-settings` interpolates only between lists of the same axes, so the axes' stops are merged and each axis is interpolated there.
- The axes are read from the font file (fvar) with fontkit. The first family of `font_family` must be shipped in `fonts[]`: a system font's file is not known when the request is checked, and only the file says which axes exist. An unknown axis is refused with the real ones listed (`wght 100..900 (default 400), wdth 50..200 (default 100)`), and so is a value outside an axis.
- A request without these keys renders byte-identical markup (`tests/fixtures/*.index.html`).

**Why.** CSS animations are what HyperFrames already seeks deterministically. A script timeline would need GSAP or a frame adapter, and both would mean shipping and pinning a second animation engine. Counting graphemes in Node with the same ICU as the scene keeps the count reported by `scene` (`text_units`) and the count drawn the same thing. Chrome's own segmentation could differ from Node's, but it is never asked: the units are fixed in the markup.

**Measured.** `tests/fixtures/fonts/hfs-test-blocks.ttf` is a variable font of blocks (`build-test-font.py`, fontTools): every base character is one block and a combining mark has no advance and sits above its base, so each drawn grapheme is one run of lit columns on every OS. The per-character fixture ("C é Å ก้ M x̣̂", one frame per unit at 10 fps) renders 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 6, ... runs per frame, and two renders have the same framemd5. With `wght` 100 to 900 the same four blocks draw over three times the ink. A right-moving wipe over 0.8 s shows half the box at 0.4 s.

**Known limits.** `chars` on Arabic or another joined script draws each letter in its isolated form, because each unit is its own box (use `words`). With `tracking`, the space added after the last letter shifts centred text by half of it, as `letter-spacing` does.

**Pinned by:** `tests/kinetic.test.mjs`.

## D21. Text is fitted by laying it out in the render's Chromium, before the scene is written

2026-11-27. Roadmap step 8.

**Context.** Long names, affiliations and talk titles must shrink and break cleanly in any language, so a lower third never overflows, and the size used must be data (`title.json`).

**Decision.**
- **Language and direction.** A text layer takes its own `lang`. Its direction follows the language: the right-to-left languages (`ar`, `he`, `fa`, `ur`, `ps`, `sd`, `ug`, `yi`, `dv`, ...) get `dir="rtl"`, and `style.direction` states it. `align` also takes `start` / `end`. The bidirectional algorithm is the browser's, so an English name inside Arabic keeps its order.
- **Line breaking.** Line breaking is the browser's (UAX #14 with its rules per language). `line_break` is CSS `line-break`: `strict` is strict kinsoku, which forbids a small kana or ー at a line's start where `normal` allows it. `phrases: true` runs BudouX (Apache-2.0, its own models, in Node) for `ja`, `zh-Hans`, `zh-Hant` and `th`. Phrases are joined by `<wbr>` under `word-break: keep-all`, or for Thai each phrase is kept in a no-wrap span, since Chrome breaks Thai inside words itself. Other languages are refused, because BudouX has no model for them.
- **Opt-in profiles.** `writing_mode: vertical` (vertical-rl, `text-orientation: mixed`) and `ruby: true`, which reads `{base|reading}`. A brace or bar outside a complete group is refused rather than drawn. Neither is on by default, whatever the language.
- **Fit.** `fit: {mode: shrink, min_font_size}` is measured, not estimated:
  - `scene` writes the page and its assets into a staging directory. It opens the page with puppeteer-core in the Chromium the render uses, with the capture flags that affect text layout (`--font-render-hinting=none`, `--force-color-profile=srgb`, `--hide-scrollbars`), and waits for every declared face.
  - It tries `font_size` first, then the minimum, then a binary search over whole pixels for the largest size that fits.
  - "Fits" means the text's box (`.hfs-t`: its rectangle and scroll size) does not reach past the layer's box on either axis. In a fitted layer `overflow-wrap` is `normal`, so a word longer than the line overflows and is measured instead of being broken anywhere.
  - The scene is then written once, at the sizes found, and measured again as written: the `text_fit` step requires overflow 0, the computed size equal to the size in the HTML, and the same line breaks.
  - A text that does not fit at its minimum is `kind: input`, with the overflow in pixels and its lines. Nothing is written.
- **Fonts.** The first family of a fitted layer must be shipped in `fonts[]` (or `--font`). HyperFrames' compiler maps generic and well-known family names to its own bundled or downloaded faces, so a measurement in plain Chromium of `sans-serif` would not be the size rendered. A shipped `@font-face` is used as declared. Tracking and `font_variation` keyframes change the text's size while it plays, so they are refused with fit.
- **Templates.** `--fit` on `template` / `batch` gives each caller text layer that declares `fit_min` in its template JSON a fit down to that minimum. These are the four title templates and the logo reveal's text, at about half the template's size. The minimum is part of the template's layout, like its sizes. `fit_min` is removed from the request, so without `--fit` every template's request is unchanged.
- **title.json.** The Velisa title spec's `text[]` has `role`, `text`, `lang`, `font`, `font_size` and nothing more. So the size used goes in `font_size`, the layer's own language in `lang`, and the breaks into `text` as `\n` ("the text as drawn"). Ruby readings are left out of `text`. No field is added.

**Why.** Only the engine that draws the text knows where its lines break: shaping, kerning, fallback fonts, kinsoku and bidi all decide them. A second layout model in Node (font metrics and a line breaker) would disagree with Chromium on exactly the hard cases: Arabic joining, Indic conjuncts, CJK punctuation. Measuring before the scene is written keeps the HTML the single source: what `text_fit` reports is what the page says and what the render draws. A page that fits itself at render time with a script would leave the size out of the HTML and out of `scene`'s result. Staging means a failed fit leaves nothing behind.

**Changed behaviour.** A scene whose own `lang` is right to left used to lay its text out left to right. It now writes `dir="rtl"` on its text layers. Every other request without the new keys renders byte-identical markup.

**Measured** (block test font, every OS). English, Arabic, Hindi and Japanese layers shrink from 48 px to 25, 25, 25 and 33 px. Each is the largest size whose lines fit: two lines of 1.2 x 25 px in a 60 px box, and BudouX's `国際学会で / 基調講演を行います` at 33 px in 100 px. The render's ink lies inside the four boxes. Arabic `start` hugs the right edge and English the left. `あいうえおょかきくけ` in a five-character line breaks before ょ with `normal` and before お with `strict`. A vertical layer reports its columns, with the ruby widening its base. At a 40 px minimum the English name overflows its box by 132 px (four lines), and the scene is refused.

**Pinned by:** `tests/typeset.test.mjs`.

## D22. Shapes are static SVG inside animated HTML boxes; patterns are seeded presets whose cycle closes

2026-11-27. Roadmap step 9.

**Context.** Geometric looks and logo backgrounds without footage, reproducible from a seed, with typed parameters, never raw CSS.

**Decision.**
- **Nothing inside an SVG is animated.** HyperFrames' CSS adapter discovers animated elements with `querySelectorAll("*")` and keeps only those in the XHTML namespace. A CSS animation on an SVG element would play on the browser's own clock instead of being seeked, and the frames would depend on capture speed. So an SVG is only ever drawn, and everything that moves is an HTML element.
- **Shapes.** A `shape` layer is a static inline SVG the size of its box (`rect`, `rounded_rect`, `circle` as the box's ellipse, `line`, `polygon` from points or `sides`). It has a solid fill or an SVG linear / radial gradient, and a stroke inset by half its width so it stays in the box. The SVG sits in two HTML boxes: the inner one holds the static `rotation`, and the outer one runs the `keyframes` (`translate`, `scale`, `rotate`, `opacity`, the individual properties, linear). Those compose with the layer's transitions (`transform`, `opacity` on the layer) and its loop animation, because they are on another element. Like kinetic units (D20), the inner box runs on the composition's clock, so its delay is the layer's start in that composition. Like them, every inner animation (the shape's keyframes, every pattern element) is `animation-play-state: paused`, so it rests at time 0 until HyperFrames seeks it.
- **Patterns.** A `pattern` layer is one of five presets drawn from `seed` (mulberry32) with `speed` (cycles per second), `palette` and typed `params`:
  - `grid` and `lines`: HTML lines in a field rotated by `angle`. Line k has palette colour (k + offset) mod n, and the field shifts by n spacings per cycle, so a cycle ends with every colour back in place.
  - `dots`: dots that pulse in opacity, each with a seeded colour and phase.
  - `rings`: one box with a `repeating-radial-gradient` whose start is a registered `<length>` (`@property`). It grows by n ring spacings per cycle, which is the gradient's own repeat.
  - `polygons`: boxes clipped by `clip-path: polygon()`, morphing between two seeded vertex sets of the same count (0 % = 100 %), the second turned a quarter turn inside the clip path.
  - No pattern scales or rotates a box. On CI, dots that pulsed with `scale` were not bit-identical between two renders, as D12 measured for scaled layers. Opacity and clip paths are.
  The seed picks only colours, phases and, for polygons, places and shapes. Sizes, timing and the file stay the same.
- **Loops.** A pattern's cycle is 1 / speed, and a cycle ends on its first picture. Inside a seamless loop segment the cycle must be whole frames that divide the loop, like a loop animation's period. A shape's keyframe tracks must hold one value through the loop.
- Bounds: at most 4000 elements per pattern, 64 points per polygon, 8 palette colours.

**Why.** Typed presets keep the request a description, not code. A seeded PRNG in Node makes the markup itself the reproducible artefact: the same request gives byte-identical HTML. Registered custom properties are animated by the same CSS animation engine HyperFrames seeks, so the rings need no script.

**Measured.** Each preset (320x180, 0.5 s at 10 fps) renders twice to the same framemd5. With another seed the framemd5 differs, while width, height, frame count, codec, fps and duration are equal. Changing the seed in the request changes only lines that belong to the pattern layer. A red square with a `position` track from 0 to 180 px moves its centroid from x 60 to 240 with the same 6400 pixels. A `lines` pattern and a `rings` pattern at 2.5 cycles per second in a 0.8 s loop segment pass the loop seam check while moving.

**Pinned by:** `tests/shapes.test.mjs`.

## D23. Generative layers: bundled three.js, a runtime driven by hf-seek, time as a pure input

2026-11-27. Roadmap step 10.

**Context.** Particles, shaders and 3D type in the same scene, with no separate tool and no network, and output that stays deterministic on one machine.

**Decision.**
- **What the scene contains.** A `generative` layer is a `<canvas>` in the layer's box, plus its configuration as an inline `<script type="application/json">`, with `<` escaped so it can never close the tag. The configuration holds the program, seed, palette, typed params, the time offset, and, for `type3d`, the text's outlines.
- **What is copied, never fetched.** `scene` copies three.js 0.187.0 (`three.core.js` and `three.module.js`, MIT, from `node_modules`) and `lib/generative-runtime.js` (`assets/hfs-generative.js`) into the scene. The page loads them as an ES module, which works because HyperFrames serves the scene over local HTTP.
- **The frame adapter.** The runtime listens for HyperFrames' `hf-seek` event and draws every canvas at the event's time plus the layer's offset (`time_start` less the layer's start in that composition, plus what a segment cut off). An inline script registers `window.__hf.buildReady.hfsGenerative` before the module loads, so the render waits until the runtime has drawn.
- **Time is the only input that changes.** Every program is a pure function of seed, params and time:
  - particles move by `wrap(p0 + v x t)`;
  - the noise field and the gradient are fragment shaders of `uTime`;
  - the 3D type turns by `spin x t`.
  Nothing reads a clock or `Math.random`; a mulberry32 stream from the seed sets the initial state.
- **`type3d` outlines.** The outlines come from the shipped font file, laid out with fontkit (kerning, ligatures), as path commands in em units. The page turns them into `THREE.Shape`s, with holes by winding and containment, and extrudes them.
- **A user's shader.** It is accepted only as a local `.frag` / `.glsl` / `.fs` file of UTF-8 text, at most 64 KB, with `void main()` and a colour output. It may have no `#include` / `#extension`, and none of the words a script would need for network or DOM access (`fetch`, `XMLHttpRequest`, `WebSocket`, `import`, `document`, `window`, ...), outside comments. GLSL cannot reach the network, and the text reaches the page as a JSON string compiled by WebGL, never as markup or code. The word check makes that visible in the request, and refuses a file that is not a shader.
- **Backend.** Rendering stays on SwiftShader: `render` already passes `--no-browser-gpu`, and HyperFrames then launches Chrome with ANGLE on SwiftShader. `doctor` runs Chromium with those flags and reports `webgl` (`version`, `vendor`, `renderer`, `backend: swiftshader | other`). It is optional for `render` and `preview`, when a scene has a generative layer.
- **Loops.** A generative layer inside a seamless loop segment is refused: its time does not repeat.

**Why.** HyperFrames' own frame adapters (`@hyperframes/core`, Apache-2.0) document `hf-seek` with `waitUntil` as the hook for Three.js. Using it keeps capture, timing and encoding in HyperFrames, and frame N depends on N alone. A program that integrated state from frame to frame would make frame N depend on whether frames 0..N-1 were drawn, and segment renders (which start mid-way) would differ from the full render. Copying three.js from the pinned dependency keeps the render offline and the version fixed.

**Measured.** The particles fixture (600 particles, 320x180, 1 s at 10 fps) renders byte-identical twice (sha256 of the .mp4). As lossless PNG frames, a one-frame scene whose program starts at 0.7 s equals frame 7 of the full render, which differs from frame 6. On one frame, the noise field and the gradient cover their boxes, the extruded text covers part of its box, and a user's ring shader covers its box. `doctor` reports `WebGL 2.0 (OpenGL ES 3.0 Chromium)` on `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)`.

**Pinned by:** `tests/generative.test.mjs`.

## D24. Sound is HyperFrames' own audio mix; beats move starts before anything is checked

2026-11-27. Roadmap step 11.

**Context.** "Neon, 120 BPM, 15 s, vertical" should land every move on the beat, with the music in the file.

**Decision.**
- **Audio layers.** An `audio` layer becomes `<audio class="clip" data-start data-duration data-media-start data-volume data-fade-in data-fade-out>`. HyperFrames mixes it into the encode itself: AAC 48 kHz stereo in .mp4 and .mov, Opus in .webm, silent before `data-start` (measured). No second encoder is added (D3).
- **Verification.** `render` sees an `<audio>` element in the composition and adds `expected.audio` and a verification step `audio`: the output has an audio stream, and its duration (the stream's own, or the container's for WebM) is the scene's within one frame.
- **PNG and loops.** A PNG sequence has nowhere to put sound, so `--codec png` refuses a scene with audio rather than dropping it silently. An audio layer inside a seamless loop segment is refused, because sound does not repeat with the picture there. A segment that cuts an audio layer keeps only the fades of the edges it did not cut.
- **Stingers.** `stinger.json` writes `audio: true` when the output carries sound. It was `false` while there was no audio.
- **Beat lock.** A top-level `beat` is applied to the raw request before it is validated, so every later check (the layer ends inside the scene, a transition's span fits, a seamless loop) sees the snapped times.
  - Each visual layer's `start` goes to the nearest beat, rounded to the nearest frame (within half a frame of the beat). Its end stays where it was, so a layer that ran to the scene's end still does, and its duration changes by the move.
  - With evenly spaced beats, each `chars` / `words` / `lines` stagger becomes a whole number of beats, at least one. A grid that is not evenly spaced snaps starts only, and the report says why.
  - Beats come from `bpm` + `offset` + `division`, or from a grid file. For ffmpeg-skill `scenes --beats` this is `beat_grid.supported_beats`: its own rule is that a tool that moves things uses only the beats a measured onset supports. Or it is sound-design-skill's `beats.json` / `tempo_map` (`beats: [{time}]`), or a plain array.
  - `scene` reports `beat_lock`: every layer's `given` and `snapped` start, the beat index and time, the frame rounding, and every stagger.

**Why.** Snapping inside the markup step, after validation, would let a snapped layer run past the scene or into a loop unnoticed. Snapping first and validating the result keeps "a value outside the schema is refused, never fixed up" true for the times the scene actually uses. HyperFrames already implements `<audio>` with gain, fades and media offset, and mixes it in its encode, so this skill only states and checks it.

**Measured.** A 120 BPM scene with layers asked at 0.13, 1.27 and 2.2 s starts them at 0, 1.5 and 2 s, and its 0.2 s stagger becomes 0.5 s. Rendered with a 440 Hz tone from 0.5 s, the .mp4 and the .mov each carry a 3.000 s audio stream for the 3 s scene: silent below -60 dBFS before 0.5 s and the tone after. At 30 fps with eighths and a 0.1 s offset, the beat at 1.35 s (frame 40.5) becomes frame 41, 1.366667 s. A stinger with an audio layer writes `audio: true`.

**Pinned by:** `tests/audio.test.mjs`.
