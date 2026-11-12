import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addCredits: vi.fn(),
  useCredits: vi.fn(),
  refundCredits: vi.fn(),
  adminGrantCredits: vi.fn(),
}));

vi.mock("@/modules/money-credit/services/money-credit.service.js", () => ({
  moneyCreditService: {
    ...mocks,
  },
}));

vi.mock("@/modules/money-credit/services/credit-checkout.service.js", () => ({
  creditCheckoutService: {},
}));

vi.mock("@/modules/auth/auth.utils.js", () => ({
  getAuthenticatedUserId: vi.fn(() => "64b000000000000000000702"),
  getAuthenticatedUserName: vi.fn(() => "Credit manager"),
}));

vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: vi.fn(() => "64b000000000000000000701"),
}));

vi.mock("@/modules/auth/middleware/requireAuthContext.js", () => ({
  assertAuthContext: vi.fn(),
}));

vi.mock("@/modules/tenant-access/services/authorization.service.js", () => ({
  hasWorkspacePermission: vi.fn(),
  resolveWorkspaceAccessForUser: vi.fn(),
}));

import {
  addCredits,
  adminGrantCredits,
  refundCredits,
  useCredits,
} from "@/modules/money-credit/controllers/money-credit.controller.js";

const USER_ID = "64b000000000000000000703";

const invoke = async (
  controller: any,
  body: Record<string, unknown>,
  idempotencyKey?: string,
) => {
  const req = {
    body,
    get: vi.fn((name: string) =>
      name.toLowerCase() === "idempotency-key" ? idempotencyKey : undefined,
    ),
  };
  const res = { json: vi.fn() };
  const next = vi.fn();

  await controller(req, res, next);
  return { req, res, next };
};

describe("direct credit mutation HTTP idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [addCredits, { userId: USER_ID, amount: 1 }],
    [useCredits, { userId: USER_ID, amount: 1 }],
    [refundCredits, { userId: USER_ID, amount: 1 }],
    [
      adminGrantCredits,
      { targetUserId: USER_ID, amount: 1, reason: "manual correction" },
    ],
  ])(
    "rejects a missing Idempotency-Key before mutation",
    async (handler, body) => {
      const { next } = await invoke(handler, body);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          code: "CREDIT_IDEMPOTENCY_KEY_REQUIRED",
        }),
      );
      expect(mocks.addCredits).not.toHaveBeenCalled();
      expect(mocks.useCredits).not.toHaveBeenCalled();
      expect(mocks.refundCredits).not.toHaveBeenCalled();
      expect(mocks.adminGrantCredits).not.toHaveBeenCalled();
    },
  );

  it("forwards the authenticated actor and validated key", async () => {
    mocks.addCredits.mockResolvedValue({ ok: true });

    const { res, next } = await invoke(
      addCredits,
      { userId: USER_ID, amount: 1 },
      "credit-http-001",
    );

    expect(next).not.toHaveBeenCalled();
    expect(mocks.addCredits).toHaveBeenCalledWith(
      "64b000000000000000000701",
      {
        actorUserId: "64b000000000000000000702",
        idempotencyKey: "credit-http-001",
      },
      expect.objectContaining({ userId: USER_ID, amount: 1 }),
    );
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it("rejects a conflicting legacy body key", async () => {
    const { next } = await invoke(
      adminGrantCredits,
      {
        targetUserId: USER_ID,
        amount: 1,
        reason: "manual correction",
        idempotencyKey: "legacy-key-001",
      },
      "header-key-001",
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        code: "CREDIT_IDEMPOTENCY_KEY_MISMATCH",
      }),
    );
    expect(mocks.adminGrantCredits).not.toHaveBeenCalled();
  });
});
