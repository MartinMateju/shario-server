import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliveryFindOne: vi.fn(),
  deliveryUpdateOne: vi.fn(),
  messageFindOne: vi.fn(),
  suppressionUpdateOne: vi.fn(),
  automationFindOne: vi.fn(),
  automationUpdateOne: vi.fn(),
  senderFindOne: vi.fn(),
  senderExists: vi.fn(),
  senderUpdateOne: vi.fn(),
  orderFindOne: vi.fn(),
}));

vi.mock("@/modules/order/order.model.js", () => ({
  Order: { findOne: mocks.orderFindOne },
}));

vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationDeliveryModel: {
    findOne: mocks.deliveryFindOne,
    updateOne: mocks.deliveryUpdateOne,
  },
  CommunicationMessageModel: { findOne: mocks.messageFindOne },
  CommunicationSuppressionModel: {
    updateOne: mocks.suppressionUpdateOne,
  },
}));

vi.mock(
  "@/modules/communication-email-logs/communication-email-log.model.js",
  () => ({
    CommunicationEmailLogModel: {
      findOne: mocks.automationFindOne,
      updateOne: mocks.automationUpdateOne,
    },
  }),
);

vi.mock(
  "@/modules/registered-sender-email/registered-sender-email.model.js",
  () => ({
    RegisteredSenderEmailModel: {
      findOne: mocks.senderFindOne,
      exists: mocks.senderExists,
      updateOne: mocks.senderUpdateOne,
    },
  }),
);

import {
  isManagedPostmarkProvisioningAttemptActive,
  processPostmarkOutboundWebhook,
} from "@/modules/communications/services/postmark-outbound-webhook.service.js";

const selectedLeanQuery = (value: unknown) => ({
  select: vi.fn(() => ({
    lean: vi.fn(() => ({ exec: vi.fn().mockResolvedValue(value) })),
  })),
});

const deliveryEvent = {
  RecordType: "Delivery" as const,
  MessageID: "883953f4-6105-42a2-a16a-77a8eac79483",
  Recipient: "ada@example.com",
  DeliveredAt: "2026-08-10T13:28:10.273Z",
  Details: "250 accepted",
  ServerID: 23,
  MessageStream: "outbound",
};
const provisioningAttemptId = "a634445f-0875-4df0-ab82-8f184301f951";

describe("Postmark managed-test webhook persistence adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deliveryFindOne.mockReturnValue(selectedLeanQuery(null));
    mocks.orderFindOne.mockReturnValue(selectedLeanQuery(null));
    mocks.automationFindOne.mockReturnValue(selectedLeanQuery(null));
    mocks.senderFindOne.mockReturnValue(
      selectedLeanQuery({
        _id: "sender-1",
        tenant: "tenant-1",
        providerServerId: 23,
        lastTestProviderMessageId: deliveryEvent.MessageID,
        lastTestRecipientEmail: "ada@example.com",
        managedTestCorrelations: [
          {
            providerMessageId: deliveryEvent.MessageID,
            recipientEmail: "ada@example.com",
            status: "accepted",
          },
        ],
      }),
    );
    mocks.senderExists.mockReturnValue({
      exec: vi.fn().mockResolvedValue({ _id: "sender-1" }),
    });
    mocks.senderUpdateOne.mockImplementation(() => ({
      exec: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    }));
  });

  it("matches hidden persisted correlation fields and updates only the current latest test", async () => {
    const result = await processPostmarkOutboundWebhook(deliveryEvent);

    expect(result).toMatchObject({
      matched: true,
      managedTestMatched: true,
      managedTestUpdated: true,
      correlationMismatch: false,
    });
    expect(mocks.senderFindOne).toHaveBeenCalledWith({
      provider: "postmark_managed",
      "managedTestCorrelations.providerMessageId": deliveryEvent.MessageID,
    });
    expect(mocks.senderExists).toHaveBeenCalledWith({
      tenant: "tenant-1",
      provider: "postmark_managed",
      providerServerId: 23,
    });
    expect(mocks.senderUpdateOne).toHaveBeenCalledTimes(2);
    expect(mocks.senderUpdateOne.mock.calls[0][0]).toMatchObject({
      _id: "sender-1",
      tenant: "tenant-1",
      provider: "postmark_managed",
      managedTestCorrelations: {
        $elemMatch: {
          providerMessageId: deliveryEvent.MessageID,
          status: { $in: ["accepted"] },
        },
      },
    });
    expect(mocks.senderUpdateOne.mock.calls[1][0]).toMatchObject({
      _id: "sender-1",
      tenant: "tenant-1",
      provider: "postmark_managed",
      lastTestProviderMessageId: deliveryEvent.MessageID,
      lastTestStatus: "pending",
    });
    expect(mocks.senderUpdateOne.mock.calls[1][1]).toMatchObject({
      $set: { lastTestStatus: "success", lastTestError: "" },
    });
  });

  it("fails closed without mutation when the persisted test recipient differs", async () => {
    mocks.senderFindOne.mockReturnValue(
      selectedLeanQuery({
        _id: "sender-1",
        tenant: "tenant-1",
        providerServerId: 23,
        managedTestCorrelations: [
          {
            providerMessageId: deliveryEvent.MessageID,
            recipientEmail: "mallory@example.com",
            status: "accepted",
          },
        ],
      }),
    );

    const result = await processPostmarkOutboundWebhook(deliveryEvent);

    expect(result).toMatchObject({
      matched: false,
      providerMessageMatched: true,
      correlationMismatch: true,
    });
    expect(mocks.senderUpdateOne).not.toHaveBeenCalled();
  });
  it("requires the exact attempt on an active pending sender within a bounded time window", async () => {
    const now = new Date("2026-08-10T12:00:00.000Z");

    await expect(
      isManagedPostmarkProvisioningAttemptActive(provisioningAttemptId, now),
    ).resolves.toBe(true);
    expect(mocks.senderExists).toHaveBeenCalledExactlyOnceWith({
      provider: "postmark_managed",
      providerServerId: { $gt: 0, $lte: Number.MAX_SAFE_INTEGER },
      providerProvisioningAttemptId: provisioningAttemptId,
      isActive: true,
      providerProvisioningStatus: "pending",
      providerProvisionedAt: null,
      providerProvisioningAttemptedAt: {
        $gte: new Date("2026-08-10T11:55:00.000Z"),
        $lte: now,
      },
    });
    expect(mocks.senderUpdateOne).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["non-UUID", "pending-server-23"],
    ["UUIDv1", "a634445f-0875-1df0-ab82-8f184301f951"],
    ["wrong UUID variant", "a634445f-0875-4df0-7b82-8f184301f951"],
    ["leading whitespace", ` ${provisioningAttemptId}`],
    ["trailing whitespace", `${provisioningAttemptId} `],
    ["trailing newline", `${provisioningAttemptId}\n`],
    [
      "multiple header values",
      `${provisioningAttemptId}, ${provisioningAttemptId}`,
    ],
    ["oversized", "a".repeat(1_000)],
  ])(
    "rejects a %s attempt token before any database query",
    async (_label, token) => {
      await expect(
        isManagedPostmarkProvisioningAttemptActive(token),
      ).resolves.toBe(false);

      expect(mocks.senderExists).not.toHaveBeenCalled();
      expect(mocks.senderUpdateOne).not.toHaveBeenCalled();
    },
  );

  it("rejects an unknown or expired attempt when no eligible sender exists", async () => {
    mocks.senderExists.mockReturnValue({
      exec: vi.fn().mockResolvedValue(null),
    });

    await expect(
      isManagedPostmarkProvisioningAttemptActive(provisioningAttemptId),
    ).resolves.toBe(false);

    expect(mocks.senderExists).toHaveBeenCalledOnce();
    expect(
      mocks.senderExists.mock.calls[0][0].providerProvisioningAttemptId,
    ).toBe(provisioningAttemptId);
    expect(mocks.senderUpdateOne).not.toHaveBeenCalled();
  });
});
vi.mock(
  "@/modules/communications/services/door-access-webhook.service.js",
  () => ({
    findDoorAccessForPostmarkEvent: vi.fn().mockResolvedValue(null),
    transitionDoorAccessFromPostmark: vi.fn(),
  }),
);
