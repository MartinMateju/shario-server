import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loggerError: vi.fn(),
}));

vi.mock("@/config/logger.js", () => ({
  logger: { error: mocks.loggerError },
}));

import { withQueueErrorLogging } from "@/infrastructure/queues/queue-observability.js";

describe("BullMQ queue observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs queue connection errors instead of leaving them unhandled", () => {
    const queue = { on: vi.fn() };

    expect(withQueueErrorLogging(queue, "data-imports")).toBe(queue);
    expect(queue.on).toHaveBeenCalledWith("error", expect.any(Function));

    const listener = queue.on.mock.calls[0][1] as (error: Error) => void;
    const error = new Error("Redis unavailable");

    expect(() => listener(error)).not.toThrow();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      { err: error, queue: "data-imports" },
      "BullMQ queue error.",
    );
  });
});
