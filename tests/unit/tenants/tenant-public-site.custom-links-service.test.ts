import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tenant: {} as any,
  versions: [] as any[],
  deleteCache: vi.fn(),
}));
vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: vi.fn(async () => mocks.tenant),
}));
vi.mock("@/modules/tenants/tenant.model.js", () => ({ default: {
  findOneAndUpdate: vi.fn((_filter: unknown, update: any) => ({ exec: async () => {
    for (const [path, value] of Object.entries(update.$set ?? {})) {
      if (path.startsWith("publicSiteEditor.")) mocks.tenant.publicSiteEditor[path.slice(17)] = value;
      else mocks.tenant[path] = value;
    }
    for (const [path, value] of Object.entries(update.$inc ?? {})) mocks.tenant.publicSiteEditor[path.slice(17)] += Number(value);
    return mocks.tenant;
  } })),
} }));
vi.mock("@/modules/tenants/public-site/tenant-public-site-version.model.js", () => ({ default: {
  findOneAndUpdate: vi.fn((_filter: unknown, update: any) => ({ exec: async () => {
    mocks.versions.push(structuredClone(update.$setOnInsert));
    return update.$setOnInsert;
  } })),
} }));
vi.mock("@/modules/tenants/settings/public-site-media-cleanup.js", () => ({ cleanupDiscardedPublicSiteMedia: vi.fn() }));
vi.mock("@/infrastructure/redis/cache.js", () => ({ deleteCache: mocks.deleteCache }));
vi.mock("@/modules/setup-center/setup-publication.service.js", () => ({
  getTenantPublicationState: vi.fn(),
  publicTenantCacheKey: (slug: string) => `public:${slug}`,
}));
vi.mock("@/modules/tenants/public-site/tenant-public-site.capabilities.js", () => ({ derivePublicTenantCapabilities: vi.fn(async () => ({})) }));
vi.mock("@/modules/tenants/customer-piece-access.service.js", () => ({ getTenantCustomerCapabilities: vi.fn(async () => ({})) }));

import { updateTenantPublicSiteDraft, publishTenantPublicSiteDraft } from "@/modules/tenants/settings/tenant-settings.service.js";
import { buildPublicTenantConfig } from "@/modules/tenants/public-site/tenant-public-site.config.js";
import { updateTenantPublicSiteSchema } from "@/modules/tenants/public-site/tenant-public-site.validators.js";

const entry = (id: string) => ({ id, label: { cs: "Studio", en: "Studio" }, href: { cs: "/cs/studio", en: "/en/studio" } });

describe("custom-link draft publication", () => {
  afterEach(() => vi.restoreAllMocks());

  it("replaces and clears link arrays in drafts, preserves siblings, and only exposes them after publication", async () => {
    const before = { header: { customLinks: [entry("old")], announcement: { text: { en: "Keep announcement" } } }, footer: { customLinks: [entry("footer")], phone: "+420123456789" } };
    mocks.tenant = {
      _id: "507f1f77bcf86cd799439011", name: "Studio", slug: "studio", status: "active",
      settings: { currency: "CZK", timezone: "Europe/Prague", language: "cz" },
      publicSite: structuredClone(before),
      publicSiteEditor: { draft: structuredClone(before), published: structuredClone(before), draftRevision: 1, publishedRevision: 1 },
    };
    mocks.versions = [];
    const session = { withTransaction: async (operation: () => Promise<void>) => operation(), endSession: vi.fn(async () => {}) };
    vi.spyOn(mongoose, "startSession").mockResolvedValue(session as any);
    const customLinks = [
      { id: "learn", label: { cs: "Tvořit", en: "Create" }, children: [entry("new"), { ...entry("second"), separatorBefore: true }] },
      { ...entry("book"), emphasis: "button" },
    ];
    const patch = updateTenantPublicSiteSchema.parse({ header: {
      layout: "website", backgroundColor: "#f6eade", linkColor: "#2f61cc", buttonColor: "#ed8467", customLinks,
    }, footer: { customLinks: [] } });
    const saved = await updateTenantPublicSiteDraft({ tenantId: mocks.tenant._id, revision: 1, patch });
    expect(saved.editor.draftRevision).toBe(2);
    expect(saved.draft.header.customLinks).toMatchObject(customLinks);
    expect(saved.draft.header).toMatchObject({ layout: "website", backgroundColor: "#F6EADE", linkColor: "#2F61CC", buttonColor: "#ED8467" });
    expect(saved.draft.footer.customLinks).toEqual([]);
    expect(saved.draft.footer.phone).toBe("+420123456789");
    expect(saved.draft.header.announcement.text.en).toBe("Keep announcement");
    const beforePublish = (await buildPublicTenantConfig(mocks.tenant)).publicSite.header;
    expect(beforePublish.customLinks.map((link) => link.id)).toEqual(["old"]);
    expect(beforePublish.layout).toBe("default");
    const published = await publishTenantPublicSiteDraft({ tenantId: mocks.tenant._id, userId: "507f1f77bcf86cd799439012", revision: 2 });
    expect(published.editor.hasUnpublishedChanges).toBe(false);
    const live = await buildPublicTenantConfig(mocks.tenant);
    expect(live.publicSite.header).toEqual(saved.draft.header);
    expect(live.publicSite.footer.customLinks).toEqual([]);
    expect(mocks.versions.at(-1).snapshot.header).toEqual(saved.draft.header);
    expect(mocks.deleteCache).toHaveBeenCalledWith("public:studio");
    const cleared = await updateTenantPublicSiteDraft({ tenantId: mocks.tenant._id, revision: 2, patch: { header: { customLinks: [] } } });
    expect(cleared.draft.header.customLinks).toEqual([]);
    expect(cleared.draft.header.layout).toBe("website");
    expect((await buildPublicTenantConfig(mocks.tenant)).publicSite.header.customLinks).toMatchObject(customLinks);
    await publishTenantPublicSiteDraft({ tenantId: mocks.tenant._id, userId: "507f1f77bcf86cd799439012", revision: 3 });
    expect((await buildPublicTenantConfig(mocks.tenant)).publicSite.header.customLinks).toEqual([]);
    expect(mocks.versions.at(-1).snapshot.header.customLinks).toEqual([]);
  });
});
