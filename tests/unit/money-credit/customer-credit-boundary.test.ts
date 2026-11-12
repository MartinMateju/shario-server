import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBalance: vi.fn(),
  getTransactions: vi.fn(),
  resolveWorkspaceAccess: vi.fn(),
  hasWorkspacePermission: vi.fn(),
}));

vi.mock(
  "@/modules/money-credit/services/money-credit.service.js",
  () => ({
    moneyCreditService: {
      getBalance: mocks.getBalance,
      getTransactions: mocks.getTransactions,
      addCredits: vi.fn(),
      useCredits: vi.fn(),
      refundCredits: vi.fn(),
      adminGrantCredits: vi.fn(),
    },
  }),
);

vi.mock(
  "@/modules/money-credit/services/credit-checkout.service.js",
  () => ({
    creditCheckoutService: {
      createCreditPurchaseCheckout: vi.fn(),
    },
  }),
);

vi.mock(
  "@/modules/tenant-access/services/authorization.service.js",
  () => ({
    resolveWorkspaceAccessForUser:
      mocks.resolveWorkspaceAccess,
    hasWorkspacePermission:
      mocks.hasWorkspacePermission,
  }),
);

import {
  getCreditBalance,
  getMyCreditBalance,
} from "@/modules/money-credit/controllers/money-credit.controller.js";
import { errorHandler } from "@/shared/http/errorHandler.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const OWNER_ID = "507f1f77bcf86cd799439012";
const OTHER_ID = "507f1f77bcf86cd799439013";

const injectAuth = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  (
    req as Request & {
      userInfo: Record<string, unknown>;
    }
  ).userInfo = {
    id: OWNER_ID,
    tenant: TENANT_ID,
    authContext:
      req.get("x-auth-context") === "workspace"
        ? "workspace"
        : "customer",
  };
  next();
};

const app = express();
app.use(injectAuth);
app.get("/mine/balance", getMyCreditBalance);
app.get("/balance/:userId", getCreditBalance);
app.use(errorHandler);

describe("customer credit ownership boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBalance.mockResolvedValue({
      balanceMinor: 5000,
    });
    mocks.resolveWorkspaceAccess.mockResolvedValue({
      status: "active",
      role: "owner",
    });
    mocks.hasWorkspacePermission.mockReturnValue(true);
  });

  it("uses the authenticated user for the native mine endpoint", async () => {
    await request(app)
      .get("/mine/balance")
      .set("x-auth-context", "customer")
      .expect(200, { balanceMinor: 5000 });

    expect(mocks.getBalance).toHaveBeenCalledWith(
      TENANT_ID,
      OWNER_ID,
    );
    expect(mocks.resolveWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("allows the legacy route for self but never escalates customer context for another user", async () => {
    await request(app)
      .get(`/balance/${OWNER_ID}`)
      .set("x-auth-context", "customer")
      .expect(200);

    await request(app)
      .get(`/balance/${OTHER_ID}`)
      .set("x-auth-context", "customer")
      .expect(403);

    expect(mocks.getBalance).toHaveBeenCalledTimes(1);
    expect(mocks.resolveWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("retains permission-checked cross-user access in workspace context", async () => {
    await request(app)
      .get(`/balance/${OTHER_ID}`)
      .set("x-auth-context", "workspace")
      .expect(200);

    expect(mocks.resolveWorkspaceAccess).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: OWNER_ID,
    });
    expect(mocks.getBalance).toHaveBeenCalledWith(
      TENANT_ID,
      OTHER_ID,
    );
  });
});
