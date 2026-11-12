import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createUserRepository: vi.fn(),
  createMoneyCreditRepository: vi.fn(),
  tenantFindById: vi.fn(),
  operationFindOne: vi.fn(),
  operationCreate: vi.fn(),
  startSession: vi.fn(),
}));

vi.mock("@/modules/user/user.repository.js", () => ({
  createUserRepository: mocks.createUserRepository,
}));

vi.mock("@/modules/money-credit/money-credit.repository.js", () => ({
  createMoneyCreditRepository: mocks.createMoneyCreditRepository,
}));

vi.mock("@/modules/tenants/tenant.model.js", () => ({
  default: { findById: mocks.tenantFindById },
}));

vi.mock("@/modules/money-credit/credit-mutation-operation.model.js", () => ({
  CreditMutationOperationModel: {
    findOne: mocks.operationFindOne,
    create: mocks.operationCreate,
  },
}));

import mongoose from "mongoose";
import {
  hashCreditMutationRequest,
  sha256CreditValue,
} from "@/modules/money-credit/money-credit.direct-idempotency.js";
import { moneyCreditService } from "@/modules/money-credit/services/money-credit.service.js";

const TENANT_ID = "64b000000000000000000701";
const ACTOR_ID = "64b000000000000000000702";
const USER_ID = "64b000000000000000000703";

const query = (value: unknown) => {
  const chain: any = {};
  for (const method of ["select", "session", "lean"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.exec = vi.fn().mockResolvedValue(value);
  return chain;
};

describe("moneyCreditService integer arithmetic and direct idempotency", () => {
  const operations = new Map<string, any>();
  const user: any = {
    _id: USER_ID,
    moneyCredits: 0,
    moneyCreditsMinor: null,
  };
  const creditRecord: any = {
    currency: "EUR",
    balance: 0,
    balanceMinor: null,
    transactions: [],
  };
  const saveUser = vi.fn(async (value: unknown) => value);
  const saveCreditRecord = vi.fn(async (value: unknown) => value);

  beforeEach(() => {
    vi.clearAllMocks();
    operations.clear();
    Object.assign(user, { moneyCredits: 0, moneyCreditsMinor: null });
    Object.assign(creditRecord, {
      currency: "EUR",
      balance: 0,
      balanceMinor: null,
      transactions: [],
    });

    mocks.tenantFindById.mockReturnValue(
      query({ settings: { currency: "EUR" } }),
    );
    mocks.createUserRepository.mockReturnValue({
      findById: vi.fn().mockResolvedValue(user),
      save: saveUser,
    });
    mocks.createMoneyCreditRepository.mockReturnValue({
      findByUser: vi.fn().mockResolvedValue(creditRecord),
      createForUser: vi.fn(),
      save: saveCreditRecord,
    });
    mocks.operationFindOne.mockImplementation((filter: any) =>
      query(operations.get(String(filter.keyHash)) ?? null),
    );
    mocks.operationCreate.mockImplementation(async ([document]: [any]) => {
      operations.set(String(document.keyHash), document);
      return [document];
    });

    const session = {
      withTransaction: vi.fn(async (work: () => Promise<void>) => work()),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    mocks.startSession.mockResolvedValue(session);
    vi.spyOn(mongoose, "startSession").mockImplementation(mocks.startSession);
  });

  it("performs 0.30 - 0.10 - 0.20 exactly in integer minor units", async () => {
    await moneyCreditService.addCredits(
      TENANT_ID,
      { actorUserId: ACTOR_ID, idempotencyKey: "credit-add-001" },
      { userId: USER_ID, amount: 0.3, description: "add" },
    );
    await moneyCreditService.useCredits(
      TENANT_ID,
      { actorUserId: ACTOR_ID, idempotencyKey: "credit-use-001" },
      { userId: USER_ID, amount: 0.1, description: "use" },
    );
    const result = await moneyCreditService.useCredits(
      TENANT_ID,
      { actorUserId: ACTOR_ID, idempotencyKey: "credit-use-002" },
      { userId: USER_ID, amount: 0.2, description: "use" },
    );

    expect(result).toMatchObject({ newBalance: 0, newBalanceMinor: 0 });
    expect(user).toMatchObject({ moneyCredits: 0, moneyCreditsMinor: 0 });
    expect(creditRecord).toMatchObject({ balance: 0, balanceMinor: 0 });
    expect(
      creditRecord.transactions.map((item: any) => item.amountMinor),
    ).toEqual([30, 10, 20]);
  });

  it("replays the same request without a second balance mutation", async () => {
    const context = {
      actorUserId: ACTOR_ID,
      idempotencyKey: "credit-replay-001",
    };
    const input = { userId: USER_ID, amount: 2, description: "one grant" };

    await moneyCreditService.addCredits(TENANT_ID, context, input);
    const replay = await moneyCreditService.addCredits(
      TENANT_ID,
      context,
      input,
    );

    expect(replay.idempotent).toBe(true);
    expect(user.moneyCreditsMinor).toBe(200);
    expect(creditRecord.transactions).toHaveLength(1);
    expect(saveUser).toHaveBeenCalledTimes(1);
  });

  it("replays the original result after a later mutation changed the balance", async () => {
    const firstContext = {
      actorUserId: ACTOR_ID,
      idempotencyKey: "credit-original-result-001",
    };
    const firstInput = {
      userId: USER_ID,
      amount: 5,
      description: "first",
    };

    await moneyCreditService.addCredits(TENANT_ID, firstContext, firstInput);
    await moneyCreditService.useCredits(
      TENANT_ID,
      { actorUserId: ACTOR_ID, idempotencyKey: "credit-later-use-001" },
      { userId: USER_ID, amount: 2, description: "later" },
    );
    const replay = await moneyCreditService.addCredits(
      TENANT_ID,
      firstContext,
      firstInput,
    );

    expect(user.moneyCreditsMinor).toBe(300);
    expect(replay).toMatchObject({
      idempotent: true,
      newBalance: 5,
      newBalanceMinor: 500,
    });
    expect(creditRecord.transactions).toHaveLength(2);
  });

  it("rejects reuse of a key for a different request", async () => {
    const context = {
      actorUserId: ACTOR_ID,
      idempotencyKey: "credit-conflict-001",
    };

    await moneyCreditService.addCredits(TENANT_ID, context, {
      userId: USER_ID,
      amount: 2,
      description: "first",
    });

    await expect(
      moneyCreditService.addCredits(TENANT_ID, context, {
        userId: USER_ID,
        amount: 3,
        description: "changed",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "CREDIT_IDEMPOTENCY_KEY_CONFLICT",
    });

    expect(creditRecord.transactions).toHaveLength(1);
  });

  it("replays the committed winner after a concurrent unique-key race", async () => {
    const idempotencyKey = "credit-race-001";
    const input = { userId: USER_ID, amount: 5, description: "race" };
    const completedOperation = {
      targetUser: USER_ID,
      currency: "EUR",
      resultingBalanceMinor: 500,
      requestHash: hashCreditMutationRequest({
        operation: "add",
        targetUserId: USER_ID,
        amountDelta: 5,
        request: input,
      }),
    };
    let operationRead = 0;
    mocks.operationFindOne.mockImplementation(() => {
      operationRead += 1;
      return query(operationRead === 1 ? null : completedOperation);
    });
    mocks.operationCreate.mockRejectedValue(
      Object.assign(new Error("duplicate operation"), { code: 11000 }),
    );

    const session = {
      withTransaction: vi.fn(async (work: () => Promise<void>) => {
        try {
          await work();
        } catch (error) {
          // Model MongoDB's atomic abort, followed by the concurrently
          // committed winner becoming visible to the duplicate-key loser.
          Object.assign(user, { moneyCredits: 5, moneyCreditsMinor: 500 });
          Object.assign(creditRecord, {
            balance: 5,
            balanceMinor: 500,
            transactions: [
              {
                type: "added",
                amount: 5,
                amountMinor: 500,
                currency: "EUR",
                idempotencyKey: `direct:${ACTOR_ID}:${sha256CreditValue(
                  idempotencyKey,
                )}`,
              },
            ],
          });
          throw error;
        }
      }),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    mocks.startSession.mockResolvedValue(session);

    const result = await moneyCreditService.addCredits(
      TENANT_ID,
      { actorUserId: ACTOR_ID, idempotencyKey },
      input,
    );

    expect(result).toMatchObject({
      idempotent: true,
      newBalance: 5,
      newBalanceMinor: 500,
    });
    expect(creditRecord.transactions).toHaveLength(1);
    expect(operationRead).toBe(2);
  });

  it("lazily migrates a legacy major-unit balance on mutation", async () => {
    Object.assign(user, { moneyCredits: 0.3 - 0.1, moneyCreditsMinor: null });
    Object.assign(creditRecord, {
      balance: 0.3 - 0.1,
      balanceMinor: null,
    });

    const result = await moneyCreditService.useCredits(
      TENANT_ID,
      { actorUserId: ACTOR_ID, idempotencyKey: "credit-migrate-001" },
      { userId: USER_ID, amount: 0.2, description: "migrate" },
    );

    expect(result).toMatchObject({ newBalance: 0, newBalanceMinor: 0 });
    expect(user.moneyCreditsMinor).toBe(0);
    expect(creditRecord.balanceMinor).toBe(0);
  });
});
