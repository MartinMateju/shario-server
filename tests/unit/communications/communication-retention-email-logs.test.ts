import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  distinct: vi.fn(),
}));

vi.mock("@/modules/communication-email-logs/communication-email-log.model.js", () => ({
  default: {
    updateMany: mocks.updateMany,
    deleteMany: mocks.deleteMany,
    distinct: mocks.distinct,
  },
}));

import {
  enforceCommunicationEmailLogRetention,
  listCommunicationEmailLogTenantIds,
  mergeCommunicationRetentionTenantIds,
} from "@/modules/communication-email-logs/communication-email-log-retention.service.js";

describe("communication automation email-log retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ modifiedCount: 2 });
    mocks.deleteMany.mockResolvedValue({ deletedCount: 3 });
    mocks.distinct.mockResolvedValue([]);
  });

  it("redacts PII and message content from old terminal logs", async () => {
    const cutoff = new Date("2026-07-02T00:00:00.000Z");

    await expect(
      enforceCommunicationEmailLogRetention({
        tenantId: "tenant-1",
        cutoff,
        redact: true,
      }),
    ).resolves.toBe(2);

    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: "tenant-1",
        status: { $in: ["sent", "failed", "canceled", "suppressed"] },
        updatedAt: { $lt: cutoff },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          recipientEmail: "redacted@retention.invalid",
          recipientName: "",
          subject: "[redacted by retention policy]",
          htmlContent: "",
          body: "",
          providerMessageId: "",
          user: null,
          relatedEntityId: null,
        }),
      }),
    );
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes old terminal logs when tenant redaction is disabled", async () => {
    const cutoff = new Date("2026-07-02T00:00:00.000Z");

    await expect(
      enforceCommunicationEmailLogRetention({
        tenantId: "tenant-1",
        cutoff,
        redact: false,
      }),
    ).resolves.toBe(3);
    expect(mocks.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: "tenant-1",
        status: { $in: ["sent", "failed", "canceled", "suppressed"] },
        updatedAt: { $lt: cutoff },
      }),
    );
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("is wired into the tenant retention workflow and result count", () => {
    const source = readFileSync(
      "src/modules/communications/services/retention.service.ts",
      "utf8",
    );
    expect(source).toContain("enforceCommunicationEmailLogRetention");
    expect(source).toContain("automationEmailLogs");
    expect(source).toContain("listCommunicationEmailLogTenantIds");
  });

  it("includes email-log tenants even when no settings row exists", async () => {
    mocks.distinct.mockResolvedValue(["tenant-without-settings"]);
    await expect(listCommunicationEmailLogTenantIds()).resolves.toEqual([
      "tenant-without-settings",
    ]);
    expect(
      mergeCommunicationRetentionTenantIds([], ["tenant-without-settings"]),
    ).toEqual(["tenant-without-settings"]);
  });
});
