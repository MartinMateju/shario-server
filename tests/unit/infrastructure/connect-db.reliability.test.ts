import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const connection: Record<string | symbol, any> = {
    readyState: 0,
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, [...(listeners.get(event) || []), listener]);
      return connection;
    }),
    asPromise: vi.fn(),
    close: vi.fn(),
  };

  return {
    connection,
    connect: vi.fn(),
    setServers: vi.fn(),
    listeners,
    logger: {
      fatal: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
});

vi.mock("node:dns", () => ({ setServers: mocks.setServers }));

vi.mock("mongoose", () => ({
  default: {
    connection: mocks.connection,
    connect: mocks.connect,
  },
}));

vi.mock("@/config/logger.js", () => ({ logger: mocks.logger }));

describe("database connection lifecycle", () => {
  beforeEach(() => {
    process.env.MONGO_URI = "mongodb://example.test/shario";
    delete process.env.DNS_SERVERS;
    mocks.connection.readyState = 0;
    mocks.connect.mockReset();
    mocks.setServers.mockReset();
    mocks.connection.asPromise.mockReset();
    mocks.connection.close.mockReset();
  });

  afterEach(() => {
    delete process.env.DNS_SERVERS;
  });

  it("uses one connection attempt and one listener set across repeated calls and module reloads", async () => {
    let resolveConnection: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      resolveConnection = resolve;
    });
    mocks.connect.mockImplementation(() => {
      mocks.connection.readyState = 2;
      return pending;
    });

    const firstModule = await import("@/infrastructure/database/connect-db.js");
    const first = firstModule.connectDB();
    const second = firstModule.connectDB();

    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.setServers).not.toHaveBeenCalled();
    expect(mocks.connection.on).toHaveBeenCalledTimes(3);
    expect([...mocks.listeners.keys()].sort()).toEqual([
      "connected",
      "disconnected",
      "error",
    ]);

    mocks.connection.readyState = 1;
    resolveConnection({});
    await Promise.all([first, second]);
    await firstModule.connectDB();

    vi.resetModules();
    const reloadedModule = await import(
      "@/infrastructure/database/connect-db.js"
    );
    await reloadedModule.connectDB();

    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.connection.on).toHaveBeenCalledTimes(3);
  });

  it("reuses a connection attempt already started outside this module", async () => {
    mocks.connection.readyState = 2;
    mocks.connection.asPromise.mockResolvedValue({});

    const { connectDB } = await import(
      "@/infrastructure/database/connect-db.js"
    );
    await Promise.all([connectDB(), connectDB()]);

    expect(mocks.connection.asPromise).toHaveBeenCalledOnce();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("clears a failed single-flight promise so a later connection can retry", async () => {
    const failure = new Error("server selection failed");
    mocks.connect
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(async () => {
        mocks.connection.readyState = 1;
        return {};
      });

    const { connectDB } = await import(
      "@/infrastructure/database/connect-db.js"
    );

    await expect(connectDB()).rejects.toBe(failure);
    mocks.connection.readyState = 0;
    await expect(connectDB()).resolves.toBeUndefined();

    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.logger.fatal).toHaveBeenCalledWith(
      { err: failure },
      "Failed to connect to MongoDB.",
    );
  });

  it("uses configured DNS servers before starting a new connection", async () => {
    process.env.DNS_SERVERS = " 8.8.8.8, 1.1.1.1, ";
    mocks.connect.mockImplementation(async () => {
      expect(mocks.setServers).toHaveBeenCalledWith([
        "8.8.8.8",
        "1.1.1.1",
      ]);
      mocks.connection.readyState = 1;
      return {};
    });

    const { connectDB } = await import(
      "@/infrastructure/database/connect-db.js"
    );
    await connectDB();

    expect(mocks.setServers).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledOnce();
  });

  it("closes an active database connection and ignores an already closed one", async () => {
    const { closeDatabaseConnection } = await import(
      "@/infrastructure/database/connect-db.js"
    );

    mocks.connection.readyState = 1;
    mocks.connection.close.mockResolvedValue(undefined);
    await closeDatabaseConnection();
    expect(mocks.connection.close).toHaveBeenCalledOnce();

    mocks.connection.readyState = 0;
    await closeDatabaseConnection();
    expect(mocks.connection.close).toHaveBeenCalledOnce();
  });
});
