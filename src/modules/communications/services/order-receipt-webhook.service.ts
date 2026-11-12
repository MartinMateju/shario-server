import { Order } from "@/modules/order/order.model.js";
import { ORDER_CONFIRM_NOTIFICATION_TYPE } from "@/modules/order/order.constants.js";
import type { PostmarkOutboundWebhookPayload } from "../postmark-outbound-webhook.validators.js";
import type {
  PostmarkOutboundOrderReceiptReference,
  PostmarkOutboundTransition,
} from "./postmark-outbound-webhook.core.js";

const receiptStatuses = ["PROCESSING", "AMBIGUOUS", "SENT"];
const objectIdPattern = /^[a-f\d]{24}$/i;

type ReceiptEntry = {
  type: string;
  provider: string;
  providerMessageId?: string;
  providerStartedAt?: Date | null;
  claimId?: string;
  deliveryVersion?: number;
  status: string;
  to: string;
};

type ReceiptOrder = {
  _id: unknown;
  tenant: unknown;
  notificationLog: ReceiptEntry[];
};

const startedReceipt = {
  type: ORDER_CONFIRM_NOTIFICATION_TYPE,
  provider: "postmark",
  deliveryVersion: 1,
  status: { $in: receiptStatuses },
  providerStartedAt: { $type: "date" },
  claimId: { $type: "string", $ne: "" },
};

const isStartedReceipt = (entry: ReceiptEntry) =>
  entry.type === ORDER_CONFIRM_NOTIFICATION_TYPE &&
  entry.provider === "postmark" &&
  entry.deliveryVersion === 1 &&
  receiptStatuses.includes(entry.status) &&
  Boolean(entry.claimId) &&
  entry.providerStartedAt instanceof Date &&
  Number.isFinite(entry.providerStartedAt.getTime());

const referenceFor = (
  order: ReceiptOrder,
  entry: ReceiptEntry,
  providerMessageId: string,
): PostmarkOutboundOrderReceiptReference => ({
  id: order._id,
  tenantId: order.tenant,
  recipientEmail: entry.to,
  claimId: entry.claimId!,
  providerStartedAt: entry.providerStartedAt!,
  providerMessageId,
});

export const findOrderReceiptForPostmarkEvent = async (
  event: PostmarkOutboundWebhookPayload,
): Promise<PostmarkOutboundOrderReceiptReference | null> => {
  const knownOrder = await Order.findOne({
    notificationLog: {
      $elemMatch: { ...startedReceipt, providerMessageId: event.MessageID },
    },
  })
    .select("_id tenant notificationLog")
    .lean<ReceiptOrder>()
    .exec();
  const knownEntry = knownOrder?.notificationLog.find(
    (entry) =>
      isStartedReceipt(entry) && entry.providerMessageId === event.MessageID,
  );
  if (knownOrder && knownEntry) {
    return referenceFor(knownOrder, knownEntry, event.MessageID);
  }

  // A webhook may arrive before the accepted MessageID was persisted. Metadata
  // only locates the attempt; the caller still verifies its stored recipient
  // and tenant's Postmark Server before allowing any mutation.
  const { orderId, tenantId, deliveryId } = event.Metadata || {};
  if (
    !objectIdPattern.test(orderId || "") ||
    !objectIdPattern.test(tenantId || "") ||
    !deliveryId ||
    deliveryId.length > 300 ||
    deliveryId.trim() !== deliveryId
  ) {
    return null;
  }
  const order = await Order.findOne({
    _id: orderId,
    tenant: tenantId,
    notificationLog: {
      $elemMatch: {
        ...startedReceipt,
        claimId: deliveryId,
        providerMessageId: { $in: ["", null] },
      },
    },
  })
    .select("_id tenant notificationLog")
    .lean<ReceiptOrder>()
    .exec();
  const entry = order?.notificationLog.find(
    (candidate) =>
      isStartedReceipt(candidate) &&
      candidate.claimId === deliveryId &&
      !candidate.providerMessageId,
  );
  return order && entry ? referenceFor(order, entry, event.MessageID) : null;
};

export const transitionOrderReceiptFromPostmark = async (
  reference: PostmarkOutboundOrderReceiptReference,
  transition: PostmarkOutboundTransition,
): Promise<boolean> => {
  const providerStatusFilter =
    transition.status === "delivered"
      ? { $nin: ["delivered", "bounced", "complained"] }
      : transition.status === "bounced"
        ? { $nin: ["bounced", "complained"] }
        : { $ne: "complained" };
  const entryFilter = {
    ...startedReceipt,
    claimId: reference.claimId,
    providerStartedAt: reference.providerStartedAt,
    to: reference.recipientEmail,
    providerMessageId: { $in: ["", null, reference.providerMessageId] },
    providerDeliveryStatus: providerStatusFilter,
  };
  const result = await Order.updateOne(
    {
      _id: reference.id,
      tenant: reference.tenantId,
      notificationLog: { $elemMatch: entryFilter },
    },
    {
      $set: {
        // Delivery, bounce and complaint all prove provider acceptance. SENT
        // prevents another send; the separate provider status records outcome.
        "notificationLog.$[receipt].status": "SENT",
        "notificationLog.$[receipt].providerMessageId":
          reference.providerMessageId,
        "notificationLog.$[receipt].providerDeliveryStatus": transition.status,
        "notificationLog.$[receipt].providerStatusAt": transition.at,
        "notificationLog.$[receipt].error":
          transition.status === "delivered"
            ? ""
            : transition.reason.slice(0, 2000),
        ...(transition.status === "delivered"
          ? { "notificationLog.$[receipt].deliveredAt": transition.at }
          : {}),
      },
    },
    {
      arrayFilters: [
        Object.fromEntries(
          Object.entries(entryFilter).map(([key, value]) => [
            `receipt.${key}`,
            value,
          ]),
        ),
      ],
    },
  ).exec();
  return result.modifiedCount === 1;
};
