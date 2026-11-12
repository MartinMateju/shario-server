import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queueRollback: vi.fn(),
  tenantId: vi.fn(() => "tenant-a"),
  actorId: vi.fn(() => "actor-a"),
}));

vi.mock("@/modules/auth/auth.utils.js", () => ({
  getAuthenticatedUserId: mocks.actorId,
}));
vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: mocks.tenantId,
}));
vi.mock(
  "../../../src/modules/data-import/services/data-import.service.js",
  () => ({
    createCustomerImportSession: vi.fn(),
    getTenantImportSession: vi.fn(),
    listImportRows: vi.fn(),
    listTenantImportSessions: vi.fn(),
    serializeImportSession: vi.fn(),
    validateCustomerImportSession: vi.fn(),
  }),
);
vi.mock(
  "../../../src/modules/data-import/services/data-import-queue.service.js",
  () => ({
    queueDataImportSession: vi.fn(),
    queueImportRollbackSession: mocks.queueRollback,
  }),
);
vi.mock(
  "../../../src/modules/data-import/services/product-import.service.js",
  () => ({
    createProductImportSession: vi.fn(),
    validateProductImportSession: vi.fn(),
  }),
);
vi.mock(
  "../../../src/modules/data-import/services/booking-import.service.js",
  () => ({
    createBookingImportSession: vi.fn(),
    validateBookingImportSession: vi.fn(),
  }),
);
vi.mock(
  "../../../src/modules/data-import/services/membership-plan-import.service.js",
  () => ({
    createMembershipPlanImportSession: vi.fn(),
    validateMembershipPlanImportSession: vi.fn(),
  }),
);
vi.mock(
  "../../../src/modules/data-import/services/membership-import.service.js",
  () => ({
    createMembershipImportSession: vi.fn(),
    validateMembershipImportSession: vi.fn(),
  }),
);
vi.mock(
  "../../../src/modules/data-import/services/credit-import.service.js",
  () => ({
    createCreditImportSession: vi.fn(),
    validateCreditImportSession: vi.fn(),
  }),
);
vi.mock(
  "../../../src/modules/data-import/services/voucher-product-import.service.js",
  () => ({
    createVoucherProductImportSession: vi.fn(),
    validateVoucherProductImportSession: vi.fn(),
  }),
);
vi.mock(
  "../../../src/modules/data-import/services/voucher-import.service.js",
  () => ({
    createVoucherImportSession: vi.fn(),
    validateVoucherImportSession: vi.fn(),
  }),
);
vi.mock(
  "../../../src/modules/data-import/services/data-import-report.service.js",
  () => ({
    buildBookingImportTemplateCsv: vi.fn(),
    buildCreditImportTemplateCsv: vi.fn(),
    buildCustomerImportReportCsv: vi.fn(),
    buildImportRollbackReportCsv: vi.fn(),
    buildCustomerImportTemplateCsv: vi.fn(),
    buildMembershipImportTemplateCsv: vi.fn(),
    buildMembershipPlanImportTemplateCsv: vi.fn(),
    buildProductImportTemplateCsv: vi.fn(),
    buildVoucherImportTemplateCsv: vi.fn(),
    buildVoucherProductImportTemplateCsv: vi.fn(),
  }),
);
vi.mock(
  "../../../src/modules/data-import/services/data-import-rollback.service.js",
  () => ({
    previewImportRollback: vi.fn(),
  }),
);

import { rollbackImport } from "../../../src/modules/data-import/data-import.controller.js";

const response = () => {
  const res: any = {
    set: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
};

const request = ({
  revision = 2,
  previewToken = "a".repeat(64),
  idempotencyKey,
}: {
  revision?: unknown;
  previewToken?: unknown;
  idempotencyKey?: string;
} = {}) => ({
  params: { id: "session-a" },
  body: { revision, previewToken },
  get: vi.fn((name: string) =>
    name === "Idempotency-Key" ? idempotencyKey : undefined,
  ),
});

const invoke = async (req: any) => {
  const res = response();
  const next = vi.fn();
  await rollbackImport(req, res, next);
  return { res, next };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queueRollback.mockResolvedValue({
    id: "session-a",
    rollback: { status: "queued" },
  });
});

describe("rollback request validation and idempotency", () => {
  it("uses a valid explicit idempotency key and returns 202/no-store", async () => {
    const token = "b".repeat(64);
    const { res, next } = await invoke(
      request({
        revision: 7,
        previewToken: token,
        idempotencyKey: "rollback:request-7",
      }),
    );

    expect(next).not.toHaveBeenCalled();
    expect(mocks.queueRollback).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      sessionId: "session-a",
      revision: 7,
      previewToken: token,
      idempotencyKey: "rollback:request-7",
      actorId: "actor-a",
    });
    expect(res.set).toHaveBeenCalledWith({
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it("derives a stable idempotency key from the exact preview token", async () => {
    const token = "c".repeat(64);
    await invoke(request({ revision: 3, previewToken: token }));
    expect(mocks.queueRollback).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `preview:${token}` }),
    );
  });

  it.each([
    [request({ revision: 0 }), "IMPORT_ROLLBACK_REVISION_INVALID"],
    [request({ revision: 1.5 }), "IMPORT_ROLLBACK_REVISION_INVALID"],
    [
      request({ previewToken: "not-a-digest" }),
      "IMPORT_ROLLBACK_PREVIEW_TOKEN_INVALID",
    ],
    [
      request({ idempotencyKey: "contains spaces" }),
      "IMPORT_ROLLBACK_IDEMPOTENCY_KEY_INVALID",
    ],
    [
      request({ idempotencyKey: "x".repeat(129) }),
      "IMPORT_ROLLBACK_IDEMPOTENCY_KEY_INVALID",
    ],
  ] as const)("rejects malformed destructive request %#", async (req, code) => {
    const { next } = await invoke(req);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code }));
    expect(mocks.queueRollback).not.toHaveBeenCalled();
  });
});
