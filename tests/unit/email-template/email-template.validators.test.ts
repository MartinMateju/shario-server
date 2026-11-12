import { describe, expect, it } from "vitest";

import {
  createEmailTemplateSchema,
  listEmailTemplatesQuerySchema,
  updateEmailTemplateSchema,
} from "@/modules/email-template/email-template.validators.js";

describe("email template payload validation", () => {
  it("accepts the canonical FE localized payload and preserves legacy fields", () => {
    const parsed = createEmailTemplateSchema.parse({
      name: "Booking reminder",
      category: "booking",
      defaultLocale: "en",
      contentVariants: {
        cs: {
          subject: "Rezervace {{firstName}}",
          body: "Ahoj {{firstName}}",
        },
        en: {
          subject: "Booking {{firstName}}",
          htmlContent: '<p onclick="evil()">Hello {{firstName}}</p>',
        },
      },
    });

    expect(parsed).toMatchObject({
      defaultLocale: "en",
      subject: "Booking {{firstName}}",
      htmlContent: "<p>Hello {{firstName}}</p>",
      body: "",
      format: "html",
      variables: ["firstName"],
      isActive: true,
      isDefault: false,
    });
    expect(parsed.contentVariants).toMatchObject({
      cs: { format: "plain" },
      en: {
        format: "html",
        htmlContent: "<p>Hello {{firstName}}</p>",
      },
    });
  });

  it("normalizes editor aliases including Czech locale aliases", () => {
    const parsed = createEmailTemplateSchema.parse({
      name: "Alias payload",
      category: "general",
      defaultLanguage: "CZ",
      variants: {
        cz: {
          subject: "Ahoj",
          format: "plain",
          bodyText: "Text",
          bodyHtml: "",
        },
      },
    });

    expect(parsed).toMatchObject({
      defaultLocale: "cs",
      subject: "Ahoj",
      body: "Text",
      format: "plain",
      contentVariants: {
        cs: { subject: "Ahoj", body: "Text", format: "plain" },
      },
    });
  });

  it("rejects unknown variables, incomplete content and inactive defaults", () => {
    expect(() =>
      createEmailTemplateSchema.parse({
        name: "Bad variables",
        category: "general",
        subject: "Hello {{madeUp}}",
        body: "Body",
      }),
    ).toThrow(/Unsupported email variables: madeUp/);

    expect(() =>
      createEmailTemplateSchema.parse({
        name: "Incomplete",
        category: "booking",
        contentVariants: { en: { subject: "Subject only" } },
      }),
    ).toThrow(/HTML or plain-text content is required/);

    expect(() =>
      createEmailTemplateSchema.parse({
        name: "Inactive default",
        category: "general",
        subject: "Subject",
        body: "Body",
        isDefault: true,
        isActive: false,
      }),
    ).toThrow(/default email template must be active/i);
  });

  it("keeps a metadata-only PATCH partial and does not overwrite variables", () => {
    expect(updateEmailTemplateSchema.parse({ name: "Renamed" })).toEqual({
      name: "Renamed",
    });
  });

  it("supports the content list filter and rejects ambiguous booleans", () => {
    expect(
      listEmailTemplatesQuerySchema.parse({ type: "content", active: "false" }),
    ).toMatchObject({ type: "content", active: false });
    expect(() =>
      listEmailTemplatesQuerySchema.parse({ active: "not-a-boolean" }),
    ).toThrow();
  });
});
