import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  contextFromEnvironment,
  findReusableValidation,
  main,
  makeEvidence,
} from "../../scripts/ci/validation-evidence.mjs";

const sha = (character) => character.repeat(40);
const NOW = Date.parse("2026-11-17T10:00:00.000Z");
const RECENT = "2026-11-17T09:00:00.000Z";
const REPO = "example/client";
const WORKFLOW = ".github/workflows/client-ci.yml";

function fixture() {
  const context = {
    repository: REPO,
    workflow: WORKFLOW,
    eventName: "push",
    ref: "refs/heads/main",
    sha: sha("a"),
    runId: 900,
    runAttempt: 1,
    dependencyTree: sha("d"),
    dependencySha: sha("e"),
  };
  const identity = { commit: context.sha, tree: sha("b") };
  const pull = {
    number: 42,
    merged_at: RECENT,
    merge_commit_sha: context.sha,
    state: "closed",
    head: { sha: sha("c"), repo: { full_name: REPO } },
    base: { ref: "main", repo: { full_name: REPO } },
  };
  const run = {
    id: 800,
    run_attempt: 2,
    event: "pull_request",
    head_sha: pull.head.sha,
    path: WORKFLOW,
    head_repository: { full_name: REPO },
    repository: { full_name: REPO },
    pull_requests: [pull],
    status: "completed",
    conclusion: "success",
    created_at: RECENT,
  };
  const evidence = makeEvidence(
    {
      ...context,
      sha: sha("f"),
      eventName: "pull_request",
      runId: run.id,
      runAttempt: run.run_attempt,
    },
    { commit: sha("f"), tree: identity.tree },
    { number: pull.number, pull_request: pull },
    NOW - 30 * 60 * 1000,
  );
  const artifact = {
    id: 700,
    name: "validation-evidence-800-2",
    expired: false,
    size_in_bytes: 800,
    workflow_run: { id: run.id, head_sha: run.head_sha },
  };
  const state = {
    context,
    identity,
    pulls: [pull],
    runs: [run],
    artifacts: [artifact],
    evidence,
    commit: { sha: evidence.testedCommit, tree: { sha: identity.tree } },
    calls: [],
  };
  state.adapters = {
    identity,
    now: NOW,
    api: async (route) => {
      state.calls.push(route);
      if (route.includes("/pulls?")) return state.pulls;
      if (route.includes("/workflows/")) return { workflow_runs: state.runs };
      if (route.includes("/artifacts?")) return { artifacts: state.artifacts };
      if (route.includes("/git/commits/")) return state.commit;
      assert.fail(`Unexpected API route: ${route}`);
    },
    readArtifact: async (id) => {
      assert.equal(id, artifact.id);
      return state.evidence;
    },
  };
  return state;
}

test("reuses the latest successful same-repository PR attempt when both trees match", async () => {
  const f = fixture();
  const result = await findReusableValidation(f.context, f.adapters);
  assert.equal(result.reused, true);
  assert.equal(
    result.source_url,
    "https://github.com/example/client/actions/runs/800/attempts/2",
  );
  assert.ok(f.calls.some((route) => route.includes("head_sha=" + sha("c"))));
  assert.ok(
    f.calls.some((route) => route.includes("name=validation-evidence-800-2")),
  );
  assert.ok(
    f.calls.some((route) => route.endsWith("/git/commits/" + sha("f"))),
  );
});

test("server-only validation uses the same contract without a dependency", async () => {
  const f = fixture();
  f.context.dependencyTree = f.evidence.dependencyTree = null;
  f.context.dependencySha = f.evidence.dependencySha = null;
  assert.equal(
    (await findReusableValidation(f.context, f.adapters)).reused,
    true,
  );
});

test("merged PR run with an empty GitHub PR array still requires recorded PR identity", async () => {
  const f = fixture();
  f.runs[0].pull_requests = [];
  assert.equal(
    (await findReusableValidation(f.context, f.adapters)).reused,
    true,
  );
  f.evidence.pullRequest.number = 999;
  await assert.rejects(findReusableValidation(f.context, f.adapters));
});

test("an equivalent backend merge commit is reusable only with an identical complete tree", async () => {
  const f = fixture();
  f.context.dependencySha = sha("9");
  assert.equal(
    (await findReusableValidation(f.context, f.adapters)).reused,
    true,
  );
  f.context.dependencyTree = sha("8");
  await assert.rejects(
    findReusableValidation(f.context, f.adapters),
    /Dependency source tree/,
  );
});

for (const [name, eventName, ref] of [
  ["pull request", "pull_request", "refs/pull/42/merge"],
  ["manual dispatch", "workflow_dispatch", "refs/heads/main"],
  ["scheduled regression", "schedule", "refs/heads/main"],
  ["other branch push", "push", "refs/heads/feature"],
]) {
  test(`${name} always runs fresh validation without calling GitHub`, async () => {
    const f = fixture();
    Object.assign(f.context, { eventName, ref });
    assert.equal(
      (await findReusableValidation(f.context, f.adapters)).reused,
      false,
    );
    assert.equal(f.calls.length, 0);
  });
}

const rejectedCases = [
  [
    "direct push without a merged PR",
    (f) => {
      f.pulls = [];
    },
  ],
  [
    "PR merged to another commit",
    (f) => {
      f.pulls[0].merge_commit_sha = sha("1");
    },
  ],
  [
    "open PR",
    (f) => {
      f.pulls[0].state = "open";
    },
  ],
  [
    "unmerged PR",
    (f) => {
      f.pulls[0].merged_at = null;
    },
  ],
  [
    "ambiguous merged PR",
    (f) => {
      f.pulls.push(structuredClone(f.pulls[0]));
    },
  ],
  [
    "fork PR",
    (f) => {
      f.pulls[0].head.repo.full_name = "other/client";
    },
  ],
  [
    "different PR base",
    (f) => {
      f.pulls[0].base.ref = "staging";
    },
  ],
  [
    "different PR base repository",
    (f) => {
      f.pulls[0].base.repo.full_name = "other/client";
    },
  ],
  [
    "different checked-out commit",
    (f) => {
      f.identity.commit = sha("9");
    },
  ],
  [
    "missing PR run",
    (f) => {
      f.runs = [];
    },
  ],
  [
    "fork run",
    (f) => {
      f.runs[0].head_repository.full_name = "other/client";
    },
  ],
  [
    "wrong run repository",
    (f) => {
      f.runs[0].repository.full_name = "other/client";
    },
  ],
  [
    "wrong workflow path",
    (f) => {
      f.runs[0].path = ".github/workflows/other.yml";
    },
  ],
  [
    "invalid run PR association",
    (f) => {
      f.runs[0].pull_requests = null;
    },
  ],
  [
    "unsuccessful latest run",
    (f) => {
      f.runs[0].conclusion = "failure";
    },
  ],
  [
    "neutral latest run",
    (f) => {
      f.runs[0].conclusion = "neutral";
    },
  ],
  [
    "cancelled latest run",
    (f) => {
      f.runs[0].conclusion = "cancelled";
    },
  ],
  [
    "skipped latest run",
    (f) => {
      f.runs[0].conclusion = "skipped";
    },
  ],
  [
    "pending latest run",
    (f) => {
      f.runs[0].status = "in_progress";
    },
  ],
  [
    "expired source run",
    (f) => {
      f.runs[0].created_at = "2026-11-01T10:00:00Z";
    },
  ],
  [
    "future source run",
    (f) => {
      f.runs[0].created_at = "2026-11-19T10:00:00Z";
    },
  ],
  [
    "missing artifact",
    (f) => {
      f.artifacts = [];
    },
  ],
  [
    "duplicate artifacts",
    (f) => {
      f.artifacts.push(structuredClone(f.artifacts[0]));
    },
  ],
  [
    "expired artifact",
    (f) => {
      f.artifacts[0].expired = true;
    },
  ],
  [
    "old attempt artifact",
    (f) => {
      f.artifacts[0].name = "validation-evidence-800-1";
    },
  ],
  [
    "artifact from wrong run",
    (f) => {
      f.artifacts[0].workflow_run.id = 799;
    },
  ],
  [
    "artifact from wrong revision",
    (f) => {
      f.artifacts[0].workflow_run.head_sha = sha("9");
    },
  ],
  [
    "oversized artifact",
    (f) => {
      f.artifacts[0].size_in_bytes = 100_000;
    },
  ],
  [
    "unknown evidence schema",
    (f) => {
      f.evidence.schemaVersion = 2;
    },
  ],
  [
    "transitively reused evidence",
    (f) => {
      f.evidence.source = "reused";
    },
  ],
  [
    "wrong evidence repository",
    (f) => {
      f.evidence.repository = "other/client";
    },
  ],
  [
    "wrong evidence workflow",
    (f) => {
      f.evidence.workflow = ".github/workflows/other.yml";
    },
  ],
  [
    "evidence from manual event",
    (f) => {
      f.evidence.eventName = "workflow_dispatch";
    },
  ],
  [
    "wrong evidence run",
    (f) => {
      f.evidence.runId = 799;
    },
  ],
  [
    "wrong evidence attempt",
    (f) => {
      f.evidence.runAttempt = 1;
    },
  ],
  [
    "invalid tested commit",
    (f) => {
      f.evidence.testedCommit = "main";
    },
  ],
  [
    "changed source tree",
    (f) => {
      f.evidence.testedTree = sha("9");
    },
  ],
  [
    "changed dependency tree",
    (f) => {
      f.evidence.dependencyTree = sha("9");
    },
  ],
  [
    "missing dependency tree",
    (f) => {
      delete f.evidence.dependencyTree;
    },
  ],
  [
    "wrong evidence PR",
    (f) => {
      f.evidence.pullRequest.number = 43;
    },
  ],
  [
    "wrong evidence PR head",
    (f) => {
      f.evidence.pullRequest.headCommit = sha("9");
    },
  ],
  [
    "expired evidence",
    (f) => {
      f.evidence.createdAt = "2026-11-01T10:00:00Z";
    },
  ],
  [
    "future evidence",
    (f) => {
      f.evidence.createdAt = "2026-11-19T10:00:00Z";
    },
  ],
  [
    "GitHub commit differs from evidence",
    (f) => {
      f.commit.sha = sha("9");
    },
  ],
  [
    "GitHub tree differs from evidence",
    (f) => {
      f.commit.tree.sha = sha("9");
    },
  ],
];

for (const [name, mutate] of rejectedCases) {
  test(`rejects ${name}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(findReusableValidation(f.context, f.adapters));
  });
}

for (const [name, mutation] of [
  ["failure", { conclusion: "failure" }],
  ["pending run", { status: "in_progress", conclusion: null }],
  ["malformed provenance", { pull_requests: null }],
]) {
  test(`never falls back to older success after newer ${name}`, async () => {
    const f = fixture();
    f.runs.push({ ...structuredClone(f.runs[0]), id: 801, ...mutation });
    await assert.rejects(findReusableValidation(f.context, f.adapters));
    assert.ok(!f.calls.some((route) => route.includes("/artifacts?")));
  });
}

test("record refuses to attest another checkout", () => {
  const f = fixture();
  assert.throws(() =>
    makeEvidence(f.context, { commit: sha("9"), tree: sha("b") }),
  );
});

test("record refuses reusable evidence from a fork", () => {
  const f = fixture();
  f.pulls[0].head.repo.full_name = "fork/client";
  assert.throws(() =>
    makeEvidence({ ...f.context, eventName: "pull_request" }, f.identity, {
      pull_request: f.pulls[0],
    }),
  );
});

test("context validates workflow, repository and dependency identities", () => {
  const env = {
    GITHUB_REPOSITORY: REPO,
    CI_VALIDATION_WORKFLOW: WORKFLOW,
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: sha("a"),
    GITHUB_RUN_ID: "900",
    GITHUB_RUN_ATTEMPT: "1",
  };
  assert.equal(contextFromEnvironment(env).dependencyTree, null);
  assert.throws(() =>
    contextFromEnvironment({
      ...env,
      CI_VALIDATION_WORKFLOW: "../../other.yml",
    }),
  );
  assert.throws(() =>
    contextFromEnvironment({ ...env, GITHUB_REPOSITORY: "other/client?x=1" }),
  );
  assert.throws(() =>
    contextFromEnvironment({ ...env, CI_VALIDATION_DEPENDENCY_SHA: sha("d") }),
  );
  assert.throws(() =>
    contextFromEnvironment({ ...env, CI_VALIDATION_DEPENDENCY_TREE: "main" }),
  );
});

test("lookup/configuration failures publish reused=false rather than a passing reuse decision", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "validation-evidence-test-"),
  );
  const output = path.join(directory, "output");
  try {
    await main(["reuse"], { GITHUB_OUTPUT: output });
    assert.equal(await readFile(output, "utf8"), "reused=false\nsource_url=\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
