export const EMAIL_NOTIFICATION_POPULATE = [
  {
    path: "sentBy",
    select: "firstname lastname email customId",
  },
  {
    path: "relatedBooking",
    select: "start end status",
  },
] as const;

export const NOTIFICATION_LOG_POPULATE = [
  {
    path: "user",
    select: "firstname lastname email customId",
  },
  {
    path: "booking",
    select: "start end status location",
  },
] as const;
