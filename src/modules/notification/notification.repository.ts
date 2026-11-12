import BookingModel from "@/modules/booking/booking.model.js";
import mongoose from "mongoose";

import { NotificationLog } from "./notification-log.model.js";
import { EmailNotification } from "./notification.model.js";
import type {
  EmailNotificationDocument,
  EmailNotificationListFilters,
  NotificationListFilters,
  NotificationLogDocument,
} from "./notification.types.js";
import type { CreateEmailNotificationInput } from "./notification.validators.js";

const toObjectId = (value: string): mongoose.Types.ObjectId => {
  return new mongoose.Types.ObjectId(value);
};

export const notificationRepository = {
  async listLogs(filters: NotificationListFilters) {
    const skip = (filters.page - 1) * filters.limit;
    const query: Record<string, unknown> = {
      tenant: toObjectId(filters.tenantId),
    };

    if (filters.status) query.status = filters.status;
    if (filters.type) query.type = filters.type;
    if (filters.recipient) {
      query.recipient = { $regex: filters.recipient, $options: "i" };
    }

    const [logs, total] = await Promise.all([
      NotificationLog.find(query)
        .populate("user", "firstname lastname email customId")
        .populate("booking", "start end status location")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(filters.limit)
        .lean()
        .exec(),
      NotificationLog.countDocuments(query).exec(),
    ]);

    return {
      logs,
      total,
      page: filters.page,
      pages: Math.ceil(total / filters.limit),
    };
  },

  async createLog(input: Partial<NotificationLogDocument>) {
    return NotificationLog.create(input);
  },

  async markLogSent(
    logId: string,
    providerMessageId = "",
  ): Promise<NotificationLogDocument | null> {
    return NotificationLog.findByIdAndUpdate(
      logId,
      {
        $set: {
          status: "SENT",
          sentAt: new Date(),
          errorMessage: "",
          providerMessageId,
        },
        $inc: { attempts: 1 },
      },
      { returnDocument: "after" },
    ).exec();
  },

  async markLogFailed(
    logId: string,
    errorMessage: string,
  ): Promise<NotificationLogDocument | null> {
    return NotificationLog.findByIdAndUpdate(
      logId,
      {
        $set: {
          status: "FAILED",
          errorMessage: errorMessage.slice(0, 2000),
        },
        $inc: { attempts: 1 },
      },
      { returnDocument: "after" },
    ).exec();
  },

  async listEmailNotifications(filters: EmailNotificationListFilters) {
    const skip = (filters.page - 1) * filters.limit;
    const query: Record<string, unknown> = {
      tenant: toObjectId(filters.tenantId),
    };

    if (filters.emailType) query.emailType = filters.emailType;

    if (filters.sentFrom || filters.sentTo) {
      query.sentAt = {};
      if (filters.sentFrom) {
        (query.sentAt as Record<string, Date>).$gte = filters.sentFrom;
      }
      if (filters.sentTo) {
        (query.sentAt as Record<string, Date>).$lte = filters.sentTo;
      }
    }

    const [notifications, total] = await Promise.all([
      EmailNotification.find(query)
        .populate("sentBy", "firstname lastname email customId")
        .populate({ path: "relatedBooking", model: BookingModel, select: "start end status", match: { tenant: toObjectId(filters.tenantId) } })
        .sort({ sentAt: -1 })
        .skip(skip)
        .limit(filters.limit)
        .lean()
        .exec(),
      EmailNotification.countDocuments(query).exec(),
    ]);

    return {
      notifications,
      total,
      page: filters.page,
      pages: Math.ceil(total / filters.limit),
    };
  },

  async findEmailNotificationByIdForTenant(
    tenantId: string,
    notificationId: string,
  ) {
    return EmailNotification.findOne({
      _id: toObjectId(notificationId),
      tenant: toObjectId(tenantId),
    })
      .populate("sentBy", "firstname lastname email customId")
      .populate({ path: "relatedBooking", model: BookingModel, select: "start end status", match: { tenant: toObjectId(tenantId) } })
      .lean()
      .exec();
  },

  async createEmailNotification(
    tenantId: string,
    sentBy: string,
    input: CreateEmailNotificationInput,
  ): Promise<EmailNotificationDocument> {
    return EmailNotification.create({
      ...input,
      tenant: toObjectId(tenantId),
      sentBy: toObjectId(sentBy),
      relatedBooking: input.relatedBooking ? toObjectId(input.relatedBooking) : null,
      totalRecipients: input.recipients.length,
      sentAt: new Date(),
    });
  },
};
