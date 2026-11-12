import mongoose, {
  Schema,
  type Model,
  type Types,
} from "mongoose";

import {
  CUSTOMER_SOCIAL_PROVIDERS,
  type CustomerSocialProvider,
} from "./customer-social.constants.js";

export type CustomerSocialIdentity = {
  tenant: Types.ObjectId;
  user: Types.ObjectId;
  provider: CustomerSocialProvider;
  subject: string;
  providerEmail: string;
  emailVerified: boolean;
  lastAuthenticatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export const customerSocialIdentitySchema = new Schema(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: CUSTOMER_SOCIAL_PROVIDERS,
      required: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
    },
    providerEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
    },
    emailVerified: {
      type: Boolean,
      required: true,
      default: true,
    },
    lastAuthenticatedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    strict: true,
  },
);

customerSocialIdentitySchema.index(
  { tenant: 1, provider: 1, subject: 1 },
  {
    unique: true,
    name: "tenant_provider_subject_unique",
  },
);

customerSocialIdentitySchema.index(
  { tenant: 1, user: 1, provider: 1 },
  {
    unique: true,
    name: "tenant_user_provider_unique",
  },
);

const CustomerSocialIdentityModel =
  (mongoose.models.CustomerSocialIdentity as
    | Model<CustomerSocialIdentity>
    | undefined) ??
  mongoose.model<CustomerSocialIdentity>(
    "CustomerSocialIdentity",
    customerSocialIdentitySchema,
  );

export default CustomerSocialIdentityModel;
