import type { Job } from "bullmq";
import { z } from "zod";

import { notificationQueue } from "@/infrastructure/queues/notification.queue.js";

export const enqueueNotificationSchema = z.object({
  tenantId: z.string().trim().min(1),
  type: z.string().trim().min(1),

  userId: z.string().trim().optional().nullable(),
  bookingId: z.string().trim().optional().nullable(),

  recipient: z.string().trim().email(),
  subject: z.string().trim().min(1),
  html: z.string().min(1),

  delay: z.coerce.number().int().min(0).default(0),
});

export type EnqueueNotificationInput = z.infer<
  typeof enqueueNotificationSchema
>;

export type NotificationJobPayload = Omit<
  EnqueueNotificationInput,
  "delay"
>;

export const enqueueNotification = async (
  input: EnqueueNotificationInput,
): Promise<Job<NotificationJobPayload>> => {
  const data = enqueueNotificationSchema.parse(input);

  const { delay, ...payload } = data;

  return notificationQueue.add(data.type, payload, {
    delay,
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 60_000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
    jobId: [
      data.tenantId,
      data.type,
      data.userId || "no-user",
      data.bookingId || "no-booking",
      data.recipient,
    ].join(":"),
  });
};