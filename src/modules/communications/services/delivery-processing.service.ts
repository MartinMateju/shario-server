import { randomUUID } from "node:crypto";
import mongoose from "mongoose";

import {
  COMMUNICATION_CHANNEL,
  DELIVERY_STATUS,
  type CommunicationChannel,
} from "../communications.constants.js";
import {
  CommunicationConsentModel,
  CommunicationConversationModel,
  CommunicationDeliveryModel,
  CommunicationMessageModel,
  CommunicationSettingsModel,
  CommunicationSuppressionModel,
} from "../communications.models.js";
import { isWithinQuietHours } from "./business-hours.service.js";
import { isCommunicationAllowed } from "./consent.service.js";
import {
  buildDeliveryIdempotencyKey,
  getDeliveryRetryDecision,
  selectFallbackChannel,
} from "./delivery.service.js";
import { recordCommunicationAudit } from "./audit.service.js";
import { sendThroughCommunicationProvider } from "./provider.service.js";

const resolveLeanQuery = async <T = any>(query: any): Promise<T> =>
  typeof query?.lean === "function" ? query.lean() : await query;

const deliveryClaimLeaseMs = () =>
  Math.max(
    60_000,
    Number(process.env.COMMUNICATION_DELIVERY_CLAIM_LEASE_MS || 5 * 60_000),
  );

const recipientIdentity = (
  channel: string,
  recipients: any[],
  contact?: any,
) => {
  const merged = [...(recipients ?? []), ...(contact ? [contact] : [])];
  if (channel === "email")
    return merged.find((item) => item?.email)?.email || "";
  if (channel === "whatsapp")
    return (
      merged.find((item) => item?.whatsappId || item?.phone)?.whatsappId ||
      merged.find((item) => item?.phone)?.phone ||
      ""
    );
  if (channel === "instagram")
    return (
      merged.find((item) => item?.instagramScopedId)?.instagramScopedId || ""
    );
  return "";
};

const providerRecipients = (
  channel: string,
  recipients: any[],
  contact: any,
) => {
  if (channel === COMMUNICATION_CHANNEL.INSTAGRAM) {
    return [
      {
        name: contact?.name || "",
        instagramScopedId: contact?.instagramScopedId || "",
        instagramUsername: contact?.instagramUsername || "",
        externalId: contact?.instagramScopedId || "",
      },
    ];
  }
  if (recipientIdentity(channel, recipients)) return recipients;
  if (channel === COMMUNICATION_CHANNEL.EMAIL) {
    return [{ name: contact?.name || "", email: contact?.email || "" }];
  }
  if (channel === COMMUNICATION_CHANNEL.WHATSAPP) {
    return [
      {
        name: contact?.name || "",
        phone: contact?.phone || "",
        whatsappId: contact?.whatsappId || contact?.phone || "",
      },
    ];
  }
  return [{ name: contact?.name || "", externalId: contact?.externalId || "" }];
};

const getConsent = async (delivery: any, conversation: any) => {
  if (!conversation.customerId) return null;
  return CommunicationConsentModel.findOne({
    tenantId: delivery.tenantId,
    customerId: conversation.customerId,
    channel: delivery.channel,
    purpose: delivery.purpose,
  }).lean();
};

const getReplyContext = async (
  tenantId: unknown,
  conversationId: unknown,
  channel: string,
) => {
  const filter: Record<string, unknown> = {
    tenantId,
    conversationId,
    direction: "incoming",
    channel,
    deletedAt: null,
  };
  if (
    [COMMUNICATION_CHANNEL.WHATSAPP, COMMUNICATION_CHANNEL.INSTAGRAM].includes(
      channel as never,
    )
  ) {
    const occurredAtField =
      channel === COMMUNICATION_CHANNEL.INSTAGRAM
        ? "headers.providerOccurredAt"
        : "createdAt";
    filter[occurredAtField] = {
      $gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
    };
  }
  let query: any = CommunicationMessageModel.findOne(filter);
  if (typeof query?.select === "function") query = query.select("_id sender");
  const incoming = await resolveLeanQuery(query);
  return {
    customerInitiated: Boolean(incoming),
    serviceWindowOpen: [
      COMMUNICATION_CHANNEL.WHATSAPP,
      COMMUNICATION_CHANNEL.INSTAGRAM,
    ].includes(channel as never)
      ? Boolean(incoming)
      : false,
    inboundInstagramScopedId: String(incoming?.sender?.instagramScopedId || ""),
  };
};

export const processCommunicationDelivery = async (
  deliveryId: unknown,
  { force = false }: { force?: boolean } = {},
) => {
  let delivery = await CommunicationDeliveryModel.findById(deliveryId);
  if (!delivery) return null;
  if (
    !force &&
    ![DELIVERY_STATUS.QUEUED, DELIVERY_STATUS.FAILED].includes(
      delivery.status as never,
    )
  )
    return delivery;
  if (
    !force &&
    delivery.nextAttemptAt &&
    delivery.nextAttemptAt.getTime() > Date.now()
  )
    return delivery;

  const now = new Date();
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + deliveryClaimLeaseMs());
  const claimed = await CommunicationDeliveryModel.findOneAndUpdate(
    {
      _id: delivery._id,
      tenantId: delivery.tenantId,
      status: { $in: [DELIVERY_STATUS.QUEUED, DELIVERY_STATUS.FAILED] },
      ...(!force
        ? {
            $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
          }
        : {}),
    },
    {
      $set: {
        status: DELIVERY_STATUS.SENDING,
        claimToken,
        leaseExpiresAt,
        providerAttemptStartedAt: null,
        manualReviewRequiredAt: null,
      },
    },
    { returnDocument: "after" },
  );
  if (claimed === null) {
    return CommunicationDeliveryModel.findOne({
      _id: deliveryId,
      tenantId: delivery.tenantId,
    });
  }
  if (claimed === undefined) {
    // Keeps isolated adapter tests usable; real Mongoose returns a document
    // or null. Production always owns an atomic claim before validation.
    delivery.status = DELIVERY_STATUS.SENDING;
    delivery.claimToken = claimToken;
    delivery.leaseExpiresAt = leaseExpiresAt;
    delivery.providerAttemptStartedAt = null;
    delivery.manualReviewRequiredAt = null;
    await delivery.save();
  } else {
    delivery = claimed;
  }

  const transitionClaim = async (
    status: string,
    fields: Record<string, unknown> = {},
  ) => {
    const transitioned = await CommunicationDeliveryModel.findOneAndUpdate(
      {
        _id: delivery._id,
        tenantId: delivery.tenantId,
        status: DELIVERY_STATUS.SENDING,
        claimToken,
      },
      {
        $set: {
          status,
          ...fields,
          claimToken: "",
          leaseExpiresAt: null,
          providerAttemptStartedAt: null,
        },
      },
      { returnDocument: "after" },
    );
    if (transitioned === null) {
      return CommunicationDeliveryModel.findOne({
        _id: deliveryId,
        tenantId: delivery.tenantId,
      });
    }
    if (transitioned === undefined) {
      Object.assign(delivery, fields, {
        status,
        claimToken: "",
        leaseExpiresAt: null,
        providerAttemptStartedAt: null,
      });
      await delivery.save();
      return delivery;
    }
    delivery = transitioned;
    return delivery;
  };

  const [messageValue, conversationValue, settings] = await Promise.all([
    resolveLeanQuery(
      CommunicationMessageModel.findOne({
        _id: delivery.messageId,
        tenantId: delivery.tenantId,
      }),
    ),
    resolveLeanQuery(
      CommunicationConversationModel.findOne({
        _id: delivery.conversationId,
        tenantId: delivery.tenantId,
      }),
    ),
    resolveLeanQuery(
      CommunicationSettingsModel.findOne({ tenantId: delivery.tenantId }),
    ),
  ]);
  const message =
    messageValue &&
    (!messageValue.tenantId ||
      String(messageValue.tenantId) === String(delivery.tenantId))
      ? messageValue
      : null;
  const conversation =
    conversationValue &&
    (!conversationValue.tenantId ||
      String(conversationValue.tenantId) === String(delivery.tenantId))
      ? conversationValue
      : null;
  if (!message || !conversation) {
    return transitionClaim(DELIVERY_STATUS.CANCELLED, {
      failure: {
        code: "SOURCE_MISSING",
        message: "Message or conversation no longer exists.",
        permanent: true,
      },
      nextAttemptAt: null,
    });
  }

  if (
    [COMMUNICATION_CHANNEL.WHATSAPP, COMMUNICATION_CHANNEL.INSTAGRAM].includes(
      delivery.channel,
    )
  ) {
    return transitionClaim(DELIVERY_STATUS.REJECTED, {
      failure: {
        code: "CHANNEL_RETIRED",
        message: `${delivery.channel} delivery is not available yet.`,
        permanent: true,
      },
      nextAttemptAt: null,
    });
  }

  if (
    delivery.channel === COMMUNICATION_CHANNEL.INSTAGRAM &&
    settings?.channels?.instagram?.enabled !== true
  ) {
    return transitionClaim(DELIVERY_STATUS.REJECTED, {
      failure: {
        code: "CHANNEL_DISABLED",
        message: "Instagram channel is disabled for this workspace.",
        permanent: true,
      },
      nextAttemptAt: null,
    });
  }

  const quiet = settings?.quietHours;
  const timezone = settings?.businessHours?.timezone || "UTC";
  if (
    !force &&
    isWithinQuietHours(now, quiet ?? { enabled: false }, timezone) &&
    !(quiet?.allowUrgent && conversation.priority === "urgent")
  ) {
    return transitionClaim(DELIVERY_STATUS.QUEUED, {
      nextAttemptAt: new Date(now.getTime() + 60 * 60 * 1000),
    });
  }

  const identity = recipientIdentity(
    delivery.channel,
    message.recipients as any[],
    conversation.contact,
  );
  const [suppression, consent, replyContext] = await Promise.all([
    identity
      ? CommunicationSuppressionModel.exists({
          tenantId: delivery.tenantId,
          channel: delivery.channel,
          identity: String(identity).trim().toLowerCase(),
          active: true,
        })
      : null,
    getConsent(delivery, conversation),
    getReplyContext(delivery.tenantId, conversation._id, delivery.channel),
  ]);
  if (delivery.channel === COMMUNICATION_CHANNEL.INSTAGRAM) {
    if (!replyContext.serviceWindowOpen) {
      return transitionClaim(DELIVERY_STATUS.REJECTED, {
        failure: {
          code: "INSTAGRAM_REPLY_WINDOW_CLOSED",
          message:
            "Instagram replies are allowed only within 24 hours of the customer's latest message.",
          permanent: true,
        },
        nextAttemptAt: null,
      });
    }
    const requestedRecipient = String(identity || "").trim();
    if (
      !requestedRecipient ||
      requestedRecipient !== replyContext.inboundInstagramScopedId
    ) {
      return transitionClaim(DELIVERY_STATUS.REJECTED, {
        failure: {
          code: "INSTAGRAM_RECIPIENT_MISMATCH",
          message:
            "Instagram replies must target the scoped identity from the inbound conversation.",
          permanent: true,
        },
        nextAttemptAt: null,
      });
    }
  }
  const allowed = isCommunicationAllowed({
    channel: delivery.channel,
    purpose: delivery.purpose,
    consent,
    customerInitiated: replyContext.customerInitiated,
    serviceWindowOpen: replyContext.serviceWindowOpen,
    suppressed: Boolean(suppression),
  });
  if (!allowed.allowed) {
    return transitionClaim(DELIVERY_STATUS.REJECTED, {
      failure: {
        code: "CONSENT_OR_SUPPRESSION",
        message: allowed.reason,
        permanent: true,
      },
      nextAttemptAt: null,
    });
  }

  if (
    delivery.channel === COMMUNICATION_CHANNEL.WHATSAPP &&
    !replyContext.serviceWindowOpen &&
    !message.whatsappTemplate?.name
  ) {
    return transitionClaim(DELIVERY_STATUS.REJECTED, {
      failure: {
        code: "TEMPLATE_REQUIRED",
        message:
          "An approved WhatsApp template is required outside the 24-hour customer-service window.",
        permanent: true,
      },
      nextAttemptAt: null,
    });
  }

  const providerAttemptAt = new Date();
  const providerAttempt = await CommunicationDeliveryModel.findOneAndUpdate(
    {
      _id: delivery._id,
      tenantId: delivery.tenantId,
      status: DELIVERY_STATUS.SENDING,
      claimToken,
      leaseExpiresAt: { $gt: providerAttemptAt },
      providerAttemptStartedAt: null,
    },
    {
      $set: {
        providerAttemptStartedAt: providerAttemptAt,
        lastAttemptAt: providerAttemptAt,
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: "after" },
  );
  if (providerAttempt === null) {
    return CommunicationDeliveryModel.findOne({
      _id: deliveryId,
      tenantId: delivery.tenantId,
    });
  }
  if (providerAttempt === undefined) {
    delivery.providerAttemptStartedAt = providerAttemptAt;
    delivery.lastAttemptAt = providerAttemptAt;
    delivery.attempts += 1;
    await delivery.save();
  } else {
    delivery = providerAttempt;
  }

  let result: Awaited<ReturnType<typeof sendThroughCommunicationProvider>>;
  try {
    result = await sendThroughCommunicationProvider({
      tenantId: String(delivery.tenantId),
      channel: delivery.channel as CommunicationChannel,
      deliveryId: String(delivery._id),
      messageId: String(message._id),
      to: providerRecipients(
        delivery.channel,
        message.recipients as any[],
        conversation.contact,
      ),
      subject: message.subject,
      text: message.text,
      html: message.html,
      attachments: message.attachments as any[],
      emailHeaders:
        delivery.channel === COMMUNICATION_CHANNEL.EMAIL
          ? {
              messageId: message.headers?.messageId,
              inReplyTo: message.headers?.inReplyTo,
              references: Array.isArray(message.headers?.references)
                ? message.headers.references
                : [],
            }
          : undefined,
      whatsappTemplate: message.whatsappTemplate?.name
        ? {
            name: message.whatsappTemplate.name,
            languageCode: message.whatsappTemplate.languageCode,
            components: message.whatsappTemplate.components || [],
          }
        : null,
      instagramReplyWindowOpen:
        delivery.channel === COMMUNICATION_CHANNEL.INSTAGRAM
          ? replyContext.serviceWindowOpen
          : undefined,
      idempotencyKey: delivery.idempotencyKey,
    });
  } catch (error: any) {
    const providerOutcomeKnownNotSent =
      error?.safeToRetry === true || error?.deliveryOutcome === "not_sent";
    const permanent = error?.permanent === true;
    const status = providerOutcomeKnownNotSent
      ? DELIVERY_STATUS.FAILED
      : DELIVERY_STATUS.AMBIGUOUS;
    const failure = providerOutcomeKnownNotSent
      ? {
          code: String(error?.code || "PROVIDER_ERROR").slice(0, 120),
          message: String(error?.message || "Delivery provider failed.").slice(
            0,
            2000,
          ),
          permanent,
        }
      : {
          code: "PROVIDER_OUTCOME_UNKNOWN",
          message:
            "The provider attempt may have been accepted. Reconcile it before manually retrying.",
          permanent: true,
        };
    const retry = providerOutcomeKnownNotSent
      ? getDeliveryRetryDecision({
          status,
          attempts: delivery.attempts,
          maxAttempts: delivery.maxAttempts,
          permanent,
          baseSeconds: settings?.delivery?.retryBaseSeconds || 60,
          now: providerAttemptAt,
        })
      : { retry: false, nextAttemptAt: null };
    const failed = await CommunicationDeliveryModel.findOneAndUpdate(
      {
        _id: delivery._id,
        tenantId: delivery.tenantId,
        status: DELIVERY_STATUS.SENDING,
        claimToken,
      },
      {
        $set: {
          status,
          failure,
          nextAttemptAt: retry.nextAttemptAt,
          leaseExpiresAt: null,
          ...(providerOutcomeKnownNotSent
            ? { claimToken: "", providerAttemptStartedAt: null }
            : { manualReviewRequiredAt: providerAttemptAt }),
        },
      },
      { returnDocument: "after" },
    );
    if (failed === undefined) {
      delivery.status = status;
      delivery.failure = failure;
      delivery.nextAttemptAt = retry.nextAttemptAt;
      delivery.leaseExpiresAt = null;
      if (providerOutcomeKnownNotSent) {
        delivery.claimToken = "";
        delivery.providerAttemptStartedAt = null;
      } else {
        delivery.manualReviewRequiredAt = providerAttemptAt;
      }
      await delivery.save();
    } else if (failed === null) {
      const current = await CommunicationDeliveryModel.findOne({
        _id: deliveryId,
        tenantId: delivery.tenantId,
      });
      if (current) delivery = current;
    } else if (failed) {
      delivery = failed;
    }
    await recordCommunicationAudit({
      tenantId: delivery.tenantId,
      actorType: "provider",
      action: "delivery_failed",
      resourceType: "delivery",
      resourceId: delivery._id,
      conversationId: delivery.conversationId,
      summary: failure.message,
      metadata: {
        code: failure.code,
        retry: retry.retry,
        manualReview: !providerOutcomeKnownNotSent,
      },
    });
    return delivery;
  }

  const finalized = await CommunicationDeliveryModel.findOneAndUpdate(
    {
      _id: delivery._id,
      tenantId: delivery.tenantId,
      status: DELIVERY_STATUS.SENDING,
      claimToken,
    },
    {
      $set: {
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        status: result.status,
        sentAt: providerAttemptAt,
        ...(result.status === DELIVERY_STATUS.DELIVERED
          ? { deliveredAt: providerAttemptAt }
          : {}),
        nextAttemptAt: null,
        failure: { code: "", message: "", permanent: false },
        claimToken: "",
        leaseExpiresAt: null,
      },
      $push: {
        eventHistory: {
          status: result.status,
          at: providerAttemptAt,
          payload: { provider: result.provider },
        },
      },
    },
    { returnDocument: "after" },
  );
  if (finalized === null) {
    return CommunicationDeliveryModel.findOne({
      _id: deliveryId,
      tenantId: delivery.tenantId,
    });
  }
  if (finalized === undefined) {
    delivery.provider = result.provider;
    delivery.providerMessageId = result.providerMessageId;
    delivery.status = result.status;
    delivery.sentAt = providerAttemptAt;
    if (result.status === DELIVERY_STATUS.DELIVERED)
      delivery.deliveredAt = providerAttemptAt;
    delivery.nextAttemptAt = null;
    delivery.failure = { code: "", message: "", permanent: false };
    delivery.claimToken = "";
    delivery.leaseExpiresAt = null;
    delivery.eventHistory.push({
      status: delivery.status,
      at: providerAttemptAt,
      payload: { provider: result.provider },
    } as never);
    await delivery.save();
  } else {
    delivery = finalized;
  }
  if (typeof (CommunicationMessageModel as any).updateOne === "function") {
    await CommunicationMessageModel.updateOne(
      {
        _id: delivery.messageId,
        tenantId: delivery.tenantId,
      },
      {
        $set: {
          provider: result.provider,
          providerMessageId: result.providerMessageId,
        },
      },
    );
  }
  return delivery;
};

export const retryCommunicationDelivery = async (
  tenantId: string,
  deliveryId: string,
  force = false,
) => {
  const delivery = await CommunicationDeliveryModel.findOne({
    _id: deliveryId,
    tenantId,
  });
  if (!delivery) return null;
  const retryableStatus = delivery.status === DELIVERY_STATUS.FAILED;
  const forceableStatus = [
    DELIVERY_STATUS.FAILED,
    DELIVERY_STATUS.AMBIGUOUS,
  ].includes(delivery.status as never);
  if ((force && !forceableStatus) || (!force && !retryableStatus)) {
    return {
      delivery,
      retry: { retry: false, nextAttemptAt: null },
    };
  }
  const retry = getDeliveryRetryDecision({
    status: delivery.status,
    attempts: force ? 0 : delivery.attempts,
    maxAttempts: delivery.maxAttempts,
    permanent: force ? false : delivery.failure?.permanent,
    baseSeconds: 5,
  });
  if (!force && !retry.retry) return { delivery, retry };
  const queued = await CommunicationDeliveryModel.findOneAndUpdate(
    { _id: deliveryId, tenantId, status: delivery.status },
    {
      $set: {
        status: DELIVERY_STATUS.QUEUED,
        nextAttemptAt: new Date(),
        claimToken: "",
        leaseExpiresAt: null,
        providerAttemptStartedAt: null,
        manualReviewRequiredAt: null,
        ...(force
          ? { failure: { code: "", message: "", permanent: false } }
          : {}),
      },
    },
    { returnDocument: "after" },
  );
  if (!queued) {
    return {
      delivery: await CommunicationDeliveryModel.findOne({
        _id: deliveryId,
        tenantId,
      }),
      retry: { retry: false, nextAttemptAt: null },
    };
  }
  const processed = await processCommunicationDelivery(queued._id, { force });
  return { delivery: processed, retry };
};

export const fallbackCommunicationDelivery = async ({
  tenantId,
  deliveryId,
  requestedChannel,
}: {
  tenantId: string;
  deliveryId: string;
  requestedChannel?: CommunicationChannel;
}) => {
  let delivery = await resolveLeanQuery<any>(
    CommunicationDeliveryModel.findOne({ _id: deliveryId, tenantId }),
  );
  if (!delivery) return null;
  if (delivery.status !== DELIVERY_STATUS.FAILED) return null;
  if (delivery.nextAttemptAt) return null;
  const [conversation, message, settings] = await Promise.all([
    resolveLeanQuery(
      CommunicationConversationModel.findOne({
        _id: delivery.conversationId,
        tenantId,
      }),
    ),
    resolveLeanQuery(
      CommunicationMessageModel.findOne({ _id: delivery.messageId, tenantId }),
    ),
    resolveLeanQuery(CommunicationSettingsModel.findOne({ tenantId })),
  ]);
  if (!conversation || !message) return null;
  const available: CommunicationChannel[] = [];
  if (
    recipientIdentity(
      "email",
      message.recipients as any[],
      conversation.contact,
    )
  )
    available.push(COMMUNICATION_CHANNEL.EMAIL);
  available.push(COMMUNICATION_CHANNEL.IN_APP);
  const channel =
    requestedChannel ||
    selectFallbackChannel({
      failedChannel: delivery.channel,
      order: settings?.delivery?.fallbackOrder || ["email", "in_app"],
      available,
      purpose: delivery.purpose,
      serviceWindows: {},
    });
  if (!channel || channel === delivery.channel || !available.includes(channel))
    return null;

  const idempotencyKey = buildDeliveryIdempotencyKey({
    tenantId,
    messageId: message._id,
    channel,
    purpose: delivery.purpose,
    generation: delivery.attempts + 1,
  });
  const session = await mongoose.startSession();
  let fallback: any = null;
  try {
    await session.withTransaction(async () => {
      const reservedSource = await CommunicationDeliveryModel.findOneAndUpdate(
        {
          _id: deliveryId,
          tenantId,
          status: DELIVERY_STATUS.FAILED,
          $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $exists: false } }],
        },
        {
          $set: {
            status: DELIVERY_STATUS.CANCELLED,
            nextAttemptAt: null,
            failure: {
              code: "FALLBACK_SELECTED",
              message:
                "A fallback delivery was durably selected for this failed channel.",
              permanent: true,
            },
          },
        },
        { session, returnDocument: "after" },
      );
      if (!reservedSource) return;
      fallback = await CommunicationDeliveryModel.findOneAndUpdate(
        { tenantId, idempotencyKey },
        {
          $setOnInsert: {
            tenantId,
            conversationId: conversation._id,
            messageId: message._id,
            channel,
            purpose: delivery.purpose,
            idempotencyKey,
            status: DELIVERY_STATUS.QUEUED,
            maxAttempts: settings?.delivery?.maxAttempts || 4,
            nextAttemptAt: new Date(),
            fallbackFromDeliveryId: delivery._id,
          },
        },
        { session, upsert: true, returnDocument: "after" },
      );
      if (!fallback)
        throw new Error("Fallback delivery could not be persisted.");
    });
  } finally {
    await session.endSession();
  }
  if (!fallback) return null;
  return processCommunicationDelivery(fallback._id);
};

export const recoverStaleCommunicationDeliveries = async ({
  now = new Date(),
  limit = Number(process.env.COMMUNICATION_DELIVERY_RECOVERY_BATCH_SIZE || 200),
}: {
  now?: Date;
  limit?: number;
} = {}) => {
  const boundedLimit = Math.min(Math.max(limit, 1), 1_000);
  const legacyCutoff = new Date(now.getTime() - deliveryClaimLeaseMs());
  const stale = await CommunicationDeliveryModel.find({
    status: DELIVERY_STATUS.SENDING,
    $or: [
      { leaseExpiresAt: { $lte: now } },
      {
        $and: [
          {
            $or: [
              { leaseExpiresAt: null },
              { leaseExpiresAt: { $exists: false } },
            ],
          },
          { lastAttemptAt: { $lte: legacyCutoff } },
        ],
      },
    ],
  })
    .sort({ lastAttemptAt: 1, _id: 1 })
    .limit(boundedLimit)
    .select(
      "_id claimToken leaseExpiresAt providerAttemptStartedAt lastAttemptAt",
    )
    .lean();
  if (!stale.length) return { requeued: 0, ambiguous: 0 };

  const safelyRequeueable = stale.filter(
    (delivery: any) =>
      Boolean(delivery.claimToken) &&
      delivery.leaseExpiresAt &&
      new Date(delivery.leaseExpiresAt).getTime() <= now.getTime() &&
      !delivery.providerAttemptStartedAt,
  );
  const safeIds = new Set(
    safelyRequeueable.map((delivery: any) => String(delivery._id)),
  );
  const ambiguous = stale.filter(
    (delivery: any) => !safeIds.has(String(delivery._id)),
  );

  let requeuedCount = 0;
  if (safelyRequeueable.length) {
    const result = await CommunicationDeliveryModel.updateMany(
      {
        _id: { $in: safelyRequeueable.map((delivery: any) => delivery._id) },
        status: DELIVERY_STATUS.SENDING,
        claimToken: { $type: "string", $gt: "" },
        leaseExpiresAt: { $lte: now },
        providerAttemptStartedAt: null,
      },
      {
        $set: {
          status: DELIVERY_STATUS.QUEUED,
          nextAttemptAt: now,
          claimToken: "",
          leaseExpiresAt: null,
          failure: {
            code: "CLAIM_EXPIRED_BEFORE_PROVIDER",
            message:
              "Delivery claim expired before the provider attempt; safely requeued.",
            permanent: false,
          },
        },
      },
    );
    requeuedCount = result.modifiedCount;
  }

  let ambiguousCount = 0;
  if (ambiguous.length) {
    const result = await CommunicationDeliveryModel.updateMany(
      {
        _id: { $in: ambiguous.map((delivery: any) => delivery._id) },
        status: DELIVERY_STATUS.SENDING,
        $or: [
          { leaseExpiresAt: { $lte: now } },
          {
            $and: [
              {
                $or: [
                  { leaseExpiresAt: null },
                  { leaseExpiresAt: { $exists: false } },
                ],
              },
              { lastAttemptAt: { $lte: legacyCutoff } },
            ],
          },
        ],
      },
      {
        $set: {
          status: DELIVERY_STATUS.AMBIGUOUS,
          nextAttemptAt: null,
          leaseExpiresAt: null,
          manualReviewRequiredAt: now,
          failure: {
            code: "PROVIDER_OUTCOME_UNKNOWN",
            message:
              "The worker lease expired after the provider attempt may have started. Reconcile before manually retrying.",
            permanent: true,
          },
        },
      },
    );
    ambiguousCount = result.modifiedCount;
  }
  return { requeued: requeuedCount, ambiguous: ambiguousCount };
};

export const processPendingCommunicationDeliveries = async (
  limit = Number(process.env.COMMUNICATION_DELIVERY_BATCH_SIZE || 50),
) => {
  await recoverStaleCommunicationDeliveries({ limit });
  const pending = await CommunicationDeliveryModel.find({
    status: { $in: [DELIVERY_STATUS.QUEUED, DELIVERY_STATUS.FAILED] },
    nextAttemptAt: { $lte: new Date() },
  })
    .sort({ nextAttemptAt: 1 })
    .limit(Math.min(Math.max(limit, 1), 200))
    .select("_id")
    .lean();
  const results = [];
  for (const delivery of pending) {
    results.push(await processCommunicationDelivery(delivery._id));
  }
  return results;
};
