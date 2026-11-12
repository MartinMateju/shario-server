import bcrypt from "bcryptjs";
import { serializePortalAppearance } from "@/shared/appearance/portal-appearance.js";

import UserModel from "@/modules/user/user.model.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import { resolveTenantLocaleSettings } from "@/modules/tenants/tenant-locale.js";
import { normalizeRolloutEligibleAppLocale } from "@/shared/i18n/locales.js";
import { ensureUserMemberNumber } from "@/modules/user/user-member-number.assignment.service.js";
import { normalizeEmail } from "@/modules/auth/auth.utils.js";
import {
  badRequest,
  notFound,
  unauthorized,
} from "@/shared/http/httpErrors.js";

import type {
  AccountPasswordInput,
  AccountProfileInput,
  CustomerPreferencesInput,
} from "./account.validators.js";

const selectAccount =
  "_id firstname lastname email phone customId memberNumber customerDefaultLanguage +portalAppearance isEmailVerified lastLoginAt createdAt updatedAt";

const serializeAccount = (user: Record<string, unknown>) => ({
  id: String(user._id ?? ""),
  firstname: String(user.firstname ?? ""),
  lastname: String(user.lastname ?? ""),
  email: normalizeEmail(user.email),
  phone: String(user.phone ?? ""),
  customerDefaultLanguage: normalizeRolloutEligibleAppLocale(
    user.customerDefaultLanguage,
  ),
  portalAppearance: serializePortalAppearance(user.portalAppearance),
  customId: String(user.customId ?? ""),
  memberNumber:
    Number.isSafeInteger(user.memberNumber) && Number(user.memberNumber) > 0
      ? Number(user.memberNumber)
      : null,
  isEmailVerified: user.isEmailVerified === true,
  lastLoginAt: user.lastLoginAt ?? null,
  createdAt: user.createdAt ?? null,
  updatedAt: user.updatedAt ?? null,
  accountScope: "tenant",
});

export const getCurrentAccount = async ({
  tenantId,
  userId,
}: {
  tenantId: string;
  userId: string;
}) => {
  await ensureUserMemberNumber({ tenantId, userId });

  const user = await UserModel.findOne({
    _id: userId,
    tenant: tenantId,
  })
    .select(selectAccount)
    .lean()
    .exec();

  if (!user) {
    notFound("Account not found.");
  }

  return serializeAccount(user as unknown as Record<string, unknown>);
};

export const updateCurrentCustomerPreferences = async ({
  tenantId,
  userId,
  input,
}: {
  tenantId: string;
  userId: string;
  input: CustomerPreferencesInput;
}) => {
  if (input.defaultLanguage !== undefined && input.defaultLanguage !== null) {
    const tenant = await TenantModel.findById(tenantId)
      .select("settings")
      .lean()
      .exec();

    if (!tenant) notFound("Studio not found.");

    const { supportedPublicLanguages } = resolveTenantLocaleSettings(
      tenant.settings,
    );
    if (!supportedPublicLanguages.includes(input.defaultLanguage)) {
      badRequest({
        message: "Choose one of this studio's available customer languages.",
        code: "CUSTOMER_LANGUAGE_UNAVAILABLE",
      });
    }
  }

  const setValues: Record<string, unknown> = {};
  if (input.defaultLanguage !== undefined) {
    setValues.customerDefaultLanguage = input.defaultLanguage;
  }
  if (input.portalAppearance) {
    for (const [key, value] of Object.entries(input.portalAppearance)) {
      setValues[`portalAppearance.${key}`] = value;
    }
  }

  const user = await UserModel.findOneAndUpdate(
    { _id: userId, tenant: tenantId },
    { $set: setValues },
    { returnDocument: "after", runValidators: true },
  )
    .select(selectAccount)
    .lean()
    .exec();

  if (!user) notFound("Account not found.");

  return serializeAccount(user as unknown as Record<string, unknown>);
};

export const updateCurrentAccountProfile = async ({
  tenantId,
  userId,
  input,
}: {
  tenantId: string;
  userId: string;
  input: AccountProfileInput;
}) => {
  await ensureUserMemberNumber({ tenantId, userId });

  const user = await UserModel.findOne({
    _id: userId,
    tenant: tenantId,
  })
    .select(selectAccount)
    .exec();

  if (!user) {
    notFound("Account not found.");
  }

  if (input.firstname !== undefined) user.firstname = input.firstname;
  if (input.lastname !== undefined) user.lastname = input.lastname;
  if (input.phone !== undefined) user.phone = input.phone;

  await user.save();

  return serializeAccount(
    user.toObject() as unknown as Record<string, unknown>,
  );
};

export const updateCurrentAccountPassword = async ({
  tenantId,
  userId,
  input,
}: {
  tenantId: string;
  userId: string;
  input: AccountPasswordInput;
}): Promise<void> => {
  await changePasswordAndRevokeSessions({
    tenantId,
    userId,
    currentPassword: input.currentPassword,
    newPassword: input.newPassword,
  });
};

/**
 * Authoritative password-change operation used by both the account API and
 * the legacy /users/pass compatibility route.
 *
 * Password hashing runs through the User schema save hook. The password,
 * refresh-token revocation and session-version increment are persisted in one
 * document save so a successful password change always ends every session,
 * including the browser that initiated it.
 */
export const changePasswordAndRevokeSessions = async ({
  tenantId,
  userId,
  currentPassword,
  newPassword,
}: {
  tenantId: string;
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<void> => {
  const user = await UserModel.findOne({
    _id: userId,
    tenant: tenantId,
  })
    .select("+password +refreshToken +sessionVersion")
    .exec();

  if (!user) {
    notFound("Account not found.");
  }

  if (!(await bcrypt.compare(currentPassword, user.password))) {
    unauthorized("Current password is incorrect.");
  }

  const currentSessionVersion =
    typeof user.sessionVersion === "number" &&
    Number.isSafeInteger(user.sessionVersion) &&
    user.sessionVersion >= 0
      ? user.sessionVersion
      : 0;

  user.password = newPassword;
  user.refreshToken = [];
  user.sessionVersion = currentSessionVersion + 1;
  await user.save();
};
