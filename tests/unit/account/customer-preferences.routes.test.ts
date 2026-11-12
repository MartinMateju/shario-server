import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateCurrentCustomerPreferences: vi.fn(),
  verifyJWT: vi.fn((req, _res, next) => {
    const context = req.get("x-test-auth-context");
    if (context)
      req.userInfo = {
        id: "507f1f77bcf86cd799439012",
        tenant: "507f1f77bcf86cd799439011",
        ...(context === "legacy" ? {} : { authContext: context }),
      };
    next();
  }),
}));
vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: mocks.verifyJWT,
}));
vi.mock("@/config/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/modules/account/account.service.js", () => ({
  getCurrentAccount: vi.fn(),
  updateCurrentAccountProfile: vi.fn(),
  updateCurrentAccountPassword: vi.fn(),
  updateCurrentCustomerPreferences: mocks.updateCurrentCustomerPreferences,
}));

import accountRouter from "@/modules/account/account.routes.js";
import { errorHandler } from "@/shared/http/errorHandler.js";

const app = express();
app.use(express.json());
app.use("/account", accountRouter);
app.use(errorHandler);

describe("customer preference route boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateCurrentCustomerPreferences.mockResolvedValue({
      id: "507f1f77bcf86cd799439012",
      customerDefaultLanguage: "cs",
    });
  });

  it("authenticates the route, uses only the current identity, and canonicalizes the requested language", async () => {
    const response = await request(app)
      .patch("/account/customer-preferences")
      .set("x-test-auth-context", "customer")
      .send({ defaultLanguage: "CZ" })
      .expect(200);
    expect(mocks.verifyJWT).toHaveBeenCalledOnce();
    expect(mocks.updateCurrentCustomerPreferences).toHaveBeenCalledWith({
      tenantId: "507f1f77bcf86cd799439011",
      userId: "507f1f77bcf86cd799439012",
      input: { defaultLanguage: "cs" },
    });
    expect(response.body.account.customerDefaultLanguage).toBe("cs");
  });

  it("passes an explicit null reset", async () => {
    await request(app)
      .patch("/account/customer-preferences")
      .set("x-test-auth-context", "customer")
      .send({ defaultLanguage: null })
      .expect(200);
    expect(mocks.updateCurrentCustomerPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ input: { defaultLanguage: null } }),
    );
  });

  it("accepts personal color changes without a language change and uses the authenticated account", async () => {
    await request(app)
      .patch("/account/customer-preferences")
      .set("x-test-auth-context", "customer")
      .send({
        portalAppearance: { backgroundColor: "#aabbcc", headerTextColor: "" },
      })
      .expect(200);
    expect(mocks.updateCurrentCustomerPreferences).toHaveBeenCalledWith({
      tenantId: "507f1f77bcf86cd799439011",
      userId: "507f1f77bcf86cd799439012",
      input: {
        portalAppearance: { backgroundColor: "#AABBCC", headerTextColor: "" },
      },
    });
  });

  it.each(["workspace", "legacy", undefined])(
    "does not allow %s sessions to change personal colors",
    async (context) => {
      const pending = request(app).patch("/account/customer-preferences");
      if (context) pending.set("x-test-auth-context", context);
      await pending
        .send({ portalAppearance: { backgroundColor: "#112233" } })
        .expect(context ? 403 : 401);
      expect(mocks.updateCurrentCustomerPreferences).not.toHaveBeenCalled();
    },
  );

  it.each(["workspace", "legacy"])(
    "rejects %s credentials without touching the account",
    async (context) => {
      const response = await request(app)
        .patch("/account/customer-preferences")
        .set("x-test-auth-context", context)
        .send({ defaultLanguage: "cs" })
        .expect(403);
      expect(response.body.code).toBe("CUSTOMER_SESSION_REQUIRED");
      expect(mocks.updateCurrentCustomerPreferences).not.toHaveBeenCalled();
    },
  );

  it("rejects an unauthenticated request", async () => {
    await request(app)
      .patch("/account/customer-preferences")
      .send({ defaultLanguage: "cs" })
      .expect(401);
    expect(mocks.updateCurrentCustomerPreferences).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { defaultLanguage: ["cs"] },
    { defaultLanguage: "cs", userId: "507f1f77bcf86cd799439013" },
    { defaultLanguage: "cs", tenantId: "507f1f77bcf86cd799439014" },
    { defaultLanguage: "cs", language: "en" },
    { portalAppearance: { backgroundColor: "#ABCDEF" }, userId: "other" },
    { portalAppearance: { backgroundColor: "#ABCDEF" }, tenantId: "other" },
    { portalAppearance: { customCss: "display:none" } },
  ])("rejects invalid fields before persistence: %j", async (body) => {
    await request(app)
      .patch("/account/customer-preferences")
      .set("x-test-auth-context", "customer")
      .send(body)
      .expect(400);
    expect(mocks.updateCurrentCustomerPreferences).not.toHaveBeenCalled();
  });
});
