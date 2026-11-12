import mongoose from "mongoose";

import { membershipPlanSchema } from "./membership-plan.schema.js";
import type { MembershipPlan as MembershipPlanAttrs } from "./membership.types.js";

export const MembershipPlanModel: mongoose.Model<MembershipPlanAttrs> =
  (mongoose.models.MembershipPlan as mongoose.Model<MembershipPlanAttrs> | undefined) ??
  mongoose.model<MembershipPlanAttrs>("MembershipPlan", membershipPlanSchema);

export { MembershipPlanModel as MembershipPlan };

export default MembershipPlanModel;
