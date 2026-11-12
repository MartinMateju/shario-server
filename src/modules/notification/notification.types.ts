import type { HydratedDocument, InferSchemaType, Types } from "mongoose";

import type { emailNotificationSchema } from "./notification.schema.js";
import type { notificationLogSchema } from "./notification-log.schema.js";
import type {
  EmailNotificationType,
  NotificationStatus,
} from "./notification.constants.js";

export type NotificationLog = InferSchemaType<typeof notificationLogSchema>;
export type NotificationLogDocument = HydratedDocument<NotificationLog>;

export type EmailNotification = InferSchemaType<typeof emailNotificationSchema>;
export type EmailNotificationDocument = HydratedDocument<EmailNotification>;

export type NotificationListFilters = {
  tenantId: string;
  status?: NotificationStatus;
  type?: string;
  recipient?: string;
  page: number;
  limit: number;
};

export type EmailNotificationListFilters = {
  tenantId: string;
  emailType?: string;
  sentFrom?: Date;
  sentTo?: Date;
  page: number;
  limit: number;
};

export type NotificationRecipientInput = {
  user?: string | Types.ObjectId | null;
  userCustomId?: string;
  firstname?: string;
  lastname?: string;
  email: string;
  privateMessage?: string;
  photoUrl?: string;
  locationId?: string;
  itemCount?: number | null;
  recipientIndex?: number;
  files?: Express.Multer.File[];
};

export type SendBulkEmailNotificationInput = {
  tenantId: string;
  sentBy: string;
  title: string;
  emailType: EmailNotificationType | string;
  subject: string;
  globalMessage: string;
  relatedBooking?: string | null;
  recipients: NotificationRecipientInput[];
  locationId?: string;
  message?: string;
};

export type NotificationDeliveryFailure = {
  recipientIndex: number;
  email: string;
  code: "EMAIL_DELIVERY_FAILED";
  message: string;
};

export type NotificationDeliveryResult = {
  totalCount: number;
  sentCount: number;
  failedCount: number;
  failures: NotificationDeliveryFailure[];
};
