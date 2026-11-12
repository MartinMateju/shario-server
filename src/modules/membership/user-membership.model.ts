import mongoose from "mongoose";

import { userMembershipSchema } from "./user-membership.schema.js";
import type { UserMembership as UserMembershipAttributes } from "./membership.types.js";

export const UserMembership =
  (mongoose.models.UserMembership as
    | mongoose.Model<UserMembershipAttributes>
    | undefined) ??
  mongoose.model<UserMembershipAttributes>(
    "UserMembership",
    userMembershipSchema,
  );

export default UserMembership;