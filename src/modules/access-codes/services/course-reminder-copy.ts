import { formatDateTimeRange } from "@/modules/access-codes/access-code.utils.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import { resolveTenantLocaleSettings } from "@/modules/tenants/tenant-locale.js";
import {
  COMMUNICATION_CONTENT_LOCALE,
  resolveCommunicationContentLocale,
  type CommunicationContentLocale,
} from "@/shared/i18n/communication-locales.js";

/**
 * The legacy course reminder runs for every studio, so its copy follows the
 * studio's public default language: Czech for Czech studios, English for
 * everyone else.
 */
export const resolveCourseReminderLocale = async (
  tenantId: unknown,
): Promise<CommunicationContentLocale> => {
  try {
    const tenant = await Tenant.findById(tenantId as never)
      .select("settings")
      .lean<{ settings?: Record<string, unknown> } | null>()
      .exec();
    if (!tenant) return COMMUNICATION_CONTENT_LOCALE.EN;

    return resolveCommunicationContentLocale(
      resolveTenantLocaleSettings(tenant.settings as never)
        .publicDefaultLanguage,
    );
  } catch {
    return COMMUNICATION_CONTENT_LOCALE.EN;
  }
};

export const buildCourseReminderCopy = ({
  locale,
  courseName,
  locationName,
  start,
  end,
  timezone,
}: {
  locale: CommunicationContentLocale;
  courseName?: string | null;
  locationName?: string | null;
  start: Date;
  end: Date;
  timezone: string;
}): { subject: string; textContent: string } => {
  const dateTime = formatDateTimeRange(start, end, timezone, locale);
  const location = locationName || "Studio";

  if (locale === COMMUNICATION_CONTENT_LOCALE.CS) {
    const name = courseName || "kurz keramiky";
    return {
      subject: `Připomínka: ${name} už brzy`,
      textContent: `Dobrý den,\n\npřipomínáme, že váš kurz ${name} začíná ${dateTime}.\n\n${location}`,
    };
  }

  const name = courseName || "your class";
  return {
    subject: `Reminder: ${name} is coming up`,
    textContent: `Hello,\n\nthis is a reminder that ${name} starts on ${dateTime}.\n\n${location}`,
  };
};
