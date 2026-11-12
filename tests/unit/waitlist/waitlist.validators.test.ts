import { describe, expect, it } from "vitest";

import {
  guestWaitlistRequestSchema,
  joinCustomerWaitlistSchema,
  waitlistSettingsPatchSchema,
} from "@/modules/waitlist/waitlist.validators.js";

describe("waitlist request contracts", () => {
  const sessionId = "507f1f77bcf86cd799439011";

  it("accepts and canonicalizes rollout-eligible locale snapshots", () => {
    expect(
      joinCustomerWaitlistSchema.parse({ sessionId, locale: "cs" }),
    ).toEqual({
      sessionId,
      locale: "cs",
    });
    expect(joinCustomerWaitlistSchema.parse({ sessionId })).toEqual({
      sessionId,
      locale: "en",
    });
    for (const [input, expected] of [
      ["CZ", "cs"],
      ["cs-CZ", "cs"],
      ["de-DE", "de"],
      ["pl_PL", "pl"],
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
    ] as const) {
      expect(
        joinCustomerWaitlistSchema.parse({ sessionId, locale: input }),
      ).toEqual({ sessionId, locale: expected });
    }
    for (const locale of ["ja", "nn-NO", "pt-BR"]) {
      expect(() =>
        joinCustomerWaitlistSchema.parse({ sessionId, locale }),
      ).toThrow();
    }
    expect(() =>
      joinCustomerWaitlistSchema.parse({
        sessionId,
        locale: "en",
        admin: true,
      }),
    ).toThrow();
  });

  it("strictly validates verified guest identity input", () => {
    expect(
      guestWaitlistRequestSchema.parse({
        sessionId,
        email: " Person@Example.com ",
        firstName: "Ada",
        lastName: "Lovelace",
        locale: "cs",
      }),
    ).toMatchObject({ email: "Person@Example.com", locale: "cs" });
    expect(() =>
      guestWaitlistRequestSchema.parse({
        sessionId,
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        position: 1,
      }),
    ).toThrow();
  });

  it("enforces integer admin settings bounds and a non-empty patch", () => {
    expect(
      waitlistSettingsPatchSchema.parse({
        enabled: true,
        autoPromote: false,
        offerWindowHours: 168,
        cutoffHours: 0,
      }),
    ).toEqual({
      enabled: true,
      autoPromote: false,
      offerWindowHours: 168,
      cutoffHours: 0,
    });
    expect(() => waitlistSettingsPatchSchema.parse({})).toThrow();
    expect(() =>
      waitlistSettingsPatchSchema.parse({ offerWindowHours: 168.5 }),
    ).toThrow();
    expect(() =>
      waitlistSettingsPatchSchema.parse({ offerWindowHours: 169 }),
    ).toThrow();
  });
});
