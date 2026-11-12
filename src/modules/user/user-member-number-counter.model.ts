import mongoose from "mongoose";

import { userMemberNumberCounterSchema } from "./user-member-number-counter.schema.js";

export type UserMemberNumberCounter = {
  _id: string;
  tenant: mongoose.Types.ObjectId;
  key: string;
  value: number;
  allocationEpoch?: number;
  allocationPausedUntil?: Date | null;
  repairLock?: string | null;
};

const UserMemberNumberCounterModel =
  (mongoose.models.UserMemberNumberCounter as
    mongoose.Model<UserMemberNumberCounter> | undefined) ??
  mongoose.model<UserMemberNumberCounter>(
    "UserMemberNumberCounter",
    userMemberNumberCounterSchema,
  );

export default UserMemberNumberCounterModel;
