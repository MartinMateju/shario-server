import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOperationsConfig } from "@/infrastructure/operations/operations.config.js";
import { createOperationsRouter } from "@/infrastructure/operations/operations.routes.js";
import { createBoundedProbe, createOperationsHealthReader, OPERATIONS_CACHE_MS, OPERATIONS_PROBE_TIMEOUT_MS, type OperationsHealth } from "@/infrastructure/operations/operations-health.js";

const token = "dedicated-test-monitor-token-32-characters";
const settings = () => getOperationsConfig({ OPS_MONITOR_TOKEN: token, OPS_MONITOR_NAMESPACE: "test-a" });
const paymentChecks = () => ["payments.paid-unfulfilled", "payments.refunds-review", "payments.refunds-stale"]
  .map((id) => ({ id, status: "ok" as const, reason: "healthy", count: 0 }));
const report: OperationsHealth = { schemaVersion: 1, status: "ok", observedAt: "2026-11-01T00:00:00.000Z", checks: [{ id: "runtime", status: "ok", reason: "ready" }] };
const appFor = (read = vi.fn().mockResolvedValue(report), config = settings) => {
  const app = express();
  app.use("/internal/operations", createOperationsRouter(read, config));
  return { app, read };
};

describe("private operational endpoint", () => {
  it.each([undefined, "", "short"])("is disabled without a dedicated valid token (%s)", async (value) => {
    const { app, read } = appFor(undefined, () => getOperationsConfig({ OPS_MONITOR_TOKEN: value }));
    await request(app).get("/internal/operations/health").set("Authorization", `Bearer ${token}`).expect(404);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([undefined, "Bearer wrong", `Basic ${token}`, `Bearer ${"x".repeat(600)}`])("rejects invalid authorization without reading dependencies", async (authorization) => {
    const { app, read } = appFor();
    let req = request(app).get("/internal/operations/health");
    if (authorization) req = req.set("Authorization", authorization);
    const response = await req.expect(401);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(read).not.toHaveBeenCalled();
    expect(response.text).not.toContain(token);
  });

  it("returns authenticated success and no-store, and maps unhealthy to503", async () => {
    const { app, read } = appFor();
    const good = await request(app).get("/internal/operations/health").set("Authorization", `Bearer ${token}`).expect(200);
    expect(good.body).toEqual(report);
    expect(good.headers["cache-control"]).toBe("no-store");
    read.mockResolvedValue({ ...report, status: "unhealthy" });
    await request(app).get("/internal/operations/health").set("Authorization", `Bearer ${token}`).expect(503);
  });

  it("contains unexpected exceptions without exposing private errors", async () => {
    const { app } = appFor(vi.fn().mockRejectedValue(new Error("redis://password@internal/customer@example.test")));
    const response = await request(app).get("/internal/operations/health").set("Authorization", `Bearer ${token}`).expect(503);
    expect(response.body.checks[0].reason).toBe("probe_unavailable");
    expect(response.text).not.toMatch(/password|customer@example|redis:/);
  });
});

describe("aggregate operational health", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-01T00:00:00.000Z")); });
  const setup = () => {
    const runtime = vi.fn(() => ({ ready: true, state: "ready" as const }));
    const mongo = vi.fn().mockResolvedValue(true);
    const workers = vi.fn().mockImplementation(async (config) => config.expectedWorkers.map((role: string) => ({ id: `worker.${role}`, status: "ok", reason: "healthy" })));
    const payments = vi.fn().mockResolvedValue(paymentChecks());
    const crons = vi.fn(() => [{ id: "cron.sendOutAccessCodes", status: "ok" as const, reason: "healthy" }]);
    const publicSite = vi.fn().mockResolvedValue({ id: "public-site.configuration", status: "ok", reason: "healthy" });
    const read = createOperationsHealthReader({ runtime, mongo, workers, payments, publicSite, crons, now: () => Date.now() });
    return { read, runtime, mongo, workers, payments, publicSite, crons };
  };

  it.each([{ OPS_MONITOR_NAMESPACE: "" }, { OPS_MONITOR_WORKERS: "unknown-sensitive-role" }, { OPS_MONITOR_WORKERS: "" }])("fails closed on invalid configuration without querying", async (overrides) => {
    const h = setup();
    const config = getOperationsConfig({ OPS_MONITOR_TOKEN: token, OPS_MONITOR_NAMESPACE: "test-a", ...overrides });
    const result = await h.read(config);
    expect(result.status).toBe("unhealthy");
    expect(result.checks).toContainEqual({ id: "configuration", status: "unhealthy", reason: "invalid_configuration" });
    expect(result.checks.map((check) => check.id)).toEqual(expect.arrayContaining(["runtime", "mongo", "redis", ...paymentChecks().map((check) => check.id)]));
    expect(JSON.stringify(result)).not.toContain("unknown-sensitive-role");
    expect(h.mongo).not.toHaveBeenCalled();
    expect(h.workers).not.toHaveBeenCalled();
  });

  it("shares concurrent polls, briefly caches probes, and refreshes after the TTL", async () => {
    const h = setup();
    const [a, b] = await Promise.all([h.read(settings()), h.read(settings())]);
    expect(a).toEqual(b);
    expect(a.status).toBe("ok");
    await h.read(settings());
    expect(h.mongo).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(OPERATIONS_CACHE_MS + 1);
    await h.read(settings());
    expect(h.mongo).toHaveBeenCalledTimes(2);
  });

  it("pages for real visitors whose studio configuration was throttled even with healthy infrastructure", async () => {
    const h = setup();
    h.publicSite.mockResolvedValue({ id: "public-site.configuration", status: "unhealthy", reason: "recent_visitor_throttled" });
    const result = await h.read(settings());
    expect(result.status).toBe("unhealthy");
    expect(result.checks).toContainEqual({ id: "public-site.configuration", status: "unhealthy", reason: "recent_visitor_throttled" });
  });

  it("reports unavailable dependency probes and cannot leak their exceptions", async () => {
    const h = setup();
    h.mongo.mockRejectedValue(new Error("mongodb://secret@private"));
    h.workers.mockRejectedValue(new Error("redis://secret@private"));
    h.payments.mockRejectedValue(new Error("private customer record"));
    const result = await h.read(settings());
    expect(result.status).toBe("unhealthy");
    expect(result.checks.filter((check) => check.id.startsWith("worker.") || check.id.startsWith("payments.")).every((check) => check.status === "unavailable")).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/secret|private|mongodb:|redis:/);
  });

  it("bounds a hung probe and does not launch duplicate work on later polls", async () => {
    const h = setup();
    let release!: (value: unknown[]) => void;
    h.workers.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const first = h.read(settings());
    await vi.advanceTimersByTimeAsync(OPERATIONS_PROBE_TIMEOUT_MS);
    expect((await first).checks.find((check) => check.id === "redis")?.status).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(OPERATIONS_CACHE_MS + 1);
    const second = h.read(settings());
    await vi.advanceTimersByTimeAsync(OPERATIONS_PROBE_TIMEOUT_MS);
    await second;
    expect(h.workers).toHaveBeenCalledTimes(1);
    release([]);
    await vi.advanceTimersByTimeAsync(OPERATIONS_CACHE_MS + 1);
    h.workers.mockResolvedValue(settings().expectedWorkers.map((role) => ({ id: `worker.${role}`, status: "ok", reason: "healthy" })));
    expect((await h.read(settings())).status).toBe("ok");
  });

  it("does not serve cached healthy readiness during shutdown", async () => {
    const h = setup();
    await h.read(settings());
    h.runtime.mockReturnValue({ ready: false, state: "shutting_down" } as never);
    expect((await h.read(settings())).status).toBe("unhealthy");
  });

  it("does not reuse a probe across namespace changes while an old read hangs", async () => {
    const probe = createBoundedProbe(10);
    let release!: (value: number) => void;
    const first = probe("production", () => new Promise<number>((resolve) => { release = resolve; }));
    const rejected = expect(first).rejects.toThrow("Probe timeout");
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    await expect(probe("staging", async () => 1)).rejects.toThrow("Probe busy");
    release(3);
    await vi.advanceTimersByTimeAsync(0);
    await expect(probe("staging", async () => 1)).resolves.toBe(1);
  });
});
