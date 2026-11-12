import { getCustomerContactEmail } from "./user.guest-contact.js";

const id = (value: unknown): string =>
  String((value as { _id?: unknown } | null)?._id ?? value ?? "").trim();

const iso = (value: unknown): string | null => {
  if (!value) return null;

  const date = new Date(value as string | number | Date);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Canonical workspace-facing customer representation.
 *
 * Keep this allow-list deliberately small. In particular, never spread a
 * Mongoose user document here: newly-created documents can still contain
 * select:false credentials before they are queried again.
 */
export const serializeCustomer = (customer: any) => ({
  id: id(customer),
  customId: String(customer?.customId ?? ""),
  memberNumber:
    Number.isSafeInteger(customer?.memberNumber) && customer.memberNumber > 0
      ? customer.memberNumber
      : null,
  firstname: String(customer?.firstname ?? ""),
  lastname: String(customer?.lastname ?? ""),
  email: getCustomerContactEmail(customer),
  phone: String(customer?.phone ?? ""),
  isAccessGranted: customer?.isAccessGranted !== false,
  isEmailVerified: customer?.isEmailVerified === true,
  lastLoginAt: iso(customer?.lastLoginAt),
  createdAt: iso(customer?.createdAt),
  updatedAt: iso(customer?.updatedAt),
});
