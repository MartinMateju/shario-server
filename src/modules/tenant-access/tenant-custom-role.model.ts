import mongoose, { type InferSchemaType, type Model } from "mongoose";

import { tenantCustomRoleSchema } from "./tenant-custom-role.schema.js";

type TenantCustomRoleModelType = Model<
  InferSchemaType<typeof tenantCustomRoleSchema>
>;

export const TenantCustomRoleModel =
  (mongoose.models.TenantCustomRole as TenantCustomRoleModelType | undefined) ??
  mongoose.model<InferSchemaType<typeof tenantCustomRoleSchema>>(
    "TenantCustomRole",
    tenantCustomRoleSchema,
  );

export default TenantCustomRoleModel;
