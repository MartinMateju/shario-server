import express from "express";
import request from "supertest";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  pass: vi.fn(
    (_req, _res, next) =>
      next(),
  ),
  findPublishedTenantBySlug:
    vi.fn(),
  getTenantBySlug: vi.fn(),
  requestVerificationEmail:
    vi.fn(),
  verifyEmail: vi.fn(),
  requestReset: vi.fn(),
  verifyOtp: vi.fn(),
  resetPassword: vi.fn(),
}));

vi.mock(
  "@/shared/middleware/loginLimiter.js",
  () => ({
    loginLimiter: mocks.pass,
  }),
);

vi.mock(
  "@/modules/checkout/checkout.public-limiter.js",
  () => ({
    publicTenantLookupLimiter:
      mocks.pass,
  }),
);

vi.mock(
  "@/modules/verification/user-verification.limiter.js",
  () => ({
    emailVerificationRequestLimiter:
      mocks.pass,
    emailVerificationVerifyLimiter:
      mocks.pass,
  }),
);

vi.mock(
  "@/modules/password_reset/password-reset.limiter.js",
  () => ({
    passwordResetRequestLimiter:
      mocks.pass,
    passwordResetVerifyLimiter:
      mocks.pass,
  }),
);

vi.mock(
  "@/modules/setup-center/setup-publication.service.js",
  () => ({
    findPublishedTenantBySlug:
      mocks.findPublishedTenantBySlug,
  }),
);

vi.mock(
  "@/modules/tenants/services/tenant.service.js",
  () => ({
    getTenantBySlug:
      mocks.getTenantBySlug,
  }),
);

vi.mock(
  "@/modules/verification/services/user-verification.service.js",
  () => ({
    verificationService: {
      requestVerificationEmail:
        mocks.requestVerificationEmail,
      verifyEmail:
        mocks.verifyEmail,
    },
  }),
);

vi.mock(
  "@/modules/password_reset/services/password-reset.service.js",
  () => ({
    createPasswordResetService: () => ({
      requestReset:
        mocks.requestReset,
      verifyOtp:
        mocks.verifyOtp,
      resetPassword:
        mocks.resetPassword,
    }),
  }),
);

vi.mock(
  "@/modules/password_reset/services/password-reset-email.service.js",
  () => ({
    createPasswordResetEmailService:
      () => ({}),
  }),
);

vi.mock(
  "@/infrastructure/email/nodemailer.client.js",
  () => ({
    sendEmail: vi.fn(),
  }),
);

vi.mock(
  "@/modules/auth/controllers/auth.controller.js",
  () => ({
    login: mocks.pass,
    loginCustomer: mocks.pass,
    exchangeCustomerSessionHandoff:
      mocks.pass,
    exchangeWorkspaceSessionHandoff:
      mocks.pass,
    logout: mocks.pass,
    logoutCustomer: mocks.pass,
    refresh: mocks.pass,
    refreshCustomer: mocks.pass,
  }),
);

vi.mock(
  "@/modules/auth/controllers/register.controller.js",
  () => ({
    registerCustomer:
      mocks.pass,
    registerTenant: mocks.pass,
  }),
);

vi.mock(
  "@/modules/auth/social/customer-social.controller.js",
  () => ({
    completeCustomerSocialSignIn:
      mocks.pass,
    listCustomerSocialProviders:
      mocks.pass,
    startCustomerSocialSignIn:
      mocks.pass,
  }),
);

import authRouter from "@/modules/auth/routes/auth.routes.js";
import passwordResetRouter from "@/modules/password_reset/routes/password-reset.routes.js";
import { errorHandler } from "@/shared/http/errorHandler.js";

const TENANT_ID =
  "64b000000000000000000301";
const tenant = {
  _id: TENANT_ID,
  slug: "studio-alpha",
  name: "Studio Alpha",
  settings: {
    defaultLanguage: "en",
  },
  publicSite: {
    branding: {
      displayName:
        "Alpha Pottery",
    },
  },
};

const app = express();
app.use(express.json());
app.use("/auth", authRouter);
app.use(
  "/password-reset",
  passwordResetRouter,
);
app.use(errorHandler);

describe("public account recovery route contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestVerificationEmail.mockResolvedValue(
      {
        sent: true,
      },
    );
    mocks.verifyEmail.mockResolvedValue(
      {
        verified: true,
      },
    );
    mocks.requestReset.mockResolvedValue(
      {
        status: "PENDING",
      },
    );
    mocks.verifyOtp.mockResolvedValue(
      {
        status: "VERIFIED",
        resetToken:
          "f".repeat(64),
      },
    );
    mocks.resetPassword.mockResolvedValue(
      {
        status: "SUCCESS",
      },
    );
  });

  it.each([
    ["nl_NL", "nl"],
    ["ro_RO", "ro"],
  ] as const)(
    "exposes generic 202 verification request and resend responses (%s)",
    async (inputLocale, expectedLocale) => {
    mocks.findPublishedTenantBySlug
      .mockResolvedValueOnce(
        tenant,
      )
      .mockResolvedValueOnce(
        null,
      );

    const known = await request(app)
      .post(
        "/auth/customer/email-verification/request",
      )
      .set(
        "Origin",
        "https://studio-alpha.shario.io",
      )
      .send({
        tenantSlug:
          "studio-alpha",
        email:
          "known@example.com",
        next:
          "/portal?intent=abc",
        locale: inputLocale,
      })
      .expect(202);

    const unknown = await request(app)
      .post(
        "/auth/customer/email-verification/resend",
      )
      .send({
        tenantSlug:
          "missing-studio",
        email:
          "missing@example.com",
      })
      .expect(202);

    expect(unknown.body).toEqual(
      known.body,
    );
    expect(
      mocks.requestVerificationEmail,
    ).toHaveBeenCalledOnce();
    expect(
      mocks.requestVerificationEmail,
    ).toHaveBeenCalledWith({
      tenant,
      email:
        "known@example.com",
      next:
        "/portal?intent=abc",
      requestedOrigin:
        "https://studio-alpha.shario.io",
      locale: expectedLocale,
    });
    },
  );

  it.each(["pt-BR", "ja-JP", "nn-NO"])(
    "rejects an ineligible verification locale (%s)",
    async (locale) => {
      await request(app)
        .post(
          "/auth/customer/email-verification/request",
        )
        .send({
          tenantSlug:
            "studio-alpha",
          email:
            "known@example.com",
          locale,
        })
        .expect(400);

      expect(
        mocks.findPublishedTenantBySlug,
      ).not.toHaveBeenCalled();
      expect(
        mocks.requestVerificationEmail,
      ).not.toHaveBeenCalled();
    },
  );

  it("verifies an opaque token in the body and tenant scope", async () => {
    mocks.findPublishedTenantBySlug.mockResolvedValue(
      tenant,
    );

    await request(app)
      .post(
        "/auth/customer/email-verification/verify",
      )
      .send({
        tenantSlug:
          "studio-alpha",
        token: "a".repeat(64),
      })
      .expect(200, {
        status: "VERIFIED",
        verified: true,
        message:
          "Email was verified successfully.",
      });

    expect(
      mocks.verifyEmail,
    ).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      token: "a".repeat(64),
    });
  });

  it("keeps password reset requests generic and resolves login-compatible workspaces", async () => {
    mocks.getTenantBySlug
      .mockResolvedValueOnce(
        tenant,
      )
      .mockResolvedValueOnce(
        null,
      );

    const known = await request(app)
      .post(
        "/password-reset/request",
      )
      .send({
        tenantSlug:
          "studio-alpha",
        email:
          "known@example.com",
        locale: "cs",
      })
      .expect(202);
    const unknown = await request(app)
      .post(
        "/password-reset/request",
      )
      .send({
        tenantSlug:
          "missing-studio",
        email:
          "missing@example.com",
      })
      .expect(202);

    expect(unknown.body).toEqual(
      known.body,
    );
    expect(
      mocks.requestReset,
    ).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      email:
        "known@example.com",
      locale: "cs",
      studioName:
        "Alpha Pottery",
    });
    expect(
      mocks.getTenantBySlug,
    ).toHaveBeenNthCalledWith(
      1,
      "studio-alpha",
    );

    await request(app)
      .post(
        "/password-reset/request",
      )
      .send({
        email:
          "missing-tenant@example.com",
      })
      .expect(400);
  });

  it("returns only the opaque reset token and consumes it without a client-provided user id", async () => {
    mocks.getTenantBySlug.mockResolvedValue(
      tenant,
    );

    const verified = await request(
      app,
    )
      .post(
        "/password-reset/verify-otp",
      )
      .send({
        tenantSlug:
          "studio-alpha",
        email:
          "customer@example.com",
        otp: "123456",
      })
      .expect(200);

    expect(verified.body).toEqual({
      status: "VERIFIED",
      resetToken:
        "f".repeat(64),
    });
    expect(
      verified.body,
    ).not.toHaveProperty("userId");

    await request(app)
      .post(
        "/password-reset/reset",
      )
      .send({
        tenantSlug:
          "studio-alpha",
        resetToken:
          "f".repeat(64),
        password:
          "NewPassword123",
      })
      .expect(200);

    expect(
      mocks.resetPassword,
    ).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      resetToken:
        "f".repeat(64),
      password:
        "NewPassword123",
    });
  });

  it.each(["1234", "12345", "1234567", "12345x"])(
    "rejects a non-six-digit password reset code (%s)",
    async (otp) => {
      mocks.getTenantBySlug.mockResolvedValue(
        tenant,
      );

      await request(app)
        .post(
          "/password-reset/verify-otp",
        )
        .send({
          tenantSlug:
            "studio-alpha",
          email:
            "customer@example.com",
          otp,
        })
        .expect(400);

      expect(
        mocks.verifyOtp,
      ).not.toHaveBeenCalled();
    },
  );
});

