import { staffMemberSchema } from "./staff-member.schema.js";
// staff-member.model.ts

import mongoose from "mongoose";

import type { StaffMember } from "./staff.types.js";

export const StaffMemberModel =
  mongoose.models.StaffMember ||
  mongoose.model<StaffMember>("StaffMember", staffMemberSchema);

export default StaffMemberModel;