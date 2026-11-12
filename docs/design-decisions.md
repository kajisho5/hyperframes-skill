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
  version gate (the declared range `>=2.0.0 <4.0.0` in the contract's `dependencies` is what it was
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
