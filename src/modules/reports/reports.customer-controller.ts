import type { Request, Response } from "express";
import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";
import { WORKSPACE_PERMISSION as P } from "@/modules/tenant-access/tenant-access.permissions.js";
import { hasWorkspacePermission } from "@/modules/tenant-access/services/authorization.service.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { forbidden } from "@/shared/http/httpErrors.js";
import { csvRow } from "./reports.csv.js";
import {
  iterateReportCustomerRows,
  listReportCustomers,
  matchesReportCustomer,
  prepareReportCustomers,
} from "./reports.customer-service.js";

const context = (req: Request) => ({
  tenantId: requireTenantId(req),
  userId: getAuthenticatedUserId(req),
  access: getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
});
const headers = (res: Response) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
};
export const getReportCustomers = asyncHandler(async (req, res) => {
  const data = await listReportCustomers({
    context: context(req),
    input: req.query,
  });
  headers(res);
  res.json({ data });
});
const write = async (res: Response, value: string) => {
  if (res.destroyed) throw new Error("Customer report export disconnected.");
  if (!res.write(value))
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        res.off("drain", drain);
        res.off("close", close);
        res.off("error", fail);
      };
      const drain = () => {
        cleanup();
        resolve();
      };
      const close = () => {
        cleanup();
        reject(new Error("Customer report export disconnected."));
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      res.once("drain", drain);
      res.once("close", close);
      res.once("error", fail);
      if (res.destroyed) close();
    });
};
export const exportReportCustomersCsv = asyncHandler(async (req, res) => {
  const reportContext = context(req);
  if (!hasWorkspacePermission(reportContext.access, P.REPORTS_EXPORT))
    forbidden("Report export access is required.");
  const prepared = await prepareReportCustomers({
    context: reportContext,
    input: req.query,
  });
  const batches = iterateReportCustomerRows(prepared);
  try {
    // Validate source access and first metric batch before opening the stream.
    let next = await batches.next();
    headers(res);
    res.type("text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="shario-customers-report.csv"',
    );
    await write(
      res,
      "\uFEFF" +
        csvRow([
          "id",
          "name",
          "email",
          "memberNumber",
          "isGuest",
          "currency",
          "paidSpendMinor",
          "currentCreditMinor",
          "cancelledBookings",
          "recordedCancelledBookings",
          "cancellationHistoryComplete",
          "lastActivityAt",
          "inactiveDays",
          "spendFrom",
          "spendTo",
          "cancellationFrom",
          "cancellationTo",
          "cancellationActor",
          "asOf",
        ]) +
        "\r\n",
    );
    while (next.done === false) {
      for (const row of next.value)
        if (matchesReportCustomer(row, prepared))
          await write(
            res,
            csvRow([
              row.id,
              row.name,
              row.email,
              row.memberNumber,
              row.isGuest,
              prepared.currency,
              row.paidSpendMinor,
              row.currentCreditMinor,
              row.cancelledBookings,
              row.recordedCancelledBookings,
              row.cancellationHistoryComplete,
              row.lastActivityAt,
              row.inactiveDays,
              prepared.spendPeriod.from,
              prepared.spendPeriod.to,
              prepared.cancellationPeriod.from,
              prepared.cancellationPeriod.to,
              prepared.query.cancellationActor,
              prepared.now.toISOString(),
            ]) + "\r\n",
          );
      next = await batches.next();
    }
    res.end();
  } catch (error) {
    if (res.headersSent)
      res.destroy(error instanceof Error ? error : undefined);
    else throw error;
  } finally {
    await batches.return(undefined);
  }
});
