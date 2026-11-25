import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertTenantAuthOrigin } from "@/modules/auth/auth-origin.js";
import {
  buildTenantCommerceUrl,
  resolveTenantCommerceOrigin,
  resolveTenantPublicOrigin,
} from "@/modules/checkout/checkout.urls.js";

const domain = {
  hostname: "booking.commonground.example",
  type: "custom",
  status: "active",
  isPrimary: true,
};
const tenant = {
  slug: "common-ground",
  plan: "studio_plus",
  planVersion: 3,
  domains: [domain],
};
const primary = "https://booking.commonground.example";
const platform = "https://common-ground.shario.io";

describe("tenant primary public origin", () => {
  beforeEach(() => vi.stubEnv("NODE_ENV", "production"));
  afterEach(() => vi.unstubAllEnvs());

  it("uses the one active primary custom domain for server-created links", () => {
    expect(resolveTenantPublicOrigin(tenant)).toBe(primary);
    expect(resolveTenantCommerceOrigin({ tenant })).toBe(primary);
    expect(
      buildTenantCommerceUrl({
        origin: resolveTenantCommerceOrigin({ tenant }),
        locale: "cs",
        path: "portal/success",
        query: { orderId: "order-123" },
      }),
    ).toBe(`${primary}/cs/portal/success?orderId=order-123`);
  });

  it("continues to return checkout to the authorized browser that started it", () => {
    for (const requestedOrigin of [platform, primary]) {
      expect(resolveTenantCommerceOrigin({ tenant, requestedOrigin })).toBe(
        requestedOrigin,
      );
    }
  });

  it.each([
    "https://other-studio.shario.io",
    "https://other-studio.example",
    "https://booking.commonground.example.evil.example",
    "http://booking.commonground.example",
    "https://booking.commonground.example:8443",
    "https://user:password@booking.commonground.example",
    "https://booking.commonground.example/?next=https://evil.example",
    "javascript:alert(1)",
  ])("does not reflect an untrusted checkout origin %s", (requestedOrigin) => {
    expect(resolveTenantCommerceOrigin({ tenant, requestedOrigin })).toBe(
      primary,
    );
  });

  it.each(["pending", "verified", "failed"])(
    "does not publish a %s domain",
    (status) => {
      expect(
        resolveTenantPublicOrigin({
          ...tenant,
          domains: [{ ...domain, status }],
        }),
      ).toBe(platform);
    },
  );

  it("does not choose the first custom domain when none or multiple are primary", () => {
    expect(
      resolveTenantPublicOrigin({
        ...tenant,
        domains: [{ ...domain, isPrimary: false }],
      }),
    ).toBe(platform);
    expect(
      resolveTenantPublicOrigin({
        ...tenant,
        domains: [domain, { ...domain, hostname: "second.example" }],
      }),
    ).toBe(platform);
    expect(
      resolveTenantPublicOrigin({
        ...tenant,
        domains: [
          domain,
          { ...domain, type: "subdomain", hostname: "common-ground.shario.io" },
        ],
      }),
    ).toBe(platform);
  });

  it.each([
    "https://booking.commonground.example",
    "booking.commonground.example/path",
    "booking.commonground.example:443",
    "valid.example@evil.example",
    "127.0.0.1",
    "other-studio.shario.io",
    "-invalid.example",
    "valid..example",
  ])("rejects malformed or platform custom-domain metadata %s", (hostname) => {
    expect(
      resolveTenantPublicOrigin({
        ...tenant,
        domains: [{ ...domain, hostname }],
      }),
    ).toBe(platform);
  });

  it("normalizes a domain hostname without inventing www aliases", () => {
    expect(
      resolveTenantPublicOrigin({
        ...tenant,
        domains: [{ ...domain, hostname: " BOOKING.COMMONGROUND.EXAMPLE. " }],
      }),
    ).toBe(primary);
    expect(
      resolveTenantCommerceOrigin({
        tenant,
        requestedOrigin: "https://www.booking.commonground.example",
      }),
    ).toBe(primary);
  });

  it("falls back after an entitlement downgrade and preserves legacy entitlement", () => {
    expect(resolveTenantPublicOrigin({ ...tenant, plan: "starter" })).toBe(
      platform,
    );
    expect(
      resolveTenantPublicOrigin({ ...tenant, plan: "starter", planVersion: 2 }),
    ).toBe(primary);
  });

  it("keeps two studios isolated when selecting origins and checking browser auth", () => {
    const other = {
      ...tenant,
      slug: "other-studio",
      domains: [{ ...domain, hostname: "book.other-studio.example" }],
    };
    expect(
      resolveTenantCommerceOrigin({ tenant: other, requestedOrigin: primary }),
    ).toBe("https://book.other-studio.example");
    expect(() =>
      assertTenantAuthOrigin({ tenant: other as never, origin: primary }),
    ).toThrow();
    expect(() =>
      assertTenantAuthOrigin({ tenant: tenant as never, origin: primary }),
    ).not.toThrow();
  });
});
