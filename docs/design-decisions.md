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
