import { describe, expect, it } from "vitest";

import {
  getEffectiveAccessCodeStatus,
  serializeAccessCode,
  serializeAccessCodeAuditEvent,
} from "@/modules/access-codes/access-code.serializer.js";
import {
  bulkCreateAccessCodesSchema,
  createAccessCodeSchema,
  listAccessCodesSchema,
  updateAccessCodeSchema,
} from "@/modules/access-codes/access-code.validators.js";

const POOL_ID = "64b000000000000000000101";
const CODE_ID = "64b000000000000000000102";
const ACTOR_ID = "64b000000000000000000104";

describe("access-code public DTOs", () => {
  it("uses code/programmedAndTested while preserving leading zeroes", () => {
    expect(
      createAccessCodeSchema.parse({
        poolId: POOL_ID,
        code: "001234",
        label: "Front door",
        notes: "Programmed on the keypad",
        programmedAndTested: true,
      }),
    ).toMatchObject({
      poolId: POOL_ID,
      code: "001234",
      label: "Front door",
      notes: "Programmed on the keypad",
      programmedAndTested: true,
    });
  });

  it("accepts legacy aliases without retaining them in parsed output", () => {
    const parsed = createAccessCodeSchema.parse({
      poolId: POOL_ID,
      entryCode: "0099",
      verified: true,
    });

    expect(parsed.code).toBe("0099");
    expect(parsed.programmedAndTested).toBe(true);
    expect(parsed).not.toHaveProperty("entryCode");
    expect(parsed).not.toHaveProperty("verified");
  });

  it("validates partial updates and nullable never-expiring validity", () => {
    expect(
      updateAccessCodeSchema.parse({
        id: CODE_ID,
        validUntil: null,
        label: "Side door",
      }),
    ).toMatchObject({ id: CODE_ID, validUntil: null, label: "Side door" });
    expect(updateAccessCodeSchema.safeParse({ id: CODE_ID }).success).toBe(
      false,
    );
    expect(
      updateAccessCodeSchema.safeParse({ id: CODE_ID, status: "retired" })
        .success,
    ).toBe(false);
  });

  it("supports effective expired filtering and safe metadata search", () => {
    expect(
      listAccessCodesSchema.parse({ status: "expired", search: "front" }),
    ).toMatchObject({ status: "expired", search: "front" });
  });

  it("caps JSON imports at 500 rows", () => {
    expect(
      bulkCreateAccessCodesSchema.safeParse({
        poolId: POOL_ID,
        codes: Array.from({ length: 500 }, () => ({ code: "1234" })),
      }).success,
    ).toBe(true);
    expect(
      bulkCreateAccessCodesSchema.safeParse({
        poolId: POOL_ID,
        codes: Array.from({ length: 501 }, () => ({ code: "1234" })),
      }).success,
    ).toBe(false);
  });
});

describe("access-code serialization", () => {
  it("derives expiry and never serializes ciphertext or fingerprints", () => {
    const serialized = serializeAccessCode(
      {
        _id: CODE_ID,
        pool: POOL_ID,
        location: "64b000000000000000000103",
        entryCode: "v1:sensitive-ciphertext",
        codeFingerprint: "sensitive-fingerprint",
        codeHint: "••••34",
        label: "Front door",
        notes: "Tested",
        type: "single_booking",
        status: "available",
        validUntil: new Date("2026-01-01T00:00:00.000Z"),
        verifiedAt: new Date("2025-12-01T00:00:00.000Z"),
      },
      new Date("2026-08-20T00:00:00.000Z"),
    );

    expect(serialized.effectiveStatus).toBe("expired");
    expect(serialized.maskedCode).toBe("••••34");
    expect(serialized.programmedAndTested).toBe(true);
    expect(serialized.label).toBe("Front door");
    expect(serialized.notes).toBe("Tested");
    expect(serialized).not.toHaveProperty("entryCode");
    expect(serialized).not.toHaveProperty("codeFingerprint");
    expect(JSON.stringify(serialized)).not.toContain("sensitive");
  });

  it("keeps retired as the effective status even after validity ends", () => {
    expect(
      getEffectiveAccessCodeStatus(
        {
          status: "retired",
          validUntil: new Date("2020-01-01T00:00:00.000Z"),
        },
        new Date("2026-08-20T00:00:00.000Z"),
      ),
    ).toBe("retired");
  });

  it("returns a safe display identity for access-code audit actors", () => {
    const serialized = serializeAccessCodeAuditEvent({
      _id: "64b000000000000000000105",
      pool: POOL_ID,
      location: "64b000000000000000000103",
      accessCode: CODE_ID,
      actor: ACTOR_ID,
      actorIdentity: {
        _id: ACTOR_ID,
        firstname: "Marta",
        lastname: "Novak",
        email: "marta@example.com",
        password: "must-not-leak",
      },
      action: "code.revealed",
      metadata: { maskedCode: "••••34" },
      createdAt: new Date("2026-08-20T09:02:00.000Z"),
    });

    expect(serialized.actor).toEqual({
      name: "Marta Novak",
      email: "marta@example.com",
    });
    expect(serialized.actorId).toBe(ACTOR_ID);
    expect(JSON.stringify(serialized)).not.toContain("must-not-leak");
  });
});
