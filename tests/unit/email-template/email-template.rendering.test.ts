import { describe, expect, it } from "vitest";

import {
  getUnknownEmailTemplateVariables,
  hasDeliverableEmailTemplateContent,
  renderEmailContent,
  sanitizeEmailHtml,
  selectLocalizedEmailContent,
} from "@/modules/email-template/email-template.rendering.js";

describe("localized email template rendering", () => {
  it("falls back to the available locale and reports the locale actually used", () => {
    const selected = selectLocalizedEmailContent(
      {
        defaultLocale: "cs",
        contentVariants: {
          cs: {
            subject: "Ahoj {{firstName}}",
            body: "Česká zpráva",
            format: "plain",
          },
        },
      },
      "en",
    );

    expect(selected).toMatchObject({
      locale: "cs",
      subject: "Ahoj {{firstName}}",
      body: "Česká zpráva",
      format: "plain",
    });
  });

  it("escapes runtime values and strips executable template HTML", () => {
    const rendered = renderEmailContent({
      source: {
        subject: "Booking for {{firstName}}\r\nBcc: injected@example.test",
        htmlContent:
          '<p onclick="steal()">Hello {{firstName}}</p><script>alert(1)</script><a href="java&#x73;cript:alert(1)" target="_blank">open</a>',
        format: "html",
      },
      locale: "en",
      variables: { firstName: '<img src=x onerror="steal()">' },
    });

    expect(rendered.subject).toBe(
      "Booking for <img src=x onerror=\"steal()\"> Bcc: injected@example.test",
    );
    expect(rendered.html).toContain(
      "Hello &lt;img src=x onerror=&quot;steal()&quot;&gt;",
    );
    expect(rendered.html).not.toMatch(/script|onclick|javascript/i);
    expect(rendered.html).toContain(
      '<a target="_blank" rel="noopener noreferrer">open</a>',
    );
  });

  it("renders plain text as escaped HTML while retaining a plain alternative", () => {
    const rendered = renderEmailContent({
      source: {
        subject: "Ahoj {{firstName}}",
        body: "Line one\n{{firstName}} <3",
        format: "plain",
      },
      locale: "cs",
      variables: { firstName: "Anna & Jan" },
    });

    expect(rendered.text).toBe("Line one\nAnna & Jan <3");
    expect(rendered.html).toBe("Line one<br>Anna &amp; Jan &lt;3");
  });

  it("removes dangerous elements, encoded protocols and unsafe CSS", () => {
    const sanitized = sanitizeEmailHtml(
      '<style>body{display:none}</style><p style="color: red; background:url(javascript:evil); font-size: 14px" onmouseover="evil()">Safe</p><img src="data:text/html,evil"><a href="jav&#x09;ascript:evil">bad</a>',
    );

    expect(sanitized).toBe(
      '<p style="color: red; font-size: 14px">Safe</p><img><a>bad</a>',
    );
  });

  it("rejects variables outside the shared allowlist", () => {
    expect(
      getUnknownEmailTemplateVariables(
        "{{firstName}} {{unknown}} {{another.unknown}}",
      ),
    ).toEqual(["unknown", "another.unknown"]);
    expect(() =>
      renderEmailContent({
        source: {
          subject: "Hello {{unknown}}",
          htmlContent: "<p>Body</p>",
        },
        locale: "en",
        variables: {},
      }),
    ).toThrow("Unsupported email variables: unknown.");
  });

  it("does not treat a layout as a deliverable message template", () => {
    expect(
      hasDeliverableEmailTemplateContent({
        category: "layout",
        subject: "",
        htmlContent: "<header>Brand</header>",
      }),
    ).toBe(false);
    expect(
      hasDeliverableEmailTemplateContent({
        category: "booking",
        defaultLocale: "en",
        contentVariants: {
          en: { subject: "Reminder", body: "Starts soon", format: "plain" },
        },
      }),
    ).toBe(true);
  });
});
