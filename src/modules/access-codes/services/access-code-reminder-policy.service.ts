import { isCommunicationAllowed } from "@/modules/communications/services/consent.service.js";
import { hasActiveOrderAttendance } from "@/modules/booking/booking.attendance-read.js";

export type LegacyCourseReminderUser = {
  _id: unknown;
  email: string;
  firstname?: string;
  lastname?: string;
  tenant?: unknown;
  tenantRole?: string;
  isAccessGranted?: boolean;
};

type LegacyCourseReminderOrder = {
  _id?: unknown;
  tenant?: unknown;
  isPaid?: boolean;
  createdBy?: LegacyCourseReminderUser | unknown;
};

type TransactionalConsent = {
  customerId?: unknown;
  status?: string;
  expiresAt?: Date | string | null;
};

type EmailSuppression = {
  identity?: unknown;
  active?: boolean;
};

const id = (value: unknown): string => {
  if (value && typeof value === "object" && "_id" in value) {
    return String((value as { _id: unknown })._id);
  }
  return String(value || "");
};

export const normalizeLegacyReminderEmail = (value: unknown): string =>
  String(value || "").trim().toLowerCase();

/**
 * This is deliberately fail-closed. The population query already limits the
 * audience, while these checks prevent a malformed or cross-tenant populated
 * document from becoming a recipient.
 */
export const getEligibleLegacyCourseReminderUsers = ({
  tenantId,
  orders,
  booking,
}: {
  tenantId: string;
  orders: LegacyCourseReminderOrder[] | null | undefined;
  booking?: { attendanceManaged?: boolean; participants?: unknown[] };
}): LegacyCourseReminderUser[] => {
  if (!tenantId) return [];

  const byEmail = new Map<string, LegacyCourseReminderUser>();
  for (const order of Array.isArray(orders) ? orders : []) {
    const user = order?.createdBy;
    if (
      order?.isPaid !== true ||
      !hasActiveOrderAttendance(booking, order?._id) ||
      id(order.tenant) !== tenantId ||
      !user ||
      typeof user !== "object" ||
      !id((user as LegacyCourseReminderUser)._id) ||
      id((user as LegacyCourseReminderUser).tenant) !== tenantId ||
      (user as LegacyCourseReminderUser).tenantRole !== "customer" ||
      (user as LegacyCourseReminderUser).isAccessGranted === false
    ) {
      continue;
    }

    const email = normalizeLegacyReminderEmail(
      (user as LegacyCourseReminderUser).email,
    );
    if (!email || byEmail.has(email)) continue;
    byEmail.set(email, { ...(user as LegacyCourseReminderUser), email });
  }

  return [...byEmail.values()];
};

export const getAllowedLegacyCourseReminderUsers = ({
  users,
  consents,
  suppressions,
  now = new Date(),
}: {
  users: LegacyCourseReminderUser[];
  consents: TransactionalConsent[] | null | undefined;
  suppressions: EmailSuppression[] | null | undefined;
  now?: Date;
}): LegacyCourseReminderUser[] => {
  const consentByUserId = new Map(
    (Array.isArray(consents) ? consents : []).map((consent) => [
      id(consent.customerId),
      consent,
    ]),
  );
  const suppressedEmails = new Set(
    (Array.isArray(suppressions) ? suppressions : [])
      .filter((suppression) => suppression.active !== false)
      .map((suppression) => normalizeLegacyReminderEmail(suppression.identity))
      .filter(Boolean),
  );

  return users.filter((user) =>
    isCommunicationAllowed({
      channel: "email",
      purpose: "transactional",
      consent: consentByUserId.get(id(user._id)),
      suppressed: suppressedEmails.has(normalizeLegacyReminderEmail(user.email)),
      now,
    }).allowed,
  );
};
