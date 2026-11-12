import mongoose from "mongoose";

import { membershipPlanVersionSchema } from "./membership-plan-version.schema.js";

type MembershipPlanVersionRecord = mongoose.InferSchemaType<typeof membershipPlanVersionSchema>;

export const MembershipPlanVersionModel: mongoose.Model<MembershipPlanVersionRecord> =
  (mongoose.models.MembershipPlanVersion as mongoose.Model<MembershipPlanVersionRecord> | undefined) ??
  mongoose.model<MembershipPlanVersionRecord>("MembershipPlanVersion", membershipPlanVersionSchema);

export default MembershipPlanVersionModel;
