import type { HydratedDocument, InferSchemaType, Model, Types } from "mongoose";

import type { RolloutEligibleAppLocale } from "@/shared/i18n/locales.js";

import { verificationTokenSchema } from "./user-verification.schema.js";

export type VerificationToken = InferSchemaType<typeof verificationTokenSchema>;
export type VerificationTokenDocument = HydratedDocument<VerificationToken>;
export type VerificationTokenModel = Model<VerificationToken>;

export type IdLike = string | Types.ObjectId;

export type VerificationContext = {
  tenantId: IdLike;
};

export type VerificationTenant = {
  _id?: IdLike;
  id?: IdLike;
  name?: string;
  slug: string;
  domains?: Array<{
    hostname?: string;
    status?: string;
  }>;
  settings?: {
    defaultLanguage?: string;
    publicDefaultLanguage?: string;
  };
  publicSite?: {
    branding?: {
      displayName?: string;
    };
  };
};

export type SendVerificationEmailInput = {
  tenant: VerificationTenant;
  userId: IdLike;
  email: string;
  requestedOrigin?: string;
  next?: string;
  locale?: RolloutEligibleAppLocale;
};

export type VerifyEmailInput = VerificationContext & {
  token: string;
};

export type SendRegistrationConfirmationInput = {
  tenantId: string;
  email: string;
  customId: string;
  memberNumber?: number | null;
  firstname?: string;
};
