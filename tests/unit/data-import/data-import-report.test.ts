import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  rowModel: { find: vi.fn() },
  mutationModel: { find: vi.fn() },
}));

const query = <T>(value: T) => {
  const chain: Record<string, any> = {};
  for (const method of ["sort", "select", "limit"])
    chain[method] = vi.fn(() => chain);
  chain.lean = vi.fn(async () => value);
  chain.then = (
    resolve: (result: T) => unknown,
    reject: (error: unknown) => unknown,
  ) => Promise.resolve(value).then(resolve, reject);
  return chain;
};

vi.mock("../../../src/modules/data-import/data-import-row.model.js", () => ({
  default: mocks.rowModel,
}));
vi.mock(
  "../../../src/modules/data-import/data-import-mutation.model.js",
  () => ({
    default: mocks.mutationModel,
  }),
);
vi.mock(
  "../../../src/modules/data-import/services/data-import.service.js",
  () => ({
    getTenantImportSession: mocks.getSession,
  }),
);

import {
  buildCustomerImportReportCsv,
  buildImportRollbackReportCsv,
  safeImportCsvValue,
} from "../../../src/modules/data-import/services/data-import-report.service.js";

const retainedSession = (overrides: Record<string, unknown> = {}) => ({
  _id: "session-a",
  tenant: "tenant-a",
  headers: ["Name"],
  summary: { total: 1, created: 1, updated: 0 },
  reportAvailableUntil: new Date(Date.now() + 86_400_000),
  rollback: {
    status: "completed",
    requestedAt: new Date("2026-08-01T00:00:00.000Z"),
  },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(retainedSession());
  mocks.rowModel.find.mockReturnValue(query([]));
  mocks.mutationModel.find.mockReturnValue(query([]));
});

describe("data import downloadable reports", () => {
  it("rejects a missing or expired retention deadline before reading rows", async () => {
    for (const reportAvailableUntil of [null, new Date(Date.now() - 1)]) {
      mocks.getSession.mockResolvedValueOnce(
        retainedSession({ reportAvailableUntil }),
      );
      await expect(
        buildCustomerImportReportCsv({
          tenantId: "tenant-a",
          sessionId: "session-a",
        }),
      ).rejects.toMatchObject({
        statusCode: 410,
        code: "IMPORT_REPORT_EXPIRED",
      });
    }
    expect(mocks.rowModel.find).not.toHaveBeenCalled();
  });

  it("requires the retained report row set to be complete", async () => {
    mocks.getSession.mockResolvedValue(
      retainedSession({ summary: { total: 2 } }),
    );
    mocks.rowModel.find.mockReturnValue(query([{ rowNumber: 2 }]));

    await expect(
      buildCustomerImportReportCsv({
        tenantId: "tenant-a",
        sessionId: "session-a",
      }),
    ).rejects.toMatchObject({
      statusCode: 410,
      code: "IMPORT_REPORT_UNAVAILABLE",
    });
    expect(mocks.rowModel.find).toHaveBeenCalledWith({
      tenant: "tenant-a",
      session: "session-a",
    });
  });

  it("emits a BOM/CRLF CSV and neutralizes formulas in headers, messages, issues and raw data", async () => {
    mocks.getSession.mockResolvedValue(
      retainedSession({ headers: ["=HEADER", "Note", "Space"] }),
    );
    mocks.rowModel.find.mockReturnValue(
      query([
        {
          rowNumber: 2,
          status: "failed",
          resultMessage: "+SUM(1,1)",
          issues: [{ code: "@CODE", message: "-2+2" }],
          raw: {
            "=HEADER": "=cmd|' /C calc'!A0",
            Note: '\t=HYPERLINK("https://example.invalid")',
            Space: "   +99",
          },
        },
      ]),
    );

    const csv = await buildCustomerImportReportCsv({
      tenantId: "tenant-a",
      sessionId: "session-a",
    });

    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv).not.toMatch(/(?<=^|,|\")\s*[=+@-](?![\w -]*\")/m);
    expect(csv).toContain("'=HEADER");
    expect(csv).toContain("'+SUM(1,1)");
    expect(csv).toContain("'=cmd|' /C calc'!A0");
    expect(csv).toContain("'\t=HYPERLINK");
    expect(csv).toContain("'   +99");
  });

  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1"])(
    "prefixes dangerous formula value %j",
    (value) => expect(safeImportCsvValue(value)).toBe(`'${value}`),
  );

  it("rejects rollback report download before a rollback request", async () => {
    mocks.getSession.mockResolvedValue(retainedSession({ rollback: {} }));

    await expect(
      buildImportRollbackReportCsv({
        tenantId: "tenant-a",
        sessionId: "session-a",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "IMPORT_ROLLBACK_REPORT_NOT_READY",
    });
    expect(mocks.mutationModel.find).not.toHaveBeenCalled();
  });

  it.each(["queued", "processing"])(
    "does not expose a misleading rollback report while status is %s",
    async (status) => {
      mocks.getSession.mockResolvedValue(
        retainedSession({
          rollback: {
            status,
            requestedAt: new Date("2026-08-01T00:00:00.000Z"),
          },
        }),
      );

      await expect(
        buildImportRollbackReportCsv({
          tenantId: "tenant-a",
          sessionId: "session-a",
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "IMPORT_ROLLBACK_REPORT_NOT_READY",
      });
      expect(mocks.mutationModel.find).not.toHaveBeenCalled();
    },
  );

  it("fails closed for a legacy rollback whose journal is unavailable", async () => {
    mocks.mutationModel.find.mockReturnValue(query([]));

    await expect(
      buildImportRollbackReportCsv({
        tenantId: "tenant-a",
        sessionId: "session-a",
      }),
    ).rejects.toMatchObject({
      statusCode: 410,
      code: "IMPORT_ROLLBACK_REPORT_UNAVAILABLE",
    });
    expect(mocks.mutationModel.find).toHaveBeenCalledWith({
      tenant: "tenant-a",
      session: "session-a",
      isCanonicalResult: true,
    });
  });

  it("fails closed when retention left only a partial canonical rollback journal", async () => {
    mocks.getSession.mockResolvedValue(
      retainedSession({ summary: { total: 3, created: 2, updated: 1 } }),
    );
    mocks.mutationModel.find.mockReturnValue(
      query([
        {
          rowNumber: 2,
          entityType: "products",
          importOutcome: "created",
          operation: "create",
          target: "product-a",
          rollback: { status: "compensated" },
        },
        {
          rowNumber: 3,
          entityType: "products",
          importOutcome: "updated",
          operation: "update",
          target: "product-b",
          rollback: { status: "blocked" },
        },
      ]),
    );

    await expect(
      buildImportRollbackReportCsv({
        tenantId: "tenant-a",
        sessionId: "session-a",
      }),
    ).rejects.toMatchObject({
      statusCode: 410,
      code: "IMPORT_ROLLBACK_REPORT_UNAVAILABLE",
    });
  });

  it("reports one canonical entry per imported row and formula-escapes messages", async () => {
    mocks.mutationModel.find.mockReturnValue(
      query([
        {
          rowNumber: 2,
          entityType: "products",
          importOutcome: "created",
          operation: "create",
          target: "product-a",
          rollback: {
            status: "compensated",
            message: "=unsafe",
            completedAt: new Date("2026-08-02T03:04:05.000Z"),
          },
        },
      ]),
    );

    const csv = await buildImportRollbackReportCsv({
      tenantId: "tenant-a",
      sessionId: "session-a",
    });

    expect(csv).toContain('"products","created","create","compensated"');
    expect(csv).toContain("'=unsafe");
    expect(csv).toContain("product-a");
    expect(csv).toContain("2026-08-02T03:04:05.000Z");
  });
});
