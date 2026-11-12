import { describe, expect, it } from "vitest";
import {
  assertCustomerMyWorkEnabled,
  deriveCustomerTenantCapabilities,
  getEffectiveCustomerPricingMode,
  isCustomerMyWorkEnabled,
} from "@/modules/tenants/tenant-customer-capabilities.js";

describe("customer My work pricing policy", () => {
  it.each([
    ["time", "piece", false],
    ["time", "both", false],
    ["piece", "time", false],
    ["both", "time", false],
    ["time", null, false],
    ["piece", null, false],
    [undefined, null, false],
  ] as const)(
    "resolves default %s and location %s",
    (pricingMode, override, enabled) => {
      const tenant = {
        workspaceIntent: { pricingMode },
        modules: { firing: true },
      };
      const location = { pricingMode: override };
      expect(isCustomerMyWorkEnabled(tenant, location)).toBe(enabled);
      expect(deriveCustomerTenantCapabilities(tenant, location)).toEqual({
        myWork: enabled,
      });
      expect(getEffectiveCustomerPricingMode(tenant, location)).toBe(
        "time",
      );
    },
  );
  it.each([
    ["time", false],
    ["piece", false],
    ["both", false],
    [undefined, false],
    [null, false],
  ] as const)(
    "derives %s without changing staff modules",
    (pricingMode, enabled) => {
      const tenant = {
        workspaceIntent: { pricingMode },
        modules: { firing: true, payments: false },
      };
      const before = structuredClone(tenant);
      expect(isCustomerMyWorkEnabled(tenant)).toBe(enabled);
      expect(deriveCustomerTenantCapabilities(tenant)).toEqual({
        myWork: enabled,
      });
      expect(tenant).toEqual(before);
      if (enabled)
        expect(() => assertCustomerMyWorkEnabled(tenant)).not.toThrow();
      else
        expect(() => assertCustomerMyWorkEnabled(tenant)).toThrow(
          expect.objectContaining({
            statusCode: 403,
            code: "CUSTOMER_MY_WORK_DISABLED",
          }),
        );
    },
  );

  it("preserves legacy mode and existing firing opt-outs without requiring payments", () => {
    expect(isCustomerMyWorkEnabled({})).toBe(false);
    expect(
      deriveCustomerTenantCapabilities({ modules: { firing: true } }),
    ).toEqual({ myWork: false });
    expect(
      deriveCustomerTenantCapabilities({
        workspaceIntent: { pricingMode: "piece" },
        modules: { firing: false },
      }),
    ).toEqual({ myWork: false });
  });
});
