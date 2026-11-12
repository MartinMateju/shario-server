import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findPoolById: vi.fn(),
  listPools: vi.fn(),
  listPoolSummaryCodes: vi.fn(),
  findCodeById: vi.fn(),
  findFingerprint: vi.fn(),
  findNonRetiredEmergency: vi.fn(),
  createCode: vi.fn(),
  createAuditEvent: vi.fn(),
  locationFind: vi.fn(),
}));

vi.mock("@/modules/location/location.repository.js", () => ({
  locationRepository: { findByIdForTenant: mocks.locationFind },
}));

vi.mock("@/modules/tenant-access/index.js", () => ({
  assertLocationIdsWithinWorkspaceScope: vi.fn(),
}));

vi.mock("@/shared/http/httpErrors.js", () => {
  const httpError = (fallbackCode: string) =>
    (input: string | { message?: string; code?: string }) => {
      const details = typeof input === "string" ? { message: input } : input;
      throw Object.assign(new Error(details.message || fallbackCode), {
        ...details,
        code: details.code || fallbackCode,
      });
    };

  return {
    badRequest: httpError("BAD_REQUEST"),
    conflict: httpError("CONFLICT"),
    notFound: httpError("NOT_FOUND"),
  };
});

vi.mock(
  "@/modules/access-codes/access-code-inventory.repository.js",
  () => ({
    accessCodeInventoryRepository: {
      findPoolById: mocks.findPoolById,
      listPools: mocks.listPools,
      listPoolSummaryCodes: mocks.listPoolSummaryCodes,
      findCodeById: mocks.findCodeById,
      findFingerprint: mocks.findFingerprint,
      findNonRetiredEmergency: mocks.findNonRetiredEmergency,
      createCode: mocks.createCode,
      createAuditEvent: mocks.createAuditEvent,
    },
  }),
);

import { encryptAccessCode } from "@/modules/access-codes/access-code.crypto.js";
import { accessCodeService } from "@/modules/access-codes/services/access-code.service.js";

const TENANT_ID = "64b000000000000000000101";
const LOCATION_ID = "64b000000000000000000102";
const POOL_ID = "64b000000000000000000103";
const CODE_ID = "64b000000000000000000104";
const ACTOR_ID = "64b000000000000000000105";
const KEY = "access-code-service-test-key-at-least-32-bytes";

const pool = {
  _id: POOL_ID,
  tenant: TENANT_ID,
  location: LOCATION_ID,
  name: "Main entrance",
  lowStockThreshold: 2,
  isActive: true,
};

describe("access-code inventory service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ACCESS_CODE_ENCRYPTION_KEY = KEY;
    mocks.findPoolById.mockResolvedValue(pool);
    mocks.findFingerprint.mockResolvedValue(null);
    mocks.findNonRetiredEmergency.mockResolvedValue(null);
    mocks.createAuditEvent.mockResolvedValue({ _id: "audit-id" });
  });

  it("requires programmed-and-tested confirmation before availability", async () => {
    await expect(
      accessCodeService.create(
        TENANT_ID,
        {
          poolId: POOL_ID,
          code: "001234",
          label: "",
          notes: "",
          type: "single_booking",
          status: "available",
          validFrom: null,
          validUntil: null,
          programmedAndTested: false,
        },
        { actorId: ACTOR_ID },
      ),
    ).rejects.toMatchObject({ code: "ACCESS_CODE_VERIFICATION_REQUIRED" });

    expect(mocks.createCode).not.toHaveBeenCalled();
  });

  it("encrypts new codes, returns only the hint, and audits metadata", async () => {
    mocks.createCode.mockImplementation(async (_tenantId, input) => ({
      _id: CODE_ID,
      tenant: TENANT_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...input,
    }));

    const result = await accessCodeService.create(
      TENANT_ID,
      {
        poolId: POOL_ID,
        code: "001234",
        label: "Front door",
        notes: "Tested on site",
        type: "single_booking",
        status: "available",
        validFrom: null,
        validUntil: null,
        programmedAndTested: true,
      },
      { actorId: ACTOR_ID },
    );

    const persisted = mocks.createCode.mock.calls[0][1];
    expect(persisted.entryCode).toMatch(/^v1:/);
    expect(persisted.entryCode).not.toContain("001234");
    expect(persisted.codeHint).toBe("••••34");
    expect(result.maskedCode).toBe("••••34");
    expect(result).not.toHaveProperty("entryCode");
    expect(mocks.createAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "code.created",
        metadata: expect.objectContaining({ maskedCode: "••••34" }),
      }),
    );
    expect(JSON.stringify(mocks.createAuditEvent.mock.calls)).not.toContain(
      "001234",
    );
  });

  it("fails reveal closed when its audit cannot be persisted", async () => {
    const entryCode = encryptAccessCode({
      tenantId: TENANT_ID,
      poolId: POOL_ID,
      entryCode: "0099",
    });
    mocks.findCodeById.mockResolvedValue({
      _id: CODE_ID,
      tenant: TENANT_ID,
      pool: POOL_ID,
      location: LOCATION_ID,
      entryCode,
      codeHint: "••99",
      status: "available",
    });
    mocks.createAuditEvent.mockRejectedValue(new Error("audit unavailable"));

    await expect(
      accessCodeService.reveal(
        TENANT_ID,
        CODE_ID,
        { actorId: ACTOR_ID },
      ),
    ).rejects.toThrow("audit unavailable");
  });

  it("keeps emergency and reusable codes out of normal low-stock totals", async () => {
    mocks.listPools.mockResolvedValue([pool]);
    mocks.listPoolSummaryCodes.mockResolvedValue([
      {
        pool: POOL_ID,
        type: "single_booking",
        status: "available",
        validUntil: null,
        verifiedAt: new Date(),
      },
      {
        pool: POOL_ID,
        type: "reusable",
        status: "available",
        validUntil: null,
        verifiedAt: new Date(),
      },
      {
        pool: POOL_ID,
        type: "emergency_reserve",
        status: "available",
        validUntil: null,
        verifiedAt: new Date(),
      },
      {
        pool: POOL_ID,
        type: "single_booking",
        status: "available",
        validUntil: new Date("2020-01-01T00:00:00.000Z"),
        verifiedAt: new Date(),
      },
    ]);

    const { pools } = await accessCodeService.listPools(TENANT_ID, {
      includeArchived: false,
    });

    expect(pools[0]).toMatchObject({
      availableCount: 1,
      reusableCount: 1,
      emergencyCount: 1,
      lowStock: true,
      severity: "warning",
      counts: { available: 1, reusable: 1, emergency: 1 },
    });
  });
});
