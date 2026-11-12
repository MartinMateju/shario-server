import { describe, expect, it } from "vitest";

import { updateTenantPublicSiteSchema } from "@/modules/tenants/public-site/tenant-public-site.validators.js";

describe("tenant public-site rollout localized content", () => {
  it("accepts all and only rollout-eligible locale keys", () => {
    const description = {
      en: "A creative studio",
      cs: "Kreativní studio",
      de: "Ein Kreativstudio",
      pl: "Kreatywne studio",
      sk: "Kreatívne štúdio",
      da: "Et kreativt studio",
      fr: "Un studio créatif",
      es: "Un estudio creativo",
      it: "Uno studio creativo",
      "pt-PT": "Um estúdio criativo",
      sv: "En kreativ studio",
      nb: "Et kreativt studio",
      fi: "Luova studio",
      hu: "Kreatív stúdió",
      el: "Ένα δημιουργικό στούντιο",
      tr: "Yaratıcı bir stüdyo",
      nl: "Een creatieve studio",
      ro: "Un studio creativ",
    };

    expect(
      updateTenantPublicSiteSchema.parse({
        branding: { description },
      }).branding?.description,
    ).toEqual(description);

    expect(
      updateTenantPublicSiteSchema.safeParse({
        branding: { description: { ja: "Not enabled" } },
      }).success,
    ).toBe(false);
  });

  it("applies the existing content safety rules to every rollout locale", () => {
    expect(
      updateTenantPublicSiteSchema.safeParse({
        pages: {
          home: {
            headline: { "pt-PT": "<script>alert(1)</script>" },
          },
        },
      }).success,
    ).toBe(false);
  });
});
