import { describe, expect, it } from "vitest";
import { assertVoucherCanBeIssued, calculateVoucherExpiry, normalizeVoucherSettings } from "@/modules/coupon/voucher-policy.js";

describe("voucher validity", () => {
  it("defaults to twelve calendar months and uses the workspace calendar day", () => {
    const settings = normalizeVoucherSettings();
    expect(settings.validity).toEqual({ mode: "months", months: 12 });
    expect(calculateVoucherExpiry({ issuedAt: new Date("2026-09-15T12:00:00Z"), timezone: "Europe/Prague" })?.toISOString()).toBe("2027-09-15T21:59:59.999Z");
  });
  it("clamps month ends and leap days", () => {
    expect(calculateVoucherExpiry({ validity: { mode: "months", months: 1 }, issuedAt: new Date("2026-01-31T12:00:00Z"), timezone: "UTC" })?.toISOString()).toBe("2026-02-28T23:59:59.999Z");
    expect(calculateVoucherExpiry({ issuedAt: new Date("2024-02-29T12:00:00Z"), timezone: "UTC" })?.toISOString()).toBe("2025-02-28T23:59:59.999Z");
  });
  it("keeps a custom date valid through its local day across DST", () => {
    expect(calculateVoucherExpiry({ validity: { mode: "date", date: "2026-03-29" }, issuedAt: new Date("2026-01-01T00:00:00Z"), timezone: "Europe/Prague" })?.toISOString()).toBe("2026-03-29T21:59:59.999Z");
    expect(calculateVoucherExpiry({ validity: { mode: "date", date: "2026-10-25" }, issuedAt: new Date("2026-01-01T00:00:00Z"), timezone: "Europe/Prague" })?.toISOString()).toBe("2026-10-25T22:59:59.999Z");
  });
  it("uses local issuance date near UTC midnight", () => {
    expect(calculateVoucherExpiry({ validity: { mode: "months", months: 3 }, issuedAt: new Date("2026-01-01T00:30:00Z"), timezone: "America/Los_Angeles" })?.toISOString()).toBe("2026-04-01T06:59:59.999Z");
  });
  it("preserves explicit perpetual validity and rejects invalid or elapsed policies", () => {
    expect(calculateVoucherExpiry({ validity: { mode: "none" }, issuedAt: new Date() })).toBeNull();
    expect(() => normalizeVoucherSettings({ version: 1, type: "value", validity: { mode: "months", months: 0 } })).toThrow();
    expect(() => normalizeVoucherSettings({ version: 1, type: "value", validity: { mode: "date", date: "2026-02-30" } })).toThrow();
    expect(() => assertVoucherCanBeIssued({ version: 1, type: "value", validity: { mode: "date", date: "2026-01-01" } }, new Date("2026-01-02T00:00:00Z"), "UTC")).toThrow();
  });
});
