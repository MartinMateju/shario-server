import type {
  ClientSession,
  HydratedDocument,
  InferSchemaType,
} from "mongoose";

import type { customerNotificationSchema } from "./customer-notification.schema.js";
import type {
  CustomerNotificationCategory,
  CustomerNotificationEvent,
  CustomerNotificationSeverity,
  CustomerNotificationStatus,
} from "./customer-notification.constants.js";

export type CustomerNotification = InferSchemaType<
  typeof customerNotificationSchema
>;
export type CustomerNotificationDocument =
  HydratedDocument<CustomerNotification>;

export type CustomerNotificationLocalizedText = {
  cs: string;
  en: string;
};

export type CustomerNotificationVisibility = {
  tenantId: string;
  recipientUserId: string;
};

export type CustomerNotificationListFilters = CustomerNotificationVisibility & {
  category?: CustomerNotificationCategory;
  status: CustomerNotificationStatus;
  page: number;
  limit: number;
};

export type CustomerNotificationReadAllFilters =
  CustomerNotificationVisibility & {
    category?: CustomerNotificationCategory;
  };

export type PublishCustomerNotificationInput = {
  tenantId: string;
  recipientUserId: string;
  eventType: CustomerNotificationEvent;
  /** Derived from eventType when omitted; an explicit value must match it. */
  category?: CustomerNotificationCategory;
  severity: CustomerNotificationSeverity;
  title: CustomerNotificationLocalizedText;
  message: CustomerNotificationLocalizedText;
  actionUrl?: string;
  sourceType: string;
  sourceId: string;
  deduplicationKey: string;
  groupKey?: string;
  occurredAt?: Date;
  locationId?: string | null;
  session?: ClientSession | null;
};

export type CustomerNotificationCreateRecord = {
  tenantId: string;
  recipientUserId: string;
  locationId?: string | null;
  eventType: CustomerNotificationEvent;
  category: CustomerNotificationCategory;
  severity: CustomerNotificationSeverity;
  title: CustomerNotificationLocalizedText;
  message: CustomerNotificationLocalizedText;
  actionUrl?: string;
  sourceType: string;
  sourceId: string;
  deduplicationKey: string;
  groupKey?: string;
  occurredAt?: Date;
};

export type CustomerNotificationRepositoryOptions = {
  session?: ClientSession | null;
};
