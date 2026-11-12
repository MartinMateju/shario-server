export const COURSE_REMINDER_DELIVERY_STATUS = {
  PENDING: "pending",
  SENDING: "sending",
  SENT: "sent",
  SKIPPED: "skipped",
  FAILED: "failed",
  AMBIGUOUS: "ambiguous",
} as const;

export const COURSE_REMINDER_DELIVERY_STATUSES = Object.values(
  COURSE_REMINDER_DELIVERY_STATUS,
);

export type CourseReminderDeliveryStatus =
  (typeof COURSE_REMINDER_DELIVERY_STATUS)[keyof typeof COURSE_REMINDER_DELIVERY_STATUS];
