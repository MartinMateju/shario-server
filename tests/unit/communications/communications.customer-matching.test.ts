import { describe, expect, it } from "vitest";

import {
  normalizeContactIdentity,
  rankCustomerMatches,
  scoreCustomerMatch,
} from "@/modules/communications/services/customer-matching.service.js";
import {
  AI_AUTO_APPLY_CONFIDENCE,
  AI_REVIEW_CONFIDENCE,
} from "@/modules/communications/communications.constants.js";

describe("communications customer matching", () => {
  it("normalizes case-insensitive email identity", () => {
    expect(normalizeContactIdentity("  ANNA@Example.COM  ", "email")).toBe(
      "anna@example.com",
    );
  });

  it("normalizes WhatsApp punctuation and international 00 prefixes", () => {
    expect(
      normalizeContactIdentity("00 420 (777) 123-456", "whatsapp"),
    ).toBe("+420777123456");
  });

  it("treats exact contact identity plus name as an auto-match", () => {
    const result = scoreCustomerMatch(
      { name: "Ánna Nováková", email: "ANNA@example.com" },
      {
        _id: "customer-1",
        firstname: "Anna",
        lastname: "Novakova",
        email: "anna@example.com",
      },
    );

    expect(result).toEqual({
      score: 1,
      reasons: ["exact_email", "exact_name"],
    });
    expect(result.score).toBeGreaterThanOrEqual(AI_AUTO_APPLY_CONFIDENCE);
  });

  it("keeps a single exact email match below the auto-apply threshold", () => {
    const result = scoreCustomerMatch(
      { name: "Different person", email: "anna@example.com" },
      { name: "Anna Novak", email: "ANNA@EXAMPLE.COM" },
    );

    expect(result).toEqual({ score: 0.82, reasons: ["exact_email"] });
    expect(result.score).toBeGreaterThanOrEqual(AI_REVIEW_CONFIDENCE);
    expect(result.score).toBeLessThan(AI_AUTO_APPLY_CONFIDENCE);
  });

  it("does not identify a customer from a weak name-only match", () => {
    const result = scoreCustomerMatch(
      { name: "Anna" },
      { name: "Anna Novak" },
    );

    expect(result.score).toBeLessThan(AI_REVIEW_CONFIDENCE);
    expect(result.reasons).toEqual(["similar_name"]);
  });

  it("combines phone and WhatsApp identities but caps confidence at one", () => {
    expect(
      scoreCustomerMatch(
        {
          name: "Anna Novak",
          whatsappId: "+420 777 123 456",
          email: "anna@example.com",
        },
        {
          firstname: "Anna",
          lastname: "Novak",
          phone: "00420 777 123 456",
          email: "ANNA@example.com",
        },
      ),
    ).toEqual({
      score: 1,
      reasons: ["exact_email", "exact_phone", "exact_name"],
    });
  });

  it("ranks only plausible candidates, strongest first, with a bounded result", () => {
    const ranked = rankCustomerMatches(
      { name: "Anna Novak", email: "anna@example.com" },
      [
        { _id: "weak", firstname: "Anna", lastname: "Other" },
        {
          _id: "exact",
          firstname: "Anna",
          lastname: "Novak",
          email: "ANNA@example.com",
        },
        { _id: "email", name: "Someone Else", email: "anna@example.com" },
        { _id: "none", name: "Peter Smith", email: "peter@example.com" },
      ],
      2,
    );

    expect(ranked.map((entry) => entry.customerId)).toEqual(["exact", "email"]);
    expect(ranked[0].score).toBe(1);
    expect(ranked[1].score).toBe(0.82);
  });

  it("returns no candidate when no reliable identity overlaps", () => {
    expect(
      rankCustomerMatches(
        { email: "unknown@example.com", phone: "+420111111111" },
        [
          {
            _id: "customer-1",
            email: "anna@example.com",
            phone: "+420222222222",
          },
        ],
      ),
    ).toEqual([]);
  });
});
