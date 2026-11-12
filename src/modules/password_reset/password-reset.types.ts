import type { HydratedDocument, InferSchemaType, Model } from "mongoose";

import type { passwordResetSchema } from "./password-reset.schema.js";

export type PasswordReset = InferSchemaType<typeof passwordResetSchema>;
export type PasswordResetDocument = HydratedDocument<PasswordReset>;
export type PasswordResetModel = Model<PasswordReset>;

export type PasswordResetEmailPayload = {
  tenantId: string;
  to: string;
  otp: string;
  expiresInMinutes: number;
  locale?: "cs" | "en";
  studioName?: string;
};
