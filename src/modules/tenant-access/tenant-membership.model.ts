import mongoose, { type InferSchemaType, type Model } from "mongoose";

import { tenantMembershipSchema } from "./tenant-membership.schema.js";

type TenantMembershipModelType = Model<
  InferSchemaType<typeof tenantMembershipSchema>
>;

export const TenantMembershipModel =
  (mongoose.models.TenantMembership as TenantMembershipModelType | undefined) ??
  mongoose.model<InferSchemaType<typeof tenantMembershipSchema>>(
    "TenantMembership",
    tenantMembershipSchema,
  );

export default TenantMembershipModel;
