import { describe, expect, it } from "vitest";

import {
  isCommunicationAllowed,
} from "@/modules/communications/services/consent.service.js";

const NOW = new Date("2026-07-22T12:00:00.000Z");

describe("communications consent eligibility", () => {
  it("blocks a suppressed recipient for every channel and purpose", () => {
    expect(
      isCommunicationAllowed({
        channel: "email",
        purpose: "security",
        suppressed: true,
        now: NOW,
      }),
    ).toEqual({ allowed: false, reason: "recipient_suppressed" });
  });

  it("blocks revoked or expired consent before delivery", () => {
    expect(
      isCommunicationAllowed({
        channel: "email",
        purpose: "marketing",
        consent: { status: "revoked" },
        now: NOW,
      }),
    ).toEqual({ allowed: false, reason: "consent_revoked" });

    expect(
      isCommunicationAllowed({
        channel: "email",
        purpose: "marketing",
        consent: {
          status: "granted",
          expiresAt: "2026-07-22T11:59:59.999Z",
        },
        now: NOW,
      }),
    ).toEqual({ allowed: false, reason: "consent_expired" });
  });

  it("allows security notices without an opt-in when not suppressed", () => {
    expect(
      isCommunicationAllowed({
        channel: "email",
        purpose: "security",
        consent: null,
        now: NOW,
      }),
    ).toEqual({ allowed: true, reason: "security_necessity" });
  });

  it("allows a customer-initiated email support response", () => {
    expect(
      isCommunicationAllowed({
        channel: "email",
        purpose: "support",
        consent: null,
        customerInitiated: true,
        now: NOW,
      }),
    ).toEqual({ allowed: true, reason: "customer_initiated_support" });
  });

  it("enforces WhatsApp's service-window rule for customer-initiated free-form replies", () => {
    expect(
      isCommunicationAllowed({
        channel: "whatsapp",
        purpose: "support",
        consent: null,
        customerInitiated: true,
        serviceWindowOpen: true,
        now: NOW,
      }),
    ).toEqual({ allowed: true, reason: "customer_initiated_support" });

    expect(
      isCommunicationAllowed({
        channel: "whatsapp",
        purpose: "support",
        consent: null,
        customerInitiated: true,
        serviceWindowOpen: false,
        now: NOW,
      }),
    ).toEqual({ allowed: false, reason: "consent_required" });
  });

  it("allows necessary transactional email but requires WhatsApp opt-in", () => {
    expect(
      isCommunicationAllowed({
        channel: "email",
        purpose: "transactional",
        consent: null,
        now: NOW,
      }),
    ).toEqual({ allowed: true, reason: "transactional_necessity" });

    expect(
      isCommunicationAllowed({
        channel: "whatsapp",
        purpose: "transactional",
        consent: null,
        now: NOW,
      }),
    ).toEqual({ allowed: false, reason: "consent_required" });

    expect(
      isCommunicationAllowed({
        channel: "whatsapp",
        purpose: "transactional",
        consent: { status: "granted", expiresAt: "2027-01-01T00:00:00.000Z" },
        now: NOW,
      }),
    ).toEqual({ allowed: true, reason: "consent_granted" });
  });

  it.each(["email", "whatsapp", "in_app"])(
    "requires explicit marketing opt-in for %s",
    (channel) => {
      expect(
        isCommunicationAllowed({
          channel,
          purpose: "marketing",
          consent: { status: "unknown" },
          now: NOW,
        }),
      ).toEqual({ allowed: false, reason: "marketing_opt_in_required" });

      expect(
        isCommunicationAllowed({
          channel,
          purpose: "marketing",
          consent: { status: "granted" },
          now: NOW,
        }),
      ).toEqual({ allowed: true, reason: "consent_granted" });
    },
  );
});
