import { describe, expect, it } from "vitest";

import {
  WaitlistEntryModel,
  WaitlistVerificationModel,
} from "@/modules/waitlist/waitlist.model.js";
import { WAITLIST_STATES } from "@/modules/waitlist/waitlist.constants.js";
import { ROLLOUT_ELIGIBLE_APP_LOCALES } from "@/shared/i18n/locales.js";

describe("waitlist persistence contract", () => {
  it("uses the non-colliding courseSession path and required immutable join snapshots", () => {
    const paths = WaitlistEntryModel.schema.paths;
    expect(paths.courseSession).toBeDefined();
    expect(paths.session).toBeUndefined();
    expect(paths.sessionStartSnapshot.options.required).toBe(true);
    expect(paths.managementTokenHash.options.required).toBe(true);
    expect(paths.priceSnapshot.options.required).toBe(true);
    expect(WAITLIST_STATES).not.toContain("participant_removed");
  });

  it("installs FIFO/live uniqueness, bearer lookup and fair-reconciliation indexes", () => {
    const indexes = WaitlistEntryModel.schema.indexes();
    const byName = new Map(
      indexes.map(([keys, options]) => [options.name, keys]),
    );
    expect(byName.get("waitlist_one_live_identity_per_session")).toEqual({
      tenant: 1,
      courseSession: 1,
      identityKey: 1,
    });
    expect(byName.get("waitlist_one_live_customer_per_session")).toEqual({
      tenant: 1,
      courseSession: 1,
      customer: 1,
    });
    expect(byName.get("waitlist_fifo_sequence")).toEqual({
      tenant: 1,
      courseSession: 1,
      sequence: 1,
    });
    expect(byName.get("waitlist_manage_token_lookup")).toEqual({
      tenant: 1,
      managementTokenHash: 1,
    });
    expect(byName.get("waitlist_offer_token_lookup")).toEqual({
      tenant: 1,
      offerTokenHash: 1,
    });
    expect(indexes.some(([keys]) => keys.lastReconciledAt === 1)).toBe(true);
  });

  it("declares exactly one verification expiry index and a tenant-scoped token lookup", () => {
    const indexes = WaitlistVerificationModel.schema.indexes();
    const expiry = indexes.filter(([keys]) => keys.expiresAt === 1);
    expect(expiry).toHaveLength(1);
    expect(expiry[0][1].expireAfterSeconds).toBe(0);
    expect(
      indexes.some(([keys]) => keys.tenant === 1 && keys.tokenHash === 1),
    ).toBe(true);
  });

  it("stores every rollout locale, canonicalizes aliases and rejects unsupported values", () => {
    expect(WaitlistEntryModel.schema.path("locale").options.enum).toEqual([
      ...ROLLOUT_ELIGIBLE_APP_LOCALES,
    ]);
    expect(WaitlistVerificationModel.schema.path("locale").options.enum).toEqual(
      [...ROLLOUT_ELIGIBLE_APP_LOCALES],
    );

    expect(new WaitlistEntryModel({ locale: "CZ" }).locale).toBe("cs");
    expect(new WaitlistEntryModel({ locale: "de-DE" }).locale).toBe("de");
    expect(new WaitlistVerificationModel({ locale: "pl_PL" }).locale).toBe(
      "pl",
    );
    expect(new WaitlistEntryModel({ locale: "pt_PT" }).locale).toBe("pt-PT");
    expect(new WaitlistEntryModel({ locale: "sv-SE" }).locale).toBe("sv");
    expect(new WaitlistVerificationModel({ locale: "no_NO" }).locale).toBe(
      "nb",
    );
    expect(new WaitlistEntryModel({ locale: "nb-NO" }).locale).toBe("nb");
    expect(new WaitlistVerificationModel({ locale: "fi-FI" }).locale).toBe(
      "fi",
    );
    expect(new WaitlistEntryModel({ locale: "hu-HU" }).locale).toBe("hu");
    expect(new WaitlistVerificationModel({ locale: "el-GR" }).locale).toBe(
      "el",
    );
    expect(new WaitlistEntryModel({ locale: "tr-TR" }).locale).toBe("tr");
    expect(new WaitlistVerificationModel({ locale: "nl-NL" }).locale).toBe(
      "nl",
    );
    expect(new WaitlistEntryModel({ locale: "nl_NL" }).locale).toBe("nl");
    expect(new WaitlistVerificationModel({ locale: "ro-RO" }).locale).toBe(
      "ro",
    );
    expect(new WaitlistEntryModel({ locale: "ro_RO" }).locale).toBe("ro");
    const unsupportedEntry = new WaitlistEntryModel({ locale: "ja-JP" });
    const unsupportedVerification = new WaitlistVerificationModel({
      locale: "nn-NO",
    });
    expect(unsupportedEntry.locale).toBe("ja-JP");
    expect(unsupportedVerification.locale).toBe("nn-NO");
    expect(unsupportedEntry.validateSync()?.errors.locale).toBeDefined();
    expect(unsupportedVerification.validateSync()?.errors.locale).toBeDefined();
  });
});
