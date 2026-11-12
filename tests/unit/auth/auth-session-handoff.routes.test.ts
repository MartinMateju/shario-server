import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pass: vi.fn((_req, _res, next) => next()),
  workspaceHandoff: vi.fn((_req, res) => res.sendStatus(204)),
  customerHandoff: vi.fn((_req, res) => res.sendStatus(204)),
}));

vi.mock("@/shared/middleware/loginLimiter.js", () => ({
  loginLimiter: mocks.pass,
}));

vi.mock("@/modules/checkout/checkout.public-limiter.js", () => ({
  publicTenantLookupLimiter: mocks.pass,
}));

vi.mock("@/modules/verification/user-verification.limiter.js", () => ({
  emailVerificationRequestLimiter: mocks.pass,
  emailVerificationVerifyLimiter: mocks.pass,
}));

vi.mock("@/modules/auth/controllers/auth.controller.js", () => ({
  login: mocks.pass,
  loginCustomer: mocks.pass,
  exchangeWorkspaceSessionHandoff: mocks.workspaceHandoff,
  exchangeCustomerSessionHandoff: mocks.customerHandoff,
  logout: mocks.pass,
  logoutCustomer: mocks.pass,
  refresh: mocks.pass,
  refreshCustomer: mocks.pass,
}));

vi.mock("@/modules/auth/controllers/register.controller.js", () => ({
  registerCustomer: mocks.pass,
  registerTenant: mocks.pass,
}));

vi.mock("@/modules/auth/social/customer-social.controller.js", () => ({
  completeCustomerSocialSignIn: mocks.pass,
  listCustomerSocialProviders: mocks.pass,
  startCustomerSocialSignIn: mocks.pass,
}));

vi.mock(
  "@/modules/verification/controllers/user-verification.controller.js",
  () => ({
    requestCustomerEmailVerification: mocks.pass,
    resendCustomerEmailVerification: mocks.pass,
    verifyCustomerEmail: mocks.pass,
  }),
);

import authRouter from "@/modules/auth/routes/auth.routes.js";

const app = express();
app.use(express.json());
app.use("/auth", authRouter);

describe("session handoff routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes separate rate-limited workspace and customer exchanges", async () => {
    await request(app)
      .post("/auth/session-handoff")
      .send({ sessionHandoff: "workspace" })
      .expect(204);
    await request(app)
      .post("/auth/customer/session-handoff")
      .send({ sessionHandoff: "customer" })
      .expect(204);

    expect(mocks.workspaceHandoff).toHaveBeenCalledOnce();
    expect(mocks.customerHandoff).toHaveBeenCalledOnce();
    expect(mocks.pass).toHaveBeenCalledTimes(2);
  });
});
