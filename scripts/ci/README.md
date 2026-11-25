# Reusing validation evidence

`validation-evidence.mjs` uses Node.js 22 built-ins and the runner's `git` and
`unzip`. Run its focused checks with
`node --test tests/ci/validation-evidence.test.mjs`.

Both commands require the usual GitHub Actions identity environment variables,
plus `CI_VALIDATION_WORKFLOW` (the exact `.github/workflows/*.yml` path).
Client validation also sets `CI_VALIDATION_DEPENDENCY_TREE` to the checked-out
server's complete Git tree and `CI_VALIDATION_DEPENDENCY_SHA` to its commit.
Server validation leaves both dependency variables empty.

## `reuse`

Run after checkout, with `GITHUB_TOKEN` granted only `contents: read`,
`actions: read` and `pull-requests: read`. It writes `reused=true|false` and
`source_url` to `GITHUB_OUTPUT`. Every lookup failure falls back to fresh work.
Only a `push` to `refs/heads/main` can reuse evidence. Other events always run.

Reuse requires one same-repository PR merged to the current commit, the latest
successful PR run of this workflow for its exact head, and an unexpired artifact
named `validation-evidence-RUN_ID-RUN_ATTEMPT`. The record must match that run,
attempt, PR, repository, workflow, complete checked-out source tree and optional
dependency tree. The tested source commit/tree is independently checked against
GitHub. Evidence older than seven days is not reused. A newer failing, cancelled,
pending or unverifiable run prevents reuse of older success. Manual and scheduled
runs always provide fresh coverage; reused runs never publish new evidence.

## `record`

Run only after **all fresh required jobs succeeded**, never after a reuse.
It writes `validation-evidence.json`. Upload that file under the artifact name
above. Checkout must equal `GITHUB_SHA`; for PR events, `GITHUB_EVENT_PATH` supplies
the PR/head/base identity. This command does not grant success or determine which
tests are required: the aggregate workflow gate must check those prerequisites.

Keep stable production gate jobs running on main. A gate may pass when verified
reuse is true, or when every required fresh job succeeded. Missing/skipped/failed
preflight or test jobs must not silently count as validation. Keep the production
hosting build, deployment health checks and any intentionally different build
configuration; this evidence reuses test results, not production artifacts.
