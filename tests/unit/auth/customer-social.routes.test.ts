import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCustomerSocialProviders: vi.fn(),
  beginCustomerSocialSignIn: vi.fn(),
  finishCustomerSocialSignIn: vi.fn(),
  pass: vi.fn((_req, _res, next) => next()),
}));

vi.mock("@/shared/middleware/loginLimiter.js", () => ({
  loginLimiter: mocks.pass,
}));

vi.mock("@/modules/auth/controllers/auth.controller.js", () => ({
  login: mocks.pass,
  loginCustomer: mocks.pass,
  exchangeCustomerSessionHandoff: mocks.pass,
  exchangeWorkspaceSessionHandoff: mocks.pass,
  logout: mocks.pass,
  logoutCustomer: mocks.pass,
  refresh: mocks.pass,
  refreshCustomer: mocks.pass,
}));

vi.mock("@/modules/auth/controllers/password-reset.controller.js", () => ({
  requestPasswordResetController: mocks.pass,
  resetPassword: mocks.pass,
  verifyOtp: mocks.pass,
}));

vi.mock("@/modules/auth/controllers/register.controller.js", () => ({
  registerCustomer: mocks.pass,
  registerTenant: mocks.pass,
}));

vi.mock("@/modules/auth/social/customer-social.service.js", () => ({
  getCustomerSocialProviders: mocks.getCustomerSocialProviders,
  beginCustomerSocialSignIn: mocks.beginCustomerSocialSignIn,
  finishCustomerSocialSignIn: mocks.finishCustomerSocialSignIn,
}));

import authRouter from "@/modules/auth/routes/auth.routes.js";
import { errorHandler } from "@/shared/http/errorHandler.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use("/auth", authRouter);
app.use(errorHandler);

describe("customer social authentication routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCustomerSocialProviders.mockResolvedValue({
      tenant: {
        id: "507f1f77bcf86cd799439011",
        slug: "studio-olivka",
      },
      providers: {
        google: { available: true },
        apple: { available: false },
      },
    });
    mocks.beginCustomerSocialSignIn.mockResolvedValue(
      "https://accounts.google.com/o/oauth2/v2/auth?state=encrypted",
    );
    mocks.finishCustomerSocialSignIn.mockResolvedValue({
      redirectUrl:
        "https://studio-olivka.shario.io/en/login/complete?next=%2Fportal&socialProvider=google",
      session: null,
    });
  });

  it("serves the provider availability response without caching", async () => {
    const response = await request(app)
      .get("/auth/customer/social/providers")
      .query({ tenantSlug: "Studio-Olivka" })
      .expect(200);

    expect(response.body).toEqual({
      tenant: {
        id: "507f1f77bcf86cd799439011",
        slug: "studio-olivka",
      },
      providers: {
        google: { available: true },
        apple: { available: false },
      },
    });
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(mocks.getCustomerSocialProviders).toHaveBeenCalledWith(
      "studio-olivka",
    );
  });

  it("normalizes the start context and redirects only supported providers", async () => {
    const response = await request(app)
      .get("/auth/customer/social/google/start")
      .query({
        tenantSlug: "Studio-Olivka",
        locale: "cs",
        next: "//attacker.example/steal-session",
        returnOrigin: "https://studio-olivka.shario.io",
      })
      .expect(302);

    expect(response.headers.location).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth?state=encrypted",
    );
    expect(mocks.beginCustomerSocialSignIn).toHaveBeenCalledWith({
      provider: "google",
      tenantSlug: "studio-olivka",
      locale: "cs",
      next: "/portal",
      returnOrigin: "https://studio-olivka.shario.io",
    });

    await request(app)
      .get("/auth/customer/social/facebook/start")
      .query({ tenantSlug: "studio-olivka" })
      .expect(400);
    expect(mocks.beginCustomerSocialSignIn).toHaveBeenCalledOnce();
  });

  it.each([
    ["get", "/auth/customer/social/google/callback"],
    ["post", "/auth/customer/social/apple/callback"],
  ] as const)(
    "accepts the %s provider callback contract",
    async (method, path) => {
      const agent = request(app)[method](path);
      const response =
        method === "get"
          ? await agent.query({
              state: "s".repeat(24),
              code: "provider-code",
            })
          : await agent.type("form").send({
              state: "s".repeat(24),
              code: "provider-code",
              user: JSON.stringify({
                name: { firstName: "Ada", lastName: "Lovelace" },
              }),
            });

      expect(response.status).toBe(303);
      expect(response.headers.location).toContain("/en/login/complete?");
      expect(mocks.finishCustomerSocialSignIn).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: method === "get" ? "google" : "apple",
          state: "s".repeat(24),
          code: "provider-code",
        }),
      );
    },
  );
});
