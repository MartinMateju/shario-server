import { csvRow } from "@/modules/reports/reports.csv.js";
import { AppError } from "@/shared/http/httpErrors.js";

import DataImportMutationModel from "../data-import-mutation.model.js";
import DataImportRowModel from "../data-import-row.model.js";
import { DATA_IMPORT_ROLLBACK_STATUS } from "../data-import.constants.js";
import { getTenantImportSession } from "./data-import.service.js";

const csvDocument = (rows: string[]): string =>
  "\uFEFF" + rows.join("\r\n") + "\r\n";

export const safeImportCsvValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
};

const assertReportRetained = (session: any): void => {
  if (
    !session.reportAvailableUntil ||
    new Date(session.reportAvailableUntil).getTime() <= Date.now()
  )
    throw new AppError({
      statusCode: 410,
      message: "This import report is no longer available.",
      code: "IMPORT_REPORT_EXPIRED",
    });
};

export const buildCustomerImportTemplateCsv = (): string =>
  csvDocument([
    csvRow([
      "Full Name",
      "First Name",
      "Last Name",
      "Email",
      "Phone",
      "Member Number",
      "Customer External ID",
      "Legacy Password Hash (bcrypt)",
      "Opening Credit Balance",
      "Credit Currency",
    ]),
    csvRow([
      "Anna Novak",
      "Anna",
      "Novak",
      "anna@example.com",
      "+420 777 123 456",
      "1675",
      "legacy-001",
      "",
      "500",
      "CZK",
    ]),
  ]);

export const buildProductImportTemplateCsv = (): string =>
  csvDocument([
    csvRow([
      "Name",
      "Kind",
      "Description",
      "SKU",
      "Price",
      "Extra Charge",
      "Currency",
      "Capacity",
      "Booking Mode",
      "Active",
      "Sort Order",
      "External ID",
    ]),
    csvRow([
      "Shared Open Studio",
      "Open Studio",
      "Independent studio access",
      "OPEN-STUDIO",
      "300",
      "0",
      "CZK",
      "8",
      "public",
      "yes",
      "10",
      "legacy-service-001",
    ]),
    csvRow([
      "Photography Class",
      "Class",
      "Beginner photography class",
      "CLASS-PHOTO",
      "2400",
      "0",
      "CZK",
      "4",
      "",
      "yes",
      "20",
      "legacy-class-001",
    ]),
    csvRow([
      "Internal Studio Block",
      "Private Studio",
      "Internal calendar block without a customer",
      "PRIVATE-STUDIO",
      "0",
      "0",
      "CZK",
      "",
      "",
      "yes",
      "30",
      "legacy-private-studio-001",
    ]),
  ]);

export const buildBookingImportTemplateCsv = (): string =>
  csvDocument([
    csvRow([
      "Booking ID",
      "Customer ID",
      "Customer Email",
      "Customer Phone",
      "Service ID",
      "Service SKU",
      "Service Name",
      "Location Code",
      "Location Slug",
      "Location Name",
      "Start datetime",
      "End datetime",
      "Date",
      "Start Time",
      "End Time",
      "Guests",
      "Status",
      "Language",
      "Activity",
      "Lecturer",
      "Description",
      "Note",
    ]),
    csvRow([
      "legacy-booking-001",
      "legacy-customer-001",
      "anna@example.com",
      "+420 777 123 456",
      "legacy-service-001",
      "OPEN-STUDIO",
      "Shared Open Studio",
      "MAIN",
      "main-studio",
      "Main Studio",
      "2026-09-15T09:00:00+02:00",
      "2026-09-15T11:00:00+02:00",
      "",
      "",
      "",
      "1",
      "processed",
      "cs",
      "WORKSTATION",
      "",
      "Imported reservation",
      "",
    ]),
    csvRow([
      "legacy-class-session-001",
      "",
      "",
      "",
      "legacy-class-001",
      "CLASS-WHEEL",
      "Wheel Class",
      "MAIN",
      "main-studio",
      "Main Studio",
      "",
      "",
      "2026-09-16",
      "18:00",
      "20:00",
      "",
      "processed",
      "cs",
      "UNDEFINED",
      "Anna Lecturer",
      "Imported Class calendar session",
      "Keep customer columns blank. Customer enrolments require Orders and are not supported by this import.",
    ]),
    csvRow([
      "legacy-private-session-001",
      "",
      "",
      "",
      "legacy-private-studio-001",
      "PRIVATE-STUDIO",
      "Internal Studio Block",
      "MAIN",
      "main-studio",
      "Main Studio",
      "",
      "",
      "2026-09-17",
      "08:00",
      "10:00",
      "",
      "processed",
      "cs",
      "UNDEFINED",
      "",
      "Imported Private Studio calendar block",
      "Private Studio rows are customerless internal calendar sessions.",
    ]),
  ]);

export const buildMembershipPlanImportTemplateCsv = (): string =>
  csvDocument([
    csvRow([
      "External ID",
      "Name",
      "Description",
      "Terms",
      "Price",
      "Currency",
      "Billing Type",
      "Billing Interval",
      "Interval Count",
      "Duration Days",
      "Location Scope",
      "Location Codes",
      "Credit Allowance",
      "Discount Percent",
      "Custom Perk",
      "Benefits JSON",
      "Status",
      "Sort Order",
    ]),
    csvRow([
      "legacy-plan-001",
      "Monthly Studio",
      "Imported membership plan",
      "",
      "1490",
      "CZK",
      "recurring",
      "month",
      "1",
      "",
      "all",
      "",
      "10",
      "5",
      "Priority booking",
      "",
      "published",
      "10",
    ]),
  ]);

export const buildMembershipImportTemplateCsv = (): string =>
  csvDocument([
    csvRow([
      "External ID",
      "Customer ID",
      "Customer Email",
      "Customer Phone",
      "Plan ID",
      "Plan Name",
      "Plan Version",
      "Location Code",
      "Location Slug",
      "Location Name",
      "Status",
      "Started At",
      "Period Start",
      "Period End",
      "Cancelled At",
      "Currency",
      "Amount",
      "Allowance Balances JSON",
      "Note",
    ]),
    csvRow([
      "legacy-membership-001",
      "legacy-customer-001",
      "anna@example.com",
      "",
      "legacy-plan-001",
      "Monthly Studio",
      "",
      "",
      "",
      "",
      "active",
      "2026-08-01T00:00:00+02:00",
      "2026-08-01T00:00:00+02:00",
      "2026-09-01T00:00:00+02:00",
      "",
      "CZK",
      "1490",
      '{"credits":7}',
      "Opening balance at migration cutover",
    ]),
  ]);

export const buildCreditImportTemplateCsv = (): string =>
  csvDocument([
    csvRow([
      "External ID",
      "Customer ID",
      "Customer Email",
      "Customer Phone",
      "Balance",
      "Currency",
      "Note",
    ]),
    csvRow([
      "legacy-credit-001",
      "legacy-customer-001",
      "anna@example.com",
      "",
      "500",
      "CZK",
      "Opening source allocation",
    ]),
  ]);

export const buildVoucherProductImportTemplateCsv = (): string =>
  csvDocument([
    csvRow([
      "External ID",
      "Name",
      "Description",
      "SKU",
      "Value",
      "Currency",
      "Active",
      "Sort Order",
    ]),
    csvRow([
      "legacy-voucher-product-001",
      "Gift Voucher 1000",
      "Imported voucher offer",
      "GIFT-1000",
      "1000",
      "CZK",
      "no",
      "10",
    ]),
  ]);

export const buildVoucherImportTemplateCsv = (): string =>
  csvDocument([
    csvRow([
      "External ID",
      "Promo Code",
      "Product ID",
      "Product SKU",
      "Product Name",
      "Value",
      "Currency",
      "Status",
      "Expires At",
      "Redeemed At",
      "Customer ID",
      "Customer Email",
      "Customer Phone",
      "Note",
    ]),
    csvRow([
      "legacy-voucher-001",
      "GIFT-ABCD-1234",
      "legacy-voucher-product-001",
      "GIFT-1000",
      "Gift Voucher 1000",
      "1000",
      "CZK",
      "active",
      "2027-08-01T23:59:59+02:00",
      "",
      "",
      "",
      "",
      "Imported liability snapshot",
    ]),
  ]);

export const buildCustomerImportReportCsv = async ({
  tenantId,
  sessionId,
}: {
  tenantId: string;
  sessionId: string;
}) => {
  const session = await getTenantImportSession({ tenantId, sessionId });
  assertReportRetained(session);
  const rows = await DataImportRowModel.find({
    tenant: tenantId,
    session: session._id,
  })
    .sort({ rowNumber: 1 })
    .lean();
  if (rows.length !== Number(session.summary?.total || 0))
    throw new AppError({
      statusCode: 410,
      message: "This import report is no longer complete.",
      code: "IMPORT_REPORT_UNAVAILABLE",
    });
  const headers = session.headers || [];
  return csvDocument([
    csvRow([
      "Row",
      "Status",
      "Result",
      "Issues",
      ...headers.map(safeImportCsvValue),
    ]),
    ...rows.map((row: any) =>
      csvRow([
        row.rowNumber,
        row.status,
        safeImportCsvValue(row.resultMessage || ""),
        safeImportCsvValue(
          (row.issues || [])
            .map((issue: any) => issue.code + ": " + issue.message)
            .join(" | "),
        ),
        ...headers.map((header: string) =>
          safeImportCsvValue(row.raw?.[header] ?? ""),
        ),
      ]),
    ),
  ]);
};

export const buildImportRollbackReportCsv = async ({
  tenantId,
  sessionId,
}: {
  tenantId: string;
  sessionId: string;
}) => {
  const session = await getTenantImportSession({ tenantId, sessionId });
  assertReportRetained(session);
  if (
    !session.rollback?.requestedAt ||
    ![
      DATA_IMPORT_ROLLBACK_STATUS.COMPLETED,
      DATA_IMPORT_ROLLBACK_STATUS.PARTIAL,
      DATA_IMPORT_ROLLBACK_STATUS.BLOCKED,
      DATA_IMPORT_ROLLBACK_STATUS.FAILED,
    ].includes(session.rollback?.status as never)
  )
    throw new AppError({
      statusCode: 409,
      message: "A rollback report is available after rollback is requested.",
      code: "IMPORT_ROLLBACK_REPORT_NOT_READY",
    });
  const mutations = await DataImportMutationModel.find({
    tenant: tenantId,
    session: session._id,
    isCanonicalResult: true,
  })
    .select(
      "rowNumber entityType operation importOutcome target rollback.status rollback.reasonCode rollback.message rollback.completedAt",
    )
    .sort({ rowNumber: 1, _id: 1 })
    .lean();
  const expected =
    Number(session.summary?.created || 0) +
    Number(session.summary?.updated || 0);
  if (expected > 0 && mutations.length !== expected)
    throw new AppError({
      statusCode: 410,
      message: "This rollback report is not available for a legacy import.",
      code: "IMPORT_ROLLBACK_REPORT_UNAVAILABLE",
    });
  return csvDocument([
    csvRow([
      "Row",
      "Entity",
      "Import action",
      "Rollback operation",
      "Rollback status",
      "Reason code",
      "Message",
      "Record ID",
      "Completed at",
    ]),
    ...mutations.map((mutation: any) =>
      csvRow([
        mutation.rowNumber,
        mutation.entityType,
        mutation.importOutcome,
        mutation.operation,
        mutation.rollback?.status || "pending",
        mutation.rollback?.reasonCode || "",
        safeImportCsvValue(mutation.rollback?.message || ""),
        mutation.target ? String(mutation.target) : "",
        mutation.rollback?.completedAt
          ? new Date(mutation.rollback.completedAt).toISOString()
          : "",
      ]),
    ),
  ]);
};
