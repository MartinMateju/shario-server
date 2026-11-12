import { afterEach, describe, expect, it, vi } from "vitest";

import { parseOrderFilter } from "@/modules/order/order.validators.js";

const LOCATION_ID = "64b000000000000000000001";

describe("order read filters", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes a valid location filter", () => {
    expect(
      parseOrderFilter({ locationId: `  ${LOCATION_ID}  ` }).locationId,
    ).toBe(LOCATION_ID);
  });

  it("treats an empty location filter as absent", () => {
    expect(parseOrderFilter({ locationId: " " }).locationId).toBeUndefined();
  });

  it("rejects malformed location identifiers", () => {
    expect(() => parseOrderFilter({ locationId: "studio-a" })).toThrow();
  });

  it.each(["UTC", "Europe/Berlin", "America/Los_Angeles"])(
    "preserves the caller's inclusive timestamp boundary in %s",
    (timezone) => {
      vi.stubEnv("TZ", timezone);
      const result = parseOrderFilter({
        dateFrom: "2026-10-18T22:00:00.000Z",
        dateTo: "2026-10-19T21:59:59.999Z",
      });

      expect(result.dateFrom?.toISOString()).toBe("2026-10-18T22:00:00.000Z");
      expect(result.dateTo?.toISOString()).toBe("2026-10-19T21:59:59.999Z");
    },
  );

  it.each([
    ["2026-10-19T23:59:59.999+02:00", "2026-10-19T21:59:59.999Z"],
    ["2026-10-19T00:00:00.000Z", "2026-10-19T00:00:00.000Z"],
    ["2026-10-25T23:59:59.999+01:00", "2026-10-25T22:59:59.999Z"],
  ])("preserves an explicit ISO boundary %s", (dateTo, expected) => {
    expect(parseOrderFilter({ dateTo }).dateTo?.toISOString()).toBe(expected);
  });

  it("preserves Date boundaries without mutating them when filters are parsed again", () => {
    const dateTo = new Date("2026-10-19T08:12:34.567Z");
    const parsed = parseOrderFilter({ dateTo });

    expect(parsed.dateTo?.toISOString()).toBe("2026-10-19T08:12:34.567Z");
    expect(parseOrderFilter(parsed).dateTo?.toISOString()).toBe(
      "2026-10-19T08:12:34.567Z",
    );
    expect(dateTo.toISOString()).toBe("2026-10-19T08:12:34.567Z");
  });

  it("keeps date-only filters inclusive through the last millisecond of the day", () => {
    vi.stubEnv("TZ", "UTC");
    const parsed = parseOrderFilter({
      dateFrom: "2026-10-19",
      dateTo: "2026-10-19",
    });

    expect(parsed.dateTo?.toISOString()).toBe("2026-10-19T23:59:59.999Z");
    expect(parseOrderFilter(parsed).dateTo?.toISOString()).toBe(
      "2026-10-19T23:59:59.999Z",
    );
  });

  it.each([
    { dateFrom: "2026-10-20", dateTo: "2026-10-19" },
    {
      dateFrom: "2026-10-19T22:00:00.000Z",
      dateTo: "2026-10-19T21:59:59.999Z",
    },
  ])("rejects an inverted date range %j", (input) => {
    vi.stubEnv("TZ", "UTC");
    expect(() => parseOrderFilter(input)).toThrow(
      "Order end date must not be before its start date.",
    );
  });

  it("allows equal boundaries and optional one-sided ranges", () => {
    const boundary = "2026-10-19T21:59:59.999Z";
    expect(parseOrderFilter({ dateFrom: boundary, dateTo: boundary })).toMatchObject({
      dateFrom: new Date(boundary),
      dateTo: new Date(boundary),
    });
    expect(parseOrderFilter({ dateFrom: boundary }).dateTo).toBeUndefined();
    expect(parseOrderFilter({ dateTo: boundary }).dateFrom).toBeUndefined();
    expect(parseOrderFilter({})).not.toHaveProperty("dateFrom");
    expect(parseOrderFilter({})).not.toHaveProperty("dateTo");
  });

  it.each(["not-a-date", "2026-99-99"])("rejects invalid end dates: %s", (dateTo) => {
    expect(() => parseOrderFilter({ dateTo })).toThrow();
  });
});
