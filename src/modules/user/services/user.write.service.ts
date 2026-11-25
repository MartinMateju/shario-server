import { randomUUID } from "node:crypto";
import mongoose from "mongoose";

import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "@/shared/http/httpErrors.js";
import { createUserRepository } from "@/modules/user/user.repository.js";
import type {
  CreateUserInput,
  UpdatePasswordInput,
  UpdateUserInput,
} from "@/modules/user/user.types.js";
import { normalizeEmail } from "@/modules/user/user.utils.js";
import { PLATFORM_ROLE, TENANT_ROLE } from "@/modules/user/user.constants.js";
import {
  assertValidCreateUserInput,
  assertValidUpdatePasswordInput,
  assertValidUpdateUserInput,
} from "@/modules/user/user.validators.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import Booking from "@/modules/booking/booking.model.js";
import UserMembershipModel from "@/modules/membership/user-membership.model.js";
import { changePasswordAndRevokeSessions } from "@/modules/account/account.service.js";
import { verificationRepository } from "@/modules/verification/user-verification.repository.js";
import { verificationService } from "@/modules/verification/services/user-verification.service.js";
import { passwordResetRepository } from "@/modules/password_reset/password-reset.repository.js";
import { findTenantById } from "@/modules/tenants/tenant.repository.js";
import { logger } from "@/config/logger.js";

const validateCreateUserInput: (
  input: Partial<CreateUserInput>,
) => asserts input is CreateUserInput = assertValidCreateUserInput;

const validateUpdateUserInput: (
  input: Partial<UpdateUserInput>,
) => asserts input is UpdateUserInput = assertValidUpdateUserInput;

const validateUpdatePasswordInput: (
  input: Partial<UpdatePasswordInput>,
) => asserts input is UpdatePasswordInput = assertValidUpdatePasswordInput;

export const createUser = async ({
  tenantId,
  input,
}: {
  tenantId: string;
  input: Partial<CreateUserInput>;
}) => {
  validateCreateUserInput(input);

  const repository = createUserRepository({ tenantId });
  const email = normalizeEmail(input.email);

  const duplicate = await repository.findOne({ email });

  if (duplicate) {
    conflict("Duplicate email");
  }

  const payload: CreateUserInput = {
    firstname: input.firstname,
    lastname: input.lastname,
    email,
    phone: input.phone?.trim() || "",
    password: input.password,
    // customId is an opaque legacy/QR identifier. Ignore old client-supplied
    // values so they cannot collide with the numeric member-ID namespace.
    customId: `U-${randomUUID()}`,
    tenantRole: TENANT_ROLE.CUSTOMER,
    platformRole: PLATFORM_ROLE.NONE,
    roles: [],
  };

  const user = await repository.create(payload);

  return {
    message: `New user ${email} created`,
    userId: user._id,
  };
};

export const updateUser = async ({
  tenantId,
  input,
  requestedOrigin,
}: {
  tenantId: string;
  input: Partial<UpdateUserInput>;
  requestedOrigin?: string;
}) => {
  validateUpdateUserInput(input);
  const session = await mongoose.startSession();
  let emailChanged = false;
  let changedEmail = "";
  try {
    await session.withTransaction(async () => {
      const repository = createUserRepository({ tenantId, session });
      const user = await repository.findDocumentById(input.id, {
        select: "+tenantRole +platformRole +sessionVersion +refreshToken +passwordResetOtpHash +passwordResetOtpExpiresAt +emailToken",
      });
      if (!user) notFound("User not found");

      // Customer management never edits a workspace or platform login identity.
      const workspaceMembership = await TenantMembershipModel.exists({
        tenant: tenantId, user: input.id,
      }).session(session);
      if (workspaceMembership ||
        String(user.tenantRole ?? TENANT_ROLE.CUSTOMER) !== TENANT_ROLE.CUSTOMER ||
        String(user.platformRole ?? PLATFORM_ROLE.NONE) !== PLATFORM_ROLE.NONE) {
        forbidden({
          message: "Workspace team accounts cannot be edited from the customer API. Team members update their own profile.",
          code: "WORKSPACE_MEMBER_PROFILE_NOT_EDITABLE",
        });
      }

      const currentEmail = user.email ? normalizeEmail(user.email) : "";
      const email = input.email ? normalizeEmail(input.email) : currentEmail;
      emailChanged = email !== currentEmail;
      if (emailChanged) {
        const duplicate = await repository.findOne({ email });
        if (duplicate && String(duplicate._id) !== input.id) conflict("Duplicate email");

        const version = user.sessionVersion ?? 0;
        if (!Number.isSafeInteger(version) || version < 0 || version === Number.MAX_SAFE_INTEGER) {
          conflict({ message: "This account's credentials require review before its email can change.", code: "INVALID_SESSION_VERSION" });
        }
        user.email = email;
        user.isEmailVerified = false;
        user.refreshToken = [];
        user.sessionVersion = version + 1;
        user.passwordResetOtpHash = undefined;
        user.passwordResetOtpExpiresAt = undefined;
        user.emailToken = undefined;
        await verificationRepository.deletePendingEmailTokens(tenantId, input.id, session);
        await passwordResetRepository.invalidateActiveForUser(tenantId, input.id, session);
        changedEmail = email;
      }
      if (input.firstname !== undefined) user.firstname = input.firstname;
      if (input.lastname !== undefined) user.lastname = input.lastname;
      if (input.phone !== undefined) user.phone = input.phone;
      await repository.save(user);
    });
  } finally {
    await session.endSession();
  }

  // Delivery happens after the identity change commits. Provider failure must
  // not restore verified status or old credentials; the existing resend flow
  // can issue a fresh link to the new address.
  let verificationEmailStatus: "not_required" | "sent" | "retry_required" = "not_required";
  if (emailChanged) {
    verificationEmailStatus = "retry_required";
    try {
      const tenant = await findTenantById(tenantId);
      if (tenant) {
        const result = await verificationService.sendVerificationEmail({
          tenant, userId: input.id, email: changedEmail, requestedOrigin,
        });
        if (result.sent) verificationEmailStatus = "sent";
      }
    } catch {
      logger.warn({ tenantId, userId: input.id }, "Customer email changed; verification delivery requires retry.");
    }
  }

  return {
    message: `User ${input.id} was successfully updated.`,
    emailChanged,
    verificationEmailStatus,
  };
};

export const updateUserPassword = async ({
  tenantId,
  input,
}: {
  tenantId: string;
  input: Partial<UpdatePasswordInput>;
}) => {
  validateUpdatePasswordInput(input);

  await changePasswordAndRevokeSessions({
    tenantId,
    userId: input.id,
    currentPassword: input.currentPass,
    newPassword: input.newPass,
  });

  return {
    message: "Password was updated",
  };
};

export const deleteUser = async ({
  tenantId,
  id,
}: {
  tenantId: string;
  id?: string;
}) => {
  if (!id) {
    badRequest("User ID required");
  }

  const repository = createUserRepository({ tenantId });

  const user = await repository.findById(id);

  if (!user) {
    notFound("User not found");
  }

  const workspaceMembership = await TenantMembershipModel.exists({
    tenant: tenantId,
    user: id,
  });

  if (workspaceMembership) {
    conflict({
      message:
        "Workspace team accounts cannot be deleted from the customer API. Revoke their workspace membership instead.",
      code: "WORKSPACE_MEMBERSHIP_MUST_BE_REVOKED",
    });
  }

  // Deleting a customer is permanent. Refuse while the studio still owes them
  // something or expects them, so balances and bookings are never orphaned.
  const [futureBooking, openMembership] = await Promise.all([
    Booking.exists({
      tenant: tenantId,
      createdBy: id,
      end: { $gt: new Date() },
      archive: { $ne: true },
      status: { $ne: "cancelled" },
    }),
    UserMembershipModel.exists({ tenant: tenantId, user: id, isOpen: true }),
  ]);
  const balances = user as {
    moneyCredits?: number;
    moneyCreditsMinor?: number | null;
    membershipCredits?: number;
  };
  const blockers = [
    Number(balances.moneyCreditsMinor ?? 0) > 0 ||
    Number(balances.moneyCredits ?? 0) > 0
      ? "studio credit balance"
      : null,
    Number(balances.membershipCredits ?? 0) > 0
      ? "membership hours balance"
      : null,
    openMembership ? "open membership" : null,
    futureBooking ? "upcoming booking" : null,
  ].filter(Boolean);

  if (blockers.length) {
    conflict({
      message: `This customer cannot be deleted while they have: ${blockers.join(", ")}. Settle or cancel these first.`,
      code: "CUSTOMER_HAS_OPEN_COMMITMENTS",
      details: { blockers },
    });
  }

  await repository.deleteById(id);

  return {
    message: `User ${id} was deleted`,
  };
};
