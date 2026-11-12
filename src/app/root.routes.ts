import { Router } from "express";

import { getServiceReadiness } from "@/infrastructure/lifecycle/dependency-readiness.js";

export const rootRoutes = Router();

rootRoutes.get("/", (_req, res) => {
    res.status(200).json({
        status: "ok",
        service: "shario-api",
        environment: process.env.NODE_ENV || "development",
        timestamp: new Date().toISOString(),
    });
});

rootRoutes.get("/health", (_req, res) => {
    res.status(200).json({
        status: "ok",
    });
});

rootRoutes.get("/ready", async (_req, res) => {
    const readiness = await getServiceReadiness();

    res.set("Cache-Control", "no-store");
    res.status(readiness.ready ? 200 : 503).json({
        status: readiness.ready ? "ready" : "not_ready",
        state: readiness.state,
    });
});

export default rootRoutes;
