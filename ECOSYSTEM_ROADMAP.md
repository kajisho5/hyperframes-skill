# Roadmap — hyperframes-skill

Part of the [AI Video Production OS](https://github.com/kajisho5/AI-video-production-OS/blob/main/docs/ecosystem/ROADMAP.md) ecosystem: department **映像 (Visual)**, status `active`.
Written from a read-only audit of this repository on 2026-10-30. Each step below is meant to be one pull request; tick it off by linking the PR.

## Where it stands

v0.6.0 (CHANGELOG says unreleased; no release workflow). Node 22. batch, doctor, preview, probe, render (h264/vp9/ProRes 4444 alpha), scene, template. 76 tests, CI on Ubuntu + macOS (no Windows).

## What this repository owns

`ecosystem.json` gives each job to exactly one repository. Work outside this list belongs to its owner and is handed over, not re-implemented.

| Owned job | Status | Note |
|---|---|---|
| HTMLシーンの動画化(HyperFrames) | done | audio is a later theme |

## Wiring

Not reachable from the agent. Calls ffmpeg/ffprobe directly, bypassing ffmpeg-skill (the engine bypass, [docs/design-decisions.md D3](docs/design-decisions.md)); `render` reads its output back through ffmpeg-skill/probe when a checkout is present and reports `ffmpeg_skill.status`.

## Steps

- [x] **1. provides[] + dependencies in the contract**
  - Done when: OS conformance
- [x] **2. Release workflow; cut 0.6.0** — npm + tag ([#12](https://github.com/kajisho5/hyperframes-skill/pull/12))
  - Done when: tag produces a release
- [x] **3. Verify outputs with ffmpeg-skill when present** — probe/check; ADR on the engine bypass ([#13](https://github.com/kajisho5/hyperframes-skill/pull/13))
  - Done when: render result reports ffmpeg-skill verification
- [ ] **4. Windows** — replace sh argv shims with Node; Windows CI
  - Done when: CI green on Windows
- [ ] **5. (agent side) SkillSpec html_scene_render** — output to video-editing concat or ffmpeg-skill overlay (alpha)
  - Done when: tracked in video-production-agent

## Boundaries

title-card / lower-third templates overlap motion-graphics titles.

---
Engine for every media operation: [ffmpeg-skill](https://github.com/kajisho5/ffmpeg-skill) (42 tools, treated as complete). Orchestrator: [video-production-agent](https://github.com/kajisho5/video-production-agent).
