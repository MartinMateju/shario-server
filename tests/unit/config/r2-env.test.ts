import { describe, expect, it } from "vitest";

import {
  parseR2Environment,
  R2ConfigurationError,
  r2EnvironmentSchema,
} from "@/config/r2-env.js";

const accountId = "0123456789abcdef0123456789abcdef";

const validEnvironment = {
  R2_ACCOUNT_ID: accountId,
  R2_ENDPOINT: "",
  R2_JURISDICTION: "",
  R2_ACCESS_KEY_ID: "access-key",
  R2_SECRET_ACCESS_KEY: "secret-key",
  R2_BUCKET: "public-media",
  R2_PUBLIC_URL: "https://media.shario.test",
};

describe("R2 environment configuration", () => {
  it("normalizes account ID, jurisdiction, and the public path prefix", () => {
    expect(
      parseR2Environment({
        ...validEnvironment,
        R2_ACCOUNT_ID: accountId.toUpperCase(),
        R2_JURISDICTION: " EU ",
        R2_ENDPOINT: `https://${accountId}.eu.r2.cloudflarestorage.com/`,
        R2_PUBLIC_URL: "https://media.shario.test/public/assets///",
      }),
    ).toMatchObject({
      R2_ACCOUNT_ID: accountId,
      R2_JURISDICTION: "eu",
      R2_ENDPOINT: `https://${accountId}.eu.r2.cloudflarestorage.com/`,
      R2_PUBLIC_URL: "https://media.shario.test/public/assets",
    });
  });

  it("accepts an exact jurisdiction endpoint when jurisdiction is omitted", () => {
    expect(
      r2EnvironmentSchema.safeParse({
        ...validEnvironment,
        R2_ENDPOINT: `https://${accountId}.fedramp.r2.cloudflarestorage.com`,
      }).success,
    ).toBe(true);
  });

  it("rejects a jurisdiction and endpoint mismatch during configuration parsing", () => {
    expect(() =>
      parseR2Environment({
        ...validEnvironment,
        R2_JURISDICTION: "eu",
        R2_ENDPOINT: `https://${accountId}.r2.cloudflarestorage.com`,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<R2ConfigurationError>>({
        name: "R2ConfigurationError",
        field: "R2_ENDPOINT",
      }),
    );
  });

  it.each([
    ["R2_ACCOUNT_ID", "not-an-account-id"],
    ["R2_ENDPOINT", "https://example.test"],
    ["R2_PUBLIC_URL", "https://media.shario.test/base?token=secret"],
  ] as const)(
    "reports invalid %s as configuration, not a provider failure",
    (field, value) => {
      expect(() =>
        parseR2Environment({
          ...validEnvironment,
          [field]: value,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<R2ConfigurationError>>({
          name: "R2ConfigurationError",
          field,
        }),
      );
    },
  );
});
