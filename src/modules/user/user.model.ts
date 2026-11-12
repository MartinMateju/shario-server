import { userSchema } from "./user.schema.js";
import mongoose from "mongoose";

import type { User, UserModel } from "./user.types.js";

const UserModel =
  (mongoose.models.User as UserModel | undefined) ||
  mongoose.model<User, UserModel>("User", userSchema);

export default UserModel;