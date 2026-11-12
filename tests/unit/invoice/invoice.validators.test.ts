import { describe, expect, it } from "vitest";

import {
  createManualInvoiceSchema,
  creditNoteSchema,
  invoiceListSchema,
  recordInvoicePaymentSchema,
  reverseInvoicePaymentSchema,
} from "@/modules/invoice/invoice.validators.js";

const CUSTOMER_ID = "64b000000000000000000011";
const LINE_ID = "64b000000000000000000021";

const createInput = (overrides: Record<string, unknown> = {}) => ({
  currency: "EUR",
  customerUserId: CUSTOMER_ID,
  customer: {
    legalName: "Example Customer s.r.o.",
    email: "billing@example.test",
  },
  lines: [
    {
      description: "Open studio reservation",
      quantity: 1,
      unitGrossMinor: 2_500,
    },
  ],
  ...overrides,
});

describe("invoice validators", () => {
  describe("manual invoice dates", () => {
    it("rejects paid amounts in draft APIs", () => {
      expect(
        createManualInvoiceSchema.safeParse(
          createInput({ amountPaidMinor: 1_000 }),
        ).success,
      ).toBe(false);
    });

    it("rejects a due date before the issue date", () => {
      const result = createManualInvoiceSchema.safeParse(
        createInput({
          issueDate: "2026-07-21T12:00:00.000Z",
          dueDate: "2026-07-20T12:00:00.000Z",
        }),
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: ["dueDate"],
              message: "Due date cannot be before the issue date.",
            }),
          ]),
        );
      }
    });

    it("accepts equal issue and due dates and coerces them to Date instances", () => {
      const result = createManualInvoiceSchema.parse(
        createInput({
          issueDate: "2026-07-21T00:00:00.000Z",
          dueDate: "2026-07-21T00:00:00.000Z",
        }),
      );

      expect(result.issueDate).toBeInstanceOf(Date);
      expect(result.dueDate).toBeInstanceOf(Date);
      expect((result.dueDate as Date).getTime()).toBe(
        (result.issueDate as Date).getTime(),
      );
    });

    it("preserves date-only values for tenant-timezone interpretation", () => {
      const result = createManualInvoiceSchema.parse(
        createInput({
          issueDate: "2026-07-21",
          dueDate: "2026-08-04",
        }),
      );

      expect(result.issueDate).toBe("2026-07-21");
      expect(result.dueDate).toBe("2026-08-04");
    });

    it("rejects a date-only due date before the issue date", () => {
      const result = createManualInvoiceSchema.safeParse(
        createInput({
          issueDate: "2026-07-21",
          dueDate: "2026-07-20",
        }),
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: ["dueDate"] }),
          ]),
        );
      }
    });

    it("rejects invalid calendar input", () => {
      const result = createManualInvoiceSchema.safeParse(
        createInput({ issueDate: "not-a-date" }),
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual(["issueDate"]);
      }
    });

    it("rejects a calendar date that would otherwise roll into another month", () => {
      expect(
        createManualInvoiceSchema.safeParse(
          createInput({ issueDate: "2026-02-31" }),
        ).success,
      ).toBe(false);
    });
  });

  describe("manual payment audit input", () => {
    it("accepts supported external methods and requires an idempotency key", () => {
      expect(
        recordInvoicePaymentSchema.parse({
          amountMinor: 1_500,
          method: "bank_transfer",
          reference: "VS 20260001",
          paidAt: "2026-07-20T10:00:00.000Z",
          idempotencyKey: "payment:8d590a1d",
        }),
      ).toMatchObject({
        amountMinor: 1_500,
        method: "bank_transfer",
        reference: "VS 20260001",
      });

      expect(
        recordInvoicePaymentSchema.safeParse({
          amountMinor: 1_500,
          method: "cash",
        }).success,
      ).toBe(false);
    });

    it("preserves payment calendar dates for tenant-timezone interpretation", () => {
      const result = recordInvoicePaymentSchema.parse({
        amountMinor: 1_500,
        method: "cash",
        paidAt: "2026-07-20",
        idempotencyKey: "payment:calendar-date",
      });

      expect(result.paidAt).toBe("2026-07-20");
    });

    it("rejects payment datetimes without an explicit UTC offset", () => {
      expect(
        recordInvoicePaymentSchema.safeParse({
          amountMinor: 1_500,
          method: "cash",
          paidAt: "2026-07-20T10:00:00",
          idempotencyKey: "payment:missing-offset",
        }).success,
      ).toBe(false);
    });

    it("rejects RFC 3339 payment timestamps with impossible components", () => {
      for (const paidAt of [
        "2026-02-31T10:00:00Z",
        "2026-07-20T24:00:00Z",
        "2026-07-20T10:60:00+02:00",
        "2026-07-20T10:00:60-04:00",
        "2026-07-20T10:00:00+24:00",
      ]) {
        expect(
          recordInvoicePaymentSchema.safeParse({
            amountMinor: 1_500,
            method: "cash",
            paidAt,
            idempotencyKey: "payment:invalid-date",
          }).success,
        ).toBe(false);
      }
    });

    it("rejects automated methods and future settlement dates", () => {
      expect(
        recordInvoicePaymentSchema.safeParse({
          amountMinor: 100,
          method: "stripe",
          idempotencyKey: "payment:stripe-1",
        }).success,
      ).toBe(false);

      expect(
        recordInvoicePaymentSchema.safeParse({
          amountMinor: 100,
          method: "card",
          paidAt: new Date(Date.now() + 60 * 60 * 1000),
          idempotencyKey: "payment:future-1",
        }).success,
      ).toBe(false);
    });

    it("requires an audited reversal reason and idempotency key", () => {
      expect(
        reverseInvoicePaymentSchema.parse({
          reason: "Bank transfer was matched to the wrong customer.",
          idempotencyKey: "payment-reversal:1",
        }),
      ).toEqual({
        reason: "Bank transfer was matched to the wrong customer.",
        idempotencyKey: "payment-reversal:1",
      });

      expect(
        reverseInvoicePaymentSchema.safeParse({
          reason: "",
          idempotencyKey: "payment-reversal:2",
        }).success,
      ).toBe(false);
    });
  });

  describe("identifiers and idempotency keys", () => {
    it("normalizes a valid idempotency key", () => {
      const result = createManualInvoiceSchema.parse(
        createInput({ idempotencyKey: "  invoice:checkout_123  " }),
      );

      expect(result.idempotencyKey).toBe("invoice:checkout_123");
    });

    it.each([
      "short",
      "contains spaces",
      "contains/slash",
      "x".repeat(129),
    ])("rejects invalid idempotency key %j", (idempotencyKey) => {
      expect(
        createManualInvoiceSchema.safeParse(
          createInput({ idempotencyKey }),
        ).success,
      ).toBe(false);
    });

    it("rejects malformed customer and list-filter identifiers", () => {
      expect(
        createManualInvoiceSchema.safeParse(
          createInput({ customerUserId: "customer-1" }),
        ).success,
      ).toBe(false);

      expect(
        invoiceListSchema.safeParse({ locationId: "location-1" }).success,
      ).toBe(false);
    });
  });

  describe("credit note lines", () => {
    it("rejects the same invoice line more than once", () => {
      const result = creditNoteSchema.safeParse({
        reason: "Partial refund",
        lines: [
          { lineItemId: LINE_ID, grossAmountMinor: 500 },
          { lineItemId: LINE_ID, grossAmountMinor: 250 },
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: ["lines"],
              message:
                "Each invoice line may only be credited once per request.",
            }),
          ]),
        );
      }
    });

    it("accepts distinct lines and applies the send default", () => {
      const result = creditNoteSchema.parse({
        reason: "Cancelled items",
        lines: [
          { lineItemId: LINE_ID, grossAmountMinor: 500 },
          {
            lineItemId: "64b000000000000000000022",
            grossAmountMinor: 250,
          },
        ],
      });

      expect(result.send).toBe(false);
      expect(result.lines).toHaveLength(2);
    });
  });
});
