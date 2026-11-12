import { processPaidOrderNotifications } from "@/modules/order/jobs/order.notification.job.js";

export const sendOutNotificationsAfterPayment = async (): Promise<void> => {
  await processPaidOrderNotifications();
};
