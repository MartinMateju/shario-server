import mongoose from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tenant: null as any,
  plans: [] as any[],
  findTenantById: vi.fn(),
  findTenantBySlug: vi.fn(),
  findPlans: vi.fn(),
  populate: vi.fn(),
  locationExists: vi.fn(),
  findLocations: vi.fn(),
}));
vi.mock("@/modules/tenants/tenant.repository.js", () => ({
  findTenantById: mocks.findTenantById,
  findTenantBySlug: mocks.findTenantBySlug,
}));
vi.mock("@/modules/membership/membership-plan.model.js", () => ({
  default: { find: mocks.findPlans },
}));

import { membershipPlanService } from "@/modules/membership/services/membership-plan.service.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const LOCATION_ID = "507f1f77bcf86cd799439012";
const OTHER_LOCATION_ID = "507f1f77bcf86cd799439013";
const published = {
  _id: "507f1f77bcf86cd799439014",
  status: "published",
  version: 1,
  name: "Published membership",
  prices: [{ currency: "CZK", amountMinor: 10000 }],
  billing: { type: "fixed", durationDays: 30 },
  locationScope: { type: "selected", locationIds: [LOCATION_ID] },
};

describe("membership catalog published projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tenant = {
      _id: new mongoose.Types.ObjectId(TENANT_ID),
      slug: "clay", name: "Clay", status: "active",
      modules: { memberships: true, payments: true },
      settings: { currency: "CZK" },
    };
    mocks.findTenantById.mockResolvedValue(mocks.tenant);
    mocks.findTenantBySlug.mockResolvedValue(mocks.tenant);
    mocks.plans = [{
      _id: "507f1f77bcf86cd799439015",
      status: "published",
      currentPublishedVersion: published,
      currentDraftVersion: { ...published, version: 2, status: "draft", name: "Private draft" },
    }];
    const query = {
      populate: mocks.populate,
      sort: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => mocks.plans),
    };
    mocks.populate.mockReturnValue(query);
    mocks.findPlans.mockReturnValue(query);
    mocks.locationExists.mockResolvedValue({ _id: LOCATION_ID });
    mocks.findLocations.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([{ _id: LOCATION_ID, name: "Václavská" }]),
    });
    vi.spyOn(mongoose, "model").mockImplementation((name: string) => {
      if (name !== "Location") throw new Error(`Unexpected model: ${name}`);
      return { exists: mocks.locationExists, find: mocks.findLocations } as any;
    });
  });

  it("selects only the authenticated tenant's published plans and stable published version", async () => {
    const result = await membershipPlanService.customerCatalog(TENANT_ID, LOCATION_ID);
    expect(mocks.findTenantById).toHaveBeenCalledWith(TENANT_ID);
    expect(mocks.findTenantBySlug).not.toHaveBeenCalled();
    expect(mocks.findPlans).toHaveBeenCalledWith({
      tenant: mocks.tenant._id,
      status: "published",
      currentPublishedVersion: { $ne: null },
    });
    expect(mocks.populate).toHaveBeenCalledWith({
      path: "currentPublishedVersion", match: { status: "published" },
    });
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].name).toBe("Published membership");
    expect(result.plans[0]).not.toHaveProperty("draftVersion");
    expect(JSON.stringify(result)).not.toContain("Private draft");
    expect(result.plans[0].publishedVersion.locationScope.locations).toEqual([{ id: LOCATION_ID, name: "Václavská" }]);
    expect(mocks.findLocations).toHaveBeenCalledWith(expect.objectContaining({
      tenant: mocks.tenant._id, isActive: true,
    }));
  });

  it("filters another location and excludes an unpublished version pointer", async () => {
    mocks.plans.push(
      { _id: "other-studio", currentPublishedVersion: { ...published, locationScope: { type: "selected", locationIds: [OTHER_LOCATION_ID] } } },
      { _id: "missing-published", currentPublishedVersion: null },
      { _id: "all-studios", currentPublishedVersion: { ...published, locationScope: { type: "all", locationIds: [] } } },
    );
    const result = await membershipPlanService.customerCatalog(TENANT_ID, LOCATION_ID);
    expect(result.plans.map((plan) => plan.id)).toEqual(["507f1f77bcf86cd799439015", "all-studios"]);
  });

  it("rejects a location outside the authenticated tenant before querying plans", async () => {
    mocks.locationExists.mockResolvedValue(null);
    await expect(membershipPlanService.customerCatalog(TENANT_ID, OTHER_LOCATION_ID))
      .rejects.toThrow("Location not found.");
    expect(mocks.locationExists).toHaveBeenCalledWith({
      _id: new mongoose.Types.ObjectId(OTHER_LOCATION_ID), tenant: mocks.tenant._id,
    });
    expect(mocks.findPlans).not.toHaveBeenCalled();
  });

  it("keeps public and customer catalog output identical", async () => {
    expect(await membershipPlanService.publicCatalog("clay", LOCATION_ID))
      .toEqual(await membershipPlanService.customerCatalog(TENANT_ID, LOCATION_ID));
    expect(mocks.findTenantBySlug).toHaveBeenCalledWith("clay");
  });

  it("returns primary currency and selected languages with only published translations", async () => {
    Object.assign(mocks.tenant.settings, { publicDefaultLanguage: "cs", supportedPublicLanguages: ["cs", "en"] });
    mocks.plans[0].currentPublishedVersion = { ...published, translations: new Map([["cs", { name: "Veřejné členství" }]]) };
    mocks.plans[0].currentDraftVersion.translations = { cs: { name: "Tajný koncept" } };
    const result = await membershipPlanService.customerCatalog(TENANT_ID);
    expect(result.tenant).toMatchObject({ currency: "CZK", primaryLanguage: "cs", supportedLanguages: ["cs", "en"] });
    expect(result.plans[0].publishedVersion.translations).toEqual({ cs: { name: "Veřejné členství" } });
    expect(JSON.stringify(result)).not.toContain("Tajný koncept");
  });
});
