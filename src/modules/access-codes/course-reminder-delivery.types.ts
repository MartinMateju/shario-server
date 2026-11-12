import type { HydratedDocument, Model, Types } from "mongoose";

import type { CourseReminderDeliveryStatus } from "./course-reminder-delivery.constants.js";

export type CourseReminderDelivery = {
  tenant: Types.ObjectId;
  booking: Types.ObjectId;
  bookingStart: Date;
  recipientUser: Types.ObjectId;
  recipientEmail: string;
  idempotencyKey: string;
  messageId: string;
  subject: string;
  textContent: string;
  status: CourseReminderDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  processingStartedAt: Date | null;
  claimToken: string;
  leaseExpiresAt: Date | null;
  providerAttemptStartedAt: Date | null;
  manualReviewRequiredAt: Date | null;
  nextAttemptAt: Date | null;
  sentAt: Date | null;
  skippedAt: Date | null;
  skipReason: string;
  provider: string;
  providerMessageId: string;
  failureCode: string;
  failureMessage: string;
  createdAt: Date;
  updatedAt: Date;
};

export type CourseReminderDeliveryDocument =
  HydratedDocument<CourseReminderDelivery>;

export type CourseReminderDeliveryModel = Model<CourseReminderDelivery>;

export type CreateCourseReminderDeliveryInput = Pick<
  CourseReminderDelivery,
  | "tenant"
  | "booking"
  | "bookingStart"
  | "recipientUser"
  | "recipientEmail"
  | "idempotencyKey"
  | "messageId"
  | "subject"
  | "textContent"
> & {
  maxAttempts?: number;
};
