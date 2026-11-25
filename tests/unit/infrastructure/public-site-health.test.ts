import { afterEach, expect, it, vi } from "vitest";
import { getOperationsConfig } from "@/infrastructure/operations/operations.config.js";
import { readPublicSiteHealth, recordPublicSiteThrottle } from "@/infrastructure/operations/public-site-health.js";

const redis = vi.hoisted(() => ({
  status: "ready",
  set: vi.fn(),
  exists: vi.fn(),
}));
vi.mock("@/infrastructure/operations/worker-heartbeats.js", () => ({
  getOperationsRedis: async () => redis,
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

it("retains only the incident flag in the monitored environment and recovers when it expires", async () => {
  vi.stubEnv("OPS_MONITOR_NAMESPACE", "isolated");
  vi.stubEnv("OPS_MONITOR_TOKEN", "x".repeat(32));
  const config = getOperationsConfig();
  const key = "shario:operations:v1:isolated:public-site:configuration-throttled";
  recordPublicSiteThrottle();
  await vi.waitFor(() => expect(redis.set).toHaveBeenCalledWith(key, "1", "EX", 900));
  redis.exists.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
  expect(await readPublicSiteHealth(config)).toEqual({ id: "public-site.configuration", status: "unhealthy", reason: "recent_visitor_throttled" });
  expect(await readPublicSiteHealth(config)).toEqual({ id: "public-site.configuration", status: "ok", reason: "healthy" });
  expect(redis.exists.mock.calls).toEqual([[key], [key]]);
});
