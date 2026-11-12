import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("membership entitlement transaction session", () => {
  it("reads the redemption being reversed through the caller's session", () => {
    const source = readFileSync(
      new URL(
        "../../../src/modules/membership/services/membership-entitlement.service.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const functionStart = source.indexOf(
      "export const reverseMembershipRedemption",
    );
    const sourceLookupEnd = source.indexOf("if (!redemption)", functionStart);
    const sourceLookup = source.slice(functionStart, sourceLookupEnd);

    expect(functionStart).toBeGreaterThan(-1);
    expect(sourceLookupEnd).toBeGreaterThan(functionStart);
    expect(sourceLookup).toMatch(
      /MembershipEntitlementLedgerModel\.findOne\([\s\S]*?MEMBERSHIP_LEDGER_ENTRY_TYPE\.REDEMPTION,[\s\S]*?\}\)\s*\.session\(input\.session \?\? null\)\s*\.exec\(\)/,
    );
  });
});
