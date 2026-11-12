import { plainMembershipTranslations } from "./membership.localization.js";

const id = (value: any): string | null => {
  if (!value) return null;
  return String(value?._id ?? value);
};

const iso = (value: any): string | null =>
  value ? new Date(value).toISOString() : null;

export const serializePlanVersion = (version: any) => {
  if (!version) return null;
  return {
    id: id(version),
    version: Number(version.version),
    status: version.status,
    name: version.name,
    description: version.description ?? "",
    terms: version.terms ?? "",
    sourceLanguage: version.sourceLanguage,
    translations: plainMembershipTranslations(version.translations),
    prices: (version.prices ?? []).map((price: any) => ({
      currency: price.currency,
      amountMinor: Number(price.amountMinor),
    })),
    billing: version.billing?.type === "fixed"
      ? { type: "fixed", durationDays: Number(version.billing.durationDays) }
      : {
          type: "recurring",
          interval: version.billing?.interval,
          intervalCount: Number(version.billing?.intervalCount ?? 1),
        },
    locationScope: {
      type: version.locationScope?.type ?? "all",
      locationIds: (version.locationScope?.locationIds ?? []).map(String),
    },
    benefits: (version.benefits ?? []).map((benefit: any) => {
      const raw = typeof benefit.toObject === "function" ? benefit.toObject() : { ...benefit };
      delete raw._id;
      if (raw.translations) raw.translations = plainMembershipTranslations(raw.translations);
      return raw;
    }),
    publishedAt: iso(version.publishedAt),
    createdAt: iso(version.createdAt),
    updatedAt: iso(version.updatedAt),
  };
};

export const serializePlan = (plan: any, options: { owner?: boolean } = {}) => {
  const published = plan.currentPublishedVersion?._id
    ? plan.currentPublishedVersion
    : plan.publishedVersion;
  const draft = plan.currentDraftVersion?._id
    ? plan.currentDraftVersion
    : plan.draftVersion;
  const preferred = options.owner ? (draft ?? published) : published;
  return {
    id: id(plan),
    status: plan.status,
    sortOrder: Number(plan.sortOrder ?? 0),
    name: preferred?.name ?? "",
    description: preferred?.description ?? "",
    publishedVersion: serializePlanVersion(published),
    ...(options.owner ? { draftVersion: serializePlanVersion(draft) } : {}),
    publishedAt: iso(plan.publishedAt),
    archivedAt: iso(plan.archivedAt),
    createdAt: iso(plan.createdAt),
    updatedAt: iso(plan.updatedAt),
  };
};

export const serializeEntitlementBalance = (balance: any) => {
  const now = new Date();
  const liveBuckets = (balance.timeBuckets ?? []).filter((bucket: any) =>
    Number(bucket.available) > 0 && new Date(bucket.expiresAt) > now);
  const carryover = liveBuckets.filter((bucket: any) => bucket.kind === "carryover");
  const carryoverAvailable = carryover.reduce((sum: number, bucket: any) => sum + Number(bucket.available), 0);
  const currentPeriodAvailable = balance.timeBucketVersion === 1
    ? liveBuckets.filter((bucket: any) => bucket.kind !== "carryover")
      .reduce((sum: number, bucket: any) => sum + Number(bucket.available), 0)
    : (!balance.expiresAt || new Date(balance.expiresAt) > now ? Number(balance.available ?? 0) : 0);
  return {
  benefitKey: balance.benefitKey,
  granted: Number(balance.granted ?? 0),
  redeemed: Number(balance.redeemed ?? 0),
  adjusted: Number(balance.adjusted ?? 0),
  expired: Number(balance.expired ?? 0),
  available: balance.timeBucketVersion === 1
    ? currentPeriodAvailable + carryoverAvailable : Number(balance.available ?? 0),
  currentPeriodAvailable,
  carryoverAvailable,
  carryoverExpiresAt: carryover.length
    ? new Date(Math.min(...carryover.map((bucket: any) => new Date(bucket.expiresAt).getTime()))).toISOString()
    : null,
  expiresAt: iso(balance.expiresAt),
  updatedAt: iso(balance.updatedAt),
  };
};

export const serializeMembership = (membership: any, balances: any[] = []) => {
  if (!membership) return null;
  const snapshot = typeof membership.planSnapshot?.toObject === "function"
    ? membership.planSnapshot.toObject({ flattenMaps: true })
    : membership.planSnapshot;
  return {
    id: id(membership),
    status: membership.status,
    userId: id(membership.user),
    customer: membership.user?._id
      ? {
          id: id(membership.user),
          firstname: membership.user.firstname ?? "",
          lastname: membership.user.lastname ?? "",
          email: membership.user.email ?? "",
          customId: membership.user.customId ?? "",
          memberNumber:
            Number.isSafeInteger(membership.user.memberNumber) &&
            Number(membership.user.memberNumber) > 0
              ? Number(membership.user.memberNumber)
              : null,
        }
      : null,
    planId: id(membership.plan),
    planVersionId: id(membership.planVersion),
    canSchedulePlanChange: membership.status === "active" && membership.isOpen === true &&
      Boolean(membership.stripe?.subscriptionId && membership.stripe?.connectedAccountId) &&
      membership.autoRenew === true && !membership.cancelAtPeriodEnd &&
      !membership.billingMutation && !membership.scheduledPlanChange &&
      membership.planSnapshot?.billing?.type === "recurring" &&
      membership.planSnapshot?.billing?.interval === "month" &&
      Number(membership.planSnapshot?.billing?.intervalCount) === 1 &&
      Boolean(membership.currentPeriodStart && new Date(membership.currentPeriodEnd).getTime() > Date.now()),
    scheduledPlanChange: membership.scheduledPlanChange ? (() => {
      const change = membership.scheduledPlanChange;
      const target = typeof change.planSnapshot?.toObject === "function"
        ? change.planSnapshot.toObject({ flattenMaps: true }) : change.planSnapshot;
      return {
        planId: id(change.plan), planVersionId: id(change.planVersion),
        planSnapshot: { ...target, locationScope: { ...target.locationScope,
          locationIds: (target.locationScope?.locationIds ?? []).map(String) } },
        selectedLocationId: id(change.selectedLocation), currency: change.currency,
        amountMinor: Number(change.amountMinor), effectiveAt: iso(change.effectiveAt),
        status: change.status,
      };
    })() : null,
    planSnapshot: snapshot
      ? {
          ...snapshot,
          locationScope: {
            ...snapshot.locationScope,
            locationIds: (snapshot.locationScope?.locationIds ?? []).map(String),
          },
        }
      : null,
    selectedLocationId: id(membership.selectedLocation),
    currency: membership.currency,
    amountMinor: Number(membership.amountMinor ?? 0),
    currentPeriodStart: iso(membership.currentPeriodStart),
    currentPeriodEnd: iso(membership.currentPeriodEnd),
    renewsAt: iso(membership.renewsAt),
    expiresAt: iso(membership.currentPeriodEnd ?? membership.renewsAt),
    autoRenew: Boolean(membership.autoRenew),
    cancelAtPeriodEnd: Boolean(membership.cancelAtPeriodEnd),
    cancelScheduledAt: iso(membership.cancelScheduledAt),
    cancelledAt: iso(membership.cancelledAt),
    cancellation: membership.cancellation?.reason
      ? {
          reason: membership.cancellation.reason,
          comment: membership.cancellation.comment ?? "",
          requestedAt: iso(membership.cancellation.requestedAt),
          source: membership.cancellation.source,
        }
      : null,
    balances: balances.map(serializeEntitlementBalance),
    createdAt: iso(membership.createdAt),
    updatedAt: iso(membership.updatedAt),
  };
};

export const serializeLedgerEntry = (entry: any) => ({
  id: id(entry),
  benefitKey: entry.benefitKey,
  type: entry.type,
  amount: Number(entry.amount),
  balanceAfter: Number(entry.balanceAfter),
  reason: entry.reason,
  note: entry.note ?? "",
  reference: entry.reference?.type || entry.reference?.id
    ? { type: entry.reference.type ?? "", id: entry.reference.id ?? "" }
    : null,
  relatedEntryId: id(entry.relatedEntry),
  expiresAt: iso(entry.expiresAt),
  createdAt: iso(entry.createdAt),
});

export const membershipInvoiceLocalUrl = (invoiceId: unknown): string =>
  `/memberships/mine/invoices/${String(invoiceId)}`;

export const serializeMembershipInvoice = (invoice: any) => ({
  id: id(invoice),
  number: invoice.number ?? "",
  status: invoice.status,
  currency: invoice.currency,
  totalAmountMinor: Number(invoice.totalAmountMinor ?? 0),
  amountPaidMinor: Number(invoice.amountPaidMinor ?? 0),
  amountDueMinor: Number(invoice.amountDueMinor ?? 0),
  periodStart: iso(invoice.periodStart),
  periodEnd: iso(invoice.periodEnd),
  issuedAt: iso(invoice.issuedAt),
  paidAt: iso(invoice.paidAt),
  url: membershipInvoiceLocalUrl(invoice._id),
  documentUrl: `${membershipInvoiceLocalUrl(invoice._id)}/document`,
});

