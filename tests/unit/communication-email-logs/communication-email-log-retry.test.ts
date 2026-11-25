import mongoose from "mongoose";
import { describe, expect, it } from "vitest";
import {
  decorateCommunicationEmailLog,
  getCommunicationEmailRetryBlock,
} from "@/modules/communication-email-logs/communication-email-log-retry.js";
import { getCommunicationEmailAttemptLimit } from "@/modules/communication-email-logs/communication-email-log.constants.js";
import { retryCommunicationEmailLogSchema } from "@/modules/communication-email-logs/communication-email-log.validators.js";

const fixture = {
  status: "suppressed",
  cancelReason: "consent_revoked",
  automation: new mongoose.Types.ObjectId(),
  recipientEmail: "maker@example.test",
  subject: "Studio update",
  body: "Original content",
  emailType: "oneTimeEmail",
  purpose: "transactional",
  allowanceClass: "metered",
  deduplicationKey: "snapshot-key",
  attempts: 0,
};

describe("email history retry eligibility", () => {
  it("separates the historical reason from current eligibility", () => {
    expect(decorateCommunicationEmailLog(fixture)).toMatchObject({
      canRetry: true,
      reasonCode: "consent_revoked",
      retryBlockedReason: null,
      manualRetryCount: 0,
    });
    expect(
      decorateCommunicationEmailLog(fixture, "consent_expired"),
    ).toMatchObject({
      canRetry: false,
      reasonCode: "consent_revoked",
      retryBlockedReason: "consent_expired",
    });
  });
  it.each(["sent", "delivered", "bounced", "complained"])(
    "does not replay %s",
    (status) => {
      expect(getCommunicationEmailRetryBlock({ ...fixture, status })).toBe(
        "already_sent",
      );
    },
  );
  it.each(["pending", "scheduled", "queued", "sending"])(
    "does not duplicate %s",
    (status) => {
      expect(getCommunicationEmailRetryBlock({ ...fixture, status })).toBe(
        "delivery_in_progress",
      );
    },
  );
  it.each([
    ["providerMessageId", "accepted", "already_sent"],
    ["sentAt", new Date(), "already_sent"],
    ["providerLastEvent", { recordType: "delivered" }, "already_sent"],
    ["providerAttemptStartedAt", new Date(), "delivery_outcome_unknown"],
    ["manualReviewRequiredAt", new Date(), "delivery_outcome_unknown"],
    ["processingClaimToken", "claim", "delivery_in_progress"],
    ["queueRecoveryLeaseExpiresAt", new Date(0), "delivery_in_progress"],
  ])(
    "fails closed for the %s fence even on a failed log",
    (field, value, reason) => {
      expect(
        getCommunicationEmailRetryBlock({
          ...fixture,
          status: "failed",
          [String(field)]: value,
        }),
      ).toBe(reason);
    },
  );
  it.each([
    "passwordReset",
    "afterBisqueFiring",
    "afterFinalFiring",
    "unknown",
  ])("rejects unsafe/legacy type %s", (emailType) => {
    expect(getCommunicationEmailRetryBlock({ ...fixture, emailType })).toBe(
      "unsupported_email_type",
    );
  });
  it.each(["security", "marketing"])(
    "does not turn %s into transactional mail",
    (purpose) => {
      expect(getCommunicationEmailRetryBlock({ ...fixture, purpose })).toBe(
        "unsupported_email_type",
      );
    },
  );
  it.each([
    { recipientEmail: "redacted@retention.invalid" },
    { body: "", htmlContent: "" },
    { subject: "[redacted by retention policy]" },
    { recipientEmail: "" },
  ])("rejects unavailable snapshots: %j", (patch) => {
    expect(getCommunicationEmailRetryBlock({ ...fixture, ...patch })).toBe(
      "content_unavailable",
    );
  });
  it("does not treat a missing idempotency contract as safe to retry", () => {
    expect(
      getCommunicationEmailRetryBlock({ ...fixture, deduplicationKey: "" }),
    ).toBe("invalid_delivery_contract");
  });
  it("rejects legacy failures without a durable failed transition and malformed queue keys", () => {
    expect(
      getCommunicationEmailRetryBlock({
        ...fixture,
        status: "failed",
        failedAt: null,
      }),
    ).toBe("delivery_outcome_unknown");
    expect(
      getCommunicationEmailRetryBlock({
        ...fixture,
        deduplicationKey: "unsafe:queue:key",
      }),
    ).toBe("invalid_delivery_contract");
  });
  it("preserves direct email recipients while rejecting missing event source identities", () => {
    expect(
      getCommunicationEmailRetryBlock({ ...fixture, user: null }),
    ).toBeNull();
    expect(
      getCommunicationEmailRetryBlock({
        ...fixture,
        emailType: "afterRegistration",
        user: null,
      }),
    ).toBe("invalid_delivery_contract");
    expect(
      getCommunicationEmailRetryBlock({ ...fixture, user: "invalid" }),
    ).toBe("invalid_delivery_contract");
  });
  it.each(["oneTimeEmail", "bookingRescheduled", "firingReady"])(
    "gives an audited %s retry a bounded cycle without resetting lifetime attempts",
    (emailType) => {
      const log =
        emailType === "oneTimeEmail"
          ? { ...fixture, emailType }
          : {
              emailType,
              automation: null,
              purpose: "transactional",
              allowanceClass: "essential_system",
            };
      expect(
        getCommunicationEmailAttemptLimit(
          {
            ...log,
            attempts: 9,
            retryCycleStartAttempt: 9,
            manualRetryCount: 1,
          },
          6,
        ),
      ).toBe(15);
      expect(
        getCommunicationEmailAttemptLimit(
          { ...log, attempts: 9, retryCycleStartAttempt: 9 },
          6,
        ),
      ).toBe(6);
      expect(
        getCommunicationEmailAttemptLimit(
          {
            ...log,
            attempts: 9,
            retryCycleStartAttempt: 10,
            manualRetryCount: 1,
          },
          6,
        ),
      ).toBe(6);
    },
  );
  it("requires a bounded integer retry count and rejects force/content overrides", () => {
    expect(
      retryCommunicationEmailLogSchema.parse({ expectedManualRetryCount: 0 }),
    ).toEqual({ expectedManualRetryCount: 0 });
    for (const body of [
      {},
      { expectedManualRetryCount: -1 },
      { expectedManualRetryCount: "0" },
      { expectedManualRetryCount: 0, force: true },
      { expectedManualRetryCount: 0, recipientEmail: "other@example.test" },
    ]) {
      expect(retryCommunicationEmailLogSchema.safeParse(body).success).toBe(
        false,
      );
    }
  });
});
