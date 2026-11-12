import { staffTaskSchema } from "./staff-task.schema.js";
// staff-task.model.ts

import mongoose from "mongoose";

import type { StaffTask } from "./staff.types.js";

export const StaffTaskModel =
  mongoose.models.StaffTask ||
  mongoose.model<StaffTask>("StaffTask", staffTaskSchema);

export default StaffTaskModel;