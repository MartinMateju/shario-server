import { notificationRepository } from "@/modules/notification/notification.repository.js";
import type {
  EmailNotificationListFilters,
  NotificationListFilters,
} from "@/modules/notification/notification.types.js";
import type {
  EmailNotificationType,
  NotificationStatus,
} from "@/modules/notification/notification.constants.js";
import type { CreateEmailNotificationInput } from "@/modules/notification/notification.validators.js";

type ListNotificationLogsServiceFilters = Omit<
  NotificationListFilters,
  "status" | "type"
> & {
  status?: string;
  type?: string;
};

type ListEmailNotificationsServiceFilters = Omit<
  EmailNotificationListFilters,
  "emailType"
> & {
  emailType?: string;
};

export const notificationService = {
  listLogs(filters: ListNotificationLogsServiceFilters) {
    return notificationRepository.listLogs({
      ...filters,
      status: filters.status as NotificationStatus | undefined,
      type: filters.type as EmailNotificationType | undefined,
    });
  },

  listEmailNotifications(filters: ListEmailNotificationsServiceFilters) {
    return notificationRepository.listEmailNotifications({
      ...filters,
      emailType: filters.emailType as EmailNotificationType | undefined,
    });
  },

  getEmailNotificationById(tenantId: string, notificationId: string) {
    return notificationRepository.findEmailNotificationByIdForTenant(
      tenantId,
      notificationId,
    );
  },

  createEmailNotification(
    tenantId: string,
    sentBy: string,
    input: CreateEmailNotificationInput,
  ) {
    return notificationRepository.createEmailNotification(
      tenantId,
      sentBy,
      input,
    );
  },
};