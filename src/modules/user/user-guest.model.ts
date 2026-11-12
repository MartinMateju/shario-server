// user-guest.model.ts

import mongoose from "mongoose";

import { userGuestSchema } from "./user-guest.schema.js";
import type { UserGuest } from "./user-guest.types.js";

const UserGuestModel =
    mongoose.models.UserGuest ||
    mongoose.model<UserGuest>("UserGuest", userGuestSchema);

export default UserGuestModel;