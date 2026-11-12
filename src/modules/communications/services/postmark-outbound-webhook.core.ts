import type { PostmarkOutboundWebhookPayload } from "../postmark-outbound-webhook.validators.js";

export type PostmarkOutboundReference = {
  id: unknown;
  tenantId: unknown;
  recipientEmail: string;
};

export type PostmarkOutboundManagedTestReference = PostmarkOutboundReference & {
  providerMessageId: string;
};

export type PostmarkOutboundOrderReceiptReference =
  PostmarkOutboundReference & {
    claimId: string;
    providerStartedAt: Date;
    providerMessageId: string;
  };

export type PostmarkOutboundTransition = {
  status: "delivered" | "bounced" | "complained";
  at: Date;
  eventKey: string;
  providerEventId: string;
  code: string;
  reason: string;
  permanent: boolean;
};

export type PostmarkOutboundWebhookDependencies = {
  findDoorAccess?: (
    event: PostmarkOutboundWebhookPayload,
  ) => Promise<PostmarkOutboundOrderReceiptReference | null>;
  transitionDoorAccess?: (
    reference: PostmarkOutboundOrderReceiptReference,
    transition: PostmarkOutboundTransition,
  ) => Promise<boolean>;
  findDelivery: (
    providerMessageId: string,
  ) => Promise<PostmarkOutboundReference | null>;
  findAutomationLog: (
    providerMessageId: string,
  ) => Promise<PostmarkOutboundReference | null>;
  findManagedTest: (
    providerMessageId: string,
  ) => Promise<PostmarkOutboundManagedTestReference | null>;
  findOrderReceipt: (
    event: PostmarkOutboundWebhookPayload,
  ) => Promise<PostmarkOutboundOrderReceiptReference | null>;
  isTenantServer: (tenantId: unknown, serverId: number) => Promise<boolean>;
  transitionDelivery: (
    reference: PostmarkOutboundReference,
    transition: PostmarkOutboundTransition,
  ) => Promise<boolean>;
  transitionAutomationLog: (
    reference: PostmarkOutboundReference,
    transition: PostmarkOutboundTransition,
  ) => Promise<boolean>;
  transitionManagedTest: (
    reference: PostmarkOutboundManagedTestReference,
    transition: PostmarkOutboundTransition,
  ) => Promise<boolean>;
  transitionOrderReceipt: (
    reference: PostmarkOutboundOrderReceiptReference,
    transition: PostmarkOutboundTransition,
  ) => Promise<boolean>;
  upsertSuppression: (input: {
    tenantId: unknown;
    identity: string;
    reason: "hard_bounce" | "spam_complaint";
    providerEventId: string;
  }) => Promise<void>;
};

const normalizeEmail = (value: unknown) =>
  String(value || "")
    .trim()
    .toLowerCase();

const eventTransition = (
  event: PostmarkOutboundWebhookPayload,
): PostmarkOutboundTransition => {
  if (event.RecordType === "Delivery") {
    return {
      status: "delivered",
      at: new Date(event.DeliveredAt),
      eventKey: `Delivery:${event.DeliveredAt}`,
      providerEventId: `Delivery:${event.DeliveredAt}`,
      code: "",
      reason: String(event.Details || "Delivered by the recipient server."),
      permanent: false,
    };
  }
  if (event.RecordType === "Bounce") {
    const hardBounce = event.TypeCode === 1;
    return {
      status: "bounced",
      at: new Date(event.BouncedAt),
      eventKey: `Bounce:${String(event.ID)}`,
      providerEventId: String(event.ID),
      code: hardBounce ? "POSTMARK_HARD_BOUNCE" : "POSTMARK_BOUNCE",
      reason: String(
        event.Description || event.Details || event.Type || "Email bounced.",
      ),
      permanent: hardBounce,
    };
  }
  return {
    status: "complained",
    at: new Date(event.BouncedAt),
    eventKey: `SpamComplaint:${String(event.ID)}`,
    providerEventId: String(event.ID),
    code: "POSTMARK_SPAM_COMPLAINT",
    reason: String(
      event.Description || event.Details || "Recipient reported spam.",
    ),
    permanent: true,
  };
};

export const processPostmarkOutboundWebhook = async (
  event: PostmarkOutboundWebhookPayload,
  dependencies: PostmarkOutboundWebhookDependencies,
) => {
  const [
    rawDelivery,
    rawAutomationLog,
    rawManagedTest,
    rawOrderReceipt,
    rawDoorAccess,
  ] = await Promise.all([
    dependencies.findDelivery(event.MessageID),
    dependencies.findAutomationLog(event.MessageID),
    dependencies.findManagedTest(event.MessageID),
    dependencies.findOrderReceipt(event),
    dependencies.findDoorAccess?.(event) ?? Promise.resolve(null),
  ]);
  const eventRecipient = normalizeEmail(
    event.RecordType === "Delivery" ? event.Recipient : event.Email,
  );
  const serverMatches = new Map<string, boolean>();
  for (const reference of [
    rawDelivery,
    rawAutomationLog,
    rawManagedTest,
    rawOrderReceipt,
    rawDoorAccess,
  ]) {
    if (!reference) continue;
    const tenantKey = String(reference.tenantId);
    if (!serverMatches.has(tenantKey)) {
      serverMatches.set(
        tenantKey,
        await dependencies.isTenantServer(reference.tenantId, event.ServerID),
      );
    }
  }
  const validReference = <T extends PostmarkOutboundReference>(
    reference: T | null,
  ): T | null =>
    reference &&
    normalizeEmail(reference.recipientEmail) === eventRecipient &&
    serverMatches.get(String(reference.tenantId)) === true
      ? reference
      : null;
  const delivery = validReference(rawDelivery);
  const automationLog = validReference(rawAutomationLog);
  const managedTest = validReference(rawManagedTest);
  const orderReceipt = validReference(rawOrderReceipt);
  const doorAccess = validReference(rawDoorAccess);
  const transition = eventTransition(event);
  const [
    deliveryUpdated,
    automationLogUpdated,
    managedTestUpdated,
    orderReceiptUpdated,
    doorAccessUpdated,
  ] = await Promise.all([
    delivery
      ? dependencies.transitionDelivery(delivery, transition)
      : Promise.resolve(false),
    automationLog
      ? dependencies.transitionAutomationLog(automationLog, transition)
      : Promise.resolve(false),
    managedTest
      ? dependencies.transitionManagedTest(rawManagedTest!, transition)
      : Promise.resolve(false),
    orderReceipt
      ? dependencies.transitionOrderReceipt(orderReceipt, transition)
      : Promise.resolve(false),
    doorAccess && dependencies.transitionDoorAccess
      ? dependencies.transitionDoorAccess(doorAccess, transition)
      : Promise.resolve(false),
  ]);

  const suppressionReason =
    event.RecordType === "SpamComplaint"
      ? "spam_complaint"
      : event.RecordType === "Bounce" && event.TypeCode === 1
        ? "hard_bounce"
        : null;
  let suppressions = 0;
  if (suppressionReason) {
    const uniqueTargets = new Map<string, PostmarkOutboundReference>();
    for (const reference of [
      delivery,
      automationLog,
      managedTest,
      orderReceipt,
      doorAccess,
    ]) {
      const persistedRecipient = normalizeEmail(reference?.recipientEmail);
      if (
        reference &&
        persistedRecipient &&
        persistedRecipient === eventRecipient
      ) {
        uniqueTargets.set(
          `${String(reference.tenantId)}\n${persistedRecipient}`,
          { ...reference, recipientEmail: persistedRecipient },
        );
      }
    }
    for (const reference of uniqueTargets.values()) {
      await dependencies.upsertSuppression({
        tenantId: reference.tenantId,
        identity: reference.recipientEmail,
        reason: suppressionReason,
        providerEventId: transition.providerEventId,
      });
      suppressions += 1;
    }
  }

  return {
    matched: Boolean(
      delivery || automationLog || managedTest || orderReceipt || doorAccess,
    ),
    providerMessageMatched: Boolean(
      rawDelivery ||
      rawAutomationLog ||
      rawManagedTest ||
      rawOrderReceipt ||
      rawDoorAccess,
    ),
    correlationMismatch:
      Boolean(
        rawDelivery ||
        rawAutomationLog ||
        rawManagedTest ||
        rawOrderReceipt ||
        rawDoorAccess,
      ) &&
      !Boolean(
        delivery || automationLog || managedTest || orderReceipt || doorAccess,
      ),
    deliveryMatched: Boolean(delivery),
    automationLogMatched: Boolean(automationLog),
    managedTestMatched: Boolean(managedTest),
    orderReceiptMatched: Boolean(orderReceipt),
    deliveryUpdated,
    automationLogUpdated,
    managedTestUpdated,
    orderReceiptUpdated,
    doorAccessMatched: Boolean(doorAccess),
    doorAccessUpdated,
    suppressions,
  };
};
