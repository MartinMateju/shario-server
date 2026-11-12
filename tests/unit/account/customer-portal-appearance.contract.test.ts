import mongoose, { Schema } from "mongoose";
import { afterAll, describe, expect, it } from "vitest";

import { customerPreferencesSchema } from "@/modules/account/account.validators.js";
import { tenantPublicSiteSchema } from "@/modules/tenants/public-site/tenant-public-site.schema.js";
import { serializeTenantPublicSite } from "@/modules/tenants/public-site/tenant-public-site.serializers.js";
import { updateTenantPublicSiteSchema } from "@/modules/tenants/public-site/tenant-public-site.validators.js";
import { userSchema } from "@/modules/user/user.schema.js";
import {
  PORTAL_APPEARANCE_COLOR_KEYS,
  serializePortalAppearance,
} from "@/shared/appearance/portal-appearance.js";

const User = mongoose.model("PortalAppearanceCustomerContract", userSchema);
const Site = mongoose.model(
  "PortalAppearanceStudioContract",
  new Schema({
    publicSite: { type: tenantPublicSiteSchema, default: () => ({}) },
  }),
);
const inherited = Object.fromEntries(
  PORTAL_APPEARANCE_COLOR_KEYS.map((key) => [key, ""]),
);

describe("studio and personal customer-portal colors", () => {
  afterAll(() => {
    mongoose.deleteModel("PortalAppearanceCustomerContract");
    mongoose.deleteModel("PortalAppearanceStudioContract");
  });

  it("keeps legacy users and studios on inheritance and personal preferences out of normal projections", () => {
    const user = User.hydrate({ _id: new mongoose.Types.ObjectId() });
    const studio = Site.hydrate({ _id: new mongoose.Types.ObjectId() });
    expect(user.toObject().portalAppearance).toEqual(inherited);
    expect(studio.toObject().publicSite.customerPortal.appearance).toEqual(
      inherited,
    );
    expect(userSchema.path("portalAppearance").options.select).toBe(false);
  });

  it.each(PORTAL_APPEARANCE_COLOR_KEYS)(
    "normalizes and persists %s at both levels, with an explicit inheritance reset",
    async (key) => {
      const patch = { [key]: "  #a1b2c3  " };
      expect(
        customerPreferencesSchema.parse({ portalAppearance: patch }),
      ).toEqual({
        portalAppearance: { [key]: "#A1B2C3" },
      });
      expect(
        updateTenantPublicSiteSchema.parse({
          customerPortal: { appearance: patch },
        }),
      ).toEqual({
        customerPortal: { appearance: { [key]: "#A1B2C3" } },
      });
      const studio = new Site({
        publicSite: { customerPortal: { appearance: patch } },
      });
      await expect(studio.validate()).resolves.toBeUndefined();
      expect(studio.publicSite.customerPortal.appearance[key]).toBe("#A1B2C3");
      const user = new User({
        tenant: new mongoose.Types.ObjectId(),
        firstname: "Test",
        customId: "U-TEST",
        portalAppearance: patch,
      });
      await expect(user.validate()).resolves.toBeUndefined();
      expect(user.portalAppearance[key]).toBe("#A1B2C3");
      user.portalAppearance[key] = "";
      await expect(user.validate()).resolves.toBeUndefined();
      expect(user.portalAppearance[key]).toBe("");
      expect(
        customerPreferencesSchema.parse({ portalAppearance: { [key]: "" } }),
      ).toEqual({
        portalAppearance: { [key]: "" },
      });
    },
  );

  it.each([
    "red",
    "transparent",
    "#fff",
    "#12345678",
    "rgba(0,0,0,.5)",
    "url(https://example.test)",
    7,
    null,
    {},
  ])("rejects uncontrolled appearance value %j at both boundaries", (value) => {
    expect(
      customerPreferencesSchema.safeParse({
        portalAppearance: { backgroundColor: value },
      }).success,
    ).toBe(false);
    expect(
      updateTenantPublicSiteSchema.safeParse({
        customerPortal: { appearance: { backgroundColor: value } },
      }).success,
    ).toBe(false);
  });

  it("rejects empty or unknown patches without creating arbitrary CSS, identity or branding fields", () => {
    for (const portalAppearance of [
      {},
      { customCss: "display:none" },
      { tenantId: "other" },
      { backgroundColor: "#FFFFFF", script: "alert(1)" },
    ]) {
      expect(
        customerPreferencesSchema.safeParse({ portalAppearance }).success,
      ).toBe(false);
    }
    expect(
      customerPreferencesSchema.safeParse({
        portalAppearance: inherited,
        userId: "other",
      }).success,
    ).toBe(false);
  });

  it("sanitizes stored palette values and never serializes an account palette as public studio branding", () => {
    expect(
      serializePortalAppearance({
        textColor: "#abc123",
        backgroundColor: "red",
        customCss: "display:none",
      }),
    ).toEqual({
      ...inherited,
      textColor: "#ABC123",
    });
    const tenant = {
      name: "Studio",
      portalAppearance: { backgroundColor: "#123456" },
      publicSite: {
        customerPortal: { appearance: { backgroundColor: "#abcdef" } },
      },
    };
    expect(
      serializeTenantPublicSite(tenant as never).customerPortal.appearance,
    ).toEqual({
      ...inherited,
      backgroundColor: "#ABCDEF",
    });
    expect(
      JSON.stringify(serializeTenantPublicSite(tenant as never)),
    ).not.toContain("#123456");
  });
});
