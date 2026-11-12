import TenantPaymentAccountModel from "./tenant-payment-account.schema.js";

import type {
  TenantPaymentAccountDocument,
  TenantPaymentAccountSnapshot,
} from "./tenant-payment-account.types.js";

const accountCreateIdempotencyKey = (tenantId: string): string =>
  `shario-connect-account-${tenantId}`;

export const findTenantPaymentAccountByTenant = async (
  tenantId: string,
): Promise<TenantPaymentAccountDocument | null> =>
  TenantPaymentAccountModel.findOne({ tenant: tenantId }).exec();

export const findTenantPaymentAccountByStripeAccount = async (
  stripeAccountId: string,
): Promise<TenantPaymentAccountDocument | null> =>
  TenantPaymentAccountModel.findOne({ stripeAccountId }).exec();

export const ensureTenantPaymentAccountRecord = async (
  tenantId: string,
): Promise<TenantPaymentAccountDocument> =>
  TenantPaymentAccountModel.findOneAndUpdate(
    { tenant: tenantId },
    {
      $setOnInsert: {
        tenant: tenantId,
        accountCreateIdempotencyKey: accountCreateIdempotencyKey(tenantId),
      },
    },
    {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
    },
  ).exec();

export const markTenantPaymentProvisioningStarted = async (
  tenantId: string,
  startedAt: Date,
  nextAccountCreateIdempotencyKey: string,
): Promise<TenantPaymentAccountDocument | null> =>
  TenantPaymentAccountModel.findOneAndUpdate(
    {
      tenant: tenantId,
      // MongoDB's equality-to-null query matches both missing and null fields.
      // Older failed attempts wrote null, so accepting both states lets those
      // records recover without weakening the compare-and-set claim.
      stripeAccountId: null,
      provisioningStartedAt: null,
    },
    {
      $set: {
        provisioningStartedAt: startedAt,
        accountCreateIdempotencyKey:
          nextAccountCreateIdempotencyKey,
      },
    },
    { returnDocument: "after" },
  ).exec();

const snapshotUpdate = (snapshot: TenantPaymentAccountSnapshot) => ({
  stripeAccountId: snapshot.stripeAccountId,
  onboardingStatus: snapshot.onboardingStatus,
  detailsSubmitted: snapshot.detailsSubmitted,
  chargesEnabled: snapshot.chargesEnabled,
  payoutsEnabled: snapshot.payoutsEnabled,
  ...(snapshot.country ? { country: snapshot.country } : {}),
  ...(snapshot.defaultCurrency
    ? { defaultCurrency: snapshot.defaultCurrency }
    : {}),
  livemode: snapshot.livemode,
  requirements: snapshot.requirements,
  lastSyncedAt: snapshot.lastSyncedAt,
});

const snapshotUnset = (snapshot: TenantPaymentAccountSnapshot) => ({
  lastSyncErrorCode: 1,
  provisioningStartedAt: 1,
  ...(!snapshot.country ? { country: 1 } : {}),
  ...(!snapshot.defaultCurrency ? { defaultCurrency: 1 } : {}),
});

export const updateTenantPaymentAccountSnapshot = async ({
  tenantId,
  snapshot,
}: {
  tenantId: string;
  snapshot: TenantPaymentAccountSnapshot;
}): Promise<TenantPaymentAccountDocument | null> =>
  TenantPaymentAccountModel.findOneAndUpdate(
    {
      tenant: tenantId,
      $or: [
        { stripeAccountId: null },
        { stripeAccountId: snapshot.stripeAccountId },
      ],
    },
    {
      $set: snapshotUpdate(snapshot),
      $unset: snapshotUnset(snapshot),
    },
    { returnDocument: "after" },
  ).exec();

export const updateTenantPaymentAccountFromWebhook = async ({
  stripeAccountId,
  eventCreated,
  snapshot,
}: {
  stripeAccountId: string;
  eventCreated: number;
  snapshot: TenantPaymentAccountSnapshot;
}): Promise<TenantPaymentAccountDocument | null> =>
  TenantPaymentAccountModel.findOneAndUpdate(
    {
      stripeAccountId,
      $or: [
        { lastStripeEventCreatedAt: { $exists: false } },
        { lastStripeEventCreatedAt: { $lte: eventCreated } },
      ],
    },
    {
      $set: {
        ...snapshotUpdate(snapshot),
        lastStripeEventCreatedAt: eventCreated,
      },
      $unset: snapshotUnset(snapshot),
    },
    { returnDocument: "after" },
  ).exec();

export const resetTenantPaymentProvisioningAttempt = async ({
  tenantId,
  expectedProvisioningStartedAt,
  expectedAccountCreateIdempotencyKey,
  nextAccountCreateIdempotencyKey,
}: {
  tenantId: string;
  expectedProvisioningStartedAt: Date;
  expectedAccountCreateIdempotencyKey: string;
  nextAccountCreateIdempotencyKey: string;
}): Promise<boolean> => {
  const result = await TenantPaymentAccountModel.updateOne(
    {
      tenant: tenantId,
      stripeAccountId: null,
      provisioningStartedAt:
        expectedProvisioningStartedAt,
      accountCreateIdempotencyKey:
        expectedAccountCreateIdempotencyKey,
    },
    {
      $set: {
        accountCreateIdempotencyKey:
          nextAccountCreateIdempotencyKey,
      },
      $unset: {
        provisioningStartedAt: 1,
      },
    },
  );

  return result.modifiedCount === 1;
};

export const markTenantPaymentSyncFailed = async ({
  tenantId,
  code,
}: {
  tenantId: string;
  code: string;
}): Promise<void> => {
  await TenantPaymentAccountModel.updateOne(
    { tenant: tenantId },
    { $set: { lastSyncErrorCode: code } },
  ).exec();
};
