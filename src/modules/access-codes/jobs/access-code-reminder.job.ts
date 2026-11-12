import { logger } from "@/config/logger.js";

import { sendUpcomingCourseReminders } from "../services/access-code-reminder.service.js";

export async function sendUpcomingBookingReminders(): Promise<void> {
  const sentCount = await sendUpcomingCourseReminders();

  logger.info(
    {
      sentCount,
    },
    "Upcoming booking reminder job completed.",
  );
}