import mongoose, { type ClientSession } from "mongoose";

import Booking from "@/modules/booking/booking.model.js";
import CustomerNotificationModel from "@/modules/customer-notifications/customer-notification.model.js";
import { Order } from "@/modules/order/order.model.js";
import Product from "@/modules/product/product.model.js";
import {
  getConnectedAccountRequestOptions,
  getTenantPaymentStripe,
} from "@/modules/tenant-payments/tenant-payment.stripe.gateway.js";

import { WAITLIST_EMAIL_TYPE, WAITLIST_STATE } from "./waitlist.constants.js";
import {
  WaitlistEmailOutboxModel,
  WaitlistEntryModel,
} from "./waitlist.model.js";
import {
  promoteWaitlistEntry,
  waitlistServiceInternals,
} from "./waitlist.service.js";
import { publishWaitlistCustomerNotificationForEntry } from "./waitlist.customer-notification.service.js";

const BATCH_SIZE = 100;
const LIVE_STATES = [
  WAITLIST_STATE.WAITING,
  WAITLIST_STATE.OFFERED,
  WAITLIST_STATE.PAYMENT_PENDING,
];

const objectId = (value: unknown): mongoose.Types.ObjectId =>
  value instanceof mongoose.Types.ObjectId
    ? value
    : new mongoose.Types.ObjectId(String(value));

const withTransaction = async <T>(
  work: (session: ClientSession) => Promise<T>,
): Promise<T> => {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

const expireOfferedEntries = async (now: Date): Promise<number> => {
  const candidates = await WaitlistEntryModel.find({
    state: WAITLIST_STATE.OFFERED,
    isLive: true,
    offerExpiresAt: { $lte: now },
  })
    .select("_id tenant courseSession")
    .sort({ offerExpiresAt: 1, _id: 1 })
    .limit(BATCH_SIZE)
    .lean()
    .exec();
  let expired = 0;
  for (const candidate of candidates) {
    const result = await withTransaction(async (session) => {
      const entry = await WaitlistEntryModel.findOne({
        _id: candidate._id,
        state: WAITLIST_STATE.OFFERED,
        isLive: true,
        offerExpiresAt: { $lte: now },
      })
        .select("+offerTokenHash +managementTokenHash")
        .session(session)
        .exec();
      if (!entry) return null;
      await waitlistServiceInternals.releaseEntryCapacity({
        tenantId: String(entry.tenant),
        entry,
        session,
      });
      entry.state = WAITLIST_STATE.EXPIRED;
      entry.isLive = false;
      entry.terminalAt = now;
      entry.terminalReason = "Offer window expired before checkout started.";
      entry.offerTokenHash = "";
      entry.lastReconciledAt = now;
      await entry.save({ session });
      await waitlistServiceInternals.enqueueEmail({
        tenantId: String(entry.tenant),
        entry: entry._id,
        email: entry.email,
        name: `${entry.firstName} ${entry.lastName}`.trim(),
        type: WAITLIST_EMAIL_TYPE.EXPIRED,
        deduplicationKey: `waitlist:${String(entry._id)}:expired`,
        session,
      });
      return {
        tenantId: String(entry.tenant),
        sessionId: String(entry.courseSession),
      };
    });
    if (!result) continue;
    expired += 1;
    await promoteWaitlistEntry({ ...result, automatic: true, now }).catch(
      () => null,
    );
  }
  return expired;
};

const expirePaymentPendingEntries = async (now: Date): Promise<number> => {
  const candidates = await WaitlistEntryModel.find({
    state: WAITLIST_STATE.PAYMENT_PENDING,
    isLive: true,
    "checkout.expiresAt": { $lte: now },
    $or: [
      { "checkout.fulfillmentClaimToken": "" },
      { "checkout.fulfillmentClaimToken": { $exists: false } },
      { "checkout.fulfillmentClaimExpiresAt": { $lte: now } },
    ],
  })
    .select("_id tenant courseSession checkout")
    .sort({ "checkout.expiresAt": 1, _id: 1 })
    .limit(BATCH_SIZE)
    .lean()
    .exec();
  let expired = 0;

  for (const candidate of candidates) {
    let notPayable = false;
    try {
      notPayable = await stripeSessionIsNotPayable(candidate, now);
    } catch {
      // Stripe state is authoritative. A transient API error keeps the seat
      // reserved and the next minute retries; it must never release blindly.
      continue;
    }
    if (!notPayable) continue;
    const result = await withTransaction(async (session) => {
      const entry = await WaitlistEntryModel.findOne({
        _id: candidate._id,
        state: WAITLIST_STATE.PAYMENT_PENDING,
        isLive: true,
        "checkout.expiresAt": { $lte: now },
        $or: [
          { "checkout.fulfillmentClaimToken": "" },
          { "checkout.fulfillmentClaimToken": { $exists: false } },
          { "checkout.fulfillmentClaimExpiresAt": { $lte: now } },
        ],
      })
        .select("+offerTokenHash +managementTokenHash")
        .session(session)
        .exec();
      if (!entry?.checkout?.orderId) return null;

      const order = await Order.findOne({
        _id: entry.checkout.orderId,
        tenant: entry.tenant,
      })
        .select("isPaid status stripe.processingClaimToken")
        .session(session)
        .lean()
        .exec();
      // A webhook may have durably claimed/marked the payment before the
      // waitlist claim. Never release paid capacity; let webhook retry.
      if (order?.isPaid || order?.stripe?.processingClaimToken) return null;

      await waitlistServiceInternals.releaseEntryCapacity({
        tenantId: String(entry.tenant),
        entry,
        session,
      });
      if (order) {
        await Order.updateOne(
          { _id: order._id, tenant: entry.tenant, isPaid: false },
          {
            $set: {
              status: "cancelled_order",
              note: "Waitlist payment window expired.",
            },
          },
          { session },
        ).exec();
      }
      entry.state = WAITLIST_STATE.EXPIRED;
      entry.isLive = false;
      entry.terminalAt = now;
      entry.terminalReason = "Payment window expired.";
      entry.offerTokenHash = "";
      entry.lastReconciledAt = now;
      await entry.save({ session });
      await waitlistServiceInternals.enqueueEmail({
        tenantId: String(entry.tenant),
        entry: entry._id,
        email: entry.email,
        name: `${entry.firstName} ${entry.lastName}`.trim(),
        type: WAITLIST_EMAIL_TYPE.EXPIRED,
        deduplicationKey: `waitlist:${String(entry._id)}:expired`,
        session,
      });
      return {
        tenantId: String(entry.tenant),
        sessionId: String(entry.courseSession),
      };
    });
    if (!result) continue;
    expired += 1;
    await promoteWaitlistEntry({ ...result, automatic: true, now }).catch(
      () => null,
    );
  }
  return expired;
};

const synchronizeAttachedStripeSessions = async (
  now: Date,
): Promise<number> => {
  const candidates = await WaitlistEntryModel.find({
    state: WAITLIST_STATE.PAYMENT_PENDING,
    isLive: true,
    "checkout.stripeSessionId": "",
    "checkout.startedAt": { $lte: new Date(now.getTime() - 60_000) },
  })
    .select("_id tenant checkout")
    .limit(BATCH_SIZE)
    .lean()
    .exec();
  let synchronized = 0;
  for (const entry of candidates) {
    const order = await Order.findOne({
      _id: entry.checkout?.orderId,
      tenant: entry.tenant,
      "waitlist.entryId": entry._id,
    })
      .select("stripe.sessionId")
      .lean()
      .exec();
    const stripeSessionId = String(order?.stripe?.sessionId ?? "");
    if (!stripeSessionId) continue;
    const updated = await WaitlistEntryModel.updateOne(
      {
        _id: entry._id,
        state: WAITLIST_STATE.PAYMENT_PENDING,
        "checkout.orderId": entry.checkout.orderId,
        "checkout.stripeSessionId": "",
      },
      { $set: { "checkout.stripeSessionId": stripeSessionId } },
    ).exec();
    synchronized += updated.modifiedCount;
  }
  return synchronized;
};

const stripeSessionIsNotPayable = async (
  entry: any,
  now = new Date(),
): Promise<boolean> => {
  if (!entry.checkout?.orderId) return true;
  const order = await Order.findOne({
    _id: entry.checkout.orderId,
    tenant: entry.tenant,
  })
    .select("isPaid stripe.sessionId stripe.connectedAccountId")
    .lean()
    .exec();
  if (!order) return true;
  if (order.isPaid) return false;
  const sessionId = String(order.stripe?.sessionId ?? "");
  const accountId = String(order.stripe?.connectedAccountId ?? "");
  if (!sessionId || !accountId) {
    return new Date(entry.checkout?.reservationExpiresAt ?? 0) <= now;
  }
  const stripe = getTenantPaymentStripe();
  const options = getConnectedAccountRequestOptions(accountId);
  const current = await stripe.checkout.sessions.retrieve(sessionId, options);
  if (current.payment_status === "paid" || current.status === "complete") {
    return false;
  }
  if (current.status === "open") {
    await stripe.checkout.sessions.expire(sessionId, options);
  }
  return true;
};

const reconcileCancelledOrRescheduledSessions = async (
  now: Date,
): Promise<number> => {
  const entries = await WaitlistEntryModel.find({
    state: { $in: LIVE_STATES },
    isLive: true,
  })
    .select(
      "_id tenant courseSession state sessionStartSnapshot checkout email firstName lastName",
    )
    .sort({ lastReconciledAt: 1, _id: 1 })
    .limit(BATCH_SIZE)
    .lean()
    .exec();
  const sessionIds = [
    ...new Set(entries.map((entry) => String(entry.courseSession))),
  ];
  const sessions = await Booking.find({ _id: { $in: sessionIds } })
    .select("_id tenant bookingProduct start status archive")
    .lean()
    .exec();
  const sessionById = new Map(
    sessions.map((value) => [String(value._id), value]),
  );
  const activeProducts = await Product.find({
    _id: {
      $in: sessions.map((value) => value.bookingProduct).filter(Boolean),
    },
    isActive: true,
  })
    .select("_id")
    .lean()
    .exec();
  const activeProductIds = new Set(
    activeProducts.map((value) => String(value._id)),
  );
  let cancelled = 0;

  for (const candidate of entries) {
    const courseSession = sessionById.get(String(candidate.courseSession));
    const snapshotStart = new Date(
      candidate.sessionStartSnapshot ?? 0,
    ).getTime();
    const startChanged =
      courseSession &&
      Number.isFinite(snapshotStart) &&
      snapshotStart > 0 &&
      new Date(courseSession.start).getTime() !== snapshotStart;
    const productUnavailable =
      Boolean(courseSession) &&
      !activeProductIds.has(String(courseSession.bookingProduct ?? ""));
    const lifecycleEnded =
      !courseSession ||
      courseSession.archive === true ||
      ["cancelled", "canceled"].includes(String(courseSession.status)) ||
      new Date(courseSession.start).getTime() <= now.getTime() ||
      productUnavailable ||
      startChanged;
    if (!lifecycleEnded) {
      await WaitlistEntryModel.updateOne(
        { _id: candidate._id, isLive: true },
        { $set: { lastReconciledAt: now } },
      ).exec();
      continue;
    }
    if (candidate.state === WAITLIST_STATE.PAYMENT_PENDING) {
      let notPayable: boolean;
      try {
        notPayable = await stripeSessionIsNotPayable(candidate);
      } catch {
        // A transient Stripe error must not abort lifecycle cleanup and
        // promotions for unrelated sessions. Retain the reservation safely.
        await WaitlistEntryModel.updateOne(
          { _id: candidate._id, isLive: true },
          { $set: { lastReconciledAt: now } },
        ).exec();
        continue;
      }
      if (!notPayable) {
        await WaitlistEntryModel.updateOne(
          { _id: candidate._id, isLive: true },
          { $set: { lastReconciledAt: now } },
        ).exec();
        continue;
      }
    }

    const changed = await withTransaction(async (session) => {
      const entry = await WaitlistEntryModel.findOne({
        _id: candidate._id,
        isLive: true,
        state: { $in: LIVE_STATES },
      })
        .select("+offerTokenHash +managementTokenHash")
        .session(session)
        .exec();
      if (!entry) return false;
      await waitlistServiceInternals.releaseEntryCapacity({
        tenantId: String(entry.tenant),
        entry,
        session,
      });
      if (entry.checkout?.orderId) {
        await Order.updateOne(
          { _id: entry.checkout.orderId, tenant: entry.tenant, isPaid: false },
          { $set: { status: "cancelled_order" } },
          { session },
        ).exec();
      }
      entry.state = WAITLIST_STATE.CANCELLED;
      entry.isLive = false;
      entry.terminalAt = now;
      entry.terminalReason = startChanged
        ? "Class rescheduled; waitlist entries are not migrated."
        : productUnavailable
          ? "Class product is no longer available."
          : courseSession &&
              new Date(courseSession.start).getTime() <= now.getTime()
            ? "Class session has started."
            : "Class session cancelled.";
      entry.offerTokenHash = "";
      entry.lastReconciledAt = now;
      await entry.save({ session });
      await waitlistServiceInternals.enqueueEmail({
        tenantId: String(entry.tenant),
        entry: entry._id,
        email: entry.email,
        name: `${entry.firstName} ${entry.lastName}`.trim(),
        type: WAITLIST_EMAIL_TYPE.CANCELLED,
        deduplicationKey: `waitlist:${String(entry._id)}:cancelled`,
        session,
      });
      return true;
    });
    cancelled += Number(changed);
  }
  return cancelled;
};

const promoteAvailableCapacity = async (now: Date): Promise<number> => {
  const queueHeads = await WaitlistEntryModel.aggregate([
    {
      $match: {
        state: WAITLIST_STATE.WAITING,
        isLive: true,
      },
    },
    { $sort: { courseSession: 1, sequence: 1, _id: 1 } },
    {
      $group: {
        _id: "$courseSession",
        headEntryId: { $first: "$_id" },
        lastReconciledAt: { $first: "$lastReconciledAt" },
      },
    },
    { $sort: { lastReconciledAt: 1, _id: 1 } },
    { $limit: BATCH_SIZE },
  ]).exec();
  const sessions = await Booking.find({
    _id: { $in: queueHeads.map((head) => head._id) },
    status: { $nin: ["cancelled", "canceled"] } as any,
    archive: { $ne: true },
    start: { $gt: now },
    "waitlistConfig.enabled": true,
    "waitlistConfig.autoPromote": true,
  })
    .select("_id tenant start")
    .sort({ start: 1, _id: 1 })
    .limit(BATCH_SIZE)
    .lean()
    .exec();
  const sessionById = new Map(
    sessions.map((courseSession) => [String(courseSession._id), courseSession]),
  );
  let promoted = 0;
  for (const head of queueHeads) {
    const courseSession = sessionById.get(String(head._id));
    if (!courseSession) {
      await WaitlistEntryModel.updateOne(
        { _id: head.headEntryId, state: WAITLIST_STATE.WAITING },
        { $set: { lastReconciledAt: now } },
      ).exec();
      continue;
    }
    for (let count = 0; count < BATCH_SIZE; count += 1) {
      const entry = await promoteWaitlistEntry({
        tenantId: String(courseSession.tenant),
        sessionId: String(courseSession._id),
        automatic: true,
        now,
      }).catch(() => null);
      if (!entry) break;
      promoted += 1;
    }
    await WaitlistEntryModel.updateOne(
      { _id: head.headEntryId, state: WAITLIST_STATE.WAITING },
      { $set: { lastReconciledAt: now } },
    ).exec();
  }
  return promoted;
};

const ensureTerminalNotifications = async (): Promise<number> => {
  const entries = await WaitlistEntryModel.aggregate([
    {
      $match: {
        state: {
          $in: [
            WAITLIST_STATE.CONFIRMED,
            WAITLIST_STATE.EXPIRED,
            WAITLIST_STATE.WITHDRAWN,
            WAITLIST_STATE.CANCELLED,
          ],
        },
      },
    },
    {
      $addFields: {
        expectedNotificationKey: {
          $concat: [
            "waitlist:",
            { $toString: "$_id" },
            ":",
            {
              $switch: {
                branches: [
                  {
                    case: { $eq: ["$state", WAITLIST_STATE.CONFIRMED] },
                    then: "confirmed",
                  },
                  {
                    case: {
                      $ne: [{ $ifNull: ["$refundSnapshot.refundId", ""] }, ""],
                    },
                    then: "refunded",
                  },
                  {
                    case: { $eq: ["$state", WAITLIST_STATE.CANCELLED] },
                    then: "cancelled",
                  },
                  {
                    case: { $eq: ["$state", WAITLIST_STATE.WITHDRAWN] },
                    then: "withdrawn",
                  },
                ],
                default: "expired",
              },
            },
          ],
        },
      },
    },
    {
      $lookup: {
        from: WaitlistEmailOutboxModel.collection.collectionName,
        localField: "expectedNotificationKey",
        foreignField: "deduplicationKey",
        as: "emailNotificationRows",
      },
    },
    {
      $lookup: {
        from: CustomerNotificationModel.collection.collectionName,
        let: {
          expectedTenant: "$tenant",
          expectedRecipient: "$customer",
          expectedKey: "$expectedNotificationKey",
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$tenant", "$$expectedTenant"] },
                  { $eq: ["$recipient", "$$expectedRecipient"] },
                  { $eq: ["$deduplicationKey", "$$expectedKey"] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "customerNotificationRows",
      },
    },
    {
      $match: {
        $or: [
          {
            state: { $ne: WAITLIST_STATE.CONFIRMED },
            emailNotificationRows: { $size: 0 },
          },
          {
            source: "customer",
            customer: { $type: "objectId" },
            customerNotificationRows: { $size: 0 },
          },
        ],
      },
    },
    { $sort: { terminalAt: 1, _id: 1 } },
    { $limit: BATCH_SIZE },
    {
      $project: {
        _id: 1,
        tenant: 1,
        courseSession: 1,
        state: 1,
        email: 1,
        firstName: 1,
        lastName: 1,
        refundSnapshot: 1,
        confirmedAt: 1,
        terminalAt: 1,
        customer: 1,
        source: 1,
      },
    },
  ]).exec();
  let materialized = 0;
  for (const entry of entries) {
    const refunded = String(entry.refundSnapshot?.refundId ?? "") !== "";
    const confirmed = entry.state === WAITLIST_STATE.CONFIRMED;
    const suffix = confirmed
      ? "confirmed"
      : refunded
        ? "refunded"
        : entry.state === WAITLIST_STATE.CANCELLED
          ? "cancelled"
          : entry.state === WAITLIST_STATE.WITHDRAWN
            ? "withdrawn"
            : "expired";
    const type = confirmed
      ? WAITLIST_EMAIL_TYPE.CONFIRMED
      : refunded
        ? WAITLIST_EMAIL_TYPE.REFUNDED
        : entry.state === WAITLIST_STATE.CANCELLED
          ? WAITLIST_EMAIL_TYPE.CANCELLED
          : entry.state === WAITLIST_STATE.WITHDRAWN
            ? WAITLIST_EMAIL_TYPE.WITHDRAWN
            : WAITLIST_EMAIL_TYPE.EXPIRED;
    const deduplicationKey = `waitlist:${String(entry._id)}:${suffix}`;
    const customerResult = await publishWaitlistCustomerNotificationForEntry({
      tenantId: String(entry.tenant),
      entry,
      type,
      deduplicationKey,
    });
    let didMaterialize = customerResult.createdCount > 0;
    if (confirmed) {
      materialized += Number(didMaterialize);
      continue;
    }
    const result = await WaitlistEmailOutboxModel.updateOne(
      { deduplicationKey },
      {
        $setOnInsert: {
          tenant: entry.tenant,
          entry: entry._id,
          recipientEmail: entry.email,
          recipientName: `${entry.firstName} ${entry.lastName}`.trim(),
          type,
          ...(refunded ? { refundSnapshot: entry.refundSnapshot } : {}),
          deduplicationKey,
          status: "pending",
          attempts: 0,
          nextAttemptAt: new Date(),
        },
      },
      { upsert: true },
    ).exec();
    didMaterialize ||= result.upsertedCount > 0;
    materialized += Number(didMaterialize);
  }
  return materialized;
};

/** Immediate best-effort companion to the rotating cron scan after a product
 * capacity increase. Each promotion remains an atomic FIFO capacity claim. */
export const reconcileWaitlistCapacityForProduct = async ({
  tenantId,
  productId,
  now = new Date(),
}: {
  tenantId: string;
  productId: string;
  now?: Date;
}): Promise<number> => {
  const sessions = await Booking.find({
    tenant: objectId(tenantId),
    bookingProduct: objectId(productId),
    archive: { $ne: true },
    status: { $nin: ["cancelled", "canceled"] } as any,
    start: { $gt: now },
    "waitlistConfig.enabled": true,
    "waitlistConfig.autoPromote": true,
  })
    .select("_id")
    .sort({ start: 1, _id: 1 })
    .limit(BATCH_SIZE)
    .lean()
    .exec();

  let promoted = 0;
  for (const courseSession of sessions) {
    for (let count = 0; count < BATCH_SIZE; count += 1) {
      const entry = await promoteWaitlistEntry({
        tenantId,
        sessionId: String(courseSession._id),
        automatic: true,
        now,
      });
      if (!entry) break;
      promoted += 1;
    }
  }
  return promoted;
};

export const reconcileCourseWaitlists = async () => {
  const now = new Date();
  const synchronized = await synchronizeAttachedStripeSessions(now);
  const offeredExpired = await expireOfferedEntries(now);
  const paymentExpired = await expirePaymentPendingEntries(now);
  const lifecycleCancelled = await reconcileCancelledOrRescheduledSessions(now);
  const promoted = await promoteAvailableCapacity(now);
  const notifications = await ensureTerminalNotifications();
  return {
    synchronized,
    offeredExpired,
    paymentExpired,
    lifecycleCancelled,
    promoted,
    notifications,
  };
};

export const waitlistReconciliationInternals = {
  expireOfferedEntries,
  expirePaymentPendingEntries,
  synchronizeAttachedStripeSessions,
  reconcileCancelledOrRescheduledSessions,
  promoteAvailableCapacity,
  ensureTerminalNotifications,
};
