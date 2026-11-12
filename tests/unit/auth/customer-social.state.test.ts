import { beforeEach, describe, expect, it, vi } from "vitest";

const attempts = vi.hoisted(() => ({
  create: vi.fn(),
  findOneAndDelete: vi.fn(),
}));

vi.mock("@/modules/auth/social/customer-social-attempt.schema.js", () => ({
  default: {
    create: attempts.create,
    findOneAndDelete: attempts.findOneAndDelete,
  },
}));

import {
  createCustomerSocialState,
  decryptCustomerSocialState,
  encryptCustomerSocialState,
} from "@/modules/auth/social/customer-social.state.js";
import { normalizeCustomerSocialNext } from "@/modules/auth/social/customer-social.validators.js";

const payload = (expiresAt = Date.now() + 60_000) => ({
  provider: "google" as const,
  tenantId: "507f1f77bcf86cd799439011",
  tenantSlug: "studio-olivka",
  locale: "en" as const,
  next: "/book?product=clay",
  returnOrigin: "https://studio-olivka.shario.io",
  nonce: "n".repeat(43),
  codeVerifier: "v".repeat(43),
  stateId: "s".repeat(43),
  expiresAt,
});

describe("customer social OAuth state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CUSTOMER_SOCIAL_STATE_SECRET =
      "test-customer-social-state-secret-at-least-32";
    attempts.create.mockResolvedValue({});
  });

  it("encrypts confidential state and rejects ciphertext tampering", () => {
    const state = encryptCustomerSocialState(payload());

    expect(state).not.toContain("studio-olivka");
    expect(decryptCustomerSocialState(state)).toMatchObject({
      tenantSlug: "studio-olivka",
      next: "/book?product=clay",
    });

    const pieces = state.split(".");
    pieces[3] = `${pieces[3]!.slice(0, -2)}AA`;

    expect(() => decryptCustomerSocialState(pieces.join("."))).toThrowError(
      expect.objectContaining({
        code: "CUSTOMER_SOCIAL_STATE_INVALID",
      }),
    );
  });

  it.each([
    "fr",
    "es",
    "it",
    "pt-PT",
    "sv",
    "nb",
    "fi",
    "hu",
    "el",
    "tr",
    "nl",
    "ro",
  ] as const)(
    "preserves the rollout locale %s in authenticated state",
    (locale) => {
      const state = encryptCustomerSocialState({ ...payload(), locale });

      expect(decryptCustomerSocialState(state).locale).toBe(locale);
    },
  );

  it.each(["ja", "nn-NO", "pt-BR"])(
    "rejects the non-rollout locale %s even in authentic state",
    (locale) => {
      const state = encryptCustomerSocialState({
        ...payload(),
        locale,
      } as any);

      expect(() => decryptCustomerSocialState(state)).toThrowError(
        expect.objectContaining({ code: "CUSTOMER_SOCIAL_STATE_INVALID" }),
      );
    },
  );

  it("rejects an otherwise authentic expired state", () => {
    const state = encryptCustomerSocialState(payload(Date.now() - 1));

    expect(() => decryptCustomerSocialState(state)).toThrowError(
      expect.objectContaining({
        code: "CUSTOMER_SOCIAL_STATE_INVALID",
      }),
    );
  });

  it("creates PKCE S256 material without placing the verifier in the URL fields", async () => {
    const result = await createCustomerSocialState({
      provider: "google",
      tenantId: "507f1f77bcf86cd799439011",
      tenantSlug: "studio-olivka",
      locale: "en",
      next: "/portal",
      returnOrigin: "https://studio-olivka.shario.io",
    });

    expect(result.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(result.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.codeChallenge).not.toBe(result.codeVerifier);
    expect(attempts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: "507f1f77bcf86cd799439011",
        provider: "google",
      }),
    );
  });
});

describe("customer social next route", () => {
  it.each([
    ["/book?product=abc", "/book?product=abc"],
    ["/courses/wheel", "/courses/wheel"],
    [
      "/memberships?planId=plan-1&planVersionId=version-2",
      "/memberships?planId=plan-1&planVersionId=version-2",
    ],
    ["/help/firing", "/help/firing"],
    [
      "/portal?tab=studio-calendar&productId=product-1&locationId=location-1&start=2026-08-03T08%3A00%3A00.000Z&end=2026-08-03T10%3A00%3A00.000Z",
      "/portal?tab=studio-calendar&productId=product-1&locationId=location-1&start=2026-08-03T08%3A00%3A00.000Z&end=2026-08-03T10%3A00%3A00.000Z",
    ],
  ])("allows the customer route %s", (input, expected) => {
    expect(normalizeCustomerSocialNext(input)).toBe(expected);
  });

  it.each([
    "https://evil.example/app",
    "//evil.example/app",
    "/app",
    "/app/onboarding",
    "/admin",
    "/book\\evil",
    "/book/%2e%2e/app",
    "/book%5cevil",
    "/portal\u0000",
  ])("fails unsafe next %s closed to /portal", (input) => {
    expect(normalizeCustomerSocialNext(input)).toBe("/portal");
  });

  it("drops fragments so provider-controlled redirects cannot inject client state", () => {
    expect(
      normalizeCustomerSocialNext(
        "/courses/wheel-basics?productId=product-1#dates",
      ),
    ).toBe("/courses/wheel-basics?productId=product-1");
  });
});
