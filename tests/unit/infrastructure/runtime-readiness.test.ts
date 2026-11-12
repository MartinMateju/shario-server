import { describe, expect, it } from "vitest";

import {
  getRuntimeReadiness,
  markRuntimeReady,
  markRuntimeShuttingDown,
  markRuntimeStarting,
} from "@/infrastructure/lifecycle/runtime-readiness.js";

describe("runtime readiness", () => {
  it("becomes unavailable before startup and immediately when shutdown begins", () => {
    markRuntimeStarting();
    expect(getRuntimeReadiness()).toEqual({ ready: false, state: "starting" });

    markRuntimeReady();
    expect(getRuntimeReadiness()).toEqual({ ready: true, state: "ready" });

    markRuntimeShuttingDown();
    expect(getRuntimeReadiness()).toEqual({
      ready: false,
      state: "shutting_down",
    });
  });
});
