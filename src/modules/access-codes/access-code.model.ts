import mongoose from "mongoose";
import type { Model } from "mongoose";

import {
  accessCodeAuditEventSchema,
  accessCodeNotificationSchema,
  accessCodePoolSchema,
  accessCodeSchema,
} from "./access-code.schema.js";

import type {
  AccessCode as AccessCodeType,
  AccessCodeAuditEvent as AccessCodeAuditEventType,
  AccessCodeNotification as AccessCodeNotificationType,
  AccessCodePool as AccessCodePoolType,
} from "./access-code.types.js";

type AccessCodeModel = Model<AccessCodeType>;
type AccessCodeNotificationModel = Model<AccessCodeNotificationType>;
type AccessCodePoolModel = Model<AccessCodePoolType>;
type AccessCodeAuditEventModel = Model<AccessCodeAuditEventType>;

export const AccessCodePool =
  (mongoose.models.AccessCodePool as AccessCodePoolModel | undefined) ||
  mongoose.model<AccessCodePoolType, AccessCodePoolModel>(
    "AccessCodePool",
    accessCodePoolSchema,
  );

export const AccessCode =
  (mongoose.models.AccessCode as AccessCodeModel | undefined) ||
  mongoose.model<AccessCodeType, AccessCodeModel>(
    "AccessCode",
    accessCodeSchema,
  );

export const AccessCodeNotification =
  (mongoose.models.AccessCodeNotification as
    | AccessCodeNotificationModel
    | undefined) ||
  mongoose.model<AccessCodeNotificationType, AccessCodeNotificationModel>(
    "AccessCodeNotification",
    accessCodeNotificationSchema,
  );

export const AccessCodeAuditEvent =
  (mongoose.models.AccessCodeAuditEvent as
    | AccessCodeAuditEventModel
    | undefined) ||
  mongoose.model<AccessCodeAuditEventType, AccessCodeAuditEventModel>(
    "AccessCodeAuditEvent",
    accessCodeAuditEventSchema,
  );
