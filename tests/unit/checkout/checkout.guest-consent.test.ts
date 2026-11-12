import { describe, expect, it } from "vitest";
import { getPublishedGuestCourseLegalLinks } from "@/modules/checkout/checkout.guest-consent.js";

const site = (legal: Record<string, unknown>) => ({ footer: { legal } });

describe("published guest course legal links", () => {
  it("uses published links instead of legacy settings or draft edits", () => {
    expect(
      getPublishedGuestCourseLegalLinks({
        name: "Studio",
        publicSite: site({ terms: "https://legacy.example/terms" }),
        publicSiteEditor: {
          draft: site({ terms: "https://draft.example/terms" }),
          published: site({
            terms: "HTTPS://PUBLISHED.EXAMPLE:443",
            cancellation: "/cs/cancellation?source=course#policy",
          }),
        },
      }),
    ).toEqual({
      terms: "https://published.example/",
      cancellation: "/cs/cancellation?source=course#policy",
    });
  });

  it("preserves explicit published absence without reviving draft, legacy or alias values", () => {
    expect(
      getPublishedGuestCourseLegalLinks({
        name: "Studio",
        publicSite: site({ terms: "https://legacy.example/terms" }),
        publicSiteEditor: {
          draft: site({ terms: "https://draft.example/terms" }),
          published: site({
            terms: "",
            cancellation: "",
            termsUrl: "https://alias.example/terms",
          }),
        },
      }),
    ).toEqual({ terms: "", cancellation: "" });
  });

  it("supports a legacy public site without an editor publication but never a draft alone", () => {
    expect(
      getPublishedGuestCourseLegalLinks({
        name: "Studio",
        publicSite: site({ terms: " /terms " }),
      }),
    ).toEqual({ terms: "/terms", cancellation: "" });
    expect(
      getPublishedGuestCourseLegalLinks({
        name: "Studio",
        publicSiteEditor: { draft: site({ terms: "/draft" }) },
      }),
    ).toEqual({ terms: "", cancellation: "" });
  });

  it.each([
    "http://studio.example/terms",
    "//other.example/terms",
    "javascript:alert(1)",
    "https://user:password@studio.example/terms",
    "https://studio.example:8443/terms",
    "/terms\\other",
    "/terms\nother",
    "https://studio.example/" + "a".repeat(2048),
  ])(
    "rejects an unsafe legal URL without inventing fallback content: %s",
    (url) => {
      expect(
        getPublishedGuestCourseLegalLinks({
          name: "Studio",
          publicSite: site({ terms: url, cancellation: url }),
        }),
      ).toEqual({ terms: "", cancellation: "" });
    },
  );
});
