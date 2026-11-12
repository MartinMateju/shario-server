import { describe, expect, it } from "vitest";

import {
  importFingerprint,
  registerImportFileIdentity,
  resolveUniqueImportLookup,
  toImportMinorUnits,
} from "@/modules/data-import/services/import-domain-resolution.service.js";

describe("Step 3 import domain resolution", () => {
  it("uses collision-safe canonical fingerprint parts", () => {
    expect(importFingerprint("a|b", "c")).not.toBe(
      importFingerprint("a", "b|c"),
    );
    expect(importFingerprint("  Customer@Example.com  ", "PLAN-1")).toBe(
      importFingerprint("customer@example.COM", "plan-1"),
    );
  });

  it("fails closed when multiple identifiers resolve to different records", () => {
    const first = { _id: "customer-1" };
    const second = { _id: "customer-2" };

    expect(
      resolveUniqueImportLookup([
        { kind: "externalId", records: [first] },
        { kind: "email", records: [second] },
      ]),
    ).toEqual({ record: null, kind: null, ambiguous: true });
    expect(
      resolveUniqueImportLookup([
        { kind: "externalId", records: [first] },
        { kind: "email", records: [first] },
      ]),
    ).toEqual({ record: first, kind: "email", ambiguous: false });
  });

  it("rejects amounts that cannot round-trip through currency minor units", () => {
    expect(toImportMinorUnits(1490.5, "CZK")).toBe(149_050);
    expect(toImportMinorUnits(1490.501, "CZK")).toBeNull();
  });

  it("detects same-file duplicates and conflicting identity joins", () => {
    const fileKeys = new Map<string, number>();
    const firstIssues: Array<any> = [];
    expect(
      registerImportFileIdentity({
        keys: [
          { kind: "externalId", value: "ID-1" },
          { kind: "code", value: "CODE-1" },
        ],
        rowNumber: 2,
        fileKeys,
        issues: firstIssues,
        issueCode: "VOUCHER_DUPLICATE_IN_FILE",
        issueMessage: "Duplicate voucher.",
      }),
    ).toBeNull();

    const duplicateIssues: Array<any> = [];
    expect(
      registerImportFileIdentity({
        keys: [{ kind: "externalId", value: "ID-1" }],
        rowNumber: 3,
        fileKeys,
        issues: duplicateIssues,
        issueCode: "VOUCHER_DUPLICATE_IN_FILE",
        issueMessage: "Duplicate voucher.",
      }),
    ).toEqual({ kind: "file", rowNumber: 2 });
    expect(duplicateIssues).toContainEqual(
      expect.objectContaining({
        code: "VOUCHER_DUPLICATE_IN_FILE",
        severity: "warning",
      }),
    );

    fileKeys.set("code:CODE-2", 4);
    const conflictIssues: Array<any> = [];
    expect(
      registerImportFileIdentity({
        keys: [
          { kind: "externalId", value: "ID-1" },
          { kind: "code", value: "CODE-2" },
        ],
        rowNumber: 5,
        fileKeys,
        issues: conflictIssues,
        issueCode: "VOUCHER_DUPLICATE_IN_FILE",
        issueMessage: "Duplicate voucher.",
      }),
    ).toBeNull();
    expect(conflictIssues).toContainEqual(
      expect.objectContaining({
        code: "VOUCHER_IDENTITY_CONFLICT",
        severity: "error",
      }),
    );
  });
});
