import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/config/logger.js", () => ({
  logger: { error: mocks.logError },
}));
vi.mock("@/modules/data-import/data-import-audit-event.model.js", () => ({
  default: { create: mocks.create },
}));

import { recordDataImportAudit } from "@/modules/data-import/services/data-import-audit.service.js";

describe("data import audit recording", () => {
  it("does not fail the authoritative import transition when audit storage is unavailable", async () => {
    const error = new Error("audit database unavailable");
    mocks.create.mockRejectedValue(error);

    await expect(
      recordDataImportAudit({
        tenantId: "tenant-1",
        sessionId: "session-1",
        actorId: "actor-1",
        action: "completed",
        metadata: { created: 2 },
      }),
    ).resolves.toBeNull();
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.objectContaining({
        err: error,
        tenantId: "tenant-1",
        sessionId: "session-1",
        action: "completed",
      }),
      "Data import audit event could not be persisted.",
    );
  });
});
