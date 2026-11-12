import { isPostmarkProvisioningAttemptId } from "@/infrastructure/email/postmark-webhook-provisioning.js";
import type { CommunicationEmailLogStatus } from "@/modules/communication-email-logs/communication-email-log.constants.js";
import { CommunicationEmailLogModel } from "@/modules/communication-email-logs/communication-email-log.model.js";
import { REGISTERED_SENDER_PROVIDER } from "@/modules/registered-sender-email/registered-sender-email.constants.js";
import { RegisteredSenderEmailModel } from "@/modules/registered-sender-email/registered-sender-email.model.js";
import {
  DELIVERY_STATUS,
  type DeliveryStatus,
} from "../communications.constants.js";
import {
  CommunicationDeliveryModel,
  CommunicationMessageModel,
  CommunicationSuppressionModel,
} from "../communications.models.js";
import type { PostmarkOutboundWebhookPayload } from "../postmark-outbound-webhook.validators.js";
import {
  findOrderReceiptForPostmarkEvent,
  transitionOrderReceiptFromPostmark,
} from "./order-receipt-webhook.service.js";
import {
  processPostmarkOutboundWebhook as processCore,
  type PostmarkOutboundManagedTestReference,
  type PostmarkOutboundReference,
  type PostmarkOutboundTransition,
  type PostmarkOutboundWebhookDependencies,
} from "./postmark-outbound-webhook.core.js";

const findDelivery = async (
  providerMessageId: string,
): Promise<PostmarkOutboundReference | null> => {
  const delivery = await CommunicationDeliveryModel.findOne({
    channel: "email",
    provider: "postmark",
    providerMessageId,
  })
    .select("_id tenantId messageId")
    .lean()
    .exec();
  if (!delivery) return null;
  const message = await CommunicationMessageModel.findOne({
    _id: delivery.messageId,
    tenantId: delivery.tenantId,
    channel: "email",
    direction: "outgoing",
  })
    .select("recipients.email")
    .lean()
    .exec();
  return {
    id: delivery._id,
    tenantId: delivery.tenantId,
    recipientEmail: String(message?.recipients?.[0]?.email || ""),
  };
};

const findAutomationLog = async (
  providerMessageId: string,
): Promise<PostmarkOutboundReference | null> => {
  const log = await CommunicationEmailLogModel.findOne({
    provider: "postmark",
    providerMessageId,
  })
    .select("_id tenant recipientEmail")
    .lean()
    .exec();
  return log
    ? {
        id: log._id,
        tenantId: log.tenant,
        recipientEmail: String(log.recipientEmail || ""),
      }
    : null;
};

const findManagedTest = async (
  providerMessageId: string,
): Promise<PostmarkOutboundManagedTestReference | null> => {
  const sender = await RegisteredSenderEmailModel.findOne({
    provider: REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED,
    "managedTestCorrelations.providerMessageId": providerMessageId,
  })
    .select(
      "_id tenant providerServerId +managedTestCorrelations +lastTestProviderMessageId +lastTestRecipientEmail",
    )
    .lean()
    .exec();
  if (!sender) return null;
  const correlations = Array.isArray(sender.managedTestCorrelations)
    ? sender.managedTestCorrelations
    : [];
  const correlation = correlations.find(
    (candidate) => candidate.providerMessageId === providerMessageId,
  );
  return correlation
    ? {
        id: sender._id,
        tenantId: sender.tenant,
        providerMessageId,
        recipientEmail: String(correlation.recipientEmail || ""),
      }
    : null;
};

const PROVISIONING_PROBE_WINDOW_MS = 5 * 60 * 1_000;

export const isManagedPostmarkProvisioningAttemptActive = async (
  attemptId: string | undefined,
  now = new Date(),
): Promise<boolean> => {
  if (!isPostmarkProvisioningAttemptId(attemptId)) return false;
  return Boolean(
    await RegisteredSenderEmailModel.exists({
      provider: REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED,
      providerServerId: { $gt: 0, $lte: Number.MAX_SAFE_INTEGER },
      providerProvisioningAttemptId: attemptId,
      isActive: true,
      providerProvisioningStatus: "pending",
      providerProvisionedAt: null,
      providerProvisioningAttemptedAt: {
        $gte: new Date(now.getTime() - PROVISIONING_PROBE_WINDOW_MS),
        $lte: now,
      },
    }).exec(),
  );
};

const isTenantServer = async (
  tenantId: unknown,
  serverId: number,
): Promise<boolean> =>
  Boolean(
    await RegisteredSenderEmailModel.exists({
      tenant: tenantId,
      provider: REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED,
      providerServerId: serverId,
    }).exec(),
  );

const deliveryStatusFilter = (transition: PostmarkOutboundTransition) => {
  if (transition.status === DELIVERY_STATUS.DELIVERED) {
    return {
      $in: [
        DELIVERY_STATUS.QUEUED,
        DELIVERY_STATUS.SENDING,
        DELIVERY_STATUS.AMBIGUOUS,
        DELIVERY_STATUS.SENT,
        DELIVERY_STATUS.FAILED,
      ],
    };
  }
  if (transition.status === DELIVERY_STATUS.BOUNCED) {
    return {
      $nin: [DELIVERY_STATUS.BOUNCED, DELIVERY_STATUS.COMPLAINED],
    };
  }
  return { $ne: DELIVERY_STATUS.COMPLAINED };
};

const transitionDelivery = async (
  reference: PostmarkOutboundReference,
  transition: PostmarkOutboundTransition,
): Promise<boolean> => {
  const result = await CommunicationDeliveryModel.updateOne(
    {
      _id: reference.id,
      tenantId: reference.tenantId,
      provider: "postmark",
      status: deliveryStatusFilter(transition),
      "eventHistory.payload.postmarkEventKey": { $ne: transition.eventKey },
    },
    {
      $set: {
        status: transition.status as DeliveryStatus,
        ...(transition.status === DELIVERY_STATUS.DELIVERED
          ? { deliveredAt: transition.at }
          : {}),
        failure:
          transition.status === DELIVERY_STATUS.DELIVERED
            ? { code: "", message: "", permanent: false }
            : {
                code: transition.code,
                message: transition.reason.slice(0, 2_000),
                permanent: transition.permanent,
              },
        nextAttemptAt: null,
      },
      $push: {
        eventHistory: {
          status: transition.status,
          at: transition.at,
          payload: {
            provider: "postmark",
            postmarkEventKey: transition.eventKey,
            providerEventId: transition.providerEventId,
          },
        },
      },
    },
  ).exec();
  return result.modifiedCount > 0;
};

const automationLogStatusFilter = (
  transition: PostmarkOutboundTransition,
):
  | { $nin: CommunicationEmailLogStatus[] }
  | { $ne: CommunicationEmailLogStatus } => {
  if (transition.status === "delivered") {
    return {
      $nin: ["delivered", "bounced", "complained", "suppressed"],
    };
  }
  if (transition.status === "bounced") {
    return { $nin: ["bounced", "complained"] };
  }
  return { $ne: "complained" };
};

const transitionAutomationLog = async (
  reference: PostmarkOutboundReference,
  transition: PostmarkOutboundTransition,
): Promise<boolean> => {
  const result = await CommunicationEmailLogModel.updateOne(
    {
      _id: reference.id,
      tenant: reference.tenantId,
      provider: "postmark",
      status: automationLogStatusFilter(transition),
      "providerLastEvent.key": { $ne: transition.eventKey },
    },
    {
      $set: {
        status: transition.status,
        providerLastEvent: {
          key: transition.eventKey,
          recordType: transition.status,
          at: transition.at,
          providerEventId: transition.providerEventId,
        },
        ...(transition.status === "delivered"
          ? { deliveredAt: transition.at, errorMessage: "" }
          : {
              failedAt: transition.at,
              ...(transition.status === "bounced"
                ? { bouncedAt: transition.at }
                : { complainedAt: transition.at }),
              errorMessage: transition.reason.slice(0, 3_000),
            }),
      },
    },
  ).exec();
  return result.modifiedCount > 0;
};

const managedTestStatusFilter = (transition: PostmarkOutboundTransition) => {
  if (transition.status === "delivered") return { $in: ["accepted"] };
  if (transition.status === "bounced") {
    return { $nin: ["bounced", "complained"] };
  }
  return { $ne: "complained" };
};

const transitionManagedTest = async (
  reference: PostmarkOutboundManagedTestReference,
  transition: PostmarkOutboundTransition,
): Promise<boolean> => {
  const eventError =
    transition.status === "delivered" ? "" : transition.reason.slice(0, 2_000);
  const correlationResult = await RegisteredSenderEmailModel.updateOne(
    {
      _id: reference.id,
      tenant: reference.tenantId,
      provider: REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED,
      managedTestCorrelations: {
        $elemMatch: {
          providerMessageId: reference.providerMessageId,
          eventKey: { $ne: transition.eventKey },
          status: managedTestStatusFilter(transition),
        },
      },
    },
    {
      $set: {
        "managedTestCorrelations.$[correlation].status": transition.status,
        "managedTestCorrelations.$[correlation].eventKey": transition.eventKey,
        "managedTestCorrelations.$[correlation].eventAt": transition.at,
        "managedTestCorrelations.$[correlation].error": eventError,
        "managedTestCorrelations.$[correlation].updatedAt": transition.at,
      },
    } as any,
    {
      arrayFilters: [
        {
          "correlation.providerMessageId": reference.providerMessageId,
          "correlation.eventKey": { $ne: transition.eventKey },
          "correlation.status": managedTestStatusFilter(transition),
        },
      ],
    },
  ).exec();

  // Only the newest test controls the public last-test state. Always attempt
  // this update so a webhook retry can repair a process interruption between
  // the correlation update above and this denormalized latest-state update.
  const latestResult = await RegisteredSenderEmailModel.updateOne(
    {
      _id: reference.id,
      tenant: reference.tenantId,
      provider: REGISTERED_SENDER_PROVIDER.POSTMARK_MANAGED,
      lastTestProviderMessageId: reference.providerMessageId,
      ...(transition.status === "delivered"
        ? { lastTestStatus: "pending" }
        : {}),
    },
    {
      $set: {
        lastTestStatus:
          transition.status === "delivered" ? "success" : "failed",
        lastTestedAt: transition.at,
        lastTestError: eventError,
      },
    },
  ).exec();

  return correlationResult.modifiedCount > 0 || latestResult.modifiedCount > 0;
};

const upsertSuppression: PostmarkOutboundWebhookDependencies["upsertSuppression"] =
  async ({ tenantId, identity, reason, providerEventId }) => {
    const filter = { tenantId, channel: "email", identity };
    const update = {
      $set: {
        reason,
        provider: "postmark",
        providerEventId: providerEventId.slice(0, 300),
        active: true,
      },
    };
    try {
      await CommunicationSuppressionModel.updateOne(filter, update, {
        upsert: true,
      }).exec();
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      await CommunicationSuppressionModel.updateOne(filter, update).exec();
    }
  };

import {
  findDoorAccessForPostmarkEvent,
  transitionDoorAccessFromPostmark,
} from "./door-access-webhook.service.js";

const dependencies: PostmarkOutboundWebhookDependencies = {
  findDoorAccess: findDoorAccessForPostmarkEvent,
  transitionDoorAccess: transitionDoorAccessFromPostmark,
  findDelivery,
  findAutomationLog,
  findManagedTest,
  findOrderReceipt: findOrderReceiptForPostmarkEvent,
  isTenantServer,
  transitionDelivery,
  transitionAutomationLog,
  transitionManagedTest,
  transitionOrderReceipt: transitionOrderReceiptFromPostmark,
  upsertSuppression,
};

export const processPostmarkOutboundWebhook = (
  event: PostmarkOutboundWebhookPayload,
) => processCore(event, dependencies);
