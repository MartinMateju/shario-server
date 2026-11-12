import mongoose from "mongoose";

import { courseReminderDeliverySchema } from "./course-reminder-delivery.schema.js";
import type {
  CourseReminderDelivery,
  CourseReminderDeliveryModel,
} from "./course-reminder-delivery.types.js";

const model =
  (mongoose.models.CourseReminderDelivery as
    | CourseReminderDeliveryModel
    | undefined) ||
  mongoose.model<CourseReminderDelivery, CourseReminderDeliveryModel>(
    "CourseReminderDelivery",
    courseReminderDeliverySchema,
  );

export default model;
