import { logger } from "@/config/logger.js";

import { sendAccessCodeNotifications } from "../services/access-code-notification.service.js";

export async function sendOutAccessCodes(): Promise<void> {
  const result = await sendAccessCodeNotifications();

  logger.info(
    result,
    "Access code notification job completed.",
  );
}