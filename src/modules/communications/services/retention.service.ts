import { deleteObjectFromR2 } from "@/infrastructure/storage/r2.client.js";
import {
  enforceCommunicationEmailLogRetention,
  listCommunicationEmailLogTenantIds,
  mergeCommunicationRetentionTenantIds,
} from "@/modules/communication-email-logs/communication-email-log-retention.service.js";

import {
  CommunicationConversationModel,
  CommunicationDeliveryModel,
  CommunicationMessageModel,
  CommunicationSettingsModel,
} from "../communications.models.js";
import { buildRetentionCutoff, recordCommunicationAudit } from "./audit.service.js";
import { getOwnedCommunicationR2Key } from "./private-media.service.js";

const deleteRetainedCommunicationMedia = async (
  tenantId: string,
  conversationIds: unknown[],
  cutoff: Date,
) => {
  if (typeof (CommunicationMessageModel as any).find !== "function") return 0;
  const messages = await CommunicationMessageModel.find({
    tenantId,
    conversationId: { $in: conversationIds },
    createdAt: { $lt: cutoff },
    deletedAt: null,
    "attachments.0": { $exists: true },
  })
    .select("attachments.url")
    .lean();
  const keys = [
    ...new Set(
      messages.flatMap((message: any) =>
        (message.attachments || [])
          .map((attachment: any) => String(attachment.url || ""))
          .map((url: string) => getOwnedCommunicationR2Key(tenantId, url))
          .filter((key: string | null): key is string => Boolean(key)),
      ),
    ),
  ];
  for (const key of keys) await deleteObjectFromR2({ key });
  return keys.length;
};

/**
 * Applies tenant-configured retention only to resolved, expired conversations.
 * Open/pending and recent conversations are deliberately excluded.
 */
export const enforceCommunicationRetentionForTenant = async (
  tenantId: string,
  now = new Date(),
) => {
  const settings = await CommunicationSettingsModel.findOne({ tenantId })
    .select("retention")
    .lean();
  const days = settings?.retention?.days || 730;
  const cutoff = buildRetentionCutoff(days, now);
  const redact = settings?.retention?.redactInsteadOfDelete !== false;
  const automationEmailLogs = await enforceCommunicationEmailLogRetention({
    tenantId,
    cutoff,
    redact,
  });
  const conversations = await CommunicationConversationModel.find({
    tenantId,
    status: "closed",
    resolvedAt: { $ne: null, $lt: cutoff },
    lastMessageAt: { $lt: cutoff },
    deletedAt: null,
  })
    .select("_id locationId")
    .limit(250)
    .lean();
  const ids = conversations.map((conversation) => conversation._id);
  if (!ids.length) {
    if (automationEmailLogs) {
      await recordCommunicationAudit({
        tenantId,
        actorType: "system",
        action: "retention_purged",
        resourceType: "automation_email_log_batch",
        summary: `Communication retention processed ${automationEmailLogs} automation email logs.`,
        metadata: {
          mode: redact ? "redact" : "delete",
          automationEmailLogCount: automationEmailLogs,
          cutoff,
        },
        retentionDays: settings?.retention?.retainAuditDays || 1095,
      });
    }
    return {
      conversations: 0,
      messages: 0,
      automationEmailLogs,
      mode:
        redact ? "redact" : "soft_delete",
    };
  }

  const deletedMedia = await deleteRetainedCommunicationMedia(
    tenantId,
    ids,
    cutoff,
  );

  let messageResult;
  if (redact) {
    messageResult = await CommunicationMessageModel.updateMany(
      {
        tenantId,
        conversationId: { $in: ids },
        createdAt: { $lt: cutoff },
        deletedAt: null,
      },
      {
        $set: {
          text: "[redacted by retention policy]",
          html: "",
          transcript: "",
          attachments: [],
          translations: {},
          headers: {},
          instagram: null,
          providerMessageId: "",
          providerThreadId: "",
          sender: {},
          recipients: [],
          editedAt: now,
        },
      },
    );
    await CommunicationConversationModel.updateMany(
      { tenantId, _id: { $in: ids } },
      {
        $set: {
          subject: "Expired conversation",
          contact: {},
          customerId: null,
          customerMatch: { status: "ignored", confidence: 0, candidates: [] },
          lastMessagePreview: "[redacted by retention policy]",
          "ai.summary": "",
          "ai.suggestedReply": "",
          metadata: { retentionRedactedAt: now },
          externalThreads: [],
        },
      },
    );
    await CommunicationDeliveryModel.updateMany(
      { tenantId, conversationId: { $in: ids } },
      {
        $set: {
          providerMessageId: "",
          eventHistory: [],
          failure: { code: "", message: "", permanent: false },
        },
      },
    );
  } else {
    messageResult = await CommunicationMessageModel.updateMany(
      {
        tenantId,
        conversationId: { $in: ids },
        createdAt: { $lt: cutoff },
        deletedAt: null,
      },
      { $set: { deletedAt: now } },
    );
    await CommunicationConversationModel.updateMany(
      { tenantId, _id: { $in: ids } },
      { $set: { deletedAt: now } },
    );
  }

  await recordCommunicationAudit({
    tenantId,
    actorType: "system",
    action: "retention_purged",
    resourceType: "conversation_batch",
    summary: `Communication retention processed ${ids.length} resolved conversations.`,
    metadata: {
      mode: redact ? "redact" : "soft_delete",
      conversationCount: ids.length,
      messageCount: messageResult.modifiedCount,
      automationEmailLogCount: automationEmailLogs,
      deletedMedia,
      cutoff,
    },
    retentionDays: settings?.retention?.retainAuditDays || 1095,
  });

  return {
    conversations: ids.length,
    messages: messageResult.modifiedCount,
    automationEmailLogs,
    mode: redact ? "redact" : "soft_delete",
  };
};

export const enforceAllCommunicationRetention = async () => {
  const [settingsTenants, emailLogTenantIds] = await Promise.all([
    CommunicationSettingsModel.find({}).select("tenantId").lean(),
    listCommunicationEmailLogTenantIds(),
  ]);
  const tenantIds = mergeCommunicationRetentionTenantIds(
    settingsTenants.map((item) => item.tenantId),
    emailLogTenantIds,
  );
  const results = [];
  for (const tenantId of tenantIds) {
    results.push({
      tenantId,
      ...(await enforceCommunicationRetentionForTenant(tenantId)),
    });
  }
  return results;
};
