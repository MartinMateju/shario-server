import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/data-import/services/data-import.service.js", () => ({
  getTenantImportSession: vi.fn(),
}));

import {
  buildCustomerImportTemplateCsv,
  buildCreditImportTemplateCsv,
  buildMembershipImportTemplateCsv,
  buildMembershipPlanImportTemplateCsv,
  buildVoucherImportTemplateCsv,
  buildVoucherProductImportTemplateCsv,
} from "@/modules/data-import/services/data-import-report.service.js";
import { parseCsvRecords } from "@/modules/data-import/services/import-file-parser.service.js";

const records = (csv: string) => parseCsvRecords(csv.replace(/^\uFEFF/, ""));

describe("Step 3 downloadable import templates", () => {
  it.each([
    ["customers", buildCustomerImportTemplateCsv],
    ["membership plans", buildMembershipPlanImportTemplateCsv],
    ["memberships", buildMembershipImportTemplateCsv],
    ["credits", buildCreditImportTemplateCsv],
    ["voucher products", buildVoucherProductImportTemplateCsv],
    ["vouchers", buildVoucherImportTemplateCsv],
  ] as const)("emits a BOM-prefixed CRLF CSV for %s", (_label, build) => {
    const csv = build();
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(records(csv)).toHaveLength(2);
  });

  it("keeps password hashes blank and carries credit handoff columns", () => {
    const [headers, sample] = records(buildCustomerImportTemplateCsv());
    const row = Object.fromEntries(
      headers.map((header, index) => [header, sample[index]]),
    );

    expect(headers).toEqual(
      expect.arrayContaining([
        "Member Number",
        "Customer External ID",
        "Legacy Password Hash (bcrypt)",
        "Opening Credit Balance",
        "Credit Currency",
      ]),
    );
    expect(row["Member Number"]).toBe("1675");
    expect(row["Legacy Password Hash (bcrypt)"]).toBe("");
    expect(row["Opening Credit Balance"]).toBe("500");
    expect(row["Credit Currency"]).toBe("CZK");
  });

  it("keeps the membership-plan example on the convenience-benefit path", () => {
    const [headers, sample] = records(buildMembershipPlanImportTemplateCsv());
    const row = Object.fromEntries(
      headers.map((header, index) => [header, sample[index]]),
    );

    expect(row).toMatchObject({
      "External ID": "legacy-plan-001",
      Name: "Monthly Studio",
      "Billing Type": "recurring",
      "Billing Interval": "month",
      "Credit Allowance": "10",
      "Discount Percent": "5",
      "Benefits JSON": "",
      Status: "published",
    });
  });

  it("describes customer-membership period and remaining allowance snapshots", () => {
    const [headers, sample] = records(buildMembershipImportTemplateCsv());
    const row = Object.fromEntries(
      headers.map((header, index) => [header, sample[index]]),
    );

    expect(headers).toEqual(
      expect.arrayContaining([
        "Plan Version",
        "Period Start",
        "Period End",
        "Cancelled At",
        "Allowance Balances JSON",
      ]),
    );
    expect(row["Allowance Balances JSON"]).toBe('{"credits":7}');
    expect(row.Note).toContain("migration cutover");
  });

  it("labels credits as an opening source allocation", () => {
    const [headers, sample] = records(buildCreditImportTemplateCsv());
    const row = Object.fromEntries(
      headers.map((header, index) => [header, sample[index]]),
    );

    expect(row.Balance).toBe("500");
    expect(row.Note).toBe("Opening source allocation");
  });

  it("keeps new voucher products inactive until a PDF template exists", () => {
    const [headers, sample] = records(buildVoucherProductImportTemplateCsv());
    const row = Object.fromEntries(
      headers.map((header, index) => [header, sample[index]]),
    );

    expect(row.Active).toBe("no");
    expect(row.Value).toBe("1000");
  });

  it("includes immutable voucher liability snapshots and optional redemption data", () => {
    const [headers, sample] = records(buildVoucherImportTemplateCsv());
    const row = Object.fromEntries(
      headers.map((header, index) => [header, sample[index]]),
    );

    expect(row).toMatchObject({
      "Promo Code": "GIFT-ABCD-1234",
      Value: "1000",
      Currency: "CZK",
      Status: "active",
      "Redeemed At": "",
      "Customer ID": "",
      "Customer Email": "",
      "Customer Phone": "",
    });
    expect(row.Note).toContain("liability snapshot");
  });
});
