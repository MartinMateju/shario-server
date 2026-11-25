import { getOperationsConfig, isOperationsEnabled, type OperationsCheck, type OperationsConfig } from "./operations.config.js";
import { getOperationsRedis } from "./worker-heartbeats.js";

const key = (namespace: string) => `shario:operations:v1:${namespace}:public-site:configuration-throttled`;
const RECENT_THROTTLE_SECONDS = 15 * 60;
let pending: Promise<void> | undefined;

// The external monitor has its own visitor allowance. Retain a real visitor's
// configuration failure across API instances and several scheduled polls.
export function recordPublicSiteThrottle(): void {
  const config = getOperationsConfig();
  if (pending || !config.valid || !isOperationsEnabled(config)) return;
  pending = getOperationsRedis().then(async (redis) => {
    if (redis.status === "ready") {
      await redis.set(key(config.namespace), "1", "EX", RECENT_THROTTLE_SECONDS);
    }
  }).catch(() => {}).finally(() => { pending = undefined; });
}

export async function readPublicSiteHealth(config: OperationsConfig): Promise<OperationsCheck> {
  const redis = await getOperationsRedis();
  if (redis.status !== "ready") throw new Error("Redis unavailable");
  const throttled = await redis.exists(key(config.namespace));
  return {
    id: "public-site.configuration",
    status: throttled ? "unhealthy" : "ok",
    reason: throttled ? "recent_visitor_throttled" : "healthy",
  };
}
