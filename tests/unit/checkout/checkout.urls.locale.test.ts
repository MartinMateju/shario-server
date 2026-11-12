import { describe, expect, it } from "vitest";

import {
  buildTenantCommerceUrl,
  normalizeCommerceLocale,
} from "@/modules/checkout/checkout.urls.js";

describe("checkout locale routing", () => {
  it.each([
    ["en", "en"],
    ["cs-CZ", "cs"],
    ["cz", "cs"],
    ["de-DE", "de"],
    ["pl-PL", "pl"],
    ["sk-SK", "sk"],
    ["da-DK", "da"],
    ["fr-FR", "fr"],
    ["es_ES", "es"],
    ["it-IT", "it"],
    ["pt_PT", "pt-PT"],
    ["sv-SE", "sv"],
    ["nb-NO", "nb"],
    ["no-NO", "nb"],
    ["fi-FI", "fi"],
    ["hu-HU", "hu"],
    ["el-GR", "el"],
    ["tr-TR", "tr"],
    ["nl-NL", "nl"],
    ["nl_NL", "nl"],
    ["ro-RO", "ro"],
    ["ro_RO", "ro"],
  ])("normalizes rollout locale %s to %s", (input, expected) => {
    expect(normalizeCommerceLocale(input)).toBe(expected);
  });

  it.each(["", "ja", "nn-NO", "pt-BR", "invalid"])(
    "falls back for unsupported locale %s",
    (input) => {
      expect(normalizeCommerceLocale(input)).toBe("en");
    },
  );

  it("preserves a rollout locale in payment return URLs", () => {
    expect(
      buildTenantCommerceUrl({
        origin: "https://the-pottery-house.shario.io",
        locale: "pl",
        path: "portal/success",
        query: { orderId: "order-123" },
      }),
    ).toBe(
      "https://the-pottery-house.shario.io/pl/portal/success?orderId=order-123",
    );

    expect(
      buildTenantCommerceUrl({
        origin: "https://the-pottery-house.shario.io",
        locale:
          normalizeCommerceLocale(
            "pt_PT",
          ),
        path: "portal/success",
      }),
    ).toBe("https://the-pottery-house.shario.io/pt-PT/portal/success");
  });
});

