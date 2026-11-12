import type { ClientSession } from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";

import InvoiceCounterModel from "@/modules/invoice/invoice-counter.schema.js";
import { INVOICE_DOCUMENT_TYPE } from "@/modules/invoice/invoice.constants.js";
import {
  allocateInvoiceNumber,
  buildInvoiceSeries,
  getInvoiceNumberingHighWaterMark,
  InvoiceCounterUpsertRaceError,
  parseInvoiceSequenceFromNumber,
  runNumberedInvoiceTransaction,
} from "@/modules/invoice/invoice-numbering.service.js";
import InvoiceModel from "@/modules/invoice/invoice.schema.js";

const session = {} as ClientSession;

const execQuery = <T>(value: T) => ({
  exec: vi.fn().mockResolvedValue(value),
});

const chainedQuery = (value: unknown, withSort = false) => {
  const query: any = {};
  if (withSort) query.sort = vi.fn(() => query);
  query.select = vi.fn(() => query);
  query.session = vi.fn(() => query);
  query.lean = vi.fn(() => query);
  query.exec = vi.fn().mockResolvedValue(value);
  return query;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("invoice number allocation", () => {
  it("builds the fiscal series in the invoice timezone", () => {
    expect(
      buildInvoiceSeries({
        prefix: "inv",
        issueDate: new Date("2025-12-31T23:30:00.000Z"),
        timezone: "Europe/Prague",
      }),
    ).toBe("INV-2026");
  });

  it("includes sequence-less historical numbers in the high-water mark", () => {
    expect(
      getInvoiceNumberingHighWaterMark({
        series: "INV-2026",
        documentSequence: 8,
        counterSequences: [3, 19, null],
        historicalNumbers: ["INV-2026-000027", "OTHER-2026-999999"],
      }),
    ).toBe(27);
  });

  it("parses only exact, safe sequences belonging to the requested series", () => {
    expect(
      parseInvoiceSequenceFromNumber({
        number: "INV-2026-000042",
        series: "INV-2026",
      }),
    ).toBe(42);
    expect(
      parseInvoiceSequenceFromNumber({
        number: "OTHER-2026-000042",
        series: "INV-2026",
      }),
    ).toBeNull();
    expect(
      parseInvoiceSequenceFromNumber({
        number: "INV-2026-42-extra",
        series: "INV-2026",
      }),
    ).toBeNull();
    expect(
      parseInvoiceSequenceFromNumber({
        number: `INV-2026-${Number.MAX_SAFE_INTEGER + 1}`,
        series: "INV-2026",
      }),
    ).toBeNull();
  });

  it("uses one canonical series counter for invoices and credit notes", async () => {
    vi.spyOn(InvoiceModel, "findOne").mockReturnValue(
      chainedQuery({ sequence: 7 }, true) as never,
    );
    vi.spyOn(InvoiceModel, "find").mockReturnValue(
      chainedQuery([{ number: "OLD-2026-000015" }]) as never,
    );
    vi.spyOn(InvoiceCounterModel, "find").mockReturnValue(
      chainedQuery([{ sequence: 4 }, { sequence: 11 }]) as never,
    );
    const repair = vi
      .spyOn(InvoiceCounterModel, "updateOne")
      .mockReturnValue(execQuery({ acknowledged: true }) as never);
    const increment = vi
      .spyOn(InvoiceCounterModel, "findOneAndUpdate")
      .mockReturnValue(execQuery({ sequence: 16 }) as never);
    vi.spyOn(InvoiceModel, "exists").mockReturnValue({
      session: vi.fn().mockResolvedValue(null),
    } as never);

    const result = await allocateInvoiceNumber({
      tenantId: "64b000000000000000000001",
      documentType: INVOICE_DOCUMENT_TYPE.CREDIT_NOTE,
      prefix: "old",
      issueDate: new Date("2026-06-01T00:00:00.000Z"),
      timezone: "UTC",
      session,
    });

    const canonicalFilter = {
      tenant: "64b000000000000000000001",
      documentType: INVOICE_DOCUMENT_TYPE.INVOICE,
      series: "OLD-2026",
    };
    expect(repair).toHaveBeenCalledWith(
      canonicalFilter,
      expect.objectContaining({ $max: { sequence: 15 } }),
      expect.objectContaining({ session, upsert: true }),
    );
    expect(increment).toHaveBeenCalledWith(
      canonicalFilter,
      { $inc: { sequence: 1 } },
      expect.objectContaining({ session }),
    );
    expect(result).toEqual({
      series: "OLD-2026",
      sequence: 16,
      number: "OLD-2026-000016",
    });
  });

  it("skips a residual visible-number collision", async () => {
    vi.spyOn(InvoiceModel, "findOne").mockReturnValue(
      chainedQuery(null, true) as never,
    );
    vi.spyOn(InvoiceModel, "find").mockReturnValue(
      chainedQuery([]) as never,
    );
    vi.spyOn(InvoiceCounterModel, "find").mockReturnValue(
      chainedQuery([]) as never,
    );
    vi.spyOn(InvoiceCounterModel, "updateOne").mockReturnValue(
      execQuery({ acknowledged: true }) as never,
    );
    vi.spyOn(InvoiceCounterModel, "findOneAndUpdate")
      .mockReturnValueOnce(execQuery({ sequence: 1 }) as never)
      .mockReturnValueOnce(execQuery({ sequence: 2 }) as never);
    vi.spyOn(InvoiceModel, "exists")
      .mockReturnValueOnce({
        session: vi.fn().mockResolvedValue({ _id: "legacy" }),
      } as never)
      .mockReturnValueOnce({
        session: vi.fn().mockResolvedValue(null),
      } as never);

    await expect(
      allocateInvoiceNumber({
        tenantId: "64b000000000000000000001",
        documentType: INVOICE_DOCUMENT_TYPE.INVOICE,
        prefix: "INV",
        issueDate: new Date("2026-01-01T00:00:00.000Z"),
        timezone: "UTC",
        session,
      }),
    ).resolves.toMatchObject({
      sequence: 2,
      number: "INV-2026-000002",
    });
  });

  it("defines tenant-global sequence and number indexes", () => {
    const indexes = InvoiceModel.schema.indexes();
    const sequenceIndex = indexes.find(
      ([fields]) => "series" in fields && "sequence" in fields,
    );
    const numberIndex = indexes.find(([fields]) => "number" in fields);

    expect(sequenceIndex?.[0]).toEqual({ tenant: 1, series: 1, sequence: 1 });
    expect(sequenceIndex?.[1]).toMatchObject({
      unique: true,
      partialFilterExpression: {
        series: { $type: "string", $gt: "" },
        sequence: { $type: "number" },
      },
    });
    expect(numberIndex?.[1]).toMatchObject({
      unique: true,
      partialFilterExpression: {
        number: { $type: "string", $gt: "" },
      },
    });
  });

  it("retries the whole transaction for the wrapped counter upsert race", async () => {
    const work = vi.fn(async () => "issued");
    const transactionSession = {
      withTransaction: vi
        .fn()
        .mockRejectedValueOnce(
          new InvoiceCounterUpsertRaceError({ code: 11000 }),
        )
        .mockResolvedValueOnce("issued"),
    } as unknown as ClientSession;

    await expect(
      runNumberedInvoiceTransaction(transactionSession, work),
    ).resolves.toBe("issued");
    expect(transactionSession.withTransaction).toHaveBeenCalledTimes(2);
  });

  it("does not retry an unrelated duplicate-key error", async () => {
    const duplicate = Object.assign(new Error("duplicate invoice source"), {
      code: 11000,
    });
    const transactionSession = {
      withTransaction: vi.fn().mockRejectedValue(duplicate),
    } as unknown as ClientSession;

    await expect(
      runNumberedInvoiceTransaction(transactionSession, async () => undefined),
    ).rejects.toBe(duplicate);
    expect(transactionSession.withTransaction).toHaveBeenCalledTimes(1);
  });
});
