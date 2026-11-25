import { describe, expect, it } from "vitest";
import {
  customerDirectoryExportInput,
  customerDirectoryQuery,
} from "@/modules/user/user.directory-query.js";

const id = "507f1f77bcf86cd799439011";

describe("customer directory financial filter input", () => {
  it("accepts inclusive, signed and one-sided major-unit ranges", () => {
    expect(
      customerDirectoryQuery.parse({
        spendMin: "0",
        spendMax: "12.50",
        creditMin: "-10.25",
        creditMax: "0",
        spendFrom: "2026-02-01",
        spendTo: "2026-02-28",
        timeZone: "Europe/Prague",
      }),
    ).toMatchObject({
      spendMin: 0,
      spendMax: 12.5,
      creditMin: -10.25,
      creditMax: 0,
      spendFrom: "2026-02-01",
      spendTo: "2026-02-28",
      timeZone: "Europe/Prague",
    });
    for (const input of [
      { spendMin: -1 },
      { spendMax: 0 },
      { creditMin: 0 },
      { creditMax: -1 },
      { spendFrom: "2024-02-29" },
      { spendTo: "2026-11-17" },
      { spendMin: 5, spendMax: 5, creditMin: 0, creditMax: 0 },
    ]) {
      expect(customerDirectoryQuery.safeParse(input).success).toBe(true);
      expect(customerDirectoryExportInput.safeParse(input).success).toBe(true);
    }
  });

  it.each([
    ["spendMin", ""],
    ["spendMax", "   "],
    ["creditMin", null],
    ["creditMax", false],
    ["spendMin", true],
    ["spendMax", "NaN"],
    ["creditMin", "Infinity"],
    ["creditMax", Number.NEGATIVE_INFINITY],
    ["spendMin", []],
    ["spendMax", {}],
    ["creditMin", "ten"],
    ["spendFrom", "2026-02-29"],
    ["spendTo", "2026-04-31"],
    ["spendFrom", "2026-1-01"],
    ["spendTo", "2026-10-25T12:00:00Z"],
    ["spendFrom", ""],
    ["timeZone", "Not/AZone"],
  ])("rejects malformed %s=%j for both list and export", (key, value) => {
    const input = { [key as string]: value };
    expect(customerDirectoryQuery.safeParse(input).success).toBe(false);
    expect(customerDirectoryExportInput.safeParse(input).success).toBe(false);
  });

  it.each([
    { spendMin: 2, spendMax: 1 },
    { creditMin: -1, creditMax: -2 },
    { spendFrom: "2026-11-17", spendTo: "2026-11-16" },
  ])("rejects reversed ranges %j", (input) => {
    expect(customerDirectoryQuery.safeParse(input).success).toBe(false);
    expect(customerDirectoryExportInput.safeParse(input).success).toBe(false);
  });

  it("allows only date context alongside selected export IDs", () => {
    expect(
      customerDirectoryExportInput.safeParse({
        ids: [id],
        spendFrom: "2026-10-25",
        spendTo: "2026-10-25",
        timeZone: "Europe/Prague",
      }).success,
    ).toBe(true);
    for (const filter of [
      { spendMin: 0 },
      { spendMax: 0 },
      { creditMin: 0 },
      { creditMax: 0 },
      { search: "Customer" },
      { status: "active" },
      { membership: "none" },
    ]) {
      expect(
        customerDirectoryExportInput.safeParse({ ids: [id], ...filter })
          .success,
      ).toBe(false);
    }
  });
});
