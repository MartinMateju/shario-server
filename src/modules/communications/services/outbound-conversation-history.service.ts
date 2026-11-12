import mongoose from "mongoose";

import {
  COMMUNICATION_CHANNEL,
  MESSAGE_DIRECTION,
} from "../communications.constants.js";
import {
  CommunicationDeliveryModel,
  CommunicationMessageModel,
} from "../communications.models.js";

const asMongoId = (value: unknown): unknown =>
  mongoose.isValidObjectId(value)
    ? new mongoose.Types.ObjectId(String(value))
    : value;

const key = (value: unknown): string => String(value ?? "");

const deliverySummary = (delivery: any) =>
  delivery
    ? {
        id: key(delivery._id),
        status: delivery.status || null,
        provider: delivery.provider || null,
        sentAt: delivery.sentAt || null,
        deliveredAt: delivery.deliveredAt || null,
        updatedAt: delivery.updatedAt || null,
      }
    : null;

/**
 * Hydrate a page of outbound conversations with the latest outgoing email and
 * its latest delivery. Both reads are batched, so the history endpoint never
 * performs one query per conversation.
 */
export const hydrateOutboundConversationHistory = async ({
  tenantId,
  items,
}: {
  tenantId: string;
  items: any[];
}): Promise<any[]> => {
  if (!items.length) return [];

  const conversationIds = items.map((item) => item._id).filter(Boolean);
  const messages = await CommunicationMessageModel.aggregate([
    {
      $match: {
        tenantId: asMongoId(tenantId),
        conversationId: { $in: conversationIds },
        direction: MESSAGE_DIRECTION.OUTGOING,
        channel: COMMUNICATION_CHANNEL.EMAIL,
        deletedAt: null,
      },
    },
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $group: {
        _id: "$conversationId",
        message: { $first: "$$ROOT" },
      },
    },
    { $replaceRoot: { newRoot: "$message" } },
    {
      $project: {
        _id: 1,
        conversationId: 1,
        direction: 1,
        channel: 1,
        createdAt: 1,
      },
    },
  ]).exec();

  const latestMessageByConversation = new Map(
    messages.map((message: any) => [key(message.conversationId), message]),
  );
  const messageIds = messages.map((message: any) => message._id);
  let deliveries: any[] = [];
  if (messageIds.length) {
    deliveries = await CommunicationDeliveryModel.find({
      tenantId,
      messageId: { $in: messageIds },
      channel: COMMUNICATION_CHANNEL.EMAIL,
    })
      .select(
        "_id messageId status provider sentAt deliveredAt createdAt updatedAt",
      )
      .sort({ createdAt: -1, _id: -1 })
      .lean();
  }

  const latestDeliveryByMessage = new Map<string, any>();
  for (const delivery of deliveries) {
    const messageId = key(delivery.messageId);
    if (!latestDeliveryByMessage.has(messageId)) {
      latestDeliveryByMessage.set(messageId, delivery);
    }
  }

  return items.map((item) => {
    const message = latestMessageByConversation.get(key(item._id));
    const delivery = message
      ? latestDeliveryByMessage.get(key(message._id))
      : null;
    const summary = deliverySummary(delivery);
    return {
      ...item,
      lastMessageDirection: MESSAGE_DIRECTION.OUTGOING,
      deliveryStatus: summary?.status || null,
      lastMessage: {
        id: message ? key(message._id) : null,
        direction: MESSAGE_DIRECTION.OUTGOING,
        channel: message?.channel || COMMUNICATION_CHANNEL.EMAIL,
        createdAt: message?.createdAt || item.lastMessageAt || null,
        delivery: summary,
      },
    };
  });
};
