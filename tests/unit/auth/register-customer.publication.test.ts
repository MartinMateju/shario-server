import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findPublishedTenantBySlug: vi.fn(),
  requirePublishedTenantId: vi.fn(),
  registerUser: vi.fn(),
  registerNewTenant: vi.fn(),
  sendVerificationEmail: vi.fn(),
}));

vi.mock("@/modules/setup-center/setup-publication.service.js", () => ({
  findPublishedTenantBySlug: mocks.findPublishedTenantBySlug,
  requirePublishedTenantId: mocks.requirePublishedTenantId,
}));

vi.mock("@/modules/auth/services/register.service.js", () => ({
  registerUser: mocks.registerUser,
}));

vi.mock("@/modules/auth/services/auth.service.js", () => ({
  registerNewTenant: mocks.registerNewTenant,
}));

vi.mock(
  "@/modules/verification/services/user-verification.service.js",
  () => ({
    verificationService: {
      sendVerificationEmail:
        mocks.sendVerificationEmail,
    },
  }),
);

import {
  registerCustomer,
  registerTenant,
} from "@/modules/auth/controllers/register.controller.js";

const TENANT_ID = "507f1f77bcf86cd799439011";

const registrationBody = {
  firstname: "Martin",
  lastname: "Mateju",
  email: "martin@example.test",
  password: "secure123",
  phone: "",
  tenantSlug: "studio-grohovka",
  locale: "nl_NL",
};

const response = () => {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    cookie: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.cookie.mockReturnValue(res);
  return res as unknown as Response;
};

const request = (
  body: Record<string, unknown>,
  tenant?: unknown,
) =>
  ({
    body,
    tenant,
    get: vi.fn(
      (name: string) =>
        name.toLowerCase() ===
        "origin"
          ? "https://studio-grohovka.shario.io"
          : undefined,
    ),
  }) as unknown as Request;

describe("public customer registration publication boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["nl_NL", "nl"],
    ["ro_RO", "ro"],
  ] as const)(
    "registers against the published tenant resolved from the request slug (%s)",
    async (inputLocale, expectedLocale) => {
    const tenant = {
      _id: TENANT_ID,
      id: TENANT_ID,
      name: "Studio Grohovka",
      slug: "studio-grohovka",
      status: "active",
    };
    const user = {
      _id: "507f1f77bcf86cd799439012",
      firstname: "Martin",
      lastname: "Mateju",
      email: "martin@example.test",
      customId: "U-TEST",
      tenant: TENANT_ID,
      tenantRole: "customer",
    };
    mocks.findPublishedTenantBySlug.mockResolvedValueOnce(tenant);
    mocks.registerUser.mockResolvedValueOnce(user);
    mocks.sendVerificationEmail.mockResolvedValueOnce({
      sent: true,
    });
    const res = response();
    const next = vi.fn();

    await registerCustomer(
      request({ ...registrationBody, locale: inputLocale }),
      res,
      next as NextFunction,
    );

    expect(mocks.registerUser).toHaveBeenCalledWith({
      input: {
        firstname: "Martin",
        lastname: "Mateju",
        email: "martin@example.test",
        password: "secure123",
        phone: "",
      },
      tenant,
    });
    expect(mocks.requirePublishedTenantId).not.toHaveBeenCalled();
    expect(
      mocks.sendVerificationEmail,
    ).toHaveBeenCalledWith({
      tenant,
      userId: user._id,
      email: user.email,
      requestedOrigin:
        "https://studio-grohovka.shario.io",
      next: undefined,
      locale: expectedLocale,
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationRequired: true,
        user:
          expect.objectContaining({
            isEmailVerified:
              false,
          }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
    },
  );

  it.each(["pt-BR", "ja-JP", "nn-NO"])(
    "rejects an ineligible registration locale (%s)",
    async (locale) => {
      const next = vi.fn();

      await registerCustomer(
        request({
          ...registrationBody,
          locale,
        }),
        response(),
        next as NextFunction,
      );

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
        }),
      );
      expect(
        mocks.findPublishedTenantBySlug,
      ).not.toHaveBeenCalled();
      expect(
        mocks.registerUser,
      ).not.toHaveBeenCalled();
    },
  );

  it("rejects an unpublished slug before creating a customer", async () => {
    mocks.findPublishedTenantBySlug.mockResolvedValueOnce(null);
    const next = vi.fn();

    await registerCustomer(
      request(registrationBody),
      response(),
      next as NextFunction,
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        code: "PUBLIC_WORKSPACE_NOT_FOUND",
      }),
    );
    expect(mocks.registerUser).not.toHaveBeenCalled();
  });

  it("also verifies publication for a trusted pre-resolved tenant context", async () => {
    const tenant = {
      _id: TENANT_ID,
      id: TENANT_ID,
      name: "Studio Grohovka",
      slug: "studio-grohovka",
    };
    mocks.requirePublishedTenantId.mockResolvedValueOnce(undefined);
    mocks.registerUser.mockResolvedValueOnce({
      _id: "507f1f77bcf86cd799439012",
      firstname: "Martin",
      lastname: "Mateju",
      email: "martin@example.test",
      customId: "U-TEST",
      tenant: TENANT_ID,
      tenantRole: "customer",
      isEmailVerified: false,
    });
    mocks.sendVerificationEmail.mockResolvedValueOnce({
      sent: true,
    });

    const {
      tenantSlug: _tenantSlug,
      locale: _locale,
      ...registrationInput
    } = registrationBody;

    await registerCustomer(
      request(
        {
          ...registrationInput,
          locale: "pt_PT",
        },
        tenant,
      ),
      response(),
      vi.fn() as NextFunction,
    );

    expect(mocks.requirePublishedTenantId).toHaveBeenCalledWith(TENANT_ID);
    expect(mocks.registerUser).toHaveBeenCalledWith({
      input: registrationInput,
      tenant,
    });
  });

  it("creates an owner workspace without requiring the new public site to be published", async () => {
    const ownerId =
      "507f1f77bcf86cd799439013";
    const workspaceAccess = {
      membershipId:
        "507f1f77bcf86cd799439014",
      tenantId: TENANT_ID,
      userId: ownerId,
      status: "active",
      role: "owner",
      customRoleId: null,
      customRoleName: null,
      permissions: [
        "workspace.view",
        "workspace.update",
      ],
      locationAccess: {
        mode: "all",
        locationIds: [],
      },
      workspaceProfile: {},
      preferences: {},
      accessVersion: 1,
      isPlatformBypass: false,
    };
    mocks.registerNewTenant.mockResolvedValueOnce({
      accessToken: "owner-access-token",
      refreshToken:
        "owner-refresh-token",
      authContext: "workspace",
      user: {
        _id: ownerId,
        firstname: "Martin",
        lastname: "Mateju",
        email:
          "martin@example.test",
        customId: "U-OWNER",
        tenant: TENANT_ID,
        tenantRole: "owner",
        platformRole: "none",
        isAccessGranted: true,
        isEmailVerified: false,
      },
      tenant: {
        _id: TENANT_ID,
        name: "Studio Olivka",
        slug: "studio-olivka",
        status: "active",
        plan: "starter",
        planVersion: 1,
        domains: [],
        modules: {},
        limits: {},
        settings: {},
        onboarding: {
          completed: false,
          currentStep: 1,
        },
      },
      workspaceAccess,
    });
    const res = response();
    const next = vi.fn();

    await registerTenant(
      request({
        firstname: "Martin",
        lastname: "Mateju",
        email:
          "martin@example.test",
        password: "secure123",
        tenantName:
          "Studio Olivka",
        slug: "studio-olivka",
      }),
      res,
      next as NextFunction,
    );

    expect(
      mocks.findPublishedTenantBySlug,
    ).not.toHaveBeenCalled();
    expect(
      mocks.requirePublishedTenantId,
    ).not.toHaveBeenCalled();
    expect(
      mocks.registerNewTenant,
    ).toHaveBeenCalledWith({
      input: {
        firstname: "Martin",
        lastname: "Mateju",
        email:
          "martin@example.test",
        password: "secure123",
        tenantName:
          "Studio Olivka",
        slug: "studio-olivka",
      },
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken:
          "owner-access-token",
        authContext: "workspace",
        user:
          expect.objectContaining({
            authContext: "workspace",
          }),
        tenant:
          expect.objectContaining({
            slug: "studio-olivka",
            onboarding: {
              completed: false,
              currentStep: 1,
            },
          }),
        workspaceAccess:
          expect.objectContaining({
            roleKey: "owner",
          }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });
});

