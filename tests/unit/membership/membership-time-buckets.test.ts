import { describe, expect, it } from "vitest";
import { calculateTimeCarryover, consumeTimeBuckets, restoreTimeBuckets, type TimeBucket }
  from "@/modules/membership/membership-time-buckets.js";
import { serializeEntitlementBalance } from "@/modules/membership/membership.serializers.js";

const end = new Date("2099-02-01T00:00:00Z");
const bucket = (key: string, kind: TimeBucket["kind"], available: number): TimeBucket =>
  ({ key, kind, available, periodKey: "january", expiresAt: end });

describe("time entitlement allocation rules", () => {
  it("rounds the 25% cap down to whole stored units and excludes old carry/manual gifts", () => {
    const balance = { timeBucketVersion: 1, timePeriodEnd: end, timePeriodKey: "january", timeGrantQuantity: 239,
      timeBuckets: [bucket("base", "period", 200), bucket("carry", "carryover", 60), bucket("gift", "adjustment", 500)] };
    expect(calculateTimeCarryover(balance, { rolloverPercent: 25 }, end)).toBe(59);
    expect(calculateTimeCarryover(balance, { rolloverPercent: 0 }, end)).toBe(0);
    expect(calculateTimeCarryover(balance, { rolloverPercent: 100 }, end)).toBe(59);
    expect(calculateTimeCarryover(balance, { rolloverPercent: 25 }, new Date("2099-03-01"))).toBe(0);
    expect(calculateTimeCarryover({ ...balance, rolloverCandidateAvailable: 10 }, { rolloverPercent: 25 }, end)).toBe(10);
  });

  it("consumes carry before base regardless of array order and preserves expiry when restoring", () => {
    const original = [bucket("base", "period", 240), bucket("carry", "carryover", 60)];
    const consumed = consumeTimeBuckets(original, 90, new Date("2099-01-20"));
    expect(consumed.allocations.map((item) => [item.key, item.amount])).toEqual([["carry", 60], ["base", 30]]);
    expect(original.map((item) => item.available)).toEqual([240, 60]);
    expect(restoreTimeBuckets(consumed.buckets, consumed.allocations)).toEqual(original);
    expect(() => consumeTimeBuckets(original, 1, end)).toThrow("unexpired");
  });

  it("does not advertise expired hours while waiting for the background expiry worker", () => {
    const expired = { ...bucket("expired", "period", 60), expiresAt: new Date("2000-01-01") };
    const balance = serializeEntitlementBalance({ available: 90, timeBucketVersion: 1,
      timeBuckets: [expired, bucket("carry", "carryover", 30)], expiresAt: end });
    expect(balance).toMatchObject({ available: 30, currentPeriodAvailable: 0, carryoverAvailable: 30,
      carryoverExpiresAt: end.toISOString() });
  });
});
