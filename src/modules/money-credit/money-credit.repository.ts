import type { ClientSession, Types } from "mongoose";

import { MoneyCredit } from "./money-credit.model.js";
import type { MoneyCreditDocument } from "./money-credit.types.js";
import { toObjectId } from "@/shared/helpers/helper.js";
import type { StudioCommerceCurrency } from "@/shared/money/currency.js";
import { normalizeCreditCurrency } from "./money-credit.utils.js";
import {
  creditMinorToMajor,
  legacyCreditMajorToMinorUnits,
  resolveCreditBalanceMinor,
} from "./money-credit.balance.js";

type IdLike = string | Types.ObjectId;

type MoneyCreditRepositoryOptions = {
  tenantId: IdLike;
  session?: ClientSession | null;
};

export type CreditTransactionPayload = {
  type: string;
  amount: number;
  amountMinor?: number | null;
  currency: StudioCommerceCurrency;
  description?: string;
  relatedOrder?: Types.ObjectId | null;
  relatedBooking?: Types.ObjectId | null;
  relatedCoupon?: Types.ObjectId | null;
  adminId?: Types.ObjectId | null;
  adminName?: string;
  reason?: string;
  idempotencyKey?: string;
};

const toIdString = (value: IdLike): string => String(value);

export const createMoneyCreditRepository = ({
  tenantId,
  session = null,
}: MoneyCreditRepositoryOptions) => {
  if (!tenantId) {
    throw new Error("MoneyCreditRepository requires tenantId");
  }

  const tenantObjectId = toObjectId(toIdString(tenantId));

  return {
    findByUser(userId: IdLike): Promise<MoneyCreditDocument | null> {
      return MoneyCredit.findOne({
        tenant: tenantObjectId,
        user: toObjectId(toIdString(userId)),
      })
        .session(session)
        .exec();
    },

    async findTransactions(
      userId: IdLike,
      { page = 1, limit = 20 }: { page?: number; limit?: number } = {},
    ) {
      const normalizedPage = Math.max(1, Math.trunc(Number(page) || 1));
      const normalizedLimit = Math.min(
        100,
        Math.max(1, Math.trunc(Number(limit) || 20)),
      );
      const [record] = await MoneyCredit.aggregate([
        {
          $match: {
            tenant: tenantObjectId,
            user: toObjectId(toIdString(userId)),
          },
        },
        {
          $project: {
            currency: 1,
            totalCount: {
              $size: { $ifNull: ["$transactions", []] },
            },
            transactions: {
              $slice: [
                {
                  $reverseArray: { $ifNull: ["$transactions", []] },
                },
                (normalizedPage - 1) * normalizedLimit,
                normalizedLimit,
              ],
            },
          },
        },
      ])
        .session(session)
        .exec();

      return record ?? null;
    },

    async createForUser(
      userId: IdLike,
      balance = 0,
      currency: unknown = "CZK",
      balanceMinor: number | null = null,
    ): Promise<MoneyCreditDocument> {
      const normalizedCurrency = normalizeCreditCurrency(currency);

      const [created] = await MoneyCredit.create(
        [
          {
            tenant: tenantObjectId,
            user: toObjectId(toIdString(userId)),
            balance,
            balanceMinor,
            currency: normalizedCurrency,
            transactions: [],
          },
        ],
        session ? { session } : undefined,
      );

      return created;
    },

    async ensureRecord(
      userId: IdLike,
      currency: unknown = "CZK",
    ): Promise<MoneyCreditDocument> {
      const existing = await this.findByUser(userId);

      if (existing) {
        return existing;
      }

      return this.createForUser(userId, 0, normalizeCreditCurrency(currency));
    },

    async addTransaction(
      userId: IdLike,
      transaction: CreditTransactionPayload,
    ): Promise<MoneyCreditDocument> {
      const record = await this.ensureRecord(userId, transaction.currency);
      const currency = normalizeCreditCurrency(record.currency);
      const currentMinor = resolveCreditBalanceMinor({
        moneyCreditsMinor: record.balanceMinor,
        moneyCredits: record.balance,
        currency,
      });
      const amountMinor =
        transaction.amountMinor == null
          ? legacyCreditMajorToMinorUnits(transaction.amount, currency)
          : Number(transaction.amountMinor);

      if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
        throw new Error("Credit transaction amountMinor must be non-negative.");
      }

      const nextMinor = currentMinor + amountMinor;
      if (!Number.isSafeInteger(nextMinor)) {
        throw new Error("Credit balance exceeds the safe integer range.");
      }

      record.balanceMinor = nextMinor;
      record.balance = creditMinorToMajor(nextMinor, currency);
      record.transactions.push({
        ...transaction,
        amountMinor,
        amount: creditMinorToMajor(amountMinor, currency),
      });

      return this.save(record);
    },

    save(document: MoneyCreditDocument): Promise<MoneyCreditDocument> {
      return document.save(session ? { session } : undefined);
    },
  };
};

export type MoneyCreditRepository = ReturnType<
  typeof createMoneyCreditRepository
>;

export const moneyCreditRepository = {
  findByUser: (tenantId: string, userId: string) =>
    createMoneyCreditRepository({ tenantId }).findByUser(userId),

  findTransactions: (
    tenantId: string,
    userId: string,
    pagination?: { page?: number; limit?: number },
  ) =>
    createMoneyCreditRepository({ tenantId }).findTransactions(
      userId,
      pagination,
    ),

  createForUser: (
    tenantId: string,
    userId: string,
    balance = 0,
    currency: unknown = "CZK",
    session?: ClientSession | null,
    balanceMinor: number | null = null,
  ) =>
    createMoneyCreditRepository({ tenantId, session }).createForUser(
      userId,
      balance,
      currency,
      balanceMinor,
    ),

  ensureRecord: (
    tenantId: string,
    userId: string,
    currency: unknown = "CZK",
    session?: ClientSession | null,
  ) =>
    createMoneyCreditRepository({ tenantId, session }).ensureRecord(
      userId,
      currency,
    ),

  addTransaction: (
    tenantId: string,
    userId: string,
    transaction: CreditTransactionPayload,
    session?: ClientSession | null,
  ) =>
    createMoneyCreditRepository({ tenantId, session }).addTransaction(
      userId,
      transaction,
    ),

  save: (
    tenantId: string,
    document: MoneyCreditDocument,
    session?: ClientSession | null,
  ) => createMoneyCreditRepository({ tenantId, session }).save(document),
};
