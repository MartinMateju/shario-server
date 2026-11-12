import { describe, expect, it } from "vitest";

import { serializeTenantPublicSite } from "@/modules/tenants/public-site/tenant-public-site.serializers.js";
import { updateTenantPublicSiteSchema } from "@/modules/tenants/public-site/tenant-public-site.validators.js";

const snapshot = (
  label: string,
  stylePreset:
    | "classic-editorial-v1"
    | "modern-minimal-v1"
    | "warm-organic-v1" = "classic-editorial-v1",
) => ({
  branding: {
    displayName: `${label} name`,
    stylePreset,
    logoUrl: "",
    faviconUrl: "",
    accentColor: "#1F36D4",
    secondaryColor: "#D27357",
    backgroundColor: "#FCFBF8",
    textColor: "#1F1F1F",
    coverImageUrl: "",
    description: {
      cs: `${label} popis`,
      en: `${label} description`,
    },
  },
  login: {
    headline: {
      cs: `${label} přihlášení`,
      en: `${label} login`,
    },
    supportingText: { cs: "", en: "" },
    helpText: { cs: "", en: "" },
    backgroundImageUrl: "",
  },
  header: {
    navOrder: ["book", "courses", "memberships", "help"],
    hiddenItems: [],
    primaryCta: "auto",
    announcement: {
      text: { cs: "", en: "" },
      url: "",
    },
  },
  footer: {
    description: {
      cs: `${label} patička`,
      en: `${label} footer`,
    },
    openingHours: { cs: "", en: "" },
    copyright: { cs: "", en: "" },
    email: "",
    phone: "",
    address: "",
    social: {
      instagram: "",
      facebook: "",
      youtube: "",
      website: "",
    },
    legal: {
      studioRules: "",
      terms: "",
      privacy: "",
      cancellation: "",
    },
  },
  pages: {
    home: {
      eyebrow: { cs: "", en: "" },
      headline: {
        cs: `${label} domů`,
        en: `${label} home`,
      },
      description: { cs: "", en: "" },
    },
    book: {
      title: { cs: "", en: "" },
      description: { cs: "", en: "" },
    },
    courses: {
      title: { cs: "", en: "" },
      description: { cs: "", en: "" },
    },
    memberships: {
      title: { cs: "", en: "" },
      description: { cs: "", en: "" },
    },
    help: {
      title: { cs: "", en: "" },
      description: { cs: "", en: "" },
    },
  },
});

describe("public-site snapshot security boundary", () => {
  it("never serializes the editor draft through the anonymous default path", () => {
    const tenant = {
      name: "Legacy studio",
      publicSite: snapshot("legacy"),
      publicSiteEditor: {
        draft: snapshot("secret draft", "modern-minimal-v1"),
        published: snapshot("public", "warm-organic-v1"),
        draftRevision: 8,
        publishedRevision: 4,
      },
    };

    const anonymous = serializeTenantPublicSite(tenant as never);
    const preview = serializeTenantPublicSite(tenant as never, {
      snapshot: "draft",
    });

    expect(anonymous.branding.displayName).toBe("public name");
    expect(anonymous.branding.description).toEqual({
      en: "public description",
      cs: "public popis",
      de: "",
      pl: "",
      sk: "",
      da: "",
      fr: "",
      es: "",
      it: "",
      "pt-PT": "",
      sv: "",
      nb: "",
      fi: "",
      hu: "",
      el: "",
      tr: "",
      nl: "",
      ro: "",
    });
    expect(anonymous.pages.home.headline.en).toBe("public home");
    expect(JSON.stringify(anonymous)).not.toContain("secret draft");
    expect(anonymous.branding.stylePreset).toBe("warm-organic-v1");

    expect(preview.branding.displayName).toBe("secret draft name");
    expect(preview.branding.description).toEqual({
      en: "secret draft description",
      cs: "secret draft popis",
      de: "",
      pl: "",
      sk: "",
      da: "",
      fr: "",
      es: "",
      it: "",
      "pt-PT": "",
      sv: "",
      nb: "",
      fi: "",
      hu: "",
      el: "",
      tr: "",
      nl: "",
      ro: "",
    });
    expect(preview.pages.home.headline.en).toBe("secret draft home");
    expect(preview.branding.stylePreset).toBe("modern-minimal-v1");
  });

  it("falls back to the legacy published mirror for pre-editor tenants", () => {
    const result = serializeTenantPublicSite({
      name: "Legacy studio",
      publicSite: snapshot("legacy"),
    } as never);

    expect(result.branding.displayName).toBe("legacy name");
    expect(result.login.headline.en).toBe("legacy login");
    expect(result.pages.home.headline.cs).toBe("legacy domů");
    expect(result.pages.home.headline).toEqual({
      en: "legacy home",
      cs: "legacy domů",
      de: "legacy name",
      pl: "legacy name",
      sk: "legacy name",
      da: "legacy name",
      fr: "legacy name",
      es: "legacy name",
      it: "legacy name",
      "pt-PT": "legacy name",
      sv: "legacy name",
      nb: "legacy name",
      fi: "legacy name",
      hu: "legacy name",
      el: "legacy name",
      tr: "legacy name",
      nl: "legacy name",
      ro: "legacy name",
    });
  });

  it("serializes rollout tenant copy and ignores unknown keys", () => {
    const publicSite = snapshot("wave one") as ReturnType<typeof snapshot> & {
      branding: ReturnType<typeof snapshot>["branding"] & {
        description: Record<string, string>;
      };
    };
    Object.assign(publicSite.branding.description, {
      de: "Deutsche Beschreibung",
      pl: "Polski opis",
      sk: "Slovenský opis",
      da: "Dansk beskrivelse",
      fr: "Description française",
      es: "Descripción española",
      it: "Descrizione italiana",
      "pt-PT": "Descrição portuguesa",
      sv: "Svensk beskrivning",
      nb: "Norsk beskrivelse",
      fi: "Suomenkielinen kuvaus",
      hu: "Magyar leírás",
      el: "Ελληνική περιγραφή",
      tr: "Türkçe açıklama",
      nl: "Nederlandse beschrijving",
      ro: "Descriere în limba română",
      ja: "Not enabled",
    });

    const result = serializeTenantPublicSite({
      name: "Wave one studio",
      publicSite,
    } as never);

    expect(result.branding.description).toEqual({
      en: "wave one description",
      cs: "wave one popis",
      de: "Deutsche Beschreibung",
      pl: "Polski opis",
      sk: "Slovenský opis",
      da: "Dansk beskrivelse",
      fr: "Description française",
      es: "Descripción española",
      it: "Descrizione italiana",
      "pt-PT": "Descrição portuguesa",
      sv: "Svensk beskrivning",
      nb: "Norsk beskrivelse",
      fi: "Suomenkielinen kuvaus",
      hu: "Magyar leírás",
      el: "Ελληνική περιγραφή",
      tr: "Türkçe açıklama",
      nl: "Nederlandse beschrijving",
      ro: "Descriere în limba română",
    });
    expect(result.branding.description).not.toHaveProperty("ja");
  });

  it("fails closed when legacy published data contains executable values", () => {
    const corrupt = snapshot("public");
    corrupt.branding.logoUrl = "javascript:alert(1)";
    corrupt.branding.coverImageUrl = "//evil.example/cover.jpg";
    corrupt.branding.accentColor = "#fff;background:red";
    corrupt.login.headline.en = "<img src=x onerror=alert(1)>";
    corrupt.header.announcement.url = "data:text/html,boom";
    corrupt.footer.social.instagram = "http://evil.example/profile";
    corrupt.footer.legal.privacy = "\\\\evil.example\\privacy";

    const result = serializeTenantPublicSite({
      name: "Safe fallback",
      publicSite: corrupt,
    } as never);

    expect(result.branding.logoUrl).toBe("");
    expect(result.branding.coverImageUrl).toBe("");
    expect(result.branding.accentColor).toBe("#1F36D4");
    expect(result.login.headline.en).toBe("");
    expect(result.header.announcement.url).toBe("");
    expect(result.footer.social.instagram).toBe("");
    expect(result.footer.legal.privacy).toBe("");
  });

  it.each([
    {
      branding: {
        logoUrl: "javascript:alert(1)",
      },
    },
    {
      branding: {
        faviconUrl: "data:image/svg+xml,<svg onload=alert(1)>",
      },
    },
    {
      branding: {
        textColor: "#fff;color:red",
      },
    },
    {
      pages: {
        home: {
          headline: {
            en: "<script>alert(1)</script>",
          },
        },
      },
    },
    {
      footer: {
        social: {
          youtube: "https://user:password@youtube.com/channel",
        },
      },
    },
    {
      header: {
        announcement: {
          url: "//evil.example/notice",
        },
      },
    },
  ])("rejects unsafe controlled customization: %o", (value) => {
    expect(updateTenantPublicSiteSchema.safeParse(value).success).toBe(false);
  });
});
