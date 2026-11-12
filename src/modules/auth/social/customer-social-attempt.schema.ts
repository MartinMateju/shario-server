import mongoose, {
  Schema,
  type Model,
  type Types,
} from "mongoose";

import {
  CUSTOMER_SOCIAL_PROVIDERS,
  type CustomerSocialProvider,
} from "./customer-social.constants.js";

export type CustomerSocialAttempt = {
  tenant: Types.ObjectId;
  provider: CustomerSocialProvider;
  stateIdHash: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export const customerSocialAttemptSchema = new Schema(
  {
    tenant: {
      type: Schema.Types.ObjectId,
      ref: "Tenant",
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: CUSTOMER_SOCIAL_PROVIDERS,
      required: true,
    },
    stateIdHash: {
      type: String,
      required: true,
      maxlength: 64,
      select: false,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
    strict: true,
  },
);

customerSocialAttemptSchema.index(
  { stateIdHash: 1 },
  {
    unique: true,
    name: "customer_social_state_id_unique",
  },
);

customerSocialAttemptSchema.index(
  { expiresAt: 1 },
  {
    expireAfterSeconds: 0,
    name: "customer_social_attempt_ttl",
  },
);

const CustomerSocialAttemptModel =
  (mongoose.models.CustomerSocialAttempt as
    | Model<CustomerSocialAttempt>
    | undefined) ??
  mongoose.model<CustomerSocialAttempt>(
    "CustomerSocialAttempt",
    customerSocialAttemptSchema,
  );

export default CustomerSocialAttemptModel;
