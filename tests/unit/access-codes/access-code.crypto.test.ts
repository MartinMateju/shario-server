import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AccessCodeEncryptionConfigurationError,
  decryptAccessCode,
  encryptAccessCode,
  fingerprintAccessCode,
  isEncryptedAccessCode,
  maskAccessCode,
} from "@/modules/access-codes/access-code.crypto.js";

const TENANT_ID = "64b000000000000000000101";
const POOL_ID = "64b000000000000000000102";
const OTHER_POOL_ID = "64b000000000000000000103";
const TEST_KEY = "access-code-test-key-with-at-least-32-bytes";

describe("access-code encryption", () => {
  const previousKey = process.env.ACCESS_CODE_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ACCESS_CODE_ENCRYPTION_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.ACCESS_CODE_ENCRYPTION_KEY;
    } else {
      process.env.ACCESS_CODE_ENCRYPTION_KEY = previousKey;
    }
  });

  it("round-trips leading-zero codes without storing plaintext", () => {
    const encryptedEntryCode = encryptAccessCode({
      tenantId: TENANT_ID,
      poolId: POOL_ID,
      entryCode: "001234",
    });

    expect(encryptedEntryCode).not.toContain("001234");
    expect(isEncryptedAccessCode(encryptedEntryCode)).toBe(true);
    expect(
      decryptAccessCode({
        tenantId: TENANT_ID,
        poolId: POOL_ID,
        encryptedEntryCode,
      }),
    ).toBe("001234");
  });

  it("uses randomized ciphertext and a deterministic scoped fingerprint", () => {
    const input = {
      tenantId: TENANT_ID,
      poolId: POOL_ID,
      entryCode: "2468",
    };

    expect(encryptAccessCode(input)).not.toBe(encryptAccessCode(input));
    expect(fingerprintAccessCode(input)).toBe(fingerprintAccessCode(input));
    expect(fingerprintAccessCode(input)).not.toBe(
      fingerprintAccessCode({ ...input, poolId: OTHER_POOL_ID }),
    );
  });

  it("binds ciphertext to its tenant and pool context", () => {
    const encryptedEntryCode = encryptAccessCode({
      tenantId: TENANT_ID,
      poolId: POOL_ID,
      entryCode: "2468",
    });

    expect(() =>
      decryptAccessCode({
        tenantId: TENANT_ID,
        poolId: OTHER_POOL_ID,
        encryptedEntryCode,
      }),
    ).toThrow();
  });

  it("fails closed when its independent key is absent or too short", () => {
    delete process.env.ACCESS_CODE_ENCRYPTION_KEY;
    expect(() =>
      fingerprintAccessCode({
        tenantId: TENANT_ID,
        poolId: POOL_ID,
        entryCode: "2468",
      }),
    ).toThrow(AccessCodeEncryptionConfigurationError);

    process.env.ACCESS_CODE_ENCRYPTION_KEY = "short";
    expect(() =>
      encryptAccessCode({
        tenantId: TENANT_ID,
        poolId: POOL_ID,
        entryCode: "2468",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "ACCESS_CODE_ENCRYPTION_KEY_MISSING",
        statusCode: 503,
      }),
    );
  });

  it("exposes only a masked hint", () => {
    expect(maskAccessCode("001234")).toBe("••••34");
    expect(maskAccessCode("7")).toBe("•");
  });
});
