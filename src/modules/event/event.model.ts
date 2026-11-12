import mongoose from "mongoose";

import { eventSchema } from "./event.schema.js";
import type { EventModel } from "./event.types.js";

export const Event =
  (mongoose.models.Event as EventModel | undefined) ||
  mongoose.model("Event", eventSchema);

export default Event;
