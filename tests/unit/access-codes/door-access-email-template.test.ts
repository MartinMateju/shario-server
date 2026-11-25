import { describe, expect, it } from "vitest";
import {
  defaultDoorAccessEmailTemplate,
  doorAccessEmailTemplateSchema,
  renderDoorAccessEmailTemplate,
} from "@/modules/access-codes/door-access-email-template.js";
import { getUnknownEmailTemplateVariables } from "@/modules/email-template/email-template.rendering.js";

const source = (patch: Record<string, unknown> = {}) => ({
  defaultLocale: "en",
  contentVariants: {
    en: {
      subject: "{{studioName}} arrival",
      format: "html",
      htmlContent: "<p>Your code: {{entryCode}}</p>",
      body: "",
      ...patch,
    },
  },
});
const values = {
  entryCode: '73<91"',
  studioName: "Clay & <Studio>",
  studioAddress: "Clay Street 1",
  bookingTime: "16 November, 10:00–12:00",
  bookingUrl: "https://studio.example/en/portal",
};

describe("location door-email templates", () => {
  it("provides complete virtual Czech and English defaults without granting code access to other templates", () => {
    const template = doorAccessEmailTemplateSchema.parse(
      defaultDoorAccessEmailTemplate(),
    );
    expect(template.contentVariants.cs?.htmlContent).toContain("{{entryCode}}");
    expect(template.contentVariants.en?.body).toContain("{{entryCode}}");
    expect(
      getUnknownEmailTemplateVariables("{{entryCode}} {{bookingUrl}}"),
    ).toEqual(["entryCode", "bookingUrl"]);
  });

  it("renders escaped HTML and a useful text alternative, preserving customer portal URLs", () => {
    const template = doorAccessEmailTemplateSchema.parse(
      source({
        htmlContent:
          '<p>{{studioName}}</p><strong>{{entryCode}}</strong><p>{{studioAddress}} / {{bookingTime}}</p><a href="{{bookingUrl}}">My booking</a>',
      }),
    );
    const result = renderDoorAccessEmailTemplate(template, "en", values);
    expect(result.html).toContain("73&lt;91&quot;");
    expect(result.html).toContain("Clay &amp; &lt;Studio&gt;");
    expect(result.html).toContain('href="https://studio.example/en/portal"');
    expect(result.text).toContain(values.entryCode);
    expect(result.subject).toBe("Clay & <Studio> arrival");
    expect(result.subject).not.toContain(values.entryCode);
  });

  it("renders plain text safely and uses the default variant if the requested language is absent", () => {
    const template = doorAccessEmailTemplateSchema.parse({
      defaultLocale: "cs",
      contentVariants: {
        cs: {
          subject: "Vítejte {{studioName}}",
          format: "plain",
          body: "Váš kód: {{entryCode}}\n{{bookingTime}}\n{{bookingUrl}}",
        },
      },
    });
    const result = renderDoorAccessEmailTemplate(template, "en", values);
    expect(result.subject).toContain("Vítejte");
    expect(result.text).toContain(values.entryCode);
    expect(result.html).toContain("73&lt;91&quot;<br>");
  });

  it("selects the requested complete language and does not recursively expand values", () => {
    const result = renderDoorAccessEmailTemplate(
      defaultDoorAccessEmailTemplate(),
      "en",
      { ...values, studioName: "{{entryCode}}" },
    );
    expect(result.subject).toBe("{{entryCode}} | Entry code 🔑");
    expect(result.html).toContain("Your studio entry code");
    expect(
      renderDoorAccessEmailTemplate(
        defaultDoorAccessEmailTemplate(),
        "cs",
        values,
      ).html,
    ).toContain("Váš vstupní kód");
  });

  it("sanitizes executable HTML before persistence and rendering", () => {
    const template = doorAccessEmailTemplateSchema.parse(
      source({
        htmlContent:
          '<script>alert(1)</script><p onclick="steal()">{{entryCode}}</p><a href="javascript:alert(1)">Link</a>',
      }),
    );
    expect(template.contentVariants.en?.htmlContent).toBe(
      "<p>{{entryCode}}</p><a>Link</a>",
    );
    expect(
      renderDoorAccessEmailTemplate(template, "en", values).html,
    ).not.toMatch(/script|onclick|javascript/);
  });

  it("preserves static and dynamic URL query parameters across save/reload/render without double-escaping", () => {
    const template = doorAccessEmailTemplateSchema.parse(
      source({
        htmlContent:
          '<p>{{entryCode}}</p><a href="https://example.test/map?a=1&b=2">Map</a><a href="{{bookingUrl}}">Booking</a>',
      }),
    );
    const reloaded = doorAccessEmailTemplateSchema.parse(template);
    expect(reloaded).toEqual(template);
    const rendered = renderDoorAccessEmailTemplate(reloaded, "en", {
      ...values,
      bookingUrl: "https://studio.example/portal?tab=bookings&view=next",
    });
    expect(rendered.html).toContain(
      'href="https://example.test/map?a=1&amp;b=2"',
    );
    expect(rendered.html).toContain(
      'href="https://studio.example/portal?tab=bookings&amp;view=next"',
    );
    expect(rendered.html).not.toContain("&amp;amp;");
  });

  it.each([
    { subject: "Secret {{entryCode}}" },
    { subject: "Hello\r\nBcc: someone@example.test" },
    { htmlContent: "<p>No entry code</p>", body: "{{entryCode}}" },
    { htmlContent: "<!-- {{entryCode}} --><p>No code</p>" },
    { htmlContent: "<script>{{entryCode}}</script><p>No code</p>" },
    { htmlContent: '<img alt="{{entryCode}}">' },
    { htmlContent: '<p title="{{entryCode}}">{{entryCode}}</p>' },
    {
      htmlContent:
        '<a href="https://example.test/?code={{entryCode}}">{{entryCode}}</a>',
    },
    { htmlContent: "<p>https://example.test/<span>{{entryCode}}</span></p>" },
    { htmlContent: "<p>www.example.test/<span>{{entryCode}}</span></p>" },
    { htmlContent: "<p>{{entryCode}}<span>@example.test</span></p>" },
    { htmlContent: '<p style="display:none">{{entryCode}}</p>' },
    { htmlContent: '<p style="font-size:0px">{{entryCode}}</p>' },
    { htmlContent: '<p style="color:transparent">{{entryCode}}</p>' },
    { htmlContent: '<p>{{entryCode}}</p><img src="{{bookingUrl}}">' },
    { htmlContent: "<p>{{entryCode}}</p><p>{{firstName}}</p>" },
    { htmlContent: "<p>{{entryCode}}</p>{{entryCode" },
    { htmlContent: "<p>{{entryCode}}</p>{{{entryCode}}}" },
    { htmlContent: "<p>{{entryCode}}</p>{entryCode}" },
    { htmlContent: "<p>{{entryCode}}</p><broken {{studioName}}" },
    { body: "Text alternative without the code" },
    { format: "plain", body: "https://example.test/{{entryCode}}" },
    { format: "plain", body: "No entry code" },
  ])(
    "rejects incomplete, hidden, malformed or leaking code content: %j",
    (patch) => {
      expect(
        doorAccessEmailTemplateSchema.safeParse(source(patch)).success,
      ).toBe(false);
    },
  );

  it("requires every provided variant to be complete and the default variant to exist", () => {
    expect(
      doorAccessEmailTemplateSchema.safeParse({
        ...source(),
        defaultLocale: "cs",
      }).success,
    ).toBe(false);
    expect(
      doorAccessEmailTemplateSchema.safeParse({
        defaultLocale: "en",
        contentVariants: {
          ...source().contentVariants,
          cs: { subject: "Jen předmět" },
        },
      }).success,
    ).toBe(false);
    expect(
      doorAccessEmailTemplateSchema.safeParse({ ...source(), unexpected: true })
        .success,
    ).toBe(false);
    expect(
      doorAccessEmailTemplateSchema.safeParse(
        source({ subject: "x".repeat(201) }),
      ).success,
    ).toBe(false);
  });
});
