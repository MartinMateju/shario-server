import { describe, expect, it } from "vitest";

import {
  calculateSatisfactionSummary,
  createSatisfactionToken,
  hashSatisfactionToken,
  validateSatisfactionScore,
} from "@/modules/communications/services/satisfaction.service.js";

describe("communications customer satisfaction", () => {
  it.each([
    [1, 1],
    [5, 5],
    ["4", 4],
    [" 3 ", 3],
  ])("normalizes valid score %j", (input, expected) => {
    expect(validateSatisfactionScore(input)).toBe(expected);
  });

  it.each([0, 6, -1, 4.5, "bad", "", null, undefined, true, false])(
    "rejects invalid score %j",
    (input) => {
      expect(() => validateSatisfactionScore(input)).toThrow(RangeError);
    },
  );

  it("calculates response count, average, distribution, and positive rate", () => {
    expect(
      calculateSatisfactionSummary([
        { score: 5 },
        { score: 5 },
        { score: 4 },
        { score: 2 },
        { score: 1 },
      ]),
    ).toEqual({
      responses: 5,
      average: 3.4,
      distribution: { "1": 1, "2": 1, "3": 0, "4": 1, "5": 2 },
      positiveRate: 0.6,
    });
  });

  it("ignores malformed persisted scores instead of corrupting analytics", () => {
    expect(
      calculateSatisfactionSummary([
        { score: 5 },
        { score: 0 },
        { score: 6 },
        { score: 2.5 },
        { score: "invalid" },
        {},
      ]),
    ).toEqual({
      responses: 1,
      average: 5,
      distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 1 },
      positiveRate: 1,
    });
  });

  it("returns null metrics when there are no valid responses", () => {
    expect(calculateSatisfactionSummary([])).toEqual({
      responses: 0,
      average: null,
      distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
      positiveRate: null,
    });
  });

  it("creates non-recoverable, unique public survey tokens", () => {
    const first = createSatisfactionToken();
    const second = createSatisfactionToken();

    expect(first.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.tokenHash).toBe(hashSatisfactionToken(first.token));
    expect(first.tokenHash).not.toContain(first.token);
    expect(second.token).not.toBe(first.token);
    expect(second.tokenHash).not.toBe(first.tokenHash);
  });
});
