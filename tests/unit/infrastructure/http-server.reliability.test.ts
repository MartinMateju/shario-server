import { EventEmitter } from "node:events";
import type { Server } from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
  closeHttpServer,
  waitForHttpServerListening,
} from "@/infrastructure/lifecycle/http-server.js";

const createServerDouble = () => {
  const emitter = new EventEmitter() as EventEmitter &
    Partial<Server> & {
      listening: boolean;
    };
  emitter.listening = false;
  emitter.close = vi.fn();
  emitter.closeIdleConnections = vi.fn();
  return emitter as Server & {
    close: ReturnType<typeof vi.fn>;
    closeIdleConnections: ReturnType<typeof vi.fn>;
  };
};

describe("HTTP server lifecycle", () => {
  it("resolves only after listening and removes the temporary error listener", async () => {
    const server = createServerDouble();
    let settled = false;
    const listening = waitForHttpServerListening(server).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(server.listenerCount("error")).toBe(1);

    server.emit("listening");
    await listening;

    expect(settled).toBe(true);
    expect(server.listenerCount("error")).toBe(0);
  });

  it("rejects an asynchronous listen error and removes the listening listener", async () => {
    const server = createServerDouble();
    const failure = Object.assign(new Error("address in use"), {
      code: "EADDRINUSE",
    });
    const listening = waitForHttpServerListening(server);

    server.emit("error", failure);

    await expect(listening).rejects.toBe(failure);
    expect(server.listenerCount("listening")).toBe(0);
  });

  it("closes idle connections and tolerates a server that never started", async () => {
    const server = createServerDouble();
    server.close.mockImplementation((callback: (error?: Error) => void) => {
      callback(
        Object.assign(new Error("not running"), {
          code: "ERR_SERVER_NOT_RUNNING",
        }),
      );
      return server;
    });

    await expect(closeHttpServer(server)).resolves.toBeUndefined();
    expect(server.close).toHaveBeenCalledOnce();
    expect(server.closeIdleConnections).toHaveBeenCalledOnce();
  });
});
