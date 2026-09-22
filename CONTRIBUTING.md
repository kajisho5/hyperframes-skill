# Contributing to hyperframes-skill

This project has one job: execute explicit, agent-given HyperFrames render operations
deterministically, safely, and verifiably.

## Scope

This project intentionally does **not**:
- add AI/LLM-based scene understanding, highlight detection, or content judgement
- fall back to raw Chrome/ffmpeg shell invocations outside the toolset's own scripts
- depend on cloud services or require API keys
- mutate input files
- make creative or compositional decisions on the calling agent's behalf

If your idea needs one of these, it likely belongs in a different, complementary skill rather
than this one. The calling agent decides *what a scene should say* (copy, pacing, which assets
go where); this toolset only turns an already-decided, structured scene description into valid
HyperFrames markup, renders it, and reports back.

## Dependencies

ffmpeg-skill is Python standard library only. This project cannot be: it needs Node.js, the
`hyperframes` render core, a headless Chromium and ffmpeg. It keeps the spirit of that rule
instead: every dependency is declared (README, "Requirements", which a test checks against
`package.json`), pinned (`hyperframes` and `commander` to exact versions, `package-lock.json`
committed), and probed by `doctor` before any tool claims it can run. Adding a runtime
dependency needs a reason in the PR that a few lines of code could not meet.

## Before you start

- **Read `docs/contract.md` and `lib/contract.mjs` first.** The contract is generated from the
  code: a tool's flags come from its commander `Command` (`lib/tools/<name>.mjs`, `command()`),
  everything else from its `meta`. Never hand-duplicate a flag list; extend the generator.
- **Every change needs a reproduction**: the failing case before the fix and the passing case
  after, as a test.

## Tests

```bash
npm test          # all of tests/, including real Chrome + ffmpeg renders
npm run test:fast # HYPERFRAMES_SKILL_SKIP_RENDER_TESTS=1: no Chrome
```

- `tests/contract.test.mjs`: contract ↔ implementation ↔ docs, the frozen CLI surface, the
  SKILL.md byte budget.
- `tests/dryrun.test.mjs`: `--dry-run` measured behind recording fake binaries.
- `tests/failures.test.mjs`: every `error.kind` and exit code, with real failures where possible.
- `tests/render.test.mjs`: real renders of small fixtures (320x180, 1 s), pixels checked, the
  determinism test (render twice, compare sha256 and per-frame md5).
- `tests/scene.test.mjs`: request validation and markup.

A fix without a regression test that would have caught the original bug isn't done yet.
Real renders in CI, not only mocked Chrome/ffmpeg: a change that breaks determinism is a defect
on the same level as a change to the frozen CLI surface.

## Pull requests

- A `feat` PR updates every place the feature is stated: `README.md` (the tool table, the
  contract table, "What is verified"), `SKILL.md`, `references/scripts.md`, `docs/contract.md`
  and `CHANGELOG.md`. The README is read by people who never open SKILL.md, so a feature that
  only SKILL.md knows about is half shipped. The tests check tool ids, every flag and the tool
  count across these files.
- `SKILL.md` must stay under **12,000 bytes** (`tests/contract.test.mjs` enforces it): it is
  loaded into every session. Adding a line means trimming one, and the PR says which.
- A `feat` PR adds at least one before/after demo to `demos/run.mjs`. The demo runs the new
  tool end to end in CI (`npm run demo`), so a broken flag fails the build instead of the reader.
- Adding a flag: regenerate `tests/fixtures/cli_surface.json` with
  `UPDATE_SNAPSHOT=1 node --test tests/contract.test.mjs` and commit the diff.
- Something a reviewer reports as a bug that is intentional goes into
  `docs/design-decisions.md` with the test that pins it.
- State plainly which checks you ran and what you did not verify. An unrun check reported as
  passing is the same defect as an overstated result document.
