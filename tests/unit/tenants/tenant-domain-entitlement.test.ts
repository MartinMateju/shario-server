import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assertTenantAuthOrigin } from "@/modules/auth/auth-origin.js";
import { resolveTenantCommerceOrigin } from "@/modules/checkout/checkout.urls.js";
import { TENANT_DOMAIN_TYPE, TENANT_PLAN } from "@/modules/tenants/tenant.constants.js";
import { isTenantDomainEntitled } from "@/modules/tenants/tenant-domain-entitlement.js";

describe("Plan V3 custom-domain entitlement", () => {
  const customDomain = { type: TENANT_DOMAIN_TYPE.CUSTOM };

  afterEach(() => vi.unstubAllEnvs());

  it("keeps standard subdomains available on every plan", () => {
    expect(
      isTenantDomainEntitled({
        tenant: { plan: TENANT_PLAN.STARTER, planVersion: 3 },
        domain: { type: TENANT_DOMAIN_TYPE.SUBDOMAIN },
      }),
    ).toBe(true);
  });

  it("requires Studio Plus or Enterprise for a V3 custom host", () => {
    for (const plan of [TENANT_PLAN.STARTER, TENANT_PLAN.PROFESSIONAL]) {
      expect(
        isTenantDomainEntitled({
          tenant: { plan, planVersion: 3 },
          domain: customDomain,
        }),
      ).toBe(false);
    }
    for (const plan of [TENANT_PLAN.STUDIO_PLUS, TENANT_PLAN.ENTERPRISE]) {
      expect(
        isTenantDomainEntitled({
          tenant: { plan, planVersion: 3 },
          domain: customDomain,
        }),
      ).toBe(true);
    }
  });

  it("preserves active custom hosts for historical plan snapshots", () => {
    expect(
      isTenantDomainEntitled({
        tenant: { plan: TENANT_PLAN.STARTER, planVersion: 2 },
        domain: customDomain,
      }),
    ).toBe(true);
  });

  it("fails closed in auth and checkout after a V3 downgrade", () => {
    vi.stubEnv("NODE_ENV", "production");
    const domain = {
      hostname: "studio.example",
      status: "active",
      type: TENANT_DOMAIN_TYPE.CUSTOM,
    };
    const starter = {
      _id: "tenant",
      slug: "clay-school",
      plan: TENANT_PLAN.STARTER,
      planVersion: 3,
      domains: [domain],
    };

    expect(
      resolveTenantCommerceOrigin({
        tenant: starter,
        requestedOrigin: "https://studio.example",
      }),
    ).toBe("https://clay-school.shario.io");
    expect(() =>
      assertTenantAuthOrigin({
        origin: "https://studio.example",
        tenant: starter as never,
      }),
    ).toThrow();

    const plus = { ...starter, plan: TENANT_PLAN.STUDIO_PLUS };
    expect(
      resolveTenantCommerceOrigin({
        tenant: plus,
        requestedOrigin: "https://studio.example",
      }),
    ).toBe("https://studio.example");
    expect(() =>
      assertTenantAuthOrigin({
        origin: "https://studio.example",
        tenant: plus as never,
      }),
    ).not.toThrow();

    expect(
      resolveTenantCommerceOrigin({
        tenant: plus,
        requestedOrigin: "https://www.studio.example",
      }),
    ).toBe("https://clay-school.shario.io");

    const wwwPlus = {
      ...plus,
      domains: [{ ...domain, hostname: "www.studio.example" }],
    };
    expect(
      resolveTenantCommerceOrigin({
        tenant: wwwPlus,
        requestedOrigin: "https://studio.example",
      }),
    ).toBe("https://clay-school.shario.io");
  });

  it("is applied by canonical resolution, auth origins, and checkout URLs", () => {
    const read = (relativePath: string) =>
      readFileSync(
        fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url)),
        "utf8",
      );

    expect(read("src/modules/tenants/tenant.repository.ts")).toContain(
      "isTenantDomainEntitled({ tenant, domain })",
    );
    expect(read("src/shared/middleware/resolveTenant.ts")).toContain(
      "findActiveTenantByHostname(hostname)",
    );
    expect(read("src/modules/auth/auth-origin.ts")).toContain(
      "isTenantDomainEntitled({ tenant, domain })",
    );
    expect(read("src/modules/checkout/checkout.urls.ts")).toContain(
      "isTenantDomainEntitled({ tenant, domain })",
    );
  });
});
