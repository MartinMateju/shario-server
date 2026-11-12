import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  aggregate: vi.fn(),
  deliveryFind: vi.fn(),
}));

vi.mock("@/modules/communications/communications.models.js", () => ({
  CommunicationMessageModel: { aggregate: mocks.aggregate },
  CommunicationDeliveryModel: { find: mocks.deliveryFind },
}));

import { hydrateOutboundConversationHistory } from "@/modules/communications/services/outbound-conversation-history.service.js";

const query = (value: unknown) => {
  const chain: Record<string, any> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.sort = vi.fn().mockReturnValue(chain);
  chain.lean = vi.fn().mockResolvedValue(value);
  return chain;
};

describe("outbound conversation history", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hydrates latest outgoing email delivery status with two batched reads", async () => {
    const tenantId = "507f1f77bcf86cd799439011";
    const conversationId = "507f191e810c19729de860ea";
    const messageId = "507f191e810c19729de860eb";
    const aggregate = {
      exec: vi.fn().mockResolvedValue([
        {
          _id: messageId,
          conversationId,
          direction: "outgoing",
          channel: "email",
          createdAt: new Date("2026-08-10T12:00:00.000Z"),
        },
      ]),
    };
    mocks.aggregate.mockReturnValue(aggregate);
    mocks.deliveryFind.mockReturnValue(
      query([
        {
          _id: "507f191e810c19729de860ec",
          messageId,
          status: "delivered",
          provider: "postmark",
          sentAt: new Date("2026-08-10T12:00:01.000Z"),
          deliveredAt: new Date("2026-08-10T12:00:03.000Z"),
          updatedAt: new Date("2026-08-10T12:00:03.000Z"),
        },
      ]),
    );

    const [row] = await hydrateOutboundConversationHistory({
      tenantId,
      items: [{ _id: conversationId, subject: "Reminder" }],
    });

    expect(mocks.aggregate).toHaveBeenCalledOnce();
    const pipeline = mocks.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toMatchObject({
      direction: "outgoing",
      channel: "email",
      deletedAt: null,
    });
    expect(mocks.deliveryFind).toHaveBeenCalledWith({
      tenantId,
      messageId: { $in: [messageId] },
      channel: "email",
    });
    expect(row).toMatchObject({
      lastMessageDirection: "outgoing",
      deliveryStatus: "delivered",
      lastMessage: {
        id: messageId,
        direction: "outgoing",
        channel: "email",
        delivery: {
          status: "delivered",
          provider: "postmark",
        },
      },
    });
  });

  it("does not query when the outbound page is empty", async () => {
    await expect(
      hydrateOutboundConversationHistory({ tenantId: "tenant-1", items: [] }),
    ).resolves.toEqual([]);
    expect(mocks.aggregate).not.toHaveBeenCalled();
    expect(mocks.deliveryFind).not.toHaveBeenCalled();
  });
});
