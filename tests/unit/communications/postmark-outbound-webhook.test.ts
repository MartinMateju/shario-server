import { beforeEach, describe, expect, it, vi } from "vitest";

import { isValidPostmarkWebhookAuthorization } from "@/modules/communications/postmark-outbound-webhook.auth.js";
import { postmarkOutboundWebhookPayloadSchema } from "@/modules/communications/postmark-outbound-webhook.validators.js";
import {
  processPostmarkOutboundWebhook,
  type PostmarkOutboundWebhookDependencies,
} from "@/modules/communications/services/postmark-outbound-webhook.core.js";

const basic = (username: string, password: string) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

const deliveryEvent = {
  RecordType: "Delivery" as const,
  MessageID: "883953f4-6105-42a2-a16a-77a8eac79483",
  Recipient: "ada@example.com",
  DeliveredAt: "2026-08-10T13:28:10.273Z",
  Details: "250 accepted",
  ServerID: 23,
  Metadata: { tenantId: "attacker-controlled" },
  MessageStream: "outbound",
};

const bounceEvent = {
  RecordType: "Bounce" as const,
  MessageID: deliveryEvent.MessageID,
  MessageStream: "outbound",
  ID: 42,
  Type: "HardBounce",
  TypeCode: 1,
  ServerID: 23,
  Description: "Mailbox does not exist.",
  Email: "ada@example.com",
  BouncedAt: "2026-08-10T13:29:10.273Z",
};

const reference = {
  id: "delivery-1",
  tenantId: "trusted-tenant",
  recipientEmail: "ada@example.com",
};

const dependencies = (): PostmarkOutboundWebhookDependencies => ({
  findDelivery: vi.fn().mockResolvedValue(reference),
  findAutomationLog: vi.fn().mockResolvedValue(null),
  findManagedTest: vi.fn().mockResolvedValue(null),
  findOrderReceipt: vi.fn().mockResolvedValue(null),
  isTenantServer: vi.fn().mockResolvedValue(true),
  transitionDelivery: vi.fn().mockResolvedValue(true),
  transitionAutomationLog: vi.fn().mockResolvedValue(true),
  transitionManagedTest: vi.fn().mockResolvedValue(true),
  transitionOrderReceipt: vi.fn().mockResolvedValue(true),
  upsertSuppression: vi.fn().mockResolvedValue(undefined),
});

describe("Postmark outbound webhook contract", () => {
  it("verifies the door-code recipient and tenant server before recording delivery", async () => {
    const deps = dependencies();
    deps.findDelivery = vi.fn().mockResolvedValue(null);
    deps.findDoorAccess = vi
      .fn()
      .mockResolvedValue({
        ...reference,
        claimId: "claim",
        providerStartedAt: new Date(),
        providerMessageId: deliveryEvent.MessageID,
      });
    deps.transitionDoorAccess = vi.fn().mockResolvedValue(true);
    expect(
      await processPostmarkOutboundWebhook(
        { ...deliveryEvent, Recipient: "other@example.com" },
        deps,
      ),
    ).toMatchObject({ matched: false, correlationMismatch: true });
    expect(deps.transitionDoorAccess).not.toHaveBeenCalled();
    deps.isTenantServer = vi.fn().mockResolvedValue(false);
    expect(
      await processPostmarkOutboundWebhook(deliveryEvent, deps),
    ).toMatchObject({ matched: false });
    deps.isTenantServer = vi.fn().mockResolvedValue(true);
    expect(
      await processPostmarkOutboundWebhook(deliveryEvent, deps),
    ).toMatchObject({ doorAccessMatched: true, doorAccessUpdated: true });
    expect(deps.transitionDoorAccess).toHaveBeenCalledOnce();
  });
  it("validates Basic Auth without accepting malformed credentials", () => {
    expect(
      isValidPostmarkWebhookAuthorization(
        basic("webhook-user", "a-strong-webhook-password"),
        "webhook-user",
        "a-strong-webhook-password",
      ),
    ).toBe(true);
    expect(
      isValidPostmarkWebhookAuthorization(
        basic("webhook-user", "wrong"),
        "webhook-user",
        "a-strong-webhook-password",
      ),
    ).toBe(false);
    expect(
      isValidPostmarkWebhookAuthorization(
        "Bearer token",
        "webhook-user",
        "a-strong-webhook-password",
      ),
    ).toBe(false);
  });

  it("accepts supported status payloads and rejects included email content", () => {
    expect(
      postmarkOutboundWebhookPayloadSchema.safeParse(deliveryEvent).success,
    ).toBe(true);
    expect(
      postmarkOutboundWebhookPayloadSchema.safeParse(bounceEvent).success,
    ).toBe(true);
    const additive = postmarkOutboundWebhookPayloadSchema.safeParse({
      ...deliveryEvent,
      ProviderVersion: "2026-08",
    });
    expect(additive.success).toBe(true);
    if (additive.success) {
      expect(additive.data).not.toHaveProperty("ProviderVersion");
    }
    expect(
      postmarkOutboundWebhookPayloadSchema.safeParse({
        ...bounceEvent,
        Content: "full message content must never be accepted",
      }).success,
    ).toBe(false);
  });

  it("uses persisted MessageID, recipient, ServerID and tenant data", async () => {
    const deps = dependencies();
    const result = await processPostmarkOutboundWebhook(deliveryEvent, deps);

    expect(result).toMatchObject({
      matched: true,
      deliveryUpdated: true,
      correlationMismatch: false,
    });
    expect(deps.findDelivery).toHaveBeenCalledWith(deliveryEvent.MessageID);
    expect(deps.isTenantServer).toHaveBeenCalledWith("trusted-tenant", 23);
    expect(deps.transitionDelivery).toHaveBeenCalledWith(
      reference,
      expect.objectContaining({ status: "delivered" }),
    );
  });

  it("suppresses only the persisted matching recipient on hard bounce", async () => {
    const deps = dependencies();
    const result = await processPostmarkOutboundWebhook(bounceEvent, deps);

    expect(result.suppressions).toBe(1);
    expect(deps.upsertSuppression).toHaveBeenCalledWith({
      tenantId: "trusted-tenant",
      identity: "ada@example.com",
      reason: "hard_bounce",
      providerEventId: "42",
    });
  });

  it("reconciles a managed sender test from its persisted MessageID", async () => {
    const deps = dependencies();
    const managedTest = {
      ...reference,
      id: "sender-1",
      providerMessageId: deliveryEvent.MessageID,
    };
    vi.mocked(deps.findDelivery).mockResolvedValue(null);
    vi.mocked(deps.findManagedTest).mockResolvedValue(managedTest);

    const result = await processPostmarkOutboundWebhook(deliveryEvent, deps);

    expect(result).toMatchObject({
      matched: true,
      providerMessageMatched: true,
      managedTestMatched: true,
      managedTestUpdated: true,
      correlationMismatch: false,
    });
    expect(deps.findManagedTest).toHaveBeenCalledWith(deliveryEvent.MessageID);
    expect(deps.transitionManagedTest).toHaveBeenCalledWith(
      managedTest,
      expect.objectContaining({ status: "delivered" }),
    );
  });

  it("does not suppress a soft bounce", async () => {
    const deps = dependencies();
    await processPostmarkOutboundWebhook(
      { ...bounceEvent, Type: "SoftBounce", TypeCode: 2 },
      deps,
    );
    expect(deps.upsertSuppression).not.toHaveBeenCalled();
  });

  it("settles a correlated order receipt through the same recipient and server checks", async () => {
    const deps = dependencies();
    const receipt = {
      ...reference,
      id: "order-1",
      claimId: "receipt-claim",
      providerStartedAt: new Date("2026-08-10T13:28:00Z"),
      providerMessageId: deliveryEvent.MessageID,
    };
    vi.mocked(deps.findDelivery).mockResolvedValue(null);
    vi.mocked(deps.findOrderReceipt).mockResolvedValue(receipt);

    const result = await processPostmarkOutboundWebhook(deliveryEvent, deps);

    expect(result).toMatchObject({
      matched: true,
      orderReceiptMatched: true,
      orderReceiptUpdated: true,
      correlationMismatch: false,
    });
    expect(deps.findOrderReceipt).toHaveBeenCalledWith(deliveryEvent);
    expect(deps.isTenantServer).toHaveBeenCalledWith("trusted-tenant", 23);
    expect(deps.transitionOrderReceipt).toHaveBeenCalledWith(
      receipt,
      expect.objectContaining({ status: "delivered" }),
    );
  });

  it.each([
    ["recipient", "other@example.com", true],
    ["server", "ada@example.com", false],
  ])(
    "rejects an order receipt %s mismatch without updating or suppressing",
    async (_kind, email, serverMatches) => {
      const deps = dependencies();
      vi.mocked(deps.findDelivery).mockResolvedValue(null);
      vi.mocked(deps.findOrderReceipt).mockResolvedValue({
        ...reference,
        recipientEmail: email as string,
        claimId: "receipt-claim",
        providerStartedAt: new Date("2026-08-10T13:28:00Z"),
        providerMessageId: bounceEvent.MessageID,
      });
      vi.mocked(deps.isTenantServer).mockResolvedValue(
        serverMatches as boolean,
      );

      const result = await processPostmarkOutboundWebhook(bounceEvent, deps);

      expect(result).toMatchObject({
        matched: false,
        correlationMismatch: true,
      });
      expect(deps.transitionOrderReceipt).not.toHaveBeenCalled();
      expect(deps.upsertSuppression).not.toHaveBeenCalled();
    },
  );

  it("suppresses an order receipt hard bounce only once alongside another matching email record", async () => {
    const deps = dependencies();
    vi.mocked(deps.findOrderReceipt).mockResolvedValue({
      ...reference,
      claimId: "receipt-claim",
      providerStartedAt: new Date("2026-08-10T13:28:00Z"),
      providerMessageId: bounceEvent.MessageID,
    });

    const result = await processPostmarkOutboundWebhook(bounceEvent, deps);

    expect(result.orderReceiptUpdated).toBe(true);
    expect(result.suppressions).toBe(1);
    expect(deps.upsertSuppression).toHaveBeenCalledExactlyOnceWith({
      tenantId: "trusted-tenant",
      identity: "ada@example.com",
      reason: "hard_bounce",
      providerEventId: "42",
    });
  });

  it.each([
    ["recipient", { ...reference, recipientEmail: "other@example.com" }, true],
    ["server", reference, false],
  ])(
    "fails closed on a persisted %s mismatch",
    async (_kind, mismatchedReference, serverMatches) => {
      const deps = dependencies();
      vi.mocked(deps.findDelivery).mockResolvedValue(mismatchedReference);
      vi.mocked(deps.isTenantServer).mockResolvedValue(serverMatches);

      const result = await processPostmarkOutboundWebhook(deliveryEvent, deps);

      expect(result).toMatchObject({
        matched: false,
        providerMessageMatched: true,
        correlationMismatch: true,
      });
      expect(deps.transitionDelivery).not.toHaveBeenCalled();
      expect(deps.upsertSuppression).not.toHaveBeenCalled();
    },
  );
});
