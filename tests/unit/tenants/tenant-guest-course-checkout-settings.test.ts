import { describe, expect, it } from "vitest";

import TenantModel from "@/modules/tenants/tenant.model.js";
import { isGuestCourseCheckoutEnabled } from "@/modules/tenants/public-site/tenant-course-visibility.js";
import { serializeTenantPublicSite } from "@/modules/tenants/public-site/tenant-public-site.serializers.js";
import { updateTenantPublicSiteSchema } from "@/modules/tenants/public-site/tenant-public-site.validators.js";

const optIn = { customerPortal: { courses: { guestCheckoutEnabled: true } } };

describe("guest course checkout opt-in", () => {
  it("defaults off for persisted tenants and legacy serialized configurations", () => {
    const tenant = new TenantModel({ name: "Clay", slug: "clay" });
    expect(tenant.publicSite.customerPortal.courses.guestCheckoutEnabled).toBe(
      false,
    );
    expect(
      serializeTenantPublicSite({ name: "Clay" }).customerPortal.courses
        .guestCheckoutEnabled,
    ).toBe(false);
    expect(isGuestCourseCheckoutEnabled({})).toBe(false);
  });

  it.each([true, false])(
    "accepts a standalone boolean patch: %s",
    (enabled) => {
      expect(
        updateTenantPublicSiteSchema.parse({
          customerPortal: { courses: { guestCheckoutEnabled: enabled } },
        }),
      ).toEqual({
        customerPortal: { courses: { guestCheckoutEnabled: enabled } },
      });
    },
  );

  it.each(["true", 1, null])("rejects coerced opt-in values: %s", (value) => {
    expect(
      updateTenantPublicSiteSchema.safeParse({
        customerPortal: { courses: { guestCheckoutEnabled: value } },
      }).success,
    ).toBe(false);
    expect(
      serializeTenantPublicSite({
        name: "Clay",
        publicSite: {
          customerPortal: { courses: { guestCheckoutEnabled: value } },
        },
      }).customerPortal.courses.guestCheckoutEnabled,
    ).toBe(false);
  });

  it("does not enable checkout from an unpublished draft or old root snapshot", () => {
    const tenant = {
      name: "Clay",
      publicSite: optIn,
      publicSiteEditor: { published: {}, draft: optIn },
    } as any;
    expect(isGuestCourseCheckoutEnabled(tenant)).toBe(false);
    expect(isGuestCourseCheckoutEnabled(tenant, { snapshot: "draft" })).toBe(
      true,
    );
    expect(
      isGuestCourseCheckoutEnabled({
        ...tenant,
        publicSiteEditor: { published: optIn, draft: {} },
      }),
    ).toBe(true);
  });

  it.each([
    { ...optIn, pages: { courses: { visible: false } } },
    {
      customerPortal: {
        ...optIn.customerPortal,
        pages: { courses: { enabled: false } },
      },
    },
  ])("requires both course pages to remain visible", (publicSite) => {
    expect(isGuestCourseCheckoutEnabled({ publicSite } as any)).toBe(false);
  });

  it("stores draft and published settings independently", async () => {
    const tenant = new TenantModel({
      name: "Clay",
      slug: "clay",
      publicSiteEditor: { draft: optIn, published: {} },
    });
    await expect(tenant.validate()).resolves.toBeUndefined();
    expect(
      tenant.publicSiteEditor?.draft?.customerPortal.courses
        .guestCheckoutEnabled,
    ).toBe(true);
    expect(
      tenant.publicSiteEditor?.published?.customerPortal.courses
        .guestCheckoutEnabled,
    ).toBe(false);
  });
});
