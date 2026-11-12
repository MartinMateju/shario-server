import mongoose from "mongoose";

import { emailNotificationSchema } from "@/modules/notification/notification.schema.js";
import type { EmailNotification as EmailNotificationAttributes } from "@/modules/notification/notification.types.js";

export const EmailNotification =
  (mongoose.models.EmailNotification as
    | mongoose.Model<EmailNotificationAttributes>
    | undefined) ??
  mongoose.model<EmailNotificationAttributes>(
    "EmailNotification",
    emailNotificationSchema,
  );

export default EmailNotification;