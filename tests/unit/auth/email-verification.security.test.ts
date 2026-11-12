import mongoose from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(),
  updateOne: vi.fn(),
  sendEmail: vi.fn(),
  deletePendingEmailTokens: vi.fn(),
  createEmailToken: vi.fn(),
  consumePendingEmailToken: vi.fn(),
  markFailed: vi.fn(),
}));

vi.mock("@/modules/user/user.model.js", () => ({
  default: {
    findOne: mocks.findOne,
    updateOne: mocks.updateOne,
  },
}));

vi.mock("@/infrastructure/email/managed-email.service.js", () => ({
  sendManagedTenantEmail: mocks.sendEmail,
}));

vi.mock("@/modules/verification/user-verification.repository.js", () => ({
  verificationRepository: {
    deletePendingEmailTokens: mocks.deletePendingEmailTokens,
    createEmailToken: mocks.createEmailToken,
    consumePendingEmailToken: mocks.consumePendingEmailToken,
    markFailed: mocks.markFailed,
  },
}));

import { verificationService } from "@/modules/verification/services/user-verification.service.js";
import {
  buildEmailVerificationUrl,
  getSafeVerificationNext,
  hashVerificationToken,
  normalizeVerificationLocale,
} from "@/modules/verification/user-verification.utils.js";

const TENANT_A = "64b000000000000000000001";
const TENANT_B = "64b000000000000000000002";
const USER_ID = "64b000000000000000000003";

const tenant = {
  _id: TENANT_A,
  slug: "studio-olivka",
  name: "Studio Olivka",
  domains: [],
  settings: {
    defaultLanguage: "CZ",
  },
  publicSite: {
    branding: {
      displayName: "Olivka Ceramics",
    },
  },
};

const queryResult = (value: unknown) => ({
  select: vi.fn(() => ({
    exec: vi.fn().mockResolvedValue(value),
  })),
});

const updateResult = (matchedCount = 1) => {
  const query = {
    session: vi.fn(),
    exec: vi.fn().mockResolvedValue({
      matchedCount,
    }),
  };
  query.session.mockReturnValue(query);
  return query;
};

const installTransaction = () => {
  const session = {
    withTransaction: vi.fn(async (callback: () => Promise<void>) => callback()),
    endSession: vi.fn().mockResolvedValue(undefined),
  };

  vi.spyOn(mongoose, "startSession").mockResolvedValue(session as never);

  return session;
};

describe("customer email verification security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CLIENT_URL", "http://shario.localhost:3000");
    mocks.sendEmail.mockResolvedValue({});
    mocks.createEmailToken.mockResolvedValue({});
    mocks.deletePendingEmailTokens.mockResolvedValue(undefined);
    mocks.updateOne.mockReturnValue(updateResult());
  });

  it("builds a tenant-local callback and discards hostile next values", () => {
    expect(getSafeVerificationNext("//evil.example/steal")).toBe("/portal");
    expect(getSafeVerificationNext("%2F%2Fevil.example/steal")).toBe("/portal");
    expect(getSafeVerificationNext("/portal?tab=studio-calendar")).toBe(
      "/portal?tab=studio-calendar",
    );

    const url = buildEmailVerificationUrl({
      baseUrl: "https://pottery.example",
      locale: "CZ",
      token: "a".repeat(64),
      next: "//evil.example",
    });
    const parsed = new URL(url);

    expect(parsed.origin).toBe("https://pottery.example");
    expect(parsed.pathname).toBe("/cs/verify-email");
    expect(parsed.searchParams.get("token")).toBe("a".repeat(64));
    expect(parsed.searchParams.get("next")).toBe("/portal");

    expect(
      new URL(
        buildEmailVerificationUrl({
          baseUrl: "https://pottery.example",
          locale: "pt_PT",
          token: "b".repeat(64),
        }),
      ).pathname,
    ).toBe("/pt-PT/verify-email");
    expect(
      new URL(
        buildEmailVerificationUrl({
          baseUrl: "https://pottery.example",
          locale: "sv-SE",
          token: "c".repeat(64),
        }),
      ).pathname,
    ).toBe("/sv/verify-email");
    expect(
      new URL(
        buildEmailVerificationUrl({
          baseUrl: "https://pottery.example",
          locale: "no_NO",
          token: "d".repeat(64),
        }),
      ).pathname,
    ).toBe("/nb/verify-email");
    expect(
      new URL(
        buildEmailVerificationUrl({
          baseUrl: "https://pottery.example",
          locale: "fi-FI",
          token: "e".repeat(64),
        }),
      ).pathname,
    ).toBe("/fi/verify-email");
    expect(
      new URL(
        buildEmailVerificationUrl({
          baseUrl: "https://pottery.example",
          locale: "pt-BR",
          token: "c".repeat(64),
        }),
      ).pathname,
    ).toBe("/en/verify-email");
    expect(
      new URL(
        buildEmailVerificationUrl({
          baseUrl: "https://pottery.example",
          locale: "el-GR",
          token: "1".repeat(64),
        }),
      ).pathname,
    ).toBe("/el/verify-email");
    expect(
      new URL(
        buildEmailVerificationUrl({
          baseUrl: "https://pottery.example",
          locale: "tr_TR",
          token: "2".repeat(64),
        }),
      ).pathname,
    ).toBe("/tr/verify-email");
    expect(
      new URL(
        buildEmailVerificationUrl({
          baseUrl: "https://pottery.example",
          locale: "hu-HU",
          token: "f".repeat(64),
        }),
      ).pathname,
    ).toBe("/hu/verify-email");
    expect(
      new URL(
        buildEmailVerificationUrl({
          baseUrl: "https://pottery.example",
          locale: "nl-NL",
          token: "f".repeat(64),
        }),
      ).pathname,
    ).toBe("/nl/verify-email");
    expect(
      new URL(
        buildEmailVerificationUrl({
          baseUrl: "https://pottery.example",
          locale: "ro-RO",
          token: "f".repeat(64),
        }),
      ).pathname,
    ).toBe("/ro/verify-email");
    expect(
      new URL(
        buildEmailVerificationUrl({
          baseUrl: "https://pottery.example",
          locale: "nn-NO",
          token: "0".repeat(64),
        }),
      ).pathname,
    ).toBe("/en/verify-email");
  });

  it("prefers the requested verification locale, then the tenant public locale", async () => {
    mocks.findOne.mockReturnValue(
      queryResult({
        _id: USER_ID,
        email: "customer@example.com",
        isEmailVerified: false,
      }),
    );
    const localizedTenant = {
      ...tenant,
      settings: {
        defaultLanguage: "CZ",
        publicDefaultLanguage: "fr",
      },
    };

    await verificationService.sendVerificationEmail({
      tenant: localizedTenant,
      userId: USER_ID,
      email: "customer@example.com",
      locale: "pt-PT",
    });
    await verificationService.sendVerificationEmail({
      tenant: localizedTenant,
      userId: USER_ID,
      email: "customer@example.com",
    });

    const requestedMail = mocks.sendEmail.mock.calls[0][0];
    const tenantDefaultMail = mocks.sendEmail.mock.calls[1][0];

    expect(requestedMail.text).toContain(
      "http://studio-olivka.localhost:3000/pt-PT/verify-email?",
    );
    expect(requestedMail.subject).toBe("Olivka Ceramics: verify your email");
    expect(tenantDefaultMail.text).toContain(
      "http://studio-olivka.localhost:3000/fr/verify-email?",
    );
    expect(tenantDefaultMail.subject).toBe(
      "Olivka Ceramics: verify your email",
    );
  });

  it.each([
    ["sv-SE", "sv"],
    ["no_NO", "nb"],
    ["nb-NO", "nb"],
    ["fi-FI", "fi"],
  ] as const)(
    "keeps verification alias %s on the canonical %s route with English copy",
    async (locale, expectedLocale) => {
      const canonicalLocale = normalizeVerificationLocale(locale);
      expect(canonicalLocale).toBe(expectedLocale);
      mocks.findOne.mockReturnValue(
        queryResult({
          _id: USER_ID,
          email: "customer@example.com",
          isEmailVerified: false,
        }),
      );

      await verificationService.sendVerificationEmail({
        tenant,
        userId: USER_ID,
        email: "customer@example.com",
        locale: canonicalLocale,
      });

      const mail = mocks.sendEmail.mock.calls[0][0];
      expect(mail.text).toContain(
        `http://studio-olivka.localhost:3000/${expectedLocale}/verify-email?`,
      );
      expect(mail.subject).toBe("Olivka Ceramics: verify your email");
    },
  );

  it("invalidates the prior link and sends a branded, server-selected origin", async () => {
    mocks.findOne.mockReturnValue(
      queryResult({
        _id: USER_ID,
        email: "customer@example.com",
        isEmailVerified: false,
      }),
    );

    await verificationService.sendVerificationEmail({
      tenant,
      userId: USER_ID,
      email: "customer@example.com",
      requestedOrigin: "https://evil.example",
      next: "/portal?tab=studio-calendar",
    });

    expect(mocks.deletePendingEmailTokens).toHaveBeenCalledWith(
      TENANT_A,
      USER_ID,
    );
    expect(mocks.createEmailToken).toHaveBeenCalledOnce();
    const created = mocks.createEmailToken.mock.calls[0][0];
    expect(created.hashedToken).toMatch(/^[a-f0-9]{64}$/);

    const mail = mocks.sendEmail.mock.calls[0][0];
    expect(mail.subject).toContain("Olivka Ceramics");
    expect(mail.text).toContain(
      "http://studio-olivka.localhost:3000/cs/verify-email?",
    );
    expect(mail.text).not.toContain("evil.example");
  });

  it("binds token consumption to the tenant and leaves a real token intact after a wrong token", async () => {
    installTransaction();
    mocks.consumePendingEmailToken.mockResolvedValue(null);

    await expect(
      verificationService.verifyEmail({
        tenantId: TENANT_B,
        token: "b".repeat(64),
      }),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: "INVALID_EMAIL_VERIFICATION",
    });

    expect(mocks.consumePendingEmailToken).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_B,
        hashedToken: await hashVerificationToken("b".repeat(64)),
      }),
    );
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it("consumes a verification token once and updates only its tenant user", async () => {
    installTransaction();
    mocks.consumePendingEmailToken
      .mockResolvedValueOnce({
        _id: "64b000000000000000000004",
        tenant: TENANT_A,
        user: USER_ID,
      })
      .mockResolvedValueOnce(null);

    await expect(
      verificationService.verifyEmail({
        tenantId: TENANT_A,
        token: "c".repeat(64),
      }),
    ).resolves.toMatchObject({
      verified: true,
      userId: USER_ID,
    });

    expect(mocks.updateOne).toHaveBeenCalledWith(
      {
        _id: USER_ID,
        tenant: expect.objectContaining({
          toString: expect.any(Function),
        }),
      },
      {
        $set: {
          isEmailVerified: true,
        },
      },
    );

    await expect(
      verificationService.verifyEmail({
        tenantId: TENANT_A,
        token: "c".repeat(64),
      }),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: "INVALID_EMAIL_VERIFICATION",
    });

    expect(mocks.updateOne).toHaveBeenCalledOnce();
  });
});

afterEach(() => vi.unstubAllEnvs());
