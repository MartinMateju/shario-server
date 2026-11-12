import { createHash } from "node:crypto";

import LocationModel from "@/modules/location/location.model.js";
import UserModel from "@/modules/user/user.model.js";
import { uploadBufferToR2 } from "@/infrastructure/storage/r2.client.js";

import {
  AI_AUTO_APPLY_CONFIDENCE,
  AUDIT_ACTION,
  COMMUNICATION_CHANNEL,
  CONVERSATION_STATUS,
  DELIVERY_STATUS,
  MESSAGE_DIRECTION,
  type CommunicationChannel,
} from "../communications.constants.js";
import {
  CommunicationConversationModel,
  CommunicationDeliveryModel,
  CommunicationInboundEventModel,
  CommunicationMessageModel,
  CommunicationRoutingRuleModel,
  CommunicationSettingsModel,
  CommunicationSuppressionModel,
} from "../communications.models.js";
import type { InboundWebhookInput } from "../communications.validators.js";
import { analyzeCommunicationText, transcribeCommunicationAudio } from "./ai.service.js";
import { recordCommunicationAudit } from "./audit.service.js";
import { evaluateBusinessHours, shouldSendAbsenceReply } from "./business-hours.service.js";
import { rankCustomerMatches } from "./customer-matching.service.js";
import { buildDeliveryIdempotencyKey } from "./delivery.service.js";
import { getDeliveryRetryDecision } from "./delivery.service.js";
import { processCommunicationDelivery } from "./delivery-processing.service.js";
import {
  downloadInstagramMedia,
  downloadWhatsAppMedia,
} from "./provider.service.js";
import { toPrivateCommunicationR2Uri } from "./private-media.service.js";
import { routeConversation } from "./routing.service.js";

const normalizedPhone = (value: unknown) => String(value ?? "").replace(/[^0-9+]/g, "").replace(/^00/, "+");
const normalizedEmail = (value: unknown) => String(value ?? "").trim().toLowerCase();
const emailThreadReferences = (value: unknown): string[] => [
  ...new Set(
    (Array.isArray(value) ? value : [value]).flatMap((entry) =>
      (String(entry || "").replace(/[\r\n]/g, "").match(/<[^<>\s]+>/g) || [])
        .slice(0, 50),
    ),
  ),
];

const voiceFileExtension = (contentType: string) => {
  const normalized = contentType.toLowerCase().split(";")[0];
  if (normalized === "audio/mpeg") return "mp3";
  if (normalized === "audio/mp4" || normalized === "audio/x-m4a") return "m4a";
  if (normalized === "audio/wav" || normalized === "audio/x-wav") return "wav";
  if (normalized === "audio/webm") return "webm";
  if (normalized === "audio/aac") return "aac";
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/webp") return "webp";
  if (normalized === "video/mp4") return "mp4";
  if (normalized === "video/webm") return "webm";
  return "ogg";
};

const createInboundEvent = async (tenantId: string, channel: string, input: InboundWebhookInput) => {
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(input.raw ?? input))
    .digest("hex");
  try {
    return await CommunicationInboundEventModel.create({
      tenantId,
      channel,
      provider: input.provider,
      eventId: input.eventId,
      eventType: input.eventType,
      payloadHash,
      status: "received",
    });
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    if (typeof (CommunicationInboundEventModel as any).findOneAndUpdate !== "function") {
      return null;
    }
    return CommunicationInboundEventModel.findOneAndUpdate(
      {
        tenantId,
        channel,
        provider: input.provider,
        eventId: input.eventId,
        status: "failed",
      },
      {
        $set: {
          status: "received",
          error: "",
          processedAt: null,
          payloadHash,
        },
      },
      { returnDocument: "after" },
    );
  }
};

const applyDeliveryEvent = async (
  tenantId: string,
  channel: CommunicationChannel,
  input: InboundWebhookInput,
) => {
  const status = input.deliveryStatus || input.eventType.split(".").at(-1);
  let delivery: any = input.providerMessageId
    ? await CommunicationDeliveryModel.findOne({
        tenantId,
        providerMessageId: input.providerMessageId,
      })
    : null;
  // Instagram read receipts can carry only a sender-scoped thread identity
  // and watermark. Resolve them to the latest outbound message in that
  // customer thread, never across tenants or accounts.
  if (
    !delivery &&
    channel === COMMUNICATION_CHANNEL.INSTAGRAM &&
    status === DELIVERY_STATUS.READ
  ) {
    const instagramScopedId = String(
      input.sender.instagramScopedId || input.providerThreadId || "",
    ).trim();
    if (instagramScopedId) {
      const conversation = await CommunicationConversationModel.findOne({
        tenantId,
        "contact.instagramScopedId": instagramScopedId,
        deletedAt: null,
      })
        .sort({ lastMessageAt: -1 })
        .select("_id")
        .lean();
      if (conversation?._id) {
        const message = await CommunicationMessageModel.findOne({
          tenantId,
          conversationId: conversation._id,
          channel,
          direction: MESSAGE_DIRECTION.OUTGOING,
          createdAt: { $lte: input.occurredAt || new Date() },
          deletedAt: null,
        })
          .sort({ createdAt: -1 })
          .select("_id")
          .lean();
        if (message?._id) {
          delivery = await CommunicationDeliveryModel.findOne({
            tenantId,
            messageId: message._id,
          });
        }
      }
    }
  }
  if (!delivery) return { ignored: true, reason: "delivery_not_found" };
  const statusRank: Record<string, number> = {
    queued: 0,
    sending: 1,
    sent: 2,
    delivered: 3,
    read: 4,
    failed: 2,
    bounced: 5,
    rejected: 5,
    cancelled: 5,
  };
  const isFailure = [DELIVERY_STATUS.FAILED, DELIVERY_STATUS.BOUNCED, DELIVERY_STATUS.REJECTED].includes(status as never);
  if (
    isFailure &&
    [DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.READ].includes(
      delivery.status as never,
    )
  ) {
    return { delivery, ignored: true, reason: "stale_delivery_failure" };
  }
  if (!isFailure && (statusRank[status] ?? -1) < (statusRank[delivery.status] ?? -1)) {
    return { delivery, ignored: true, reason: "stale_delivery_status" };
  }
  delivery.status = status;
  const now = input.occurredAt || new Date();
  if (status === DELIVERY_STATUS.SENT) delivery.sentAt = now;
  if (status === DELIVERY_STATUS.DELIVERED) delivery.deliveredAt = now;
  if (status === DELIVERY_STATUS.READ) delivery.readAt = now;
  if (isFailure) {
    delivery.failure = input.failure || {
      code: "PROVIDER_FAILURE",
      message: `Provider reported ${status}.`,
      permanent: status !== DELIVERY_STATUS.FAILED,
    };
    const retry = getDeliveryRetryDecision({
      status,
      attempts: delivery.attempts,
      maxAttempts: delivery.maxAttempts,
      permanent: input.failure?.permanent ?? status !== DELIVERY_STATUS.FAILED,
      baseSeconds: 60,
      now,
    });
    delivery.nextAttemptAt = retry.nextAttemptAt;
  }
  delivery.eventHistory.push({ status, at: now, payload: input.raw || {} });
  await delivery.save();

  if (
    status === DELIVERY_STATUS.BOUNCED &&
    typeof (CommunicationMessageModel as any).findOne === "function"
  ) {
    const messageQuery: any = CommunicationMessageModel.findOne({
      _id: delivery.messageId,
      tenantId,
    });
    const message: any =
      typeof messageQuery?.lean === "function"
        ? await messageQuery.lean()
        : await messageQuery;
    const identity = normalizedEmail(message?.recipients?.find((recipient: any) => recipient.email)?.email);
    if (identity) {
      await CommunicationSuppressionModel.findOneAndUpdate(
        { tenantId, channel: "email", identity },
        {
          $set: {
            reason: "hard_bounce",
            provider: input.provider,
            providerEventId: input.eventId,
            active: true,
          },
        },
        { upsert: true, returnDocument: "after" },
      );
    }
  }
  return { delivery };
};

const matchCustomer = async (tenantId: string, sender: any) => {
  const email = normalizedEmail(sender.email);
  const phone = normalizedPhone(sender.whatsappId || sender.phone);
  const instagramScopedId = String(sender.instagramScopedId || "").trim();
  if (instagramScopedId) {
    const linkedConversation = await CommunicationConversationModel.findOne({
      tenantId,
      customerId: { $ne: null },
      "contact.instagramScopedId": instagramScopedId,
      deletedAt: null,
    })
      .sort({ lastMessageAt: -1 })
      .select("customerId")
      .lean();
    if (linkedConversation?.customerId) {
      const customer = await UserModel.findOne({
        _id: linkedConversation.customerId,
        tenant: tenantId,
      })
        .select("firstname lastname email phone customId")
        .lean();
      if (customer) {
        return {
          customer,
          status: "matched",
          confidence: 1,
          candidates: [
            {
              customerId: customer._id,
              score: 1,
              reasons: ["exact_instagram_scoped_id"],
            },
          ],
        };
      }
    }
  }
  const conditions: Record<string, unknown>[] = [];
  if (email) conditions.push({ email });
  if (phone) conditions.push({ phone: { $in: [phone, phone.replace(/^\+/, "")] } });
  if (!conditions.length) return { customer: null, status: "unmatched", confidence: 0, candidates: [] };
  const customers = await UserModel.find({ tenant: tenantId, $or: conditions })
    .select("firstname lastname email phone customId")
    .limit(20)
    .lean();
  const ranked = rankCustomerMatches(sender, customers, 5);
  const first = ranked[0];
  const second = ranked[1];
  const certain = Boolean(
    first &&
      first.score >= AI_AUTO_APPLY_CONFIDENCE &&
      (!second || first.score - second.score >= 0.1),
  );
  return {
    customer: certain ? first.customer : null,
    status: certain ? "matched" : ranked.length ? "suggested" : "unmatched",
    confidence: first?.score || 0,
    candidates: ranked.map((result) => ({
      customerId: result.customerId,
      score: result.score,
      reasons: result.reasons,
    })),
  };
};

const findExistingConversation = async ({
  tenantId,
  channel,
  input,
  customerId,
}: {
  tenantId: string;
  channel: CommunicationChannel;
  input: InboundWebhookInput;
  customerId?: unknown;
}) => {
  const replyAddress = input.recipients
    .map((recipient) => recipient.email)
    .find((email) => /reply\+[a-f0-9]{24}\./i.test(email || ""));
  const replyConversationId = replyAddress?.match(/reply\+([a-f0-9]{24})\./i)?.[1];
  if (replyConversationId) {
    const byReplyAddress = await CommunicationConversationModel.findOne({
      _id: replyConversationId,
      tenantId,
      deletedAt: null,
    });
    if (byReplyAddress) return byReplyAddress;
  }
  if (input.providerThreadId) {
    if (channel === COMMUNICATION_CHANNEL.EMAIL) {
      const references = emailThreadReferences(input.providerThreadId);
      if (references.length) {
        const previousMessage = await CommunicationMessageModel.findOne({
          tenantId,
          channel,
          deletedAt: null,
          $or: [
            { "headers.messageId": { $in: references } },
            { providerMessageId: { $in: references } },
          ],
        })
          .select("conversationId")
          .lean();
        if (previousMessage?.conversationId) {
          const byReferences = await CommunicationConversationModel.findOne({
            _id: previousMessage.conversationId,
            tenantId,
            deletedAt: null,
          });
          if (byReferences) return byReferences;
        }
      }
    }
    const byThread = await CommunicationConversationModel.findOne({
      tenantId,
      "externalThreads.channel": channel,
      "externalThreads.provider": input.provider,
      "externalThreads.threadId": input.providerThreadId,
      deletedAt: null,
    });
    if (byThread) return byThread;
  }
  const recent = new Date(Date.now() - 7 * 86_400_000);
  const identityFilters: Record<string, unknown>[] = [];
  if (customerId) identityFilters.push({ customerId });
  const email = normalizedEmail(input.sender.email);
  const whatsappId = normalizedPhone(input.sender.whatsappId || input.sender.phone);
  const instagramScopedId = String(
    input.sender.instagramScopedId || "",
  ).trim();
  if (email) identityFilters.push({ "contact.email": email });
  if (whatsappId) identityFilters.push({ "contact.whatsappId": { $in: [whatsappId, whatsappId.replace(/^\+/, "")] } });
  if (instagramScopedId) {
    identityFilters.push({ "contact.instagramScopedId": instagramScopedId });
  }
  if (!identityFilters.length) return null;
  return CommunicationConversationModel.findOne({
    tenantId,
    deletedAt: null,
    status: { $ne: CONVERSATION_STATUS.CLOSED },
    lastMessageAt: { $gte: recent },
    $or: identityFilters,
  }).sort({ lastMessageAt: -1 });
};

const sendAbsenceReply = async ({
  tenantId,
  conversation,
  channel,
  settings,
}: Record<string, any>) => {
  const contact = conversation.contact || {};
  const recipient =
    channel === "email"
      ? { name: contact.name || "", email: contact.email || "" }
      : channel === "instagram"
        ? {
            name: contact.name || "",
            instagramScopedId: contact.instagramScopedId || "",
            instagramUsername: contact.instagramUsername || "",
            externalId: contact.instagramScopedId || "",
          }
        : { name: contact.name || "", phone: contact.phone || "", whatsappId: contact.whatsappId || contact.phone || "" };
  const message = await CommunicationMessageModel.create({
    tenantId,
    conversationId: conversation._id,
    direction: MESSAGE_DIRECTION.SYSTEM,
    channel,
    kind: "text",
    sender: { name: settings.inbox?.senderName || "Studio", email: settings.inbox?.senderEmail || "" },
    recipients: [recipient],
    subject: channel === "email" ? `Re: ${conversation.subject}` : "",
    text: settings.absence?.message,
    provider: "system",
  });
  const idempotencyKey = buildDeliveryIdempotencyKey({
    tenantId,
    messageId: message._id,
    channel,
    purpose: "support",
  });
  const delivery = await CommunicationDeliveryModel.create({
    tenantId,
    conversationId: conversation._id,
    messageId: message._id,
    channel,
    purpose: "support",
    idempotencyKey,
    status: DELIVERY_STATUS.QUEUED,
    maxAttempts: settings.delivery?.maxAttempts || 4,
    nextAttemptAt: new Date(),
  });
  conversation.absenceReplyKey = new Date().toISOString();
  await conversation.save();
  await processCommunicationDelivery(delivery._id);
};

export const ingestCommunicationEvent = async ({
  settings,
  channel,
  input,
}: {
  settings: any;
  channel: CommunicationChannel;
  input: InboundWebhookInput;
}) => {
  const tenantId = String(settings.tenantId);
  const event = await createInboundEvent(tenantId, channel, input);
  if (!event) return { duplicate: true };
  try {
    if (input.eventType.startsWith("delivery.")) {
      const result = await applyDeliveryEvent(tenantId, channel, input);
      event.status = "processed";
      event.processedAt = new Date();
      await event.save();
      return { duplicate: false, ...result };
    }

    if (input.providerMessageId) {
      const existingMessage = await CommunicationMessageModel.findOne({
        tenantId,
        channel,
        provider: input.provider,
        providerMessageId: input.providerMessageId,
      }).lean();
      if (existingMessage) {
        event.status = "processed";
        event.processedAt = new Date();
        event.error = "";
        await event.save();
        return {
          duplicate: true,
          recovered: true,
          conversationId: existingMessage.conversationId,
          messageId: existingMessage._id,
        };
      }
    }

    if (input.locationId) {
      const validLocation = await LocationModel.exists({ _id: input.locationId, tenant: tenantId });
      if (!validLocation) input.locationId = null;
    }
    const match = await matchCustomer(tenantId, input.sender);
    let conversation: any = await findExistingConversation({
      tenantId,
      channel,
      input,
      customerId: match.customer?._id,
    });
    const downloadedMedia: Array<{
      base64: string;
      contentType: string;
    } | null> = [];
    let downloadedMediaBytes = 0;
    for (let index = 0; index < input.attachments.length; index += 1) {
      const attachment = input.attachments[index];
      if (!attachment) {
        downloadedMedia.push(null);
        continue;
      }
      const media =
          channel === COMMUNICATION_CHANNEL.WHATSAPP &&
          input.kind === "voice" &&
          index === 0 &&
          attachment.url.startsWith("whatsapp-media://")
            ? await downloadWhatsAppMedia({
                tenantId,
                mediaUri: attachment.url,
              })
            : channel === COMMUNICATION_CHANNEL.INSTAGRAM &&
                attachment.url.startsWith("instagram-media://")
              ? await downloadInstagramMedia({
                  tenantId,
                  mediaUri: attachment.url,
                })
              : null;
      if (media) {
        downloadedMediaBytes += Buffer.byteLength(media.base64, "base64");
        if (downloadedMediaBytes > 50_000_000) {
          throw Object.assign(
            new Error(
              "Combined inbound communication media exceeds the 50 MB limit.",
            ),
            { permanent: true, code: "MEDIA_TOTAL_TOO_LARGE" },
          );
        }
      }
      downloadedMedia.push(media);
    }
    const voiceAttachmentIndex = input.attachments.findIndex(
      (attachment) =>
        input.kind === "voice" ||
        String(attachment.contentType).startsWith("audio/"),
    );
    const voiceMedia =
      voiceAttachmentIndex >= 0
        ? downloadedMedia[voiceAttachmentIndex]
        : null;
    let voiceTranscript: Awaited<
      ReturnType<typeof transcribeCommunicationAudio>
    > | null = null;
    if (voiceAttachmentIndex >= 0) {
      const audioUrl = input.attachments[voiceAttachmentIndex]?.url || "";
      voiceTranscript = await transcribeCommunicationAudio({
        audioUrl:
          !voiceMedia && /^https:\/\//i.test(audioUrl)
            ? audioUrl
            : undefined,
        audioBase64: voiceMedia?.base64,
        contentType:
          voiceMedia?.contentType ||
          input.attachments[voiceAttachmentIndex]?.contentType,
      });
    }
    const messageText =
      voiceTranscript?.text ||
      input.text ||
      input.html.replace(/<[^>]+>/g, " ");
    const analysis = settings.ai?.enabled === false
      ? {
          status: "disabled",
          category: "general",
          priority: "normal",
          language: "",
          sentiment: "neutral",
          confidence: 0,
          summary: "",
          actions: [],
          provider: "disabled",
          model: "none",
          version: "1",
          processedAt: new Date(),
        }
      : await analyzeCommunicationText(messageText);
    const business = evaluateBusinessHours(input.occurredAt || new Date(), settings.businessHours || {});
    const routingRules = settings.ai?.autoRoute === false
      ? []
      : await CommunicationRoutingRuleModel.find({ tenantId, enabled: true }).sort({ order: 1 }).lean();
    const route = routeConversation(
      {
        category: analysis.category,
        channel,
        priority: analysis.priority,
        language: analysis.language,
        locationId: input.locationId,
        text: messageText,
        unmatched: !match.customer,
        outsideBusinessHours: !business.isOpen,
      },
      routingRules,
    );
    const instagramMessageAt = input.occurredAt || new Date();
    const instagramMetadata =
      channel === COMMUNICATION_CHANNEL.INSTAGRAM
        ? {
            lastCustomerMessageAt: instagramMessageAt,
            replyWindowExpiresAt: new Date(
              instagramMessageAt.getTime() + 24 * 60 * 60 * 1000,
            ),
            scopedId: input.sender.instagramScopedId || "",
            username: input.sender.instagramUsername || "",
            accountId: input.providerAccountId || "",
            sourceType:
              String(input.providerContext?.sourceType || "dm").slice(0, 40),
            isStoryReply: input.providerContext?.isStoryReply === true,
            isStoryMention: input.providerContext?.isStoryMention === true,
            storyId: String(input.providerContext?.storyId || "").slice(0, 300),
          }
        : null;

    if (!conversation) {
      conversation = await CommunicationConversationModel.create({
        tenantId,
        subject:
          input.subject ||
          (channel === COMMUNICATION_CHANNEL.WHATSAPP
            ? "WhatsApp conversation"
            : channel === COMMUNICATION_CHANNEL.INSTAGRAM
              ? "Instagram conversation"
              : "New email"),
        channels: [channel],
        customerId: match.customer?._id || null,
        contact: {
          name: input.sender.name || [match.customer?.firstname, match.customer?.lastname].filter(Boolean).join(" "),
          email: normalizedEmail(input.sender.email || match.customer?.email),
          phone: input.sender.phone || match.customer?.phone || "",
          whatsappId: input.sender.whatsappId || input.sender.phone || "",
          instagramScopedId: input.sender.instagramScopedId || "",
          instagramUsername: input.sender.instagramUsername || "",
          externalId: input.sender.externalId || match.customer?.customId || "",
        },
        customerMatch: {
          status: match.status,
          confidence: match.confidence,
          candidates: match.candidates,
        },
        locationId: route?.locationId || input.locationId || null,
        assignedTo: route?.assignedTo || settings.inbox?.defaultAssignee || null,
        assignedTeam: route?.assignedTeam || "",
        priority: route?.priority || analysis.priority,
        category: analysis.category,
        language: analysis.language,
        tags: [
          ...(route?.tags || []),
          ...(instagramMetadata?.isStoryReply
            ? ["instagram-story-reply"]
            : []),
          ...(instagramMetadata?.isStoryMention
            ? ["instagram-story-mention"]
            : []),
        ],
        externalThreads: input.providerThreadId
          ? [{ channel, provider: input.provider, threadId: input.providerThreadId }]
          : [],
        relatedEntities: input.relatedEntities,
        ai: analysis,
        source: "inbound_webhook",
        unreadCount: 1,
        lastMessagePreview: messageText,
        lastMessageAt: input.occurredAt || new Date(),
        metadata: instagramMetadata
          ? { instagram: instagramMetadata }
          : {},
      });
    } else {
      conversation.channels = [...new Set([...(conversation.channels || []), channel])];
      if (input.providerThreadId && !conversation.externalThreads?.some((thread: any) => thread.channel === channel && thread.provider === input.provider && thread.threadId === input.providerThreadId)) {
        conversation.externalThreads.push({ channel, provider: input.provider, threadId: input.providerThreadId });
      }
      if (!conversation.customerId && match.customer) {
        conversation.customerId = match.customer._id;
        conversation.customerMatch = { status: "matched", confidence: match.confidence, candidates: match.candidates };
      }
      if (
        channel === COMMUNICATION_CHANNEL.INSTAGRAM &&
        input.sender.instagramScopedId
      ) {
        conversation.contact.instagramScopedId =
          input.sender.instagramScopedId;
        if (input.sender.instagramUsername) {
          conversation.contact.instagramUsername =
            input.sender.instagramUsername;
        }
        const previousMessageAt = new Date(
          conversation.metadata?.instagram?.lastCustomerMessageAt || 0,
        ).getTime();
        if (
          instagramMetadata &&
          instagramMessageAt.getTime() >= previousMessageAt
        ) {
          conversation.metadata = {
            ...(conversation.metadata || {}),
            instagram: instagramMetadata,
          };
          conversation.markModified?.("metadata");
        }
      }
      conversation.unreadCount += 1;
      conversation.lastMessageAt = input.occurredAt || new Date();
      conversation.lastMessagePreview = messageText;
      conversation.ai = analysis;
      if (analysis.confidence >= AI_AUTO_APPLY_CONFIDENCE) {
        conversation.category = analysis.category;
        conversation.priority = route?.priority || analysis.priority;
        conversation.language = analysis.language;
      }
      if (!conversation.assignedTo && route?.assignedTo) conversation.assignedTo = route.assignedTo;
      if (!conversation.assignedTeam && route?.assignedTeam) conversation.assignedTeam = route.assignedTeam;
      if (!conversation.locationId && route?.locationId) conversation.locationId = route.locationId;
      if (route?.tags?.length) conversation.tags = [...new Set([...(conversation.tags || []), ...route.tags])];
      if (instagramMetadata?.isStoryReply) {
        conversation.tags = [
          ...new Set([...(conversation.tags || []), "instagram-story-reply"]),
        ];
      }
      if (instagramMetadata?.isStoryMention) {
        conversation.tags = [
          ...new Set([...(conversation.tags || []), "instagram-story-mention"]),
        ];
      }
      await conversation.save();
    }

    let messageAttachments = input.attachments;
    if (downloadedMedia.some(Boolean)) {
      const nextAttachments = [...input.attachments];
      for (let index = 0; index < downloadedMedia.length; index += 1) {
        const media = downloadedMedia[index];
        const attachment = input.attachments[index];
        if (!media || !attachment) continue;
        const mediaIdentity = createHash("sha256")
          .update(`${input.provider}:${input.providerMessageId}:${index}`)
          .digest("hex");
        const folder = media.contentType.startsWith("audio/")
          ? "voice"
          : "media";
        const key = [
          "tenants",
          tenantId,
          "communications",
          String(conversation._id),
          folder,
          `${mediaIdentity}.${voiceFileExtension(media.contentType)}`,
        ].join("/");
        const buffer = Buffer.from(media.base64, "base64");
        await uploadBufferToR2({
          key,
          buffer,
          contentType: media.contentType,
          cacheControl: "private, max-age=31536000, immutable",
        });
        nextAttachments[index] = {
          ...attachment,
          // All provider media is private customer data. The Inbox read path
          // replaces this owned internal reference with a short-lived URL.
          url: toPrivateCommunicationR2Uri(key),
          size: buffer.byteLength,
          contentType: media.contentType,
          checksum: createHash("sha256").update(buffer).digest("hex"),
        };
      }
      messageAttachments = nextAttachments;
    }

    const message: any = await CommunicationMessageModel.create({
      tenantId,
      conversationId: conversation._id,
      direction: MESSAGE_DIRECTION.INCOMING,
      channel,
      kind: input.kind,
      sender: input.sender,
      recipients: input.recipients,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: messageAttachments,
      instagram:
        channel === COMMUNICATION_CHANNEL.INSTAGRAM
          ? input.providerContext
          : undefined,
      provider: input.provider,
      providerMessageId: input.providerMessageId,
      providerThreadId: input.providerThreadId,
      language: analysis.language,
      transcript: voiceTranscript?.text || "",
      ai: analysis,
      headers: {
        inboundEventId: event._id,
        providerOccurredAt: input.occurredAt || new Date(),
        ...(channel === COMMUNICATION_CHANNEL.EMAIL
          ? {
              messageId: String(input.providerMessageId || "")
                .replace(/[\r\n]/g, "")
                .slice(0, 2000),
              references: emailThreadReferences(input.providerThreadId),
            }
          : {}),
        ...(channel === COMMUNICATION_CHANNEL.INSTAGRAM
          ? { providerAccountId: input.providerAccountId }
          : {}),
      },
    });

    await recordCommunicationAudit({
      tenantId,
      actorType: "provider",
      action: AUDIT_ACTION.MESSAGE_RECEIVED,
      resourceType: "message",
      resourceId: message._id,
      conversationId: conversation._id,
      locationId: conversation.locationId,
      summary: `Incoming ${channel} message received.`,
      metadata: {
        provider: input.provider,
        eventId: input.eventId,
        route: route?.matchedRuleId,
        ...(channel === COMMUNICATION_CHANNEL.INSTAGRAM
          ? {
              sourceType: input.providerContext?.sourceType || "dm",
              providerAccountId: input.providerAccountId,
            }
          : {}),
      },
    });

    if (
      !(
        channel === COMMUNICATION_CHANNEL.INSTAGRAM &&
        Date.now() - (input.occurredAt || new Date()).getTime() >=
          24 * 60 * 60 * 1000
      ) &&
      shouldSendAbsenceReply({
        evaluation: business,
        enabled: settings.absence?.enabled === true,
        lastReplyAt: conversation.absenceReplyKey || null,
        repeatAfterHours: settings.absence?.repeatAfterHours || 24,
        now: input.occurredAt || new Date(),
      })
    ) {
      await sendAbsenceReply({ tenantId, conversation, channel, settings });
    }

    event.status = "processed";
    event.processedAt = new Date();
    await event.save();
    return { duplicate: false, conversationId: conversation._id, messageId: message._id, matchedCustomerId: match.customer?._id || null };
  } catch (error: any) {
    event.status = "failed";
    event.error = String(error?.message || error).slice(0, 2000);
    event.processedAt = new Date();
    await event.save();
    throw error;
  }
};

export const findCommunicationSettingsByTenantKey = (tenantKey: string) =>
  CommunicationSettingsModel.findOne({ tenantKey });

export const findCommunicationSettingsByInstagramAccountId = (
  instagramAccountId: string,
) =>
  CommunicationSettingsModel.findOne({
    "channels.instagram.instagramAccountId": instagramAccountId,
    "channels.instagram.enabled": true,
  });
