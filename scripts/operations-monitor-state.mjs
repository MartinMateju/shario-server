// Restore only a private artifact from the latest completed main-branch run
// of this exact workflow. PR artifacts and other workflows cannot seed state.
import { chmod, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const artifactName = "operations-monitor-state-v1";

export async function restoreState({
  env = process.env,
  fetcher = fetch,
  download = spawnSync,
  log = console.log,
} = {}) {
  const repository = env.GITHUB_REPOSITORY || "";
  const currentRun = env.GITHUB_RUN_ID || "";
  const token = env.GH_TOKEN || "";
  const statePath = env.OPS_MONITOR_STATE_PATH || "";
  if (
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
    !/^\d+$/.test(currentRun) ||
    !token ||
    !statePath ||
    !statePath.endsWith("/state.json")
  ) {
    throw new Error("configuration");
  }
  // A failed restore must never leave a prior/partial file that could be
  // mistaken for this run's successfully restored durable state.
  await rm(statePath, { force: true });
  const api = async (path) => {
    const response = await fetcher(
      `https://api.github.com/repos/${repository}/${path}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw new Error("github-api");
    return response.json();
  };
  const runs = await api(
    "actions/workflows/operational-monitor.yml/runs?branch=main&per_page=100",
  );
  const latest = runs.workflow_runs
    .filter(
      (run) =>
        String(run.id) !== currentRun &&
        run.status === "completed" &&
        run.head_branch === "main" &&
        ["schedule", "workflow_dispatch"].includes(run.event),
    )
    .sort((left, right) => right.id - left.id)[0];
  // Replaying a superseded run would resurrect its old delivery record. Stop
  // before polling, sending email, or uploading state; launch a new run instead.
  if (latest && latest.id > Number(currentRun))
    throw new Error("superseded-run");
  let previous = latest;
  if (Number(env.GITHUB_RUN_ATTEMPT || 1) > 1) {
    // A manual retry must retain the first attempt's delivered-notification
    // record, otherwise re-running a failed check can send the alert twice.
    previous = { id: Number(currentRun) };
  }
  if (!previous) {
    log(
      "OPERATIONS_MONITOR_STATE no-previous-run; explicit initialization required",
    );
    return;
  }
  const artifacts = await api(
    `actions/runs/${previous.id}/artifacts?per_page=100`,
  );
  const artifact = artifacts.artifacts?.find(
    (candidate) => candidate.name === artifactName && !candidate.expired,
  );
  if (!artifact) throw new Error("state-artifact-unavailable");
  const directory = dirname(resolve(statePath));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = await mkdtemp(join(directory, "restore-"));
  try {
    const result = await download(
      "gh",
      [
        "run",
        "download",
        String(previous.id),
        "--repo",
        repository,
        "--name",
        artifactName,
        "--dir",
        temporary,
      ],
      {
        timeout: 30000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env,
      },
    );
    if (result.status !== 0) throw new Error("download-failed");
    const downloaded = join(temporary, "state.json");
    const stat = await lstat(downloaded);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768)
      throw new Error("state-artifact-invalid");
    await chmod(downloaded, 0o600);
    await rename(downloaded, statePath);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  log("OPERATIONS_MONITOR_STATE restored");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await restoreState();
  } catch (error) {
    if (error?.message === "superseded-run") {
      console.error(
        "OPERATIONS_MONITOR_STATE superseded-run; dispatch a new workflow run instead of retrying an older run",
      );
      process.exitCode = 1;
    } else {
      // Continue to the monitor: it persists a blocked state, notifies the named
      // owner, and exits unsuccessfully instead of silently resetting incidents.
      console.log(
        "::warning::Operational monitor state could not be restored. Monitoring will fail closed and notify the configured owner.",
      );
    }
  }
}
