import mongoose from "mongoose";

import { notificationLogSchema } from "./notification-log.schema.js";
import type { NotificationLog as NotificationLogType } from "./notification.types.js";

export const NotificationLog =
  (mongoose.models.NotificationLog as
    | mongoose.Model<NotificationLogType>
    | undefined) ??
  mongoose.model<NotificationLogType>(
    "NotificationLog",
    notificationLogSchema,
  );

export default NotificationLog;