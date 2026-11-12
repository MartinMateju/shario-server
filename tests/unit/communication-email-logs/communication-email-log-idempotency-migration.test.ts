import { beforeEach, describe, expect, it, vi } from "vitest";

type Index = {
  name: string;
  key: Record<string, number>;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
};

const mocks = vi.hoisted(() => ({
  indexes: [] as Index[],
  events: [] as string[],
  indexesFn: vi.fn(),
  dropIndex: vi.fn(),
  createIndex: vi.fn(),
}));

vi.mock("@/config/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("@/modules/communication-email-logs/communication-email-log.model.js", () => ({
  CommunicationEmailLogModel: {
    collection: {
      indexes: mocks.indexesFn,
      dropIndex: mocks.dropIndex,
      createIndex: mocks.createIndex,
    },
  },
}));

import { migrateCommunicationEmailLogIdempotency } from "@/modules/communication-email-logs/communication-email-log-idempotency.migration.js";

const legacyIndex = (): Index => ({
  name: "legacy_delivery_unique",
  key: {
    tenant: 1,
    automation: 1,
    recipientEmail: 1,
    relatedEntityId: 1,
  },
  unique: true,
});

describe("communication email idempotency migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.indexes = [
      { name: "_id_", key: { _id: 1 }, unique: true },
      legacyIndex(),
    ];
    mocks.indexesFn.mockImplementation(async () =>
      mocks.indexes.map((index) => ({ ...index })),
    );
    mocks.dropIndex.mockImplementation(async (name: string) => {
      mocks.events.push(`drop:${name}`);
      mocks.indexes = mocks.indexes.filter((index) => index.name !== name);
    });
    mocks.createIndex.mockImplementation(
      async (
        key: Record<string, number>,
        options: {
          name: string;
          unique: boolean;
          partialFilterExpression: Record<string, unknown>;
        },
      ) => {
        mocks.events.push(`create:${options.name}`);
        mocks.indexes.push({ key, ...options });
        return options.name;
      },
    );
  });

  it("verifies the new partial unique index before dropping legacy and is idempotent", async () => {
    await expect(migrateCommunicationEmailLogIdempotency()).resolves.toEqual({
      dropped: ["legacy_delivery_unique"],
      created: true,
    });
    expect(mocks.events).toEqual([
      "create:uniq_communication_delivery_per_tenant",
      "drop:legacy_delivery_unique",
    ]);
    expect(mocks.indexes).toContainEqual(
      expect.objectContaining({
        key: { tenant: 1, deduplicationKey: 1 },
        unique: true,
        partialFilterExpression: {
          deduplicationKey: { $type: "string", $gt: "" },
        },
      }),
    );

    await expect(migrateCommunicationEmailLogIdempotency()).resolves.toEqual({
      dropped: [],
      created: false,
    });
    expect(mocks.createIndex).toHaveBeenCalledOnce();
  });

  it("retains the legacy index if replacement creation fails", async () => {
    mocks.createIndex.mockRejectedValueOnce(new Error("duplicate delivery key"));

    await expect(migrateCommunicationEmailLogIdempotency()).rejects.toThrow(
      "duplicate delivery key",
    );
    expect(mocks.dropIndex).not.toHaveBeenCalledWith("legacy_delivery_unique");
    expect(mocks.indexes.some((index) => index.name === "legacy_delivery_unique"))
      .toBe(true);
  });

  it("creates the partial index for a fresh database without a collection", async () => {
    mocks.indexes = [];
    mocks.indexesFn
      .mockRejectedValueOnce(
        Object.assign(new Error("namespace not found"), {
          code: 26,
          codeName: "NamespaceNotFound",
        }),
      )
      .mockImplementation(async () =>
        mocks.indexes.map((index) => ({ ...index })),
      );

    await expect(migrateCommunicationEmailLogIdempotency()).resolves.toEqual({
      dropped: [],
      created: true,
    });
    expect(mocks.createIndex).toHaveBeenCalledWith(
      { tenant: 1, deduplicationKey: 1 },
      expect.objectContaining({ unique: true }),
    );
  });
});
