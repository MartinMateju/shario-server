import { randomUUID } from "node:crypto";

import { badRequest, conflict, notFound } from "@/shared/http/httpErrors.js";
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
import { changePasswordAndRevokeSessions } from "@/modules/account/account.service.js";

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
}: {
  tenantId: string;
  input: Partial<UpdateUserInput>;
}) => {
  validateUpdateUserInput(input);

  const repository = createUserRepository({ tenantId });

  const user = await repository.findDocumentById(input.id);

  if (!user) {
    notFound("User not found");
  }

  if (input.email) {
    const email = normalizeEmail(input.email);
    const duplicate = await repository.findOne({ email });

    if (duplicate && String(duplicate._id) !== input.id) {
      conflict("Duplicate email");
    }

    user.email = email;
  }

  if (input.firstname !== undefined) user.firstname = input.firstname;
  if (input.lastname !== undefined) user.lastname = input.lastname;
  if (input.phone !== undefined) user.phone = input.phone;
  await repository.save(user);

  return {
    message: `User ${input.id} was successfully updated.`,
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

  await repository.deleteById(id);

  return {
    message: `User ${id} was deleted`,
  };
};
