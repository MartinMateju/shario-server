import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("communication reminder ownership", () => {
  it("keeps the legacy booking fallback and delegates matching bookings", () => {
    const serverSource = readFileSync("src/server.ts", "utf8");
    const reminderSource = readFileSync(
      "src/modules/access-codes/services/access-code-reminder.service.ts",
      "utf8",
    );

    expect(serverSource).toContain("sendUpcomingBookingReminders");
    expect(reminderSource).toContain(
      "hasCommunicationAutomationBookingReminderOwner",
    );
    expect(reminderSource).toContain("getEligibleLegacyCourseReminderUsers");
    expect(reminderSource).toContain("getAllowedLegacyCourseReminderUsers");
  });

  it("does not let disabled marketing logs own transactional reminders", () => {
    const ownershipSource = readFileSync(
      "src/modules/communication-automations/services/communication-automation-ownership.service.ts",
      "utf8",
    );

    expect(ownershipSource).toContain('purpose: { $ne: "marketing" }');
  });
});
