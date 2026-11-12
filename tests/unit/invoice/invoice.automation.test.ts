import { describe, expect, it } from "vitest";

import {
  buildActionableAutomaticInvoiceFilter,
  buildActionablePaidOrderInvoiceFilter,
  buildInvoiceAutomationFailureState,
  INVOICE_AUTOMATION_RETRY_DELAY_MS,
} from "@/modules/invoice/invoice.automation.js";

describe("invoice automation reconciliation", () => {
  const now = new Date("2026-07-21T10:00:00.000Z");

  it("selects paid orders only when creation is enabled and retry is due", () => {
    expect(
      buildActionablePaidOrderInvoiceFilter({
        now,
        disabledTenantIds: ["tenant-disabled"],
      }),
    ).toEqual({
      isPaid: true,
      status: "processed_order",
      tenant: {
        $type: "objectId",
        $nin: ["tenant-disabled"],
      },
      $and: [
        { $or: [{ invoice: null }, { invoice: { $exists: false } }] },
        {
          $or: [
            { "invoiceAutomation.nextAttemptAt": { $exists: false } },
            { "invoiceAutomation.nextAttemptAt": null },
            { "invoiceAutomation.nextAttemptAt": { $lte: now } },
          ],
        },
      ],
    });
  });

  it("excludes legacy paid orders that do not have an ObjectId tenant", () => {
    expect(
      buildActionablePaidOrderInvoiceFilter({
        now,
        disabledTenantIds: [],
      }),
    ).toMatchObject({
      tenant: { $type: "objectId" },
    });
  });

  it("selects only automatic, non-review invoices for enabled stages", () => {
    expect(
      buildActionableAutomaticInvoiceFilter({
        now,
        finalizeTenantIds: ["tenant-finalize"],
        sendTenantIds: ["tenant-send"],
      }),
    ).toEqual({
      automatic: true,
      requiresReview: { $ne: true },
      "source.kind": "order",
      $and: [
        {
          $or: [
            { automationNextAttemptAt: { $exists: false } },
            { automationNextAttemptAt: null },
            { automationNextAttemptAt: { $lte: now } },
          ],
        },
        {
          $or: [
            {
              tenant: { $in: ["tenant-finalize"] },
              documentStatus: "draft",
            },
            {
              tenant: { $in: ["tenant-send"] },
              documentStatus: "issued",
              sentAt: null,
            },
          ],
        },
      ],
    });
  });

  it("does not scan intentional draft or delivery stops", () => {
    expect(
      buildActionableAutomaticInvoiceFilter({
        now,
        finalizeTenantIds: [],
        sendTenantIds: [],
      }),
    ).toBeNull();
  });

  it("backs failures off and bounds persisted error text", () => {
    const state = buildInvoiceAutomationFailureState(
      new Error("x".repeat(2_500)),
      now,
    );

    expect(state.lastAttemptAt).toBe(now);
    expect(state.nextAttemptAt.getTime() - now.getTime()).toBe(
      INVOICE_AUTOMATION_RETRY_DELAY_MS,
    );
    expect(state.lastError).toHaveLength(2_000);
  });
});
