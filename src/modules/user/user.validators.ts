import mongoose from "mongoose";

import {
  EMAIL_REGEX,
  PASSWORD_MIN_LENGTH,
  TENANT_ROLE,
} from "./user.constants.js";
import type {
  CreateUserInput,
  UpdatePasswordInput,
  UpdateUserInput,
} from "./user.types.js";

import { badRequest } from "../../shared/http/httpErrors.js";

export const assertValidObjectId: (
  value: unknown,
  message?: string,
) => asserts value is string = (value: unknown, message = "Invalid id") => {
  if (typeof value !== "string" || !mongoose.Types.ObjectId.isValid(value)) {
    badRequest(message);
  }
};

export const assertValidCreateUserInput = (
  input: Partial<CreateUserInput>,
): asserts input is CreateUserInput => {
  if (
    !input.firstname ||
    !input.lastname ||
    !input.email ||
    !input.password
  ) {
    badRequest("All required user fields must be provided");
  }

  if (!EMAIL_REGEX.test(input.email)) {
    badRequest("Invalid email address");
  }

  if (input.password.length < PASSWORD_MIN_LENGTH) {
    badRequest(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }

  if (input.tenantRole && !Object.values(TENANT_ROLE).includes(input.tenantRole)) {
    badRequest("Invalid tenant role");
  }
};

export const assertValidUpdateUserInput = (
  input: Partial<UpdateUserInput>,
): asserts input is UpdateUserInput => {
  if (!input.id) badRequest("User id is required");

  if (input.email && !EMAIL_REGEX.test(input.email)) {
    badRequest("Invalid email address");
  }
};

export const assertValidUpdatePasswordInput = (
  input: Partial<UpdatePasswordInput>,
): asserts input is UpdatePasswordInput => {
  if (!input.id || !input.currentPass || !input.newPass || !input.newPassConfirm) {
    badRequest("All password fields are required");
  }

  if (input.newPass !== input.newPassConfirm) {
    badRequest("Passwords do not match");
  }

  if (input.newPass.length < PASSWORD_MIN_LENGTH) {
    badRequest(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
};

