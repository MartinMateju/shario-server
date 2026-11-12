import mongoose from "mongoose";

import { workspaceNotificationSchema } from "./workspace-notification.schema.js";
import type { WorkspaceNotification } from "./workspace-notification.types.js";

const WorkspaceNotificationModel =
  (mongoose.models.WorkspaceNotification as
    mongoose.Model<WorkspaceNotification> | undefined) ??
  mongoose.model<WorkspaceNotification>(
    "WorkspaceNotification",
    workspaceNotificationSchema,
  );

export default WorkspaceNotificationModel;
