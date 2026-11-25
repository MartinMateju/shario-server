import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ARTIFACT_BYTES = 64 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const WORKFLOW = /^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/;
const REPOSITORY = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function positiveInteger(value) {
  const number = Number(value);
  requireValue(
    Number.isSafeInteger(number) && number > 0,
    "Invalid run identity",
  );
  return number;
}

export function contextFromEnvironment(env = process.env) {
  const context = {
    repository: env.GITHUB_REPOSITORY,
    workflow: env.CI_VALIDATION_WORKFLOW,
    eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA,
    runId: positiveInteger(env.GITHUB_RUN_ID),
    runAttempt: positiveInteger(env.GITHUB_RUN_ATTEMPT),
    dependencyTree: env.CI_VALIDATION_DEPENDENCY_TREE || null,
    dependencySha: env.CI_VALIDATION_DEPENDENCY_SHA || null,
  };
  requireValue(REPOSITORY.test(context.repository || ""), "Invalid repository");
  requireValue(WORKFLOW.test(context.workflow || ""), "Invalid workflow path");
  requireValue(SHA.test(context.sha || ""), "Invalid checkout revision");
  requireValue(
    context.dependencyTree === null || SHA.test(context.dependencyTree),
    "Invalid dependency tree",
  );
  requireValue(
    context.dependencySha === null || SHA.test(context.dependencySha),
    "Invalid dependency revision",
  );
  requireValue(
    !context.dependencySha || context.dependencyTree,
    "A dependency revision requires its tree",
  );
  return context;
}

function gitIdentity() {
  const git = (revision) =>
    execFileSync("git", ["rev-parse", "--verify", revision], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  return { commit: git("HEAD"), tree: git("HEAD^{tree}") };
}

export function makeEvidence(context, identity, event = {}, now = Date.now()) {
  requireValue(
    identity.commit === context.sha,
    "Checkout does not match this run",
  );
  requireValue(SHA.test(identity.tree), "Invalid checkout tree");
  const pull = event.pull_request;
  if (context.eventName === "pull_request") {
    requireValue(pull && SHA.test(pull.head?.sha || ""), "Missing PR revision");
    requireValue(
      pull.head.repo?.full_name === context.repository &&
        pull.base.repo?.full_name === context.repository &&
        pull.base.ref === "main",
      "Only same-repository main PRs may publish reusable evidence",
    );
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    source: "fresh",
    repository: context.repository,
    workflow: context.workflow,
    eventName: context.eventName,
    runId: context.runId,
    runAttempt: context.runAttempt,
    testedCommit: identity.commit,
    testedTree: identity.tree,
    dependencyTree: context.dependencyTree,
    dependencySha: context.dependencySha,
    pullRequest:
      context.eventName === "pull_request"
        ? {
            number: positiveInteger(event.number || pull.number),
            headCommit: pull.head.sha,
            baseRef: pull.base.ref,
          }
        : null,
    createdAt: new Date(now).toISOString(),
  };
}

function recent(timestamp, now) {
  const time = Date.parse(timestamp);
  return (
    Number.isFinite(time) &&
    time <= now + 5 * 60 * 1000 &&
    now - time <= MAX_AGE_MS
  );
}

export function validateEvidence({
  context,
  identity,
  pull,
  run,
  evidence,
  now,
}) {
  requireValue(
    evidence.schemaVersion === SCHEMA_VERSION,
    "Evidence schema changed",
  );
  requireValue(
    evidence.source === "fresh",
    "Only fresh test results can be reused",
  );
  requireValue(
    evidence.repository === context.repository,
    "Evidence repository mismatch",
  );
  requireValue(
    evidence.workflow === context.workflow,
    "Evidence workflow mismatch",
  );
  requireValue(
    evidence.eventName === "pull_request",
    "Evidence is not from a PR",
  );
  requireValue(evidence.runId === run.id, "Evidence run mismatch");
  requireValue(
    evidence.runAttempt === run.run_attempt,
    "Evidence attempt mismatch",
  );
  requireValue(SHA.test(evidence.testedCommit || ""), "Invalid tested commit");
  requireValue(
    evidence.testedTree === identity.tree,
    "Source tree changed after testing",
  );
  requireValue(
    evidence.dependencyTree === context.dependencyTree,
    "Dependency source tree changed after testing",
  );
  requireValue(
    evidence.pullRequest?.number === pull.number &&
      evidence.pullRequest.headCommit === pull.head.sha &&
      evidence.pullRequest.baseRef === "main",
    "Evidence PR association mismatch",
  );
  requireValue(recent(evidence.createdAt, now), "Evidence expired");
  requireValue(recent(run.created_at, now), "Source run expired");
}

// The API run, artifact and Git commit all establish provenance independently.
// A JSON file alone, a matching branch, or a green status name is insufficient.
export async function findReusableValidation(context, adapters) {
  if (context.eventName !== "push" || context.ref !== "refs/heads/main") {
    return {
      reused: false,
      reason: "Fresh validation is required for this event",
    };
  }
  const { api, readArtifact, identity, now = Date.now() } = adapters;
  requireValue(
    identity.commit === context.sha && SHA.test(identity.tree),
    "Checkout mismatch",
  );
  const prefix = `/repos/${context.repository}`;
  const pulls = await api(
    `${prefix}/commits/${context.sha}/pulls?per_page=100`,
  );
  requireValue(Array.isArray(pulls), "Invalid PR response");
  const eligiblePulls = pulls.filter(
    (pull) =>
      pull.merged_at &&
      pull.merge_commit_sha === context.sha &&
      pull.state === "closed" &&
      pull.base?.ref === "main" &&
      pull.head?.repo?.full_name === context.repository &&
      pull.base?.repo?.full_name === context.repository &&
      SHA.test(pull.head?.sha || ""),
  );
  requireValue(
    eligiblePulls.length === 1,
    "No unambiguous merged PR for this commit",
  );
  const pull = eligiblePulls[0];
  const workflow = encodeURIComponent(path.posix.basename(context.workflow));
  const response = await api(
    `${prefix}/actions/workflows/${workflow}/runs?event=pull_request&head_sha=${pull.head.sha}&per_page=100`,
  );
  requireValue(
    Array.isArray(response.workflow_runs),
    "Invalid workflow-run response",
  );
  const runs = response.workflow_runs
    .filter(
      (run) => run.event === "pull_request" && run.head_sha === pull.head.sha,
    )
    .sort((a, b) => b.id - a.id);
  // Never search for an older green run after a newer failure or pending run.
  const run = runs[0];
  requireValue(
    run && run.id !== context.runId,
    "No matching PR validation run",
  );
  requireValue(
    run.path === context.workflow &&
      run.head_repository?.full_name === context.repository &&
      run.repository?.full_name === context.repository &&
      Array.isArray(run.pull_requests) &&
      // GitHub returns [] for some merged PR runs. The commit's merged PR,
      // exact run head and recorded PR identity still establish association.
      (run.pull_requests.length === 0 ||
        run.pull_requests.some(
          (candidate) =>
            candidate.number === pull.number &&
            candidate.head?.sha === pull.head.sha &&
            candidate.base?.ref === "main",
        )),
    "Latest run provenance does not match this PR",
  );
  requireValue(
    run.status === "completed" && run.conclusion === "success",
    "Latest PR validation did not pass",
  );
  requireValue(recent(run.created_at, now), "Source run expired");
  const artifactName = `validation-evidence-${run.id}-${run.run_attempt}`;
  const artifacts = await api(
    `${prefix}/actions/runs/${run.id}/artifacts?name=${artifactName}&per_page=100`,
  );
  requireValue(Array.isArray(artifacts.artifacts), "Invalid artifact response");
  const matching = artifacts.artifacts.filter(
    (artifact) => artifact.name === artifactName,
  );
  requireValue(
    matching.length === 1 && !matching[0].expired,
    "Missing or expired evidence artifact",
  );
  const artifact = matching[0];
  requireValue(
    artifact.workflow_run?.id === run.id &&
      artifact.workflow_run?.head_sha === run.head_sha,
    "Artifact run provenance mismatch",
  );
  requireValue(
    Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= MAX_ARTIFACT_BYTES,
    "Unexpected artifact size",
  );
  const evidence = await readArtifact(artifact.id);
  validateEvidence({ context, identity, pull, run, evidence, now });
  const testedCommit = await api(
    `${prefix}/git/commits/${evidence.testedCommit}`,
  );
  requireValue(
    testedCommit.sha === evidence.testedCommit &&
      testedCommit.tree?.sha === identity.tree,
    "GitHub does not confirm the tested source tree",
  );
  return {
    reused: true,
    source_url: `https://github.com/${context.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`,
    reason:
      "The latest successful PR validation tested this complete source tree and dependency tree",
  };
}

async function requestApi(route, token, options = {}) {
  requireValue(
    route.startsWith("/repos/") && !route.includes(".."),
    "Invalid API route",
  );
  const response = await fetch(`https://api.github.com${route}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(20_000),
    ...options,
  });
  return response;
}

async function githubArtifact(repository, id, token) {
  requireValue(Number.isSafeInteger(id) && id > 0, "Invalid artifact identity");
  const response = await requestApi(
    `/repos/${repository}/actions/artifacts/${id}/zip`,
    token,
    { redirect: "manual" },
  );
  requireValue(response.status === 302, "Evidence archive unavailable");
  const location = new URL(response.headers.get("location"));
  requireValue(
    location.protocol === "https:" && !location.username && !location.password,
    "Invalid archive redirect",
  );
  // GitHub redirects to signed blob storage. Never forward the API credential.
  const download = await fetch(location, {
    signal: AbortSignal.timeout(20_000),
  });
  requireValue(download.ok, "Evidence download failed");
  const reader = download.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_ARTIFACT_BYTES) {
      await reader.cancel();
      throw new Error("Evidence archive is too large");
    }
    chunks.push(value);
  }
  const directory = await mkdtemp(path.join(tmpdir(), "ci-validation-"));
  try {
    const archive = path.join(directory, "evidence.zip");
    await writeFile(archive, Buffer.concat(chunks));
    // Read one named file; never extract or execute files from the artifact.
    const json = execFileSync(
      "unzip",
      ["-p", archive, "validation-evidence.json"],
      {
        encoding: "utf8",
        maxBuffer: MAX_ARTIFACT_BYTES,
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return JSON.parse(json);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const [command] = args;
  requireValue(
    args.length === 1 && ["reuse", "record"].includes(command),
    "Usage: validation-evidence.mjs reuse|record",
  );
  if (command === "record") {
    const context = contextFromEnvironment(env);
    const event = env.GITHUB_EVENT_PATH
      ? JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"))
      : {};
    const evidence = makeEvidence(context, gitIdentity(), event);
    await writeFile(
      "validation-evidence.json",
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    console.log("Recorded fresh validation evidence for this checkout.");
    return;
  }
  let result;
  try {
    const context = contextFromEnvironment(env);
    const token = env.GITHUB_TOKEN;
    requireValue(token, "GitHub read token unavailable");
    result = await findReusableValidation(context, {
      identity: gitIdentity(),
      api: async (route) => {
        const response = await requestApi(route, token);
        requireValue(response.ok, "GitHub evidence lookup unavailable");
        return response.json();
      },
      readArtifact: (id) => githubArtifact(context.repository, id, token),
    });
  } catch {
    // Missing permissions, expired evidence and API outages all run tests again.
    // Do not print caught errors: HTTP errors can contain signed download URLs.
    result = {
      reused: false,
      reason:
        "No complete, current and matching validation evidence was verified",
    };
  }
  const output = `reused=${result.reused}\nsource_url=${result.source_url || ""}\n`;
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, output);
  console.log(result.reason);
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      result.reused
        ? `Reused [successful PR validation](${result.source_url}) after verifying the complete source and dependency trees.\n`
        : "No reusable evidence was verified; all required validation will run.\n",
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    console.error("Unable to record or publish validation evidence.");
    process.exitCode = 1;
  });
}
