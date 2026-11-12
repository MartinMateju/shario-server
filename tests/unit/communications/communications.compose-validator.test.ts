import { describe, expect, it } from "vitest";

import { composeMessageSchema } from "@/modules/communications/communications.validators.js";

const operationalEmail = {
  channel: "email",
  to: [{ email: "customer@example.test" }],
  subject: "Booking update",
  text: "Your booking time changed.",
  purpose: "transactional",
};

describe("manual communication compose boundary", () => {
  it("accepts one operational transactional email", () => {
    expect(composeMessageSchema.parse(operationalEmail)).toMatchObject(
      operationalEmail,
    );
  });

  it("accepts the legacy support alias during the client rollout", () => {
    expect(
      composeMessageSchema.safeParse({
        ...operationalEmail,
        purpose: "support",
      }).success,
    ).toBe(true);
  });

  it.each([
    [{ ...operationalEmail, purpose: "marketing" }, "purpose"],
    [
      {
        ...operationalEmail,
        channel: "instagram",
        to: [{ instagramScopedId: "ig-customer-1" }],
      },
      "channel",
    ],
  ])("rejects unsupported manual compose input", (input, path) => {
    const result = composeMessageSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path[0])).toContain(path);
    }
  });
});
