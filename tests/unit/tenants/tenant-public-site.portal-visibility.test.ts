import mongoose, { Schema, Types } from "mongoose";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/modules/tenants/public-site/tenant-public-site.capabilities.js",
  () => ({
    derivePublicTenantCapabilities: vi.fn(async () => ({ modules: {} })),
  }),
);

import {
  CUSTOMER_PORTAL_NAVIGATION_KEYS,
  CUSTOMER_PORTAL_PAGE_IDS,
} from "@/modules/tenants/public-site/tenant-public-site.constants.js";
import { buildPublicTenantConfig } from "@/modules/tenants/public-site/tenant-public-site.config.js";
import {
  tenantPublicSiteEditorSchema,
  tenantPublicSiteSchema,
} from "@/modules/tenants/public-site/tenant-public-site.schema.js";
import { serializeTenantPublicSite } from "@/modules/tenants/public-site/tenant-public-site.serializers.js";
import { updateTenantPublicSiteSchema } from "@/modules/tenants/public-site/tenant-public-site.validators.js";
import TenantPublicSiteVersionModel from "@/modules/tenants/public-site/tenant-public-site-version.model.js";

const MODEL_NAME = "TenantPublicSitePortalVisibilityTest";
const FixtureModel = mongoose.model(
  MODEL_NAME,
  new Schema({
    name: String,
    publicSite: { type: tenantPublicSiteSchema, default: () => ({}) },
    publicSiteEditor: {
      type: tenantPublicSiteEditorSchema,
      default: undefined,
    },
  }),
);

const controls = [
  ...CUSTOMER_PORTAL_PAGE_IDS.map((key) => ["pages", key, "enabled"] as const),
  ...CUSTOMER_PORTAL_NAVIGATION_KEYS.map(
    (key) => ["navigation", key, "visible"] as const,
  ),
];

describe("customer portal page and navigation settings", () => {
  afterAll(() => mongoose.deleteModel(MODEL_NAME));

  it("preserves the legacy portal with all eleven pages and four top links available", async () => {
    const legacy = new FixtureModel({ name: "Studio" });
    await expect(legacy.validate()).resolves.toBeUndefined();
    const stored = legacy.toObject().publicSite.customerPortal;
    const serialized = serializeTenantPublicSite({
      name: "Studio",
    }).customerPortal;
    expect(Object.keys(serialized.pages)).toEqual([
      "calendar",
      "courses",
      "memberships",
      "vouchers",
      "studioGuide",
      "bookings",
      "work",
      "credits",
      "invoices",
      "account",
      "notifications",
      "waitlists",
    ]);
    expect(Object.keys(serialized.navigation)).toEqual([
      "bookSession",
      "courses",
      "memberships",
      "giftVouchers",
      "studioGuide",
    ]);
    for (const [group, key, field] of controls) {
      expect(stored[group][key][field]).toBe(true);
      expect((serialized[group] as any)[key][field]).toBe(true);
    }
  });

  it.each(controls)(
    "validates and preserves %s.%s.%s across storage and snapshots",
    async (group, key, field) => {
      const hidden = {
        customerPortal: { [group]: { [key]: { [field]: false } } },
      };
      expect(updateTenantPublicSiteSchema.parse(hidden)).toEqual(hidden);
      expect(
        updateTenantPublicSiteSchema.parse({
          customerPortal: { [group]: { [key]: { [field]: true } } },
        }),
      ).toBeDefined();

      const document = new FixtureModel({
        name: "Studio",
        publicSite: hidden,
        publicSiteEditor: { draft: hidden, published: {} },
      });
      await expect(document.validate()).resolves.toBeUndefined();
      const stored = {
        ...FixtureModel.hydrate(document.toObject()).toObject(),
        name: "Studio",
      };
      expect(
        stored.publicSiteEditor.draft.customerPortal[group][key][field],
      ).toBe(false);
      expect(
        (
          serializeTenantPublicSite(stored, { snapshot: "draft" })
            .customerPortal[group] as any
        )[key][field],
      ).toBe(false);
      expect(
        (serializeTenantPublicSite(stored).customerPortal[group] as any)[key][
          field
        ],
      ).toBe(true);

      const version = new TenantPublicSiteVersionModel({
        tenant: new Types.ObjectId(),
        sourceDraftRevision: 1,
        snapshot: hidden,
        publishedAt: new Date(),
      });
      await expect(version.validate()).resolves.toBeUndefined();
      expect((version.snapshot.customerPortal[group] as any)[key][field]).toBe(
        false,
      );

      for (const value of ["false", "true", 0, 1, null, {}, []]) {
        expect(
          updateTenantPublicSiteSchema.safeParse({
            customerPortal: { [group]: { [key]: { [field]: value } } },
          }).success,
        ).toBe(false);
      }
    },
  );

  it.each([
    { pages: {} },
    { navigation: {} },
    { pages: { calendar: {} } },
    { navigation: { bookSession: {} } },
    { pages: { unknownPage: { enabled: false } } },
    { navigation: { account: { visible: false } } },
    { pages: { calendar: { enabled: false, headerVisible: false } } },
    { navigation: { bookSession: { visible: false, url: "/other" } } },
  ])(
    "rejects empty controls and unsupported portal fields: %o",
    (customerPortal) => {
      expect(
        updateTenantPublicSiteSchema.safeParse({ customerPortal }).success,
      ).toBe(false);
    },
  );

  it("keeps page availability separate from top links and strips unsupported legacy values", () => {
    const config = serializeTenantPublicSite({
      name: "Studio",
      publicSite: {
        header: { hiddenItems: ["memberships"] },
        customerPortal: {
          pages: {
            memberships: { enabled: false, headerVisible: false },
            calendar: { enabled: "false" },
            unknownPage: { enabled: false },
          },
          navigation: {
            bookSession: { visible: false },
            studioGuide: { visible: null },
            account: { visible: false },
          },
          dashboard: { headline: { en: "Existing dashboard" } },
          appearance: { headerBackgroundColor: "#123abc" },
        },
      },
    });
    expect(config.customerPortal.pages.memberships.enabled).toBe(false);
    expect(config.customerPortal.navigation.memberships.visible).toBe(true);
    expect(config.customerPortal.pages.calendar.enabled).toBe(true);
    expect(config.customerPortal.navigation.bookSession.visible).toBe(false);
    expect(config.customerPortal.navigation.studioGuide.visible).toBe(true);
    expect(config.customerPortal.pages).not.toHaveProperty("unknownPage");
    expect(config.customerPortal.pages.memberships).not.toHaveProperty(
      "headerVisible",
    );
    expect(config.customerPortal.navigation).not.toHaveProperty("account");
    expect(config.customerPortal.dashboard.headline.en).toBe(
      "Existing dashboard",
    );
    expect(config.customerPortal.appearance.headerBackgroundColor).toBe(
      "#123ABC",
    );
    expect(config.header.hiddenItems).toEqual(["memberships"]);
  });

  it("exposes published controls in public config while preview uses only the draft", async () => {
    const tenant = {
      _id: new Types.ObjectId(),
      name: "Studio",
      slug: "studio",
      settings: {
        defaultLanguage: "en",
        currency: "CZK",
        timezone: "Europe/Prague",
      },
      publicSiteEditor: {
        published: {
          customerPortal: { pages: { credits: { enabled: false } } },
        },
        draft: {
          customerPortal: { navigation: { giftVouchers: { visible: false } } },
        },
      },
    };
    const live = await buildPublicTenantConfig(tenant as never);
    const preview = await buildPublicTenantConfig(tenant as never, {
      snapshot: "draft",
    });
    expect(live.publicSite.customerPortal.pages.credits.enabled).toBe(false);
    expect(live.publicSite.customerPortal.navigation.giftVouchers.visible).toBe(
      true,
    );
    expect(preview.publicSite.customerPortal.pages.credits.enabled).toBe(true);
    expect(
      preview.publicSite.customerPortal.navigation.giftVouchers.visible,
    ).toBe(false);
  });
});
