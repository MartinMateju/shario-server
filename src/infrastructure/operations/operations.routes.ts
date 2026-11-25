import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { getOperationsConfig, isOperationsEnabled } from "./operations.config.js";
import { readOperationsHealth } from "./operations-health.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

export const createOperationsRouter = (
  readHealth = readOperationsHealth,
  config = getOperationsConfig,
) => {
  const router = Router();
  router.get("/health", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const settings = config();
    if (!isOperationsEnabled(settings)) {
      res.status(404).json({ status: "not_found" });
      return;
    }
    const authorization = req.get("authorization") ?? "";
    const supplied = /^Bearer (.{1,512})$/i.exec(authorization)?.[1] ?? "";
    // Hash both values so comparison always operates on equal-size buffers,
    // including missing, malformed, and different-length credentials.
    if (!timingSafeEqual(digest(supplied), digest(settings.token))) {
      res.status(401).json({ status: "unauthorized" });
      return;
    }
    try {
      const report = await readHealth(settings);
      res.status(report.status === "ok" ? 200 : 503).json(report);
    } catch {
      // An unexpected monitoring error must not reach the general error handler
      // and accidentally expose an exception, connection string, or credential.
      res.status(503).json({ schemaVersion: 1, status: "unhealthy", observedAt: new Date().toISOString(), checks: [{ id: "monitor", status: "unavailable", reason: "probe_unavailable" }] });
    }
  });
  return router;
};

export default createOperationsRouter();
