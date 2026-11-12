import mongoose, {
  type ClientSession,
  type PopulateOptions,
  type SortOrder,
  type Types,
  type UpdateQuery,
} from "mongoose";

import Product from "@/modules/product/product.model.js";
import User from "@/modules/user/user.model.js";
import { createCartRepository } from "@/modules/cart/cart.repository.js";
import type { AllowedWorkspaceLocationIds } from "@/modules/tenant-access/services/location-scope.service.js";

import {
  ORDER_CONFIRM_NOTIFICATION_TYPE,
  ORDER_NOTIFICATION_BATCH_LIMIT,
  ORDER_NOTIFICATION_FALLBACK_SEND_WINDOW_HOURS,
  ORDER_NOTIFICATION_FIRST_SEND_WINDOW_HOURS,
  ORDER_NOTIFICATION_LOCK_MS,
  ORDER_NOTIFICATION_MAX_RETRIES,
  ORDER_NOTIFICATION_RETRY_DELAY_MS,
  ORDER_NOTIFICATION_RETRY_WINDOW_HOURS,
  ORDER_NOTIFICATION_STATUS,
  ORDER_STATUS,
  type OrderNotificationStatus,
} from "./order.constants.js";
import { Order } from "./order.model.js";
import {
  buildOrderLocationScopeFilter,
  buildOrderReadLocationFilter,
} from "./order.access.js";
import type {
  OrderDocument,
  OrderWithCreatedByUser,
  PaginatedOrdersResult,
} from "./order.types.js";
import { parseOrderFilter } from "./order.validators.js";

type IdLike = string | Types.ObjectId;
type OrderQueryFilter = Record<string, unknown>;

type OrderRepositoryOptions = {
  tenantId: IdLike;
  session?: ClientSession | null;
};

type SelectOption =
  | string
  | readonly string[]
  | Record<string, string | number | boolean | object>;

type FindOptions = {
  select?: SelectOption;
  sort?: Record<string, SortOrder>;
  skip?: number;
  limit?: number;
  populate?: PopulateOptions | PopulateOptions[];
  lean?: boolean;
};

const toObjectId = (value: IdLike): Types.ObjectId => {
  if (value instanceof mongoose.Types.ObjectId) return value;
  return new mongoose.Types.ObjectId(String(value));
};

const asPopulateArray = (
  populate?: PopulateOptions | PopulateOptions[],
): PopulateOptions[] => {
  if (!populate) return [];
  return Array.isArray(populate) ? populate : [populate];
};

const applySession = <
  TQuery extends { session: (session: ClientSession) => TQuery },
>(
  query: TQuery,
  session: ClientSession | null,
): TQuery => (session ? query.session(session) : query);

const emptyOrdersPage = (
  currentPage: number,
  pageSize: number,
): PaginatedOrdersResult => ({
  orders: [],
  totalCount: 0,
  totalPages: 0,
  currentPage,
  pageSize,
});

const findUserIdByCustomIdOrEmail = async (
  tenantId: string,
  customId?: string,
  email?: string,
): Promise<Types.ObjectId | null | "conflict"> => {
  let userId: Types.ObjectId | null = null;

  if (customId) {
    const user = await User.findOne({ tenant: tenantId, customId })
      .select("_id")
      .exec();

    if (!user) return null;
    userId = user._id;
  }

  if (email) {
    const user = await User.findOne({ tenant: tenantId, email })
      .select("_id")
      .exec();

    if (!user) return null;

    if (userId && userId.toString() !== user._id.toString()) {
      return "conflict";
    }

    userId = user._id;
  }

  return userId;
};

export const createOrderRepository = ({
  tenantId,
  session = null,
}: OrderRepositoryOptions) => {
  if (!tenantId) throw new Error("OrderRepository requires tenantId");

  const tenantIdString = String(tenantId);

  const scope = (filter: OrderQueryFilter = {}): OrderQueryFilter => ({
    ...filter,
    tenant: tenantIdString,
  });

  return {
    scope,

    find(filter: OrderQueryFilter = {}, options: FindOptions = {}) {
      const query = Order.find(scope(filter) as never);

      if (options.select) query.select(options.select);
      if (options.sort) query.sort(options.sort);
      if (options.skip !== undefined) query.skip(options.skip);
      if (options.limit !== undefined) query.limit(options.limit);

      for (const populate of asPopulateArray(options.populate)) {
        query.populate(populate);
      }

      applySession(query, session);

      return options.lean === false ? query.exec() : query.lean().exec();
    },

    findOne(filter: OrderQueryFilter = {}, options: FindOptions = {}) {
      const query = Order.findOne(scope(filter) as never);

      if (options.select) query.select(options.select);

      for (const populate of asPopulateArray(options.populate)) {
        query.populate(populate);
      }

      applySession(query, session);

      return options.lean === false ? query.exec() : query.lean().exec();
    },

    findById(orderId: IdLike, options: FindOptions = {}) {
      return this.findOne({ _id: orderId }, options);
    },

    findDocumentById(orderId: IdLike, options: FindOptions = {}) {
      return this.findOne({ _id: orderId }, { ...options, lean: false });
    },

    findByIdWithCart(orderId: IdLike) {
      const query = Order.findOne(scope({ _id: orderId }) as never).populate({
        path: "cart",
        populate: {
          path: "cartItems.product",
        },
      });

      applySession(query, session);
      return query.exec();
    },

    count(filter: OrderQueryFilter = {}) {
      const query = Order.countDocuments(scope(filter) as never);
      applySession(query, session);
      return query.exec();
    },

    create(payload: Record<string, unknown>) {
      return Order.create(
        [
          {
            ...payload,
            tenant: tenantIdString,
          },
        ],
        session ? { session } : undefined,
      ).then(([order]) => order);
    },

    updateById(orderId: IdLike, update: UpdateQuery<OrderDocument>) {
      return Order.findOneAndUpdate(scope({ _id: orderId }) as never, update, {
        returnDocument: "after",
        runValidators: true,
        ...(session ? { session } : {}),
      }).exec();
    },

    deleteById(orderId: IdLike) {
      const query = Order.deleteOne(scope({ _id: orderId }) as never);
      applySession(query, session);
      return query.exec();
    },

    deleteUnpaidPending(orderIds: IdLike[], pendingRegex: RegExp) {
      return Order.deleteMany({
        ...scope(),
        _id: { $in: orderIds },
        isPaid: { $ne: true },
        $and: [
          {
            $or: [{ status: pendingRegex }, { status: ORDER_STATUS.FAILED }],
          },
          {
            $or: [
              { "stripe.sessionId": { $exists: false } },
              { "stripe.sessionId": "" },
              { "stripe.sessionId": null },
            ],
          },
        ],
      }).exec();
    },

    findUnpaidStripeSessionOrders(orderIds: IdLike[]) {
      if (!orderIds.length) return Promise.resolve([]);

      return Order.find({
        ...scope(),
        _id: { $in: orderIds },
        isPaid: { $ne: true },
        "stripe.sessionId": { $type: "string", $ne: "" },
      })
        .select({ _id: 1, tenant: 1, "stripe.sessionId": 1 })
        .lean()
        .exec();
    },

    save(document: OrderDocument) {
      if (!document.tenant) document.tenant = tenantIdString as never;
      return document.save(session ? { session } : undefined);
    },
  };
};

export type OrderRepository = ReturnType<typeof createOrderRepository>;

export const listOrdersWithFilters = async ({
  tenantId,
  input,
  allowedLocationIds,
}: {
  tenantId: string;
  input: unknown;
  allowedLocationIds: AllowedWorkspaceLocationIds;
}): Promise<PaginatedOrdersResult> => {
  const normalized = parseOrderFilter(input);
  const skip = (normalized.page - 1) * normalized.limit;

  const queryFilter: OrderQueryFilter = {
    tenant: tenantId,
    ...buildOrderReadLocationFilter(allowedLocationIds, normalized.locationId),
  };

  if (normalized.search) {
    if (mongoose.isValidObjectId(normalized.search)) {
      queryFilter.$or = [
        { _id: toObjectId(normalized.search) },
        { createdBy: toObjectId(normalized.search) },
      ];
    } else {
      const matchingUsers = await User.find({
        tenant: tenantId,
        $or: [
          { customId: { $regex: normalized.search, $options: "i" } },
          { email: { $regex: normalized.search, $options: "i" } },
        ],
      })
        .select("_id")
        .lean()
        .exec();

      if (!matchingUsers.length) {
        return emptyOrdersPage(normalized.page, normalized.limit);
      }

      queryFilter.createdBy = {
        $in: matchingUsers.map((user) => user._id),
      };
    }
  }

  if (normalized.dateFrom || normalized.dateTo) {
    queryFilter.createdAt = {};

    if (normalized.dateFrom) {
      (queryFilter.createdAt as Record<string, unknown>).$gte =
        normalized.dateFrom;
    }

    if (normalized.dateTo) {
      (queryFilter.createdAt as Record<string, unknown>).$lte =
        normalized.dateTo;
    }
  }

  const explicitUserId = await findUserIdByCustomIdOrEmail(
    tenantId,
    normalized.userCustomId,
    normalized.userEmail,
  );

  if (
    explicitUserId === "conflict" ||
    (explicitUserId === null &&
      Boolean(normalized.userCustomId || normalized.userEmail))
  ) {
    return emptyOrdersPage(normalized.page, normalized.limit);
  }

  if (explicitUserId) {
    const existingCreatedBy = queryFilter.createdBy;

    if (
      existingCreatedBy &&
      typeof existingCreatedBy === "object" &&
      "$in" in existingCreatedBy &&
      Array.isArray((existingCreatedBy as { $in?: unknown[] }).$in)
    ) {
      const searchUserIds = (existingCreatedBy as { $in: unknown[] }).$in.map(
        (id) => String(id),
      );

      if (!searchUserIds.includes(explicitUserId.toString())) {
        return emptyOrdersPage(normalized.page, normalized.limit);
      }
    }

    queryFilter.createdBy = explicitUserId;
  }

  if (normalized.status) queryFilter.status = normalized.status;

  if (normalized.productType) {
    const productsOfType = await Product.find({
      type: normalized.productType,
    })
      .select("_id")
      .lean()
      .exec();

    if (!productsOfType.length) {
      return emptyOrdersPage(normalized.page, normalized.limit);
    }

    const cartRepository = createCartRepository({ tenantId });

    const cartsWithProductType =
      await cartRepository.findCartIdsContainingProducts(
        productsOfType.map((product) => product._id),
      );

    if (!cartsWithProductType.length) {
      return emptyOrdersPage(normalized.page, normalized.limit);
    }

    queryFilter.cart = {
      $in: cartsWithProductType.map((cart) => cart._id),
    };
  }

  const sort: Record<string, SortOrder> = {
    [normalized.sortBy]: normalized.sortOrder === "asc" ? 1 : -1,
  };

  const [orders, totalCount] = await Promise.all([
    Order.find(queryFilter)
      .populate({
        path: "createdBy",
        select: "firstname lastname customId email",
      })
      .populate({
        path: "cart",
        populate: {
          path: "cartItems.product",
          select: "name type price",
        },
      })
      .sort(sort)
      .skip(skip)
      .limit(normalized.limit)
      .lean()
      .exec(),

    Order.countDocuments(queryFilter).exec(),
  ]);

  return {
    orders,
    totalCount,
    totalPages: Math.ceil(totalCount / normalized.limit),
    currentPage: normalized.page,
    pageSize: normalized.limit,
  };
};

export const findOrderByIdForRead = async ({
  tenantId,
  orderId,
  allowedLocationIds,
}: {
  tenantId: string;
  orderId: string;
  allowedLocationIds: AllowedWorkspaceLocationIds;
}) => {
  if (!mongoose.isValidObjectId(orderId)) {
    return null;
  }

  return Order.findOne({
    tenant: tenantId,
    _id: toObjectId(orderId),
    ...buildOrderLocationScopeFilter(allowedLocationIds),
  })
    .populate({
      path: "createdBy",
      select: "firstname lastname customId email",
    })
    .populate({
      path: "cart",
      populate: {
        path: "cartItems.product",
        select: "name type price",
      },
    })
    .lean()
    .exec();
};

const notificationPaymentFilter = () => ({
  $or: [
    { pieceCheckout: null },
    {
      "pieceCheckout.state": "paid" as const,
      "pieceCheckout.refundedAmountMinor": { $in: [null, 0] },
    },
  ],
});

export const findOrderNotificationCandidates = async (now: Date) => {
  const retryCutoff = new Date(
    now.getTime() - ORDER_NOTIFICATION_RETRY_DELAY_MS,
  );
  const firstSendSince = new Date(
    now.getTime() - ORDER_NOTIFICATION_FIRST_SEND_WINDOW_HOURS * 60 * 60 * 1000,
  );
  const fallbackSendSince = new Date(
    now.getTime() -
      ORDER_NOTIFICATION_FALLBACK_SEND_WINDOW_HOURS * 60 * 60 * 1000,
  );
  const retrySince = new Date(
    now.getTime() - ORDER_NOTIFICATION_RETRY_WINDOW_HOURS * 60 * 60 * 1000,
  );

  const lockFreeFilter = {
    $or: [
      { "notificationLock.lockedUntil": null },
      { "notificationLock.lockedUntil": { $lte: now } },
      { notificationLock: { $exists: false } },
    ],
  };

  const timeRefInWindow = (since: Date) => ({
    $or: [
      { paidAt: { $gte: since } },
      { paidAt: null, createdAt: { $gte: since } },
      { paidAt: { $exists: false }, createdAt: { $gte: since } },
    ],
  });

  const noSentYet = {
    notificationLog: {
      $not: {
        $elemMatch: {
          type: ORDER_CONFIRM_NOTIFICATION_TYPE,
          status: ORDER_NOTIFICATION_STATUS.SENT,
        },
      },
    },
  };

  const noEntryYet = {
    notificationLog: {
      $not: { $elemMatch: { type: ORDER_CONFIRM_NOTIFICATION_TYPE } },
    },
  };

  const retryEligibleFilter = {
    notificationLog: {
      $elemMatch: {
        type: ORDER_CONFIRM_NOTIFICATION_TYPE,
        status: {
          $in: [
            ORDER_NOTIFICATION_STATUS.FAILED,
            ORDER_NOTIFICATION_STATUS.PROCESSING,
          ],
        },
        provider: { $ne: "exhausted" },
        retryable: { $ne: false },
        sentAt: { $lte: retryCutoff },
      },
    },
  };

  return Order.find({
    isPaid: true,
    legacyOrder: { $ne: true },
    status: ORDER_STATUS.PROCESSED,
    $and: [
      lockFreeFilter,
      notificationPaymentFilter(),
      {
        $or: [
          { $and: [timeRefInWindow(firstSendSince), noEntryYet, noSentYet] },
          { $and: [timeRefInWindow(fallbackSendSince), noEntryYet, noSentYet] },
          { $and: [timeRefInWindow(retrySince), retryEligibleFilter] },
          {
            $and: [
              { "notificationRecovery.expiresAt": { $gt: now } },
              { $or: [noEntryYet, retryEligibleFilter] },
              noSentYet,
            ],
          },
          // Interrupted submissions must be quarantined even after the normal
          // delivery window. A missing version belongs to the old SMTP worker.
          {
            notificationLog: {
              $elemMatch: {
                type: ORDER_CONFIRM_NOTIFICATION_TYPE,
                status: ORDER_NOTIFICATION_STATUS.PROCESSING,
                sentAt: { $lte: retryCutoff },
                $or: [
                  { deliveryVersion: { $ne: 1 } },
                  { providerStartedAt: { $ne: null } },
                ],
              },
            },
          },
        ],
      },
    ],
  })
    .sort({ paidAt: -1, createdAt: -1 })
    .limit(ORDER_NOTIFICATION_BATCH_LIMIT)
    .select("_id")
    .lean()
    .exec();
};

export const acquireOrderNotificationLock = async ({
  orderId,
  lockOwner,
  now,
}: {
  orderId: Types.ObjectId;
  lockOwner: string;
  now: Date;
}): Promise<OrderDocument | null> => {
  const lockedUntil = new Date(now.getTime() + ORDER_NOTIFICATION_LOCK_MS);

  return Order.findOneAndUpdate(
    {
      _id: orderId,
      isPaid: true,
      $and: [notificationPaymentFilter()],
      status: ORDER_STATUS.PROCESSED,
      legacyOrder: { $ne: true },
      $or: [
        { "notificationLock.lockedUntil": null },
        { "notificationLock.lockedUntil": { $lte: now } },
        { notificationLock: { $exists: false } },
      ],
    },
    {
      $set: {
        "notificationLock.lockedUntil": lockedUntil,
        "notificationLock.lockedAt": now,
        "notificationLock.lockedBy": lockOwner,
      },
    },
    { returnDocument: "after" },
  ).exec();
};

export const releaseOrderNotificationLock = async ({
  orderId,
  lockOwner,
}: {
  orderId: Types.ObjectId;
  lockOwner: string;
}): Promise<void> => {
  await Order.updateOne(
    { _id: orderId, "notificationLock.lockedBy": lockOwner },
    {
      $set: {
        "notificationLock.lockedUntil": null,
        "notificationLock.lockedAt": null,
        "notificationLock.lockedBy": "",
      },
    },
  ).exec();
};

export const findOrderForNotification = async (
  orderId: Types.ObjectId,
): Promise<OrderWithCreatedByUser | null> => {
  return Order.findOne({ _id: orderId, ...notificationPaymentFilter() })
    .populate("createdBy", "email firstname lastname customId")
    .lean<OrderWithCreatedByUser>()
    .exec();
};

type OrderNotificationClaim = {
  orderId: Types.ObjectId;
  lockOwner: string;
};

type OrderNotificationAttempt = OrderNotificationClaim & { claimId: string };

const attemptFilter = (
  claimId: string,
  statuses: OrderNotificationStatus[] = [ORDER_NOTIFICATION_STATUS.PROCESSING],
) => ({
  "entry.type": ORDER_CONFIRM_NOTIFICATION_TYPE,
  "entry.claimId": claimId || { $in: [null, ""] },
  "entry.status": { $in: statuses },
});

const activeNotificationClaim = (
  { orderId, lockOwner }: OrderNotificationClaim,
  now: Date,
) => ({
  _id: orderId,
  isPaid: true,
  ...notificationPaymentFilter(),
  status: ORDER_STATUS.PROCESSED,
  legacyOrder: { $ne: true },
  "notificationLock.lockedBy": lockOwner,
  "notificationLock.lockedUntil": { $gt: now },
});

export const renewOrderNotificationLock = async ({
  orderId,
  lockOwner,
  now,
}: OrderNotificationClaim & { now: Date }): Promise<boolean> => {
  const result = await Order.updateOne(
    activeNotificationClaim({ orderId, lockOwner }, now),
    {
      $set: {
        "notificationLock.lockedUntil": new Date(
          now.getTime() + ORDER_NOTIFICATION_LOCK_MS,
        ),
      },
    },
  ).exec();
  return result.matchedCount === 1;
};

export const markFirstOrderNotificationClaimed = async ({
  orderId,
  lockOwner,
  to,
  claimTime,
  claimId,
}: OrderNotificationAttempt & {
  to: string;
  claimTime: Date;
}) => {
  return Order.findOneAndUpdate(
    {
      ...activeNotificationClaim({ orderId, lockOwner }, claimTime),
      notificationLog: {
        $not: { $elemMatch: { type: ORDER_CONFIRM_NOTIFICATION_TYPE } },
      },
    },
    {
      $push: {
        notificationLog: {
          type: ORDER_CONFIRM_NOTIFICATION_TYPE,
          sentAt: claimTime,
          channel: "email",
          to,
          status: ORDER_NOTIFICATION_STATUS.PROCESSING,
          attempt: 1,
          claimId,
          deliveryVersion: 1,
          providerStartedAt: null,
          retryable: true,
        },
      },
    },
  ).exec();
};

export const markRetryOrderNotificationClaimed = async ({
  orderId,
  lockOwner,
  to,
  claimTime,
  retryCutoff,
  claimId,
}: OrderNotificationAttempt & {
  to: string;
  claimTime: Date;
  retryCutoff: Date;
}) => {
  return Order.findOneAndUpdate(
    {
      ...activeNotificationClaim({ orderId, lockOwner }, claimTime),
      notificationLog: {
        $elemMatch: {
          type: ORDER_CONFIRM_NOTIFICATION_TYPE,
          $or: [
            {
              status: ORDER_NOTIFICATION_STATUS.FAILED,
              retryable: { $ne: false },
              $or: [
                { deliveryVersion: 1 },
                { error: /^connect ECONNREFUSED 127\.0\.0\.1:1025$/i },
              ],
            },
            {
              status: ORDER_NOTIFICATION_STATUS.PROCESSING,
              deliveryVersion: 1,
              providerStartedAt: null,
            },
          ],
          attempt: { $lt: ORDER_NOTIFICATION_MAX_RETRIES },
          sentAt: { $lte: retryCutoff },
          providerStartedAt: null,
        },
      },
    },
    {
      $set: {
        "notificationLog.$[entry].sentAt": claimTime,
        "notificationLog.$[entry].status": ORDER_NOTIFICATION_STATUS.PROCESSING,
        "notificationLog.$[entry].to": to,
        "notificationLog.$[entry].error": "",
        "notificationLog.$[entry].provider": "",
        "notificationLog.$[entry].template": "",
        "notificationLog.$[entry].providerMessageId": "",
        "notificationLog.$[entry].providerStartedAt": null,
        "notificationLog.$[entry].claimId": claimId,
        "notificationLog.$[entry].deliveryVersion": 1,
        "notificationLog.$[entry].retryable": true,
      },
      $inc: { "notificationLog.$[entry].attempt": 1 },
    },
    {
      arrayFilters: [
        {
          $and: [
            {
              "entry.type": ORDER_CONFIRM_NOTIFICATION_TYPE,
              "entry.status": {
                $in: [
                  ORDER_NOTIFICATION_STATUS.FAILED,
                  ORDER_NOTIFICATION_STATUS.PROCESSING,
                ],
              },
              "entry.attempt": { $lt: ORDER_NOTIFICATION_MAX_RETRIES },
              "entry.sentAt": { $lte: retryCutoff },
              "entry.providerStartedAt": null,
              "entry.retryable": { $ne: false },
            },
            {
              $or: [
                { "entry.deliveryVersion": 1 },
                {
                  "entry.status": ORDER_NOTIFICATION_STATUS.FAILED,
                  "entry.error": /^connect ECONNREFUSED 127\.0\.0\.1:1025$/i,
                },
              ],
            },
          ],
        },
      ],
    },
  ).exec();
};

export const markOrderNotificationProviderStarted = async ({
  orderId,
  lockOwner,
  claimId,
  now,
}: OrderNotificationAttempt & { now: Date }): Promise<boolean> => {
  const result = await Order.updateOne(
    {
      ...activeNotificationClaim({ orderId, lockOwner }, now),
      notificationLog: {
        $elemMatch: {
          type: ORDER_CONFIRM_NOTIFICATION_TYPE,
          claimId,
          status: ORDER_NOTIFICATION_STATUS.PROCESSING,
          providerStartedAt: null,
        },
      },
    },
    {
      $set: {
        "notificationLock.lockedUntil": new Date(
          now.getTime() + ORDER_NOTIFICATION_LOCK_MS,
        ),
        "notificationLog.$[entry].providerStartedAt": now,
        "notificationLog.$[entry].provider": "postmark",
      },
    },
    { arrayFilters: [attemptFilter(claimId)] },
  ).exec();
  return result.modifiedCount === 1;
};

export const markOrderNotificationSent = async ({
  orderId,
  lockOwner,
  provider,
  providerMessageId,
  template,
  claimId,
}: OrderNotificationAttempt & {
  provider?: string | null;
  providerMessageId?: string | null;
  template?: string | null;
}): Promise<void> => {
  await Order.updateOne(
    { _id: orderId, "notificationLock.lockedBy": lockOwner },
    {
      $set: {
        "notificationLog.$[entry].provider": provider || "postmark",
        "notificationLog.$[entry].providerMessageId": providerMessageId || "",
        "notificationLog.$[entry].template":
          template || "order-confirm-general-v1",
        "notificationLog.$[entry].status": ORDER_NOTIFICATION_STATUS.SENT,
        "notificationLog.$[entry].sentAt": new Date(),
        "notificationLog.$[entry].error": "",
      },
    },
    { arrayFilters: [attemptFilter(claimId)] },
  ).exec();
};

export const markOrderNotificationFailed = async ({
  orderId,
  lockOwner,
  errorMessage,
  claimId,
  retryable = true,
}: OrderNotificationAttempt & {
  errorMessage: string;
  retryable?: boolean;
}): Promise<void> => {
  await Order.updateOne(
    { _id: orderId, "notificationLock.lockedBy": lockOwner },
    {
      $set: {
        "notificationLog.$[entry].status": ORDER_NOTIFICATION_STATUS.FAILED,
        "notificationLog.$[entry].error": errorMessage.slice(0, 2000),
        "notificationLog.$[entry].retryable": retryable,
        "notificationLog.$[entry].providerStartedAt": null,
      },
    },
    { arrayFilters: [attemptFilter(claimId)] },
  ).exec();
};

export const markOrderNotificationAmbiguous = async ({
  orderId,
  lockOwner,
  claimId,
  errorMessage,
}: OrderNotificationAttempt & { errorMessage: string }): Promise<void> => {
  await Order.updateOne(
    { _id: orderId, "notificationLock.lockedBy": lockOwner },
    {
      $set: {
        "notificationLog.$[entry].status": ORDER_NOTIFICATION_STATUS.AMBIGUOUS,
        "notificationLog.$[entry].error": errorMessage.slice(0, 2000),
        "notificationLog.$[entry].retryable": false,
      },
    },
    {
      arrayFilters: [
        attemptFilter(claimId, [
          ORDER_NOTIFICATION_STATUS.PROCESSING,
          ORDER_NOTIFICATION_STATUS.FAILED,
        ]),
      ],
    },
  ).exec();
};

export const markOrderNotificationExhausted = async ({
  orderId,
  lockOwner,
  claimId,
}: OrderNotificationAttempt): Promise<boolean> => {
  const result = await Order.updateOne(
    {
      _id: orderId,
      "notificationLock.lockedBy": lockOwner,
      notificationLog: {
        $elemMatch: {
          type: ORDER_CONFIRM_NOTIFICATION_TYPE,
          claimId: claimId || { $in: [null, ""] },
          status: {
            $in: [
              ORDER_NOTIFICATION_STATUS.FAILED,
              ORDER_NOTIFICATION_STATUS.PROCESSING,
            ],
          },
          provider: { $ne: "exhausted" },
        },
      },
    },
    {
      $set: {
        "notificationLog.$[entry].status": ORDER_NOTIFICATION_STATUS.FAILED,
        "notificationLog.$[entry].provider": "exhausted",
        "notificationLog.$[entry].template": "exhausted",
      },
    },
    {
      arrayFilters: [
        attemptFilter(claimId, [
          ORDER_NOTIFICATION_STATUS.FAILED,
          ORDER_NOTIFICATION_STATUS.PROCESSING,
        ]),
      ],
    },
  ).exec();
  return result.modifiedCount === 1;
};
