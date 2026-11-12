import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  indexes: vi.fn(),
  createIndex: vi.fn(),
  dropIndex: vi.fn(),
}));

vi.mock("@/modules/user/user.model.js", () => ({
  default: {
    collection: {
      indexes: mocks.indexes,
      createIndex: mocks.createIndex,
      dropIndex: mocks.dropIndex,
    },
  },
}));

import { migrateUserEmailIndex } from "@/modules/user/user-email-index.migration.js";

describe("importable customer email index migration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.indexes.mockResolvedValue([{ name: "tenant_1_email_1" }]);
    mocks.createIndex.mockResolvedValue("tenant_1_email_1_partial");
    mocks.dropIndex.mockResolvedValue(undefined);
  });

  it("is dry-run by default", async () => {
    await expect(migrateUserEmailIndex()).resolves.toEqual({
      mode: "dry-run",
      createPartialIndex: true,
      dropLegacyIndex: true,
      changed: false,
    });
    expect(mocks.createIndex).not.toHaveBeenCalled();
    expect(mocks.dropIndex).not.toHaveBeenCalled();
  });

  it("replaces the incompatible legacy index during the maintenance window", async () => {
    await expect(migrateUserEmailIndex({ apply: true })).resolves.toMatchObject(
      {
        mode: "apply",
        changed: true,
      },
    );
    expect(mocks.createIndex).toHaveBeenCalledWith(
      { tenant: 1, email: 1 },
      expect.objectContaining({
        unique: true,
        partialFilterExpression: { email: { $type: "string" } },
      }),
    );
    expect(mocks.dropIndex).toHaveBeenCalledWith("tenant_1_email_1");
    expect(mocks.dropIndex.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createIndex.mock.invocationCallOrder[0],
    );
  });

  it("restores the legacy constraint if partial-index creation fails", async () => {
    const failure = new Error("partial index failed");
    mocks.createIndex
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce("tenant_1_email_1");

    await expect(migrateUserEmailIndex({ apply: true })).rejects.toBe(failure);
    expect(mocks.createIndex).toHaveBeenLastCalledWith(
      { tenant: 1, email: 1 },
      { name: "tenant_1_email_1", unique: true },
    );
  });
});
