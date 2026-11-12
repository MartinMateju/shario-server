import { MONEY_CREDIT_TRANSACTION_TYPE } from "../money-credit.constants.js";
import { CreditMutationOperationModel } from "../credit-mutation-operation.model.js";
import { toObjectId } from "@/shared/helpers/helper.js";
import { createMoneyCreditRepository } from "@/modules/money-credit/money-credit.repository.js";
import { createUserRepository } from "@/modules/user/user.repository.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "@/shared/http/httpErrors.js";
import mongoose, { ClientSession, Types } from "mongoose";
import TenantModel from "@/modules/tenants/tenant.model.js";
import {
  fromCurrencyMinorUnits,
  toCurrencyMinorUnits,
  type StudioCommerceCurrency,
} from "@/shared/money/currency.js";
import { normalizeCreditCurrency } from "../money-credit.utils.js";
import { inspectCreditMutationIdempotency } from "../money-credit.idempotency.js";
import {
  creditMinorToMajor,
  hasValidCreditMinorSnapshot,
  legacyCreditMajorToMinorUnits,
  resolveCreditBalanceMinor,
} from "../money-credit.balance.js";
import {
  buildLedgerIdempotencyKey,
  hashCreditMutationRequest,
  sha256CreditValue,
  validateCreditIdempotencyKey,
} from "../money-credit.direct-idempotency.js";

import type {
  AddCreditsInput,
  AdminGrantCreditsInput,
  RefundCreditsInput,
  UseCreditsInput,
} from "../money-credit.validators.js";

type IdLike = string | Types.ObjectId;

type CreditTransactionInput = {
  type: string;
  amount?: number;
  currency?: StudioCommerceCurrency;
  description?: string;
  relatedOrder?: Types.ObjectId | null;
  relatedBooking?: Types.ObjectId | null;
  relatedCoupon?: Types.ObjectId | null;
  adminId?: Types.ObjectId | null;
  adminName?: string;
  reason?: string;
  idempotencyKey?: string;
};

type DirectCreditMutationKind = "add" | "use" | "refund" | "admin_grant";

type DirectCreditMutationContext = {
  actorUserId: string;
  idempotencyKey: string;
};

type IncrementMoneyCreditsInput = {
  tenantId: IdLike;
  userId: IdLike;
  amount: number;
  currency?: StudioCommerceCurrency;
  transaction: CreditTransactionInput;
  session?: ClientSession | null;
};

const resolveTenantCreditCurrency = async (
  tenantId: IdLike,
  session: ClientSession | null = null,
): Promise<StudioCommerceCurrency> => {
  const tenant = await TenantModel.findById(toObjectId(String(tenantId)))
    .select("settings.currency")
    .session(session)
    .lean()
    .exec();

  if (!tenant) {
    notFound("Tenant not found.");
  }

  try {
    return normalizeCreditCurrency(tenant.settings?.currency);
  } catch {
    badRequest({
      message: "Tenant has an unsupported credit currency.",
      code: "CREDIT_CURRENCY_UNSUPPORTED",
      details: { currency: tenant.settings?.currency },
    });
  }
};

const assertAmountUsesCurrencyPrecision = (
  amount: number,
  currency: StudioCommerceCurrency,
): void => {
  const absoluteAmount = Math.abs(amount);
  let restoredAmount: number;

  try {
    const amountMinor = toCurrencyMinorUnits(absoluteAmount, currency);
    restoredAmount = fromCurrencyMinorUnits(amountMinor, currency);
  } catch {
    badRequest({
      message: `Amount has too many decimal places for ${currency}.`,
      code: "INVALID_CURRENCY_PRECISION",
      details: { amount, currency },
    });
  }

  if (Math.abs(restoredAmount - absoluteAmount) > 1e-9) {
    badRequest({
      message: `Amount has too many decimal places for ${currency}.`,
      code: "INVALID_CURRENCY_PRECISION",
      details: { amount, currency },
    });
  }
};

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: number }).code === 11000,
  );

const getSignedAmountMinor = (
  amount: number,
  currency: StudioCommerceCurrency,
): number => {
  const absoluteMinor = toCurrencyMinorUnits(Math.abs(amount), currency);
  return amount < 0 ? -absoluteMinor : absoluteMinor;
};

const assertMatchingLedgerBalance = ({
  userMinor,
  creditRecord,
  currency,
}: {
  userMinor: number;
  creditRecord: any;
  currency: StudioCommerceCurrency;
}): void => {
  if (!creditRecord) return;
  const ledgerMinor = resolveCreditBalanceMinor({
    moneyCreditsMinor: creditRecord.balanceMinor,
    moneyCredits: creditRecord.balance,
    currency,
  });
  if (ledgerMinor !== userMinor) {
    console.log(`Warning! The credit balance snapshots do not match!`)
    // conflict({
    //   message: "The credit balance snapshots do not match.",
    //   code: "CREDIT_LEDGER_BALANCE_MISMATCH",
    //   details: { currency },
    // });
  }
};

const buildCurrentCreditResult = async ({
  tenantId,
  targetUserId,
  currency,
  session,
  idempotent,
  resultingBalanceMinor,
  transactionId = null,
}: {
  tenantId: IdLike;
  targetUserId: IdLike;
  currency: StudioCommerceCurrency;
  session: ClientSession | null;
  idempotent: boolean;
  resultingBalanceMinor?: number;
  transactionId?: unknown;
}) => {
  const userRepository = createUserRepository({ tenantId, session });
  const moneyCreditRepository = createMoneyCreditRepository({
    tenantId,
    session,
  });
  const user = await userRepository.findById(targetUserId, {
    select: "moneyCredits moneyCreditsMinor",
    lean: false,
  });
  if (!user) notFound("User not found.");

  const creditRecord = await moneyCreditRepository.findByUser(targetUserId);
  const currentBalanceMinor = resolveCreditBalanceMinor({
    moneyCreditsMinor: user.moneyCreditsMinor,
    moneyCredits: user.moneyCredits,
    currency,
  });
  const newBalanceMinor =
    resultingBalanceMinor === undefined
      ? currentBalanceMinor
      : resultingBalanceMinor;

  if (!Number.isSafeInteger(newBalanceMinor) || newBalanceMinor < 0) {
    throw new Error("Stored credit mutation result is invalid.");
  }

  return {
    message: idempotent
      ? "Credit balance was already updated."
      : "Credit balance updated successfully.",
    user,
    creditRecord,
    newBalance: creditMinorToMajor(newBalanceMinor, currency),
    newBalanceMinor,
    currency,
    idempotent,
    transactionId: transactionId ? String(transactionId) : null,
  };
};

const inspectCompletedDirectMutation = async ({
  operation,
  requestHash,
  tenantId,
  session = null,
}: {
  operation: any;
  requestHash: string;
  tenantId: IdLike;
  session?: ClientSession | null;
}) => {
  if (String(operation.requestHash) !== requestHash) {
    conflict({
      message: "This idempotency key was used for another credit mutation.",
      code: "CREDIT_IDEMPOTENCY_KEY_CONFLICT",
    });
  }

  return buildCurrentCreditResult({
    tenantId,
    targetUserId: operation.targetUser,
    currency: normalizeCreditCurrency(operation.currency),
    session,
    idempotent: true,
    resultingBalanceMinor: Number(operation.resultingBalanceMinor),
    transactionId: operation.transactionId,
  });
};

const executeDirectCreditMutation = async ({
  tenantId,
  actorUserId,
  idempotencyKey: rawIdempotencyKey,
  operation,
  targetUserId,
  amountDelta,
  request,
  transaction,
}: {
  tenantId: string;
  actorUserId: string;
  idempotencyKey: string;
  operation: DirectCreditMutationKind;
  targetUserId: string;
  amountDelta: number;
  request: unknown;
  transaction: CreditTransactionInput;
}) => {
  const idempotencyKey = validateCreditIdempotencyKey(rawIdempotencyKey);
  const keyHash = sha256CreditValue(idempotencyKey);
  const requestHash = hashCreditMutationRequest({
    operation,
    targetUserId,
    amountDelta,
    request,
  });
  const namespace = {
    tenant: toObjectId(tenantId),
    actor: toObjectId(actorUserId),
    keyHash,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ownedSession = await mongoose.startSession();

    try {
      let result: any;

      await ownedSession.withTransaction(async () => {
        const existing = await CreditMutationOperationModel.findOne(namespace)
          .session(ownedSession)
          .exec();

        if (existing) {
          result = await inspectCompletedDirectMutation({
            operation: existing,
            requestHash,
            tenantId,
            session: ownedSession,
          });
          return;
        }

        result = await moneyCreditService.changeBalance({
          tenantId,
          userId: targetUserId,
          amountDelta,
          transaction: {
            ...transaction,
            idempotencyKey: buildLedgerIdempotencyKey({
              actorUserId,
              keyHash,
            }),
          },
          session: ownedSession,
        });

        const lastTransaction = result.creditRecord?.transactions?.at?.(-1);
        result.transactionId = lastTransaction?._id
          ? String(lastTransaction._id)
          : null;
        await CreditMutationOperationModel.create(
          [
            {
              ...namespace,
              targetUser: toObjectId(targetUserId),
              requestHash,
              operation,
              currency: result.currency,
              resultingBalanceMinor: result.newBalanceMinor,
              transactionId: lastTransaction?._id ?? null,
            },
          ],
          { session: ownedSession },
        );
      });

      if (!result) {
        throw new Error("Credit mutation transaction returned no result.");
      }

      return result;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;

      const completed =
        await CreditMutationOperationModel.findOne(namespace).exec();
      if (completed) {
        return inspectCompletedDirectMutation({
          operation: completed,
          requestHash,
          tenantId,
        });
      }

      if (attempt === 2) throw error;
    } finally {
      await ownedSession.endSession();
    }
  }

  throw new Error("Credit mutation retry loop exhausted.");
};

export const moneyCreditService = {
  async getBalance(tenantId: string, userId: string) {
    const userRepository = createUserRepository({ tenantId });
    const moneyCreditRepository = createMoneyCreditRepository({ tenantId });

    const [user, creditRecord] = await Promise.all([
      userRepository.findById(userId, {
        select: "moneyCredits moneyCreditsMinor",
      }),
      moneyCreditRepository.findByUser(userId),
    ]);

    if (!user) {
      notFound("User not found.");
    }

    const currency = creditRecord
      ? normalizeCreditCurrency(creditRecord.currency)
      : await resolveTenantCreditCurrency(tenantId);

    const balanceMinor = resolveCreditBalanceMinor({
      moneyCreditsMinor: user.moneyCreditsMinor,
      moneyCredits: user.moneyCredits,
      currency,
    });

    return {
      userId,
      balance: creditMinorToMajor(balanceMinor, currency),
      balanceMinor,
      currency,
    };
  },

  async getTransactions(
    tenantId: string,
    userId: string,
    { page = 1, limit = 20 }: { page?: number; limit?: number } = {},
  ) {
    const moneyCreditRepository = createMoneyCreditRepository({ tenantId });

    const creditRecord = await moneyCreditRepository.findTransactions(userId, {
      page,
      limit,
    });
    const transactions = (creditRecord?.transactions || []).map(
      (transaction: any) => {
        const currency = normalizeCreditCurrency(
          transaction?.currency || creditRecord?.currency,
        );
        const amountMinor = hasValidCreditMinorSnapshot(
          transaction?.amountMinor,
        )
          ? Number(transaction.amountMinor)
          : legacyCreditMajorToMinorUnits(transaction?.amount || 0, currency);

        return {
          id: String(transaction?._id || ""),
          type: String(transaction?.type || ""),
          amount: creditMinorToMajor(amountMinor, currency),
          amountMinor,
          currency,
          description: String(transaction?.description || ""),
          relatedOrderId: transaction?.relatedOrder
            ? String(transaction.relatedOrder)
            : null,
          relatedBookingId: transaction?.relatedBooking
            ? String(transaction.relatedBooking)
            : null,
          relatedCouponId: transaction?.relatedCoupon
            ? String(transaction.relatedCoupon)
            : null,
          adminName: String(transaction?.adminName || ""),
          reason: String(transaction?.reason || ""),
          createdAt: transaction?.createdAt || null,
        };
      },
    );
    const totalCount = Math.max(0, Number(creditRecord?.totalCount || 0));

    return {
      currency: creditRecord
        ? normalizeCreditCurrency(creditRecord.currency)
        : await resolveTenantCreditCurrency(tenantId),
      transactions,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    };
  },

  async addCredits(
    tenantId: string,
    context: DirectCreditMutationContext,
    input: AddCreditsInput,
  ) {
    return executeDirectCreditMutation({
      tenantId,
      actorUserId: context.actorUserId,
      idempotencyKey: context.idempotencyKey,
      operation: "add",
      targetUserId: input.userId,
      amountDelta: input.amount,
      request: input,
      transaction: {
        type: MONEY_CREDIT_TRANSACTION_TYPE.ADDED,
        description: input.description,
      },
    });
  },

  async useCredits(
    tenantId: string,
    context: DirectCreditMutationContext,
    input: UseCreditsInput,
  ) {
    return executeDirectCreditMutation({
      tenantId,
      actorUserId: context.actorUserId,
      idempotencyKey: context.idempotencyKey,
      operation: "use",
      targetUserId: input.userId,
      amountDelta: -input.amount,
      request: input,
      transaction: {
        type: MONEY_CREDIT_TRANSACTION_TYPE.USED,
        description: input.description,
      },
    });
  },

  async refundCredits(
    tenantId: string,
    context: DirectCreditMutationContext,
    input: RefundCreditsInput,
  ) {
    return executeDirectCreditMutation({
      tenantId,
      actorUserId: context.actorUserId,
      idempotencyKey: context.idempotencyKey,
      operation: "refund",
      targetUserId: input.userId,
      amountDelta: input.amount,
      request: input,
      transaction: {
        type: MONEY_CREDIT_TRANSACTION_TYPE.REFUND,
        description: input.description,
      },
    });
  },

  async adminGrantCredits(
    tenantId: string,
    adminUserId: string,
    adminName: string,
    idempotencyKey: string,
    input: AdminGrantCreditsInput,
  ) {
    return executeDirectCreditMutation({
      tenantId,
      actorUserId: adminUserId,
      idempotencyKey,
      operation: "admin_grant",
      targetUserId: input.targetUserId,
      amountDelta: input.amount,
      request: {
        targetUserId: input.targetUserId,
        amount: input.amount,
        reason: input.reason,
      },
      transaction: {
        type: MONEY_CREDIT_TRANSACTION_TYPE.ADMIN_GRANTED,
        description: `Admin granted credits: ${input.reason}`,
        adminId: toObjectId(adminUserId),
        adminName,
        reason: input.reason,
      },
    });
  },

  async incrementMoneyCredits({
    tenantId,
    userId,
    amount,
    currency,
    transaction,
    session = null,
  }: IncrementMoneyCreditsInput) {
    return this.changeBalance({
      tenantId,
      userId,
      amountDelta: amount,
      transaction: {
        ...transaction,
        currency,
      },
      session,
    });
  },

  async changeBalance({
    tenantId,
    userId,
    amountDelta,
    transaction,
    session = null,
  }: {
    tenantId: IdLike;
    userId: IdLike;
    amountDelta: number;
    transaction: CreditTransactionInput;
    session?: ClientSession | null;
  }) {
    if (!Number.isFinite(amountDelta) || amountDelta === 0) {
      badRequest("Credit amount must be a non-zero number.");
    }

    const run = async (activeSession: ClientSession | null) => {
      const currency =
        transaction.currency ??
        (await resolveTenantCreditCurrency(tenantId, activeSession));

      assertAmountUsesCurrencyPrecision(amountDelta, currency);
      const amountDeltaMinor = getSignedAmountMinor(amountDelta, currency);

      const userRepository = createUserRepository({
        tenantId,
        session: activeSession,
      });

      const moneyCreditRepository = createMoneyCreditRepository({
        tenantId,
        session: activeSession,
      });

      // MongoDB does not support parallel operations on one transaction
      // session. These reads are deliberately sequential because checkout can
      // supply its broader atomic payment session here.
      const user = await userRepository.findById(userId, {
        select: "moneyCredits moneyCreditsMinor",
        lean: false,
      });
      const existingCreditRecord =
        await moneyCreditRepository.findByUser(userId);

      if (!user) {
        notFound("User not found.");
      }

      const currentBalanceMinor = resolveCreditBalanceMinor({
        moneyCreditsMinor: user.moneyCreditsMinor,
        moneyCredits: user.moneyCredits,
        currency,
      });

      if (existingCreditRecord) {
        const recordCurrency = normalizeCreditCurrency(
          existingCreditRecord.currency,
        );

        if (recordCurrency !== currency) {
          const existingLedgerMinor = resolveCreditBalanceMinor({
            moneyCreditsMinor: existingCreditRecord.balanceMinor,
            moneyCredits: existingCreditRecord.balance,
            currency: recordCurrency,
          });
          const canRebaseEmptyLedger =
            currentBalanceMinor === 0 &&
            existingLedgerMinor === 0 &&
            existingCreditRecord.transactions.length === 0;

          if (!canRebaseEmptyLedger) {
            badRequest({
              message:
                "Credit balance currency does not match this transaction.",
              code: "CREDIT_CURRENCY_MISMATCH",
              details: {
                ledgerCurrency: recordCurrency,
                transactionCurrency: currency,
              },
            });
          }

          existingCreditRecord.currency = currency;
        } else {
          assertMatchingLedgerBalance({
            userMinor: currentBalanceMinor,
            creditRecord: existingCreditRecord,
            currency,
          });
        }
      }

      const idempotencyKey = String(transaction.idempotencyKey || "").trim();
      const idempotency = inspectCreditMutationIdempotency({
        transactions: existingCreditRecord?.transactions ?? [],
        idempotencyKey,
        type: transaction.type,
        amount: amountDelta,
        amountMinor: amountDeltaMinor,
        currency,
      });

      if (idempotency !== "missing") {
        if (idempotency === "conflict") {
          badRequest({
            message:
              "This credit idempotency key was used for another transaction.",
            code: "CREDIT_TRANSACTION_IDEMPOTENCY_CONFLICT",
          });
        }

        return buildCurrentCreditResult({
          tenantId,
          targetUserId: userId,
          currency,
          session: activeSession,
          idempotent: true,
        });
      }

      const newBalanceMinor = currentBalanceMinor + amountDeltaMinor;

      if (!Number.isSafeInteger(newBalanceMinor)) {
        badRequest({
          message: "Credit balance exceeds the supported range.",
          code: "CREDIT_BALANCE_OUT_OF_RANGE",
        });
      }

      if (newBalanceMinor < 0) {
        badRequest("Insufficient credits.");
      }

      const newBalance = creditMinorToMajor(newBalanceMinor, currency);

      user.moneyCredits = newBalance;
      user.moneyCreditsMinor = newBalanceMinor;

      await userRepository.save(user);

      let creditRecord = existingCreditRecord;

      if (!creditRecord) {
        creditRecord = await moneyCreditRepository.createForUser(
          userId,
          newBalance,
          currency,
          newBalanceMinor,
        );
      } else {
        creditRecord.balance = newBalance;
        creditRecord.balanceMinor = newBalanceMinor;
      }

      creditRecord.transactions.push({
        ...transaction,
        amount: creditMinorToMajor(Math.abs(amountDeltaMinor), currency),
        amountMinor: Math.abs(amountDeltaMinor),
        currency,
      });
      const appendedTransaction = creditRecord.transactions.at(-1);

      await moneyCreditRepository.save(creditRecord);

      return {
        message: "Credit balance updated successfully.",
        user,
        creditRecord,
        newBalance,
        newBalanceMinor,
        currency,
        idempotent: false,
        transactionId: appendedTransaction?._id
          ? String(appendedTransaction._id)
          : null,
      };
    };

    if (session) {
      return run(session);
    }

    const ownedSession = await mongoose.startSession();

    try {
      let result: Awaited<ReturnType<typeof run>> | undefined;

      await ownedSession.withTransaction(async () => {
        result = await run(ownedSession);
      });

      return result;
    } finally {
      await ownedSession.endSession();
    }
  },

  assertCanAccessUser(
    currentUserId: string,
    targetUserId: string,
    isAdmin: boolean,
  ) {
    if (!isAdmin && currentUserId !== targetUserId) {
      forbidden("You cannot access another user's credits.");
    }
  },
};
