import { readPublicSiteHealth } from "./public-site-health.js";
import mongoose from "mongoose";
import { getRuntimeReadiness } from "@/infrastructure/lifecycle/runtime-readiness.js";
import { cronHealth } from "./cron-health.js";
import { PAYMENT_CHECK_IDS, readPaymentHealth } from "./payment-health.js";
import { readWorkerHeartbeats } from "./worker-heartbeats.js";
import type { OperationsCheck, OperationsConfig } from "./operations.config.js";

export const OPERATIONS_PROBE_TIMEOUT_MS = 2_000;
export const OPERATIONS_CACHE_MS = 5_000;

export type OperationsHealth = {
  schemaVersion: 1;
  status: "ok" | "unhealthy";
  observedAt: string;
  checks: OperationsCheck[];
};

const unavailable = (id: string, reason = "probe_unavailable"): OperationsCheck => ({ id, status: "unavailable", reason });

// Keep the actual in-flight operation locked even after the HTTP timeout. A
// stalled dependency must not cause each external poll to enqueue more work.
export const createBoundedProbe = <T>(timeoutMs = OPERATIONS_PROBE_TIMEOUT_MS) => {
  let pending: { key: string; result: Promise<T> } | null = null;
  return async (key: string, read: () => Promise<T>): Promise<T> => {
    if (pending && pending.key !== key) throw new Error("Probe busy");
    if (!pending) {
      const operation = { key, result: Promise.resolve().then(read) };
      pending = operation;
      void operation.result.then(
        () => { if (pending === operation) pending = null; },
        () => { if (pending === operation) pending = null; },
      );
    }
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        pending.result,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Probe timeout")), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
};

const probeMongo = async (): Promise<boolean> => {
  const database = mongoose.connection.db;
  if (mongoose.connection.readyState !== 1 || !database) return false;
  const result = await database.command({ ping: 1 }, { readPreference: "primary", timeoutMS: 1_000 });
  return result.ok === 1 && mongoose.connection.readyState === 1 && mongoose.connection.db === database;
};

type Dependencies = {
  runtime: typeof getRuntimeReadiness;
  mongo: () => Promise<boolean>;
  workers: typeof readWorkerHeartbeats;
  payments: typeof readPaymentHealth;
  publicSite: typeof readPublicSiteHealth;
  crons: (now: number) => OperationsCheck[];
  now: () => number;
};

export const createOperationsHealthReader = (overrides: Partial<Dependencies> = {}) => {
  const dependencies: Dependencies = {
    runtime: getRuntimeReadiness, mongo: probeMongo, workers: readWorkerHeartbeats,
    payments: readPaymentHealth, publicSite: readPublicSiteHealth, crons: (now) => cronHealth.checks(now), now: Date.now,
    ...overrides,
  };
  const mongoProbe = createBoundedProbe<boolean>();
  const workerProbe = createBoundedProbe<OperationsCheck[]>();
  const publicSiteProbe = createBoundedProbe<OperationsCheck>();
  const paymentProbe = createBoundedProbe<OperationsCheck[]>();
  let cached: { key: string; at: number; report: OperationsHealth } | null = null;
  let inFlight: { key: string; result: Promise<OperationsHealth> } | null = null;
  const collect = async (config: OperationsConfig): Promise<OperationsHealth> => {
    const now = dependencies.now();
    const runtime = dependencies.runtime();
    const checks: OperationsCheck[] = [{ id: "runtime", status: runtime.ready ? "ok" : "unhealthy", reason: runtime.state }];
    if (!config.valid) {
      checks.push({ id: "configuration", status: "unhealthy", reason: "invalid_configuration" },
        ...["mongo", "redis", ...PAYMENT_CHECK_IDS].map((id) => unavailable(id, "invalid_configuration")));
    } else {
      const workerKey = `${config.namespace}:${config.expectedWorkers.join(",")}`;
      const [mongo, workers, payments, publicSite] = await Promise.all([
        mongoProbe("mongo", dependencies.mongo)
          .then((ok): OperationsCheck => ({ id: "mongo", status: ok ? "ok" : "unavailable", reason: ok ? "healthy" : "probe_unavailable" }))
          .catch(() => unavailable("mongo")),
        workerProbe(workerKey, () => dependencies.workers(config, now))
          .then((result): OperationsCheck[] => [{ id: "redis", status: "ok", reason: "healthy" }, ...result])
          .catch(() => [unavailable("redis"), ...config.expectedWorkers.map((role) => unavailable(`worker.${role}`, "redis_unavailable"))]),
        paymentProbe("payments", () => dependencies.payments(now))
          .catch(() => PAYMENT_CHECK_IDS.map((id) => unavailable(id, "query_unavailable"))),
        publicSiteProbe(config.namespace, () => dependencies.publicSite(config))
          .catch(() => unavailable("public-site.configuration")),
      ]);
      checks.push(mongo, publicSite, ...workers, ...payments, ...dependencies.crons(now));
    }
    // Shutdown can begin while dependency probes are running.
    const currentRuntime = dependencies.runtime();
    checks[0] = { id: "runtime", status: currentRuntime.ready ? "ok" : "unhealthy", reason: currentRuntime.state };
    return { schemaVersion: 1, status: checks.every((check) => check.status === "ok") ? "ok" : "unhealthy", observedAt: new Date(now).toISOString(), checks };
  };
  return async (config: OperationsConfig): Promise<OperationsHealth> => {
    const key = `${config.valid}:${config.namespace}:${config.expectedWorkers.join(",")}`;
    const now = dependencies.now();
    // Do not serve cached readiness after a shutdown/initialization transition.
    if (cached?.key === key && now - cached.at < OPERATIONS_CACHE_MS && dependencies.runtime().ready) return cached.report;
    if (inFlight?.key === key) return inFlight.result;
    const operation = { key, result: collect(config) };
    inFlight = operation;
    try {
      const report = await operation.result;
      cached = { key, at: dependencies.now(), report };
      return report;
    } finally {
      if (inFlight === operation) inFlight = null;
    }
  };
};

export const readOperationsHealth = createOperationsHealthReader();
