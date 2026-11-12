import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantImportSession: vi.fn(),
  rowFind: vi.fn(),
}));

vi.mock("@/modules/data-import/services/data-import.service.js", () => ({
  getTenantImportSession: mocks.getTenantImportSession,
}));
vi.mock("@/modules/data-import/data-import-row.model.js", () => ({
  default: { find: mocks.rowFind },
}));

import {
  buildBookingImportTemplateCsv,
  buildCustomerImportReportCsv,
  buildProductImportTemplateCsv,
} from "@/modules/data-import/services/data-import-report.service.js";

describe("product and booking import CSV output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("provides complete product and booking templates", () => {
    const product = buildProductImportTemplateCsv();
    expect(product.startsWith("\uFEFF")).toBe(true);
    expect(product).toContain('"Name","Kind","Description","SKU"');
    expect(product).toContain('"Open Studio"');
    expect(product).toContain('"Class"');

    const booking = buildBookingImportTemplateCsv();
    expect(booking.startsWith("\uFEFF")).toBe(true);
    expect(booking).toContain(
      '"Booking ID","Customer ID","Customer Email","Customer Phone"',
    );
    expect(booking).toContain('"Start datetime","End datetime","Date"');
    expect(booking).toContain("2026-09-15T09:00:00+02:00");
  });

  it("neutralizes spreadsheet formulas in imported values and issue text", async () => {
    mocks.getTenantImportSession.mockResolvedValue({
      _id: "session-1",
      headers: ["Name", "Note"],
      summary: { total: 1 },
      reportAvailableUntil: new Date(Date.now() + 60_000),
    });
    mocks.rowFind.mockReturnValue({
      sort: () => ({
        lean: () =>
          Promise.resolve([
            {
              rowNumber: 2,
              status: "invalid",
              resultMessage: "+unsafe result",
              issues: [
                { code: "BAD", message: "@unsafe issue", severity: "error" },
              ],
              raw: { Name: "=2+2", Note: "-cmd" },
            },
          ]),
      }),
    });

    const report = await buildCustomerImportReportCsv({
      tenantId: "tenant-1",
      sessionId: "session-1",
    });

    expect(report).toContain('"\'=2+2"');
    expect(report).toContain('"\'-cmd"');
    expect(report).toContain('"\'+unsafe result"');
    expect(report).toContain('"BAD: @unsafe issue"');
    expect(report.startsWith("\uFEFF")).toBe(true);
    expect(report.endsWith("\r\n")).toBe(true);
  });
});
