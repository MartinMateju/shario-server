import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findPublishedTenantBySlug: vi.fn(),
  getTenantBySlug: vi.fn(),
  getCustomerSocialProviderAvailability: vi.fn(),
}));

vi.mock("@/modules/setup-center/setup-publication.service.js", () => ({
  findPublishedTenantBySlug: mocks.findPublishedTenantBySlug,
}));

vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantBySlug: mocks.getTenantBySlug,
}));

vi.mock("@/modules/auth/social/customer-social.config.js", () => ({
  getCustomerSocialProviderAvailability:
    mocks.getCustomerSocialProviderAvailability,
  getCustomerSocialProviderConfig: vi.fn(),
}));

import { getCustomerSocialProviders } from "@/modules/auth/social/customer-social.service.js";

describe("customer social provider service contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findPublishedTenantBySlug.mockResolvedValue({
      _id: "507f1f77bcf86cd799439011",
      slug: "studio-olivka",
      status: "active",
    });
    mocks.getTenantBySlug.mockResolvedValue(null);
    mocks.getCustomerSocialProviderAvailability.mockReturnValue({
      google: true,
      apple: false,
      facebook: true,
    });
  });

  it("returns the stable tenant-scoped provider availability shape", async () => {
    await expect(getCustomerSocialProviders("studio-olivka")).resolves.toEqual({
      tenant: {
        id: "507f1f77bcf86cd799439011",
        slug: "studio-olivka",
      },
      providers: {
        google: { available: true },
        apple: { available: false },
      },
    });

    expect(mocks.findPublishedTenantBySlug).toHaveBeenCalledWith(
      "studio-olivka",
    );
  });

  it("returns disabled providers for an existing unpublished tenant", async () => {
    mocks.findPublishedTenantBySlug.mockResolvedValueOnce(null);
    mocks.getTenantBySlug.mockResolvedValueOnce({
      _id: "507f1f77bcf86cd799439012",
      slug: "draft-studio",
      status: "active",
    });

    await expect(
      getCustomerSocialProviders("draft-studio"),
    ).resolves.toEqual({
      tenant: {
        id: "507f1f77bcf86cd799439012",
        slug: "draft-studio",
      },
      providers: {
        google: { available: false },
        apple: { available: false },
      },
    });
    expect(mocks.getCustomerSocialProviderAvailability).not.toHaveBeenCalled();
  });

  it("still hides a missing or inactive tenant behind the generic public 404", async () => {
    mocks.findPublishedTenantBySlug.mockResolvedValue(null);
    mocks.getTenantBySlug
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        _id: "507f1f77bcf86cd799439013",
        slug: "suspended-studio",
        status: "suspended",
      });

    await expect(
      getCustomerSocialProviders("missing-studio"),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "PUBLIC_WORKSPACE_NOT_FOUND",
    });
    await expect(
      getCustomerSocialProviders("suspended-studio"),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "PUBLIC_WORKSPACE_NOT_FOUND",
    });
    expect(mocks.getCustomerSocialProviderAvailability).not.toHaveBeenCalled();
  });
});
