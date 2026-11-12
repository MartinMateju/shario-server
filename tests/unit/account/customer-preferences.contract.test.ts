import mongoose from "mongoose";
import { describe, expect, it } from "vitest";

import {
  accountProfileSchema,
  customerPreferencesSchema,
} from "@/modules/account/account.validators.js";
import { userSchema } from "@/modules/user/user.schema.js";
import { ROLLOUT_ELIGIBLE_APP_LOCALES } from "@/shared/i18n/locales.js";

const User = mongoose.model("CustomerLanguageContractUser", userSchema);

describe("customer default language contract", () => {
  it("defaults old and new users to following the studio without changing workspace preferences", () => {
    expect(new User().customerDefaultLanguage).toBeNull();
    expect(
      User.hydrate({ _id: new mongoose.Types.ObjectId() })
        .customerDefaultLanguage,
    ).toBeNull();
    expect(userSchema.path("preferences.language")).toBeUndefined();
  });

  it.each(ROLLOUT_ELIGIBLE_APP_LOCALES)(
    "accepts canonical locale %s",
    (locale) => {
      expect(
        customerPreferencesSchema.parse({ defaultLanguage: locale }),
      ).toEqual({
        defaultLanguage: locale,
      });
      expect(
        new User({ customerDefaultLanguage: locale }).validateSync()?.errors
          .customerDefaultLanguage,
      ).toBeUndefined();
    },
  );

  it.each([
    ["CZ", "cs"],
    ["cs-CZ", "cs"],
    ["EN_us", "en"],
    ["pt", "pt-PT"],
  ])("canonicalizes %s to %s", (input, expected) => {
    expect(customerPreferencesSchema.parse({ defaultLanguage: input })).toEqual(
      {
        defaultLanguage: expected,
      },
    );
    expect(
      new User({ customerDefaultLanguage: input }).customerDefaultLanguage,
    ).toBe(expected);
  });

  it("accepts an explicit reset to the studio default", () => {
    expect(customerPreferencesSchema.parse({ defaultLanguage: null })).toEqual({
      defaultLanguage: null,
    });
  });

  it.each([
    {},
    { defaultLanguage: "" },
    { defaultLanguage: "xx" },
    { defaultLanguage: "pt-BR" },
    { defaultLanguage: true },
    { defaultLanguage: 1 },
    { defaultLanguage: ["cs"] },
    { defaultLanguage: {} },
    { defaultLanguage: "cs", tenant: "another-tenant" },
    { defaultLanguage: "cs", userId: "another-user" },
    { defaultLanguage: "cs", language: "en" },
  ])("rejects missing, unsupported, or uncontrolled values: %j", (input) => {
    expect(customerPreferencesSchema.safeParse(input).success).toBe(false);
  });

  it("rejects invalid stored language values and keeps the shared profile API separate", () => {
    expect(
      new User({ customerDefaultLanguage: "xx" }).validateSync()?.errors
        .customerDefaultLanguage,
    ).toBeDefined();
    expect(
      accountProfileSchema.safeParse({ customerDefaultLanguage: "cs" }).success,
    ).toBe(false);
    expect(
      accountProfileSchema.safeParse({ defaultLanguage: "cs" }).success,
    ).toBe(false);
  });
});
