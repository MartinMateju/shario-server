import { describe, expect, it } from "vitest";

import {
  addInvoiceCalendarDays,
  buildInvoiceIssueDateRange,
  resolveInvoiceDateInput,
} from "@/modules/invoice/invoice.date.js";

describe("invoice calendar dates", () => {
  it("interprets a Prague calendar date in Europe/Prague", () => {
    const result = resolveInvoiceDateInput("2026-07-21", "Europe/Prague");

    expect(result?.toISOString()).toBe("2026-07-20T22:00:00.000Z");
  });

  it("interprets a New York calendar date in America/New_York", () => {
    const result = resolveInvoiceDateInput("2026-07-21", "America/New_York");

    expect(result?.toISOString()).toBe("2026-07-21T04:00:00.000Z");
  });

  it("keeps an ISO datetime as the exact supplied instant", () => {
    const result = resolveInvoiceDateInput(
      "2026-07-21T12:34:56.000Z",
      "America/New_York",
    );

    expect(result?.toISOString()).toBe("2026-07-21T12:34:56.000Z");
  });

  it("builds an exclusive Prague end boundary across the spring DST day", () => {
    const range = buildInvoiceIssueDateRange({
      dateFrom: "2026-03-29",
      dateTo: "2026-03-29",
      timezone: "Europe/Prague",
    });

    expect(range.$gte?.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(range.$lt?.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(range).not.toHaveProperty("$lte");
  });

  it("builds an exclusive New York end boundary across the fall DST day", () => {
    const range = buildInvoiceIssueDateRange({
      dateFrom: "2026-11-01",
      dateTo: "2026-11-01",
      timezone: "America/New_York",
    });

    expect(range.$gte?.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(range.$lt?.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("keeps a datetime upper filter boundary exact and inclusive", () => {
    const range = buildInvoiceIssueDateRange({
      dateTo: new Date("2026-07-21T18:30:00.000Z"),
      timezone: "Europe/Prague",
    });

    expect(range.$lte?.toISOString()).toBe("2026-07-21T18:30:00.000Z");
    expect(range).not.toHaveProperty("$lt");
  });

  it("adds due days as tenant calendar days instead of 24-hour durations", () => {
    const issueDate = resolveInvoiceDateInput(
      "2026-03-28",
      "Europe/Prague",
    ) as Date;
    const dueDate = addInvoiceCalendarDays(issueDate, 2, "Europe/Prague");

    expect(dueDate.toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });
});
