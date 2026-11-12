import { describe, expect, it } from "vitest";

import { buildRegistrationConfirmationEmail } from "@/modules/verification/user-verification.email.js";

describe("registration confirmation member number", () => {
  it("uses the short member number as the pottery signature", () => {
    const email = buildRegistrationConfirmationEmail({
      email: "martin@example.com",
      customId: "U-legacy-qr-id",
      memberNumber: 234,
      firstname: "Martin",
    });

    expect(email.html).toContain("<strong>#234</strong>");
    expect(email.text).toContain("členské ID je #234");
    expect(email.html).not.toContain("U-legacy-qr-id");
    expect(email.text).not.toContain("U-legacy-qr-id");
  });

  it("keeps the legacy identifier as a rollout fallback", () => {
    const email = buildRegistrationConfirmationEmail({
      email: "legacy@example.com",
      customId: "U-legacy-qr-id",
    });

    expect(email.html).toContain("<strong>U-legacy-qr-id</strong>");
    expect(email.text).toContain("členské ID je U-legacy-qr-id");
  });
});
