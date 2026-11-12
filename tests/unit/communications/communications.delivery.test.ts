import { describe, expect, it } from "vitest";

import {
  buildDeliveryIdempotencyKey,
  getDeliveryRetryDecision,
  selectFallbackChannel,
} from "@/modules/communications/services/delivery.service.js";

const NOW = new Date("2026-07-22T12:00:00.000Z");

describe("communications delivery safeguards", () => {
  it("builds a stable, opaque idempotency key for a logical delivery", () => {
    const input = {
      tenantId: "tenant-1",
      messageId: "message-1",
      channel: "email",
      purpose: "support",
    };
    const first = buildDeliveryIdempotencyKey(input);
    const retry = buildDeliveryIdempotencyKey(input);

    expect(first).toBe(retry);
    expect(first).toMatch(/^comm_[a-f0-9]{64}$/);
    expect(first).not.toContain("tenant-1");
    expect(first).not.toContain("message-1");
  });

  it("separates channel, purpose, tenant, and explicit fallback generations", () => {
    const base = {
      tenantId: "tenant-1",
      messageId: "message-1",
      channel: "email",
      purpose: "support",
    };

    const keys = [
      buildDeliveryIdempotencyKey(base),
      buildDeliveryIdempotencyKey({ ...base, tenantId: "tenant-2" }),
      buildDeliveryIdempotencyKey({ ...base, channel: "whatsapp" }),
      buildDeliveryIdempotencyKey({ ...base, purpose: "transactional" }),
      buildDeliveryIdempotencyKey({ ...base, generation: 1 }),
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("retries a transient failure with exponential backoff", () => {
    expect(
      getDeliveryRetryDecision({
        status: "failed",
        attempts: 1,
        maxAttempts: 4,
        baseSeconds: 60,
        now: NOW,
      }),
    ).toEqual({
      retry: true,
      nextAttemptAt: new Date("2026-07-22T12:01:00.000Z"),
      reason: "retry_scheduled",
    });

    expect(
      getDeliveryRetryDecision({
        status: "failed",
        attempts: 3,
        maxAttempts: 4,
        baseSeconds: 60,
        now: NOW,
      }).nextAttemptAt,
    ).toEqual(new Date("2026-07-22T12:04:00.000Z"));
  });

  it("bounds retry delays and never creates a tight retry loop", () => {
    expect(
      getDeliveryRetryDecision({
        status: "failed",
        attempts: 1,
        maxAttempts: 8,
        baseSeconds: 1,
        now: NOW,
      }).nextAttemptAt,
    ).toEqual(new Date("2026-07-22T12:00:05.000Z"));

    expect(
      getDeliveryRetryDecision({
        status: "failed",
        attempts: 7,
        maxAttempts: 8,
        baseSeconds: 86_400,
        now: NOW,
      }).nextAttemptAt,
    ).toEqual(new Date("2026-07-23T12:00:00.000Z"));
  });

  it("stops after the configured attempt limit", () => {
    expect(
      getDeliveryRetryDecision({
        status: "failed",
        attempts: 4,
        maxAttempts: 4,
        now: NOW,
      }),
    ).toEqual({
      retry: false,
      nextAttemptAt: null,
      reason: "attempt_limit_reached",
    });
  });

  it.each(["bounced", "rejected"])(
    "does not retry permanent %s delivery status",
    (status) => {
      expect(
        getDeliveryRetryDecision({
          status,
          attempts: 1,
          maxAttempts: 4,
          now: NOW,
        }),
      ).toEqual({
        retry: false,
        nextAttemptAt: null,
        reason: "permanent_failure",
      });
    },
  );

  it.each(["delivered", "read", "cancelled"])(
    "does not retry terminal %s delivery status",
    (status) => {
      expect(
        getDeliveryRetryDecision({
          status,
          attempts: 1,
          maxAttempts: 4,
          now: NOW,
        }),
      ).toEqual({
        retry: false,
        nextAttemptAt: null,
        reason: "terminal_status",
      });
    },
  );

  it("honors an explicit permanent provider failure regardless of status", () => {
    expect(
      getDeliveryRetryDecision({
        status: "failed",
        attempts: 1,
        maxAttempts: 4,
        permanent: true,
        now: NOW,
      }),
    ).toEqual({
      retry: false,
      nextAttemptAt: null,
      reason: "permanent_failure",
    });
  });

  it("selects the first available and consent-eligible fallback", () => {
    expect(
      selectFallbackChannel({
        failedChannel: "whatsapp",
        order: ["whatsapp", "email", "in_app"],
        available: ["email", "in_app"],
        purpose: "support",
      }),
    ).toBe("email");
  });

  it("does not bypass marketing consent during fallback", () => {
    expect(
      selectFallbackChannel({
        failedChannel: "whatsapp",
        order: ["email", "in_app"],
        available: ["email", "in_app"],
        purpose: "marketing",
        consents: {
          email: { status: "revoked" },
          in_app: { status: "unknown" },
        },
      }),
    ).toBeNull();

    expect(
      selectFallbackChannel({
        failedChannel: "whatsapp",
        order: ["email", "in_app"],
        available: ["email", "in_app"],
        purpose: "marketing",
        consents: {
          email: { status: "granted" },
        },
      }),
    ).toBe("email");
  });

  it("requires WhatsApp opt-in before transactional fallback", () => {
    expect(
      selectFallbackChannel({
        failedChannel: "email",
        order: ["whatsapp", "in_app"],
        available: ["whatsapp"],
        purpose: "transactional",
        consents: { whatsapp: { status: "unknown" } },
      }),
    ).toBeNull();

    expect(
      selectFallbackChannel({
        failedChannel: "email",
        order: ["whatsapp", "in_app"],
        available: ["whatsapp"],
        purpose: "transactional",
        consents: { whatsapp: { status: "granted" } },
      }),
    ).toBe("whatsapp");
  });
});
