import { describe, expect, it } from "vitest";

import {
  buildR2Endpoint,
  buildR2PublicUrl,
  createR2Client,
} from "@/infrastructure/storage/r2.client.js";

const accountId = "0123456789abcdef0123456789abcdef";

describe("Cloudflare R2 endpoint configuration", () => {
  it("builds the standard and jurisdiction-specific S3 endpoints", () => {
    expect(buildR2Endpoint({ accountId })).toBe(
      `https://${accountId}.r2.cloudflarestorage.com`,
    );
    expect(buildR2Endpoint({ accountId, jurisdiction: "eu" })).toBe(
      `https://${accountId}.eu.r2.cloudflarestorage.com`,
    );
    expect(buildR2Endpoint({ accountId, jurisdiction: "FEDRAMP" })).toBe(
      `https://${accountId}.fedramp.r2.cloudflarestorage.com`,
    );
  });

  it("accepts the exact endpoint copied from Cloudflare", () => {
    expect(
      buildR2Endpoint({
        accountId,
        endpoint: `https://${accountId}.eu.r2.cloudflarestorage.com/`,
      }),
    ).toBe(`https://${accountId}.eu.r2.cloudflarestorage.com`);
  });

  it("normalizes an uppercase account ID before matching an explicit endpoint", () => {
    const uppercaseAccountId = accountId.toUpperCase();
    expect(
      buildR2Endpoint({
        accountId: uppercaseAccountId,
        jurisdiction: "EU",
        endpoint: `https://${uppercaseAccountId}.EU.r2.cloudflarestorage.com/`,
      }),
    ).toBe(`https://${accountId}.eu.r2.cloudflarestorage.com`);
  });

  it.each([
    ["a malformed account id", { accountId: "https://wrong.example" }],
    ["an unknown jurisdiction", { accountId, jurisdiction: "europe" }],
    [
      "a non-HTTPS endpoint",
      {
        accountId,
        endpoint: `http://${accountId}.r2.cloudflarestorage.com`,
      },
    ],
    [
      "a credentialed endpoint",
      {
        accountId,
        endpoint: `https://user:secret@${accountId}.r2.cloudflarestorage.com`,
      },
    ],
    [
      "an endpoint for another account",
      {
        accountId,
        endpoint:
          "https://ffffffffffffffffffffffffffffffff.r2.cloudflarestorage.com",
      },
    ],
    [
      "an endpoint path",
      {
        accountId,
        endpoint: `https://${accountId}.r2.cloudflarestorage.com/bucket`,
      },
    ],
    [
      "a jurisdiction mismatch",
      {
        accountId,
        jurisdiction: "eu",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      },
    ],
  ])("rejects %s before opening a socket", (_label, input) => {
    expect(() => buildR2Endpoint(input)).toThrow(/^R2:/);
  });

  it("configures the S3 client with the validated endpoint and credentials", async () => {
    const r2Client = createR2Client({
      R2_ACCOUNT_ID: accountId,
      R2_JURISDICTION: "eu",
      R2_ACCESS_KEY_ID: "access-key",
      R2_SECRET_ACCESS_KEY: "secret-key",
    });

    try {
      await expect(r2Client.config.endpoint()).resolves.toMatchObject({
        protocol: "https:",
        hostname: `${accountId}.eu.r2.cloudflarestorage.com`,
      });
      await expect(r2Client.config.region()).resolves.toBe("auto");
      await expect(r2Client.config.maxAttempts()).resolves.toBe(3);
      await expect(r2Client.config.credentials()).resolves.toMatchObject({
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
      });
      expect(r2Client.config.forcePathStyle).toBe(true);
    } finally {
      r2Client.destroy();
    }
  });
});

describe("Cloudflare R2 public delivery URL", () => {
  it("preserves a path prefix and safely encodes every object-key segment", () => {
    expect(
      buildR2PublicUrl(
        "https://media.shario.test/tenant-assets/",
        "public-sites/tenant alpha/logo image.png",
      ),
    ).toBe(
      "https://media.shario.test/tenant-assets/public-sites/tenant%20alpha/logo%20image.png",
    );
  });

  it.each([
    "http://media.shario.test",
    "https://user:secret@media.shario.test",
    "https://media.shario.test/base?token=secret",
    "https://media.shario.test/base#fragment",
  ])("rejects an unsafe public base URL: %s", (baseUrl) => {
    expect(() => buildR2PublicUrl(baseUrl, "public-sites/image.png")).toThrow(
      /^R2:/,
    );
  });

  it.each(["/absolute.png", "nested//image.png", "../image.png"])(
    "rejects an unsafe object key: %s",
    (key) => {
      expect(() => buildR2PublicUrl("https://media.shario.test", key)).toThrow(
        /^R2:/,
      );
    },
  );
});
