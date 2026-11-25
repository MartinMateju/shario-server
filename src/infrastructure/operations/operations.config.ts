export const OPERATIONS_WORKER_ROLES = [
  "communication-email", "communication-scheduler", "data-import",
] as const;
export type OperationsWorkerRole = (typeof OPERATIONS_WORKER_ROLES)[number];

export type OperationsConfig = {
  token: string;
  namespace: string;
  expectedWorkers: OperationsWorkerRole[];
  valid: boolean;
};

export const getOperationsConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): OperationsConfig => {
  const token = environment.OPS_MONITOR_TOKEN ?? "";
  const namespace = environment.OPS_MONITOR_NAMESPACE ?? "";
  const requested = (environment.OPS_MONITOR_WORKERS ?? OPERATIONS_WORKER_ROLES.join(","))
    .split(",").map((value) => value.trim());
  const valid = /^[a-zA-Z0-9_-]{1,64}$/.test(namespace) && requested.length > 0 &&
    requested.every((role) => OPERATIONS_WORKER_ROLES.includes(role as OperationsWorkerRole));
  return {
    token,
    namespace,
    expectedWorkers: [...new Set(requested.filter((role) => OPERATIONS_WORKER_ROLES.includes(role as OperationsWorkerRole)))] as OperationsWorkerRole[],
    valid,
  };
};

export const isOperationsEnabled = (config = getOperationsConfig()): boolean =>
  config.token.length >= 32 && config.token.length <= 512;

export type OperationsCheck = {
  id: string;
  status: "ok" | "unhealthy" | "unavailable";
  reason: string;
  count?: number;
  limit?: number;
  countCapped?: boolean;
  ageMs?: number;
  thresholdMs?: number;
  observedAt?: string;
  lastSucceededAt?: string | null;
  lastFailedAt?: string | null;
  activeElapsedMs?: number;
  waiting?: number;
  active?: number;
  delayed?: number;
  failed?: number;
};
