import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mongo = vi.hoisted(() => {
  const command = vi.fn();
  return {
    command,
    connection: {
      readyState: 1,
      db: { command } as { command: typeof command } | undefined,
    },
  };
});

vi.mock("mongoose", () => ({ default: { connection: mongo.connection } }));

import { rootRoutes } from "@/app/root.routes.js";
import {
  getServiceReadiness,
  MONGO_READINESS_TIMEOUT_MS,
} from "@/infrastructure/lifecycle/dependency-readiness.js";
import {
  markRuntimeReady,
  markRuntimeShuttingDown,
  markRuntimeStarting,
} from "@/infrastructure/lifecycle/runtime-readiness.js";

const app = express().use(rootRoutes);

describe("dependency-aware readiness", () => {
  beforeEach(() => {
    mongo.connection.readyState = 1;
    mongo.connection.db = { command: mongo.command };
    mongo.command.mockReset().mockResolvedValue({ ok: 1 });
    markRuntimeReady();
  });

  afterEach(() => {
    markRuntimeStarting();
  });

  it("keeps liveness available when MongoDB is disconnected", async () => {
    mongo.connection.readyState = 0;

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(mongo.command).not.toHaveBeenCalled();
  });

  it.each(["starting", "shutting_down"] as const)(
    "rejects %s before attempting a dependency probe",
    async (state) => {
      if (state === "starting") markRuntimeStarting();
      else markRuntimeShuttingDown();

      const response = await request(app).get("/ready");

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ status: "not_ready", state });
      expect(mongo.command).not.toHaveBeenCalled();
    },
  );

  it.each([0, 2, 3])("rejects Mongo connection state %s immediately", async (state) => {
    mongo.connection.readyState = state;

    const response = await request(app).get("/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "not_ready", state: "ready" });
    expect(mongo.command).not.toHaveBeenCalled();
  });

  it("rejects a connection with no database handle", async () => {
    mongo.connection.db = undefined;

    expect(await getServiceReadiness()).toEqual({ ready: false, state: "ready" });
    expect(mongo.command).not.toHaveBeenCalled();
  });

  it("checks the primary and prevents caching a healthy response", async () => {
    const response = await request(app).get("/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ready", state: "ready" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(mongo.command).toHaveBeenCalledWith(
      { ping: 1 },
      { readPreference: "primary", timeoutMS: MONGO_READINESS_TIMEOUT_MS },
    );
  });

  it("fails closed without returning driver errors and recovers on the next probe", async () => {
    mongo.command.mockRejectedValueOnce(new Error("private connection details"));

    const unavailable = await request(app).get("/ready");
    const recovered = await request(app).get("/ready");

    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({ status: "not_ready", state: "ready" });
    expect(unavailable.text).not.toContain("private connection details");
    expect(recovered.status).toBe(200);
  });

  it("bounds a stalled probe and shares it between concurrent requests", async () => {
    vi.useFakeTimers();
    mongo.command.mockImplementationOnce(() => new Promise(() => {}));

    const first = getServiceReadiness();
    const second = getServiceReadiness();
    expect(mongo.command).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MONGO_READINESS_TIMEOUT_MS);

    expect(await first).toEqual({ ready: false, state: "ready" });
    expect(await second).toEqual({ ready: false, state: "ready" });
    expect(vi.getTimerCount()).toBe(0);
    expect(await getServiceReadiness()).toEqual({ ready: true, state: "ready" });
    expect(mongo.command).toHaveBeenCalledTimes(2);
  });

  it("does not return ready when shutdown starts during a successful probe", async () => {
    let complete!: (value: { ok: number }) => void;
    mongo.command.mockImplementationOnce(() => new Promise((resolve) => {
      complete = resolve;
    }));

    const readiness = getServiceReadiness();
    markRuntimeShuttingDown();
    complete({ ok: 1 });

    expect(await readiness).toEqual({ ready: false, state: "shutting_down" });
  });

  it("rejects a disconnect during a successful probe", async () => {
    let complete!: (value: { ok: number }) => void;
    mongo.command.mockImplementationOnce(() => new Promise((resolve) => {
      complete = resolve;
    }));

    const readiness = getServiceReadiness();
    mongo.connection.readyState = 0;
    complete({ ok: 1 });

    expect(await readiness).toEqual({ ready: false, state: "ready" });
  });
});
