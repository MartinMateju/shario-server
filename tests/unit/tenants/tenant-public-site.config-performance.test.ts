import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publicCapabilities: vi.fn(),
  customerCapabilities: vi.fn(),
}));

vi.mock(
  "@/modules/tenants/public-site/tenant-public-site.capabilities.js",
  () => ({ derivePublicTenantCapabilities: mocks.publicCapabilities }),
);
vi.mock("@/modules/tenants/customer-piece-access.service.js", () => ({
  getTenantCustomerCapabilities: mocks.customerCapabilities,
}));

import { buildPublicTenantConfig } from "@/modules/tenants/public-site/tenant-public-site.config.js";
import type { TenantDocument } from "@/modules/tenants/tenant.types.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const tenantFixture = (slug = "studio-a") => ({
  _id: slug,
  name: slug,
  slug,
  settings: {
    publicDefaultLanguage: "cs",
    supportedPublicLanguages: ["cs", "en"],
    currency: "CZK",
    timezone: "Europe/Prague",
  },
  publicSiteEditor: {
    published: { branding: { displayName: `${slug} published` } },
    draft: { branding: { displayName: `${slug} draft` } },
  },
});

describe("public tenant config independent reads", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.publicCapabilities.mockResolvedValue({ courses: true });
    mocks.customerCapabilities.mockResolvedValue({ myWork: true });
  });

  it("starts both capability reads before either completes and waits for both", async () => {
    const publicRead = deferred<{ courses: boolean }>();
    const customerRead = deferred<{ myWork: boolean }>();
    mocks.publicCapabilities.mockReturnValue(publicRead.promise);
    mocks.customerCapabilities.mockReturnValue(customerRead.promise);
    const tenant = tenantFixture() as unknown as TenantDocument;
    let returnedConfig = false;
    const result = buildPublicTenantConfig(tenant).then((config) => {
      returnedConfig = true;
      return config;
    });

    // No timers: the customer read must begin while the public read is held.
    expect(mocks.publicCapabilities).toHaveBeenCalledWith(
      tenant,
      undefined,
      {},
    );
    expect(mocks.customerCapabilities).toHaveBeenCalledWith(tenant);
    publicRead.resolve({ courses: true });
    await publicRead.promise;
    expect(returnedConfig).toBe(false);

    customerRead.resolve({ myWork: false });
    await expect(result).resolves.toMatchObject({
      id: "studio-a",
      slug: "studio-a",
      settings: {
        publicDefaultLanguage: "cs",
        supportedPublicLanguages: ["cs", "en"],
        currency: "CZK",
        timezone: "Europe/Prague",
      },
      publicSite: { branding: { displayName: "studio-a published" } },
      publicCapabilities: { courses: true },
      customerCapabilities: { myWork: false },
    });
  });

  it.each(["public", "customer"] as const)(
    "does not return partial config when the %s read fails",
    async (failedRead) => {
      const publicRead = deferred<{ courses: boolean }>();
      const customerRead = deferred<{ myWork: boolean }>();
      mocks.publicCapabilities.mockReturnValue(publicRead.promise);
      mocks.customerCapabilities.mockReturnValue(customerRead.promise);
      const failure = new Error("capability storage unavailable");
      const result = buildPublicTenantConfig(
        tenantFixture() as unknown as TenantDocument,
      );
      const rejection = expect(result).rejects.toBe(failure);

      expect(mocks.publicCapabilities).toHaveBeenCalledOnce();
      expect(mocks.customerCapabilities).toHaveBeenCalledOnce();
      if (failedRead === "public") {
        publicRead.reject(failure);
        customerRead.resolve({ myWork: true });
      } else {
        customerRead.reject(failure);
        publicRead.resolve({ courses: true });
      }
      await rejection;
    },
  );

  it("reads fresh capabilities after publication changes and keeps preview separate", async () => {
    const tenant = tenantFixture();
    const before = await buildPublicTenantConfig(
      tenant as unknown as TenantDocument,
    );
    tenant.publicSiteEditor.published.branding.displayName = "New publication";
    mocks.publicCapabilities.mockResolvedValue({ courses: false });
    mocks.customerCapabilities.mockResolvedValue({ myWork: false });

    const after = await buildPublicTenantConfig(
      tenant as unknown as TenantDocument,
    );
    const preview = await buildPublicTenantConfig(
      tenant as unknown as TenantDocument,
      { snapshot: "draft" },
    );

    expect(before.publicSite.branding.displayName).toBe("studio-a published");
    expect(after.publicSite.branding.displayName).toBe("New publication");
    expect(preview.publicSite.branding.displayName).toBe("studio-a draft");
    expect(after.publicCapabilities).toEqual({ courses: false });
    expect(after.customerCapabilities).toEqual({ myWork: false });
    expect(mocks.publicCapabilities).toHaveBeenCalledTimes(3);
    expect(mocks.customerCapabilities).toHaveBeenCalledTimes(3);
    expect(mocks.publicCapabilities).toHaveBeenLastCalledWith(
      tenant,
      undefined,
      { snapshot: "draft" },
    );
  });

  it("keeps concurrently loaded tenant configurations and capabilities isolated", async () => {
    const tenantA = tenantFixture("studio-a");
    const tenantB = tenantFixture("studio-b");
    const publicA = deferred<{ courses: boolean }>();
    const publicB = deferred<{ courses: boolean }>();
    mocks.publicCapabilities.mockImplementation((tenant) =>
      tenant.slug === "studio-a" ? publicA.promise : publicB.promise,
    );
    mocks.customerCapabilities.mockImplementation(async (tenant) => ({
      myWork: tenant.slug === "studio-b",
    }));

    const resultA = buildPublicTenantConfig(
      tenantA as unknown as TenantDocument,
    );
    const resultB = buildPublicTenantConfig(
      tenantB as unknown as TenantDocument,
    );
    publicB.resolve({ courses: false });
    await expect(resultB).resolves.toMatchObject({
      id: "studio-b",
      publicSite: { branding: { displayName: "studio-b published" } },
      publicCapabilities: { courses: false },
      customerCapabilities: { myWork: true },
    });
    publicA.resolve({ courses: true });
    await expect(resultA).resolves.toMatchObject({
      id: "studio-a",
      publicSite: { branding: { displayName: "studio-a published" } },
      publicCapabilities: { courses: true },
      customerCapabilities: { myWork: false },
    });
  });
});
