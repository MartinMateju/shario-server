import mongoose from "mongoose";

import { customerNotificationSchema } from "./customer-notification.schema.js";
import type { CustomerNotification } from "./customer-notification.types.js";

const CustomerNotificationModel =
  (mongoose.models.CustomerNotification as
    mongoose.Model<CustomerNotification> | undefined) ??
  mongoose.model<CustomerNotification>(
    "CustomerNotification",
    customerNotificationSchema,
  );

export default CustomerNotificationModel;
