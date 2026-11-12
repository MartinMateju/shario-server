import { AccessCodeNotification } from "@/modules/access-codes/access-code.model.js";
import type { PostmarkOutboundWebhookPayload } from "../postmark-outbound-webhook.validators.js";
import type {
  PostmarkOutboundOrderReceiptReference,
  PostmarkOutboundTransition,
} from "./postmark-outbound-webhook.core.js";

export async function findDoorAccessForPostmarkEvent(
  event: PostmarkOutboundWebhookPayload,
): Promise<PostmarkOutboundOrderReceiptReference | null> {
  const started = {
    provider: "postmark" as const,
    providerAttemptStartedAt: { $type: "date" as const },
    recipientEmail: { $ne: "" },
  };
  let record = await AccessCodeNotification.findOne({
    ...started,
    providerMessageId: event.MessageID,
  })
    .lean()
    .exec();
  const { tenantId, accessCodeBookingId, deliveryId } = event.Metadata || {};
  const validMetadata =
    /^[a-f\d]{24}$/i.test(tenantId || "") &&
    /^[a-f\d]{24}$/i.test(accessCodeBookingId || "") &&
    deliveryId &&
    deliveryId.length <= 120;
  if (!record && validMetadata) {
    record = await AccessCodeNotification.findOne({
      ...started,
      tenant: tenantId,
      booking: accessCodeBookingId,
      claimToken: deliveryId,
      providerMessageId: { $in: ["", null] },
    })
      .lean()
      .exec();
  }
  if (record) {
    return {
      id: record._id,
      tenantId: record.tenant,
      recipientEmail: record.recipientEmail,
      claimId: record.claimToken,
      providerStartedAt: record.providerAttemptStartedAt!,
      providerMessageId: event.MessageID,
    };
  }

  // A reschedule moves the accepted delivery into history. Keep both message-ID
  // and early-webhook metadata correlation, with every field in the same entry.
  let archived = await AccessCodeNotification.findOne({
    deliveryHistory: {
      $elemMatch: { ...started, providerMessageId: event.MessageID },
    },
  })
    .lean()
    .exec();
  let historical = archived?.deliveryHistory.find(
    (entry) =>
      entry.provider === "postmark" &&
      entry.providerAttemptStartedAt &&
      entry.recipientEmail &&
      entry.providerMessageId === event.MessageID,
  );
  if (!historical && validMetadata) {
    archived = await AccessCodeNotification.findOne({
      tenant: tenantId,
      booking: accessCodeBookingId,
      deliveryHistory: {
        $elemMatch: {
          ...started,
          claimToken: deliveryId,
          providerMessageId: { $in: ["", null] },
        },
      },
    })
      .lean()
      .exec();
    historical = archived?.deliveryHistory.find(
      (entry) =>
        entry.provider === "postmark" &&
        entry.providerAttemptStartedAt &&
        entry.recipientEmail &&
        entry.claimToken === deliveryId &&
        !entry.providerMessageId,
    );
  }
  return archived && historical
    ? {
        id: archived._id,
        tenantId: archived.tenant,
        recipientEmail: historical.recipientEmail,
        claimId: historical.claimToken,
        providerStartedAt: historical.providerAttemptStartedAt!,
        providerMessageId: event.MessageID,
      }
    : null;
}

export async function transitionDoorAccessFromPostmark(
  reference: PostmarkOutboundOrderReceiptReference,
  transition: PostmarkOutboundTransition,
): Promise<boolean> {
  const statusFilter =
    transition.status === "delivered"
      ? { $nin: ["delivered", "bounced", "complained"] as const }
      : { $ne: "complained" as const };
  const result = await AccessCodeNotification.updateOne(
    {
      _id: reference.id,
      tenant: reference.tenantId,
      provider: "postmark",
      claimToken: reference.claimId,
      providerAttemptStartedAt: reference.providerStartedAt,
      recipientEmail: reference.recipientEmail,
      providerMessageId: { $in: ["", reference.providerMessageId] },
      providerDeliveryStatus: statusFilter,
      providerEventKey: { $ne: transition.eventKey },
    },
    {
      $set: {
        providerMessageId: reference.providerMessageId,
        providerDeliveryStatus: transition.status,
        providerStatusAt: transition.at,
        providerEventKey: transition.eventKey,
      },
    },
  ).exec();
  if (result.modifiedCount > 0) return true;
  // Also handles a reschedule committing between webhook lookup and transition.
  const historicalResult = await AccessCodeNotification.updateOne(
    {
      _id: reference.id,
      tenant: reference.tenantId,
      deliveryHistory: {
        $elemMatch: {
          provider: "postmark",
          claimToken: reference.claimId,
          providerAttemptStartedAt: reference.providerStartedAt,
          recipientEmail: reference.recipientEmail,
          providerMessageId: { $in: ["", reference.providerMessageId] },
          providerDeliveryStatus: statusFilter,
          providerEventKey: { $ne: transition.eventKey },
        },
      },
    },
    {
      $set: {
        "deliveryHistory.$.providerMessageId": reference.providerMessageId,
        "deliveryHistory.$.providerDeliveryStatus": transition.status,
        "deliveryHistory.$.providerStatusAt": transition.at,
        "deliveryHistory.$.providerEventKey": transition.eventKey,
      },
    },
  ).exec();
  return historicalResult.modifiedCount > 0;
}
