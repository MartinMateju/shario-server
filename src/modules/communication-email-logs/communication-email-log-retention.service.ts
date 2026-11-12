import CommunicationEmailLogModel from "./communication-email-log.model.js";

export const TERMINAL_COMMUNICATION_EMAIL_LOG_STATUSES = [
  "sent",
  "failed",
  "canceled",
  "suppressed",
] as const;

export const listCommunicationEmailLogTenantIds = async (): Promise<string[]> => {
  const tenantIds = await CommunicationEmailLogModel.distinct("tenant", {});
  return tenantIds.map((tenantId) => String(tenantId)).filter(Boolean);
};

export const mergeCommunicationRetentionTenantIds = (
  ...groups: ReadonlyArray<ReadonlyArray<unknown>>
): string[] => [
  ...new Set(
    groups.flatMap((group) => group.map((value) => String(value || "")))
      .filter(Boolean),
  ),
];

export const enforceCommunicationEmailLogRetention = async ({
  tenantId,
  cutoff,
  redact,
}: {
  tenantId: string;
  cutoff: Date;
  redact: boolean;
}): Promise<number> => {
  const filter = {
    tenant: tenantId,
    status: { $in: TERMINAL_COMMUNICATION_EMAIL_LOG_STATUSES },
    // Status transitions update `updatedAt`, so retention starts when the
    // terminal outcome is old rather than when a future delivery was created.
    updatedAt: { $lt: cutoff },
  };

  if (!redact) {
    const result = await CommunicationEmailLogModel.deleteMany(filter);
    return result.deletedCount;
  }

  const result = await CommunicationEmailLogModel.updateMany(
    {
      ...filter,
      recipientEmail: { $ne: "redacted@retention.invalid" },
    },
    {
      $set: {
        user: null,
        recipientEmail: "redacted@retention.invalid",
        recipientName: "",
        subject: "[redacted by retention policy]",
        htmlContent: "",
        body: "",
        providerMessageId: "",
        processingJobId: "",
        errorMessage: "",
        cancelReason: "",
        relatedEntityId: null,
      },
    },
  );
  return result.modifiedCount;
};
