import mongoose from "mongoose";
import { describe, expect, it } from "vitest";
import { CommunicationEmailLogModel as Model } from "@/modules/communication-email-logs/communication-email-log.model.js";
const fixture = {
  tenant: new mongoose.Types.ObjectId(),
  automation: null,
  recipientEmail: "customer@example.test",
  subject: "Booking cancelled",
  body: "Booking cancelled and credit restored.",
  contentFormat: "plain",
  emailType: "bookingCancelled",
  purpose: "transactional",
  allowanceClass: "essential_system",
  deduplicationKey: "a".repeat(64),
};

describe("built-in booking email log schema", () => {
  it.each(["bookingCancelled", "bookingRescheduled", "firingReady"])(
    "accepts %s without a tenant automation",
    async (emailType) => {
      const doc = new Model({ ...fixture, emailType });
      await expect(doc.validate()).resolves.toBeUndefined();
      expect(doc.automation).toBeNull();
      expect(doc.retryable).toBe(true);
    },
  );
  it.each([
    { emailType: "oneTimeEmail" },
    { automation: new mongoose.Types.ObjectId() },
    { allowanceClass: "metered" },
    { purpose: "marketing" },
  ])("rejects an invalid built-in/essential contract: %j", async (patch) => {
    await expect(
      new Model({ ...fixture, ...patch }).validate(),
    ).rejects.toThrow();
  });
  it("keeps ordinary metered automations valid and requiring their automation", async () => {
    const ordinary = {
      ...fixture,
      emailType: "afterBooking",
      allowanceClass: "metered",
      automation: new mongoose.Types.ObjectId(),
    };
    await expect(new Model(ordinary).validate()).resolves.toBeUndefined();
    await expect(
      new Model({ ...ordinary, automation: null }).validate(),
    ).rejects.toThrow(/automation/);
  });
});
