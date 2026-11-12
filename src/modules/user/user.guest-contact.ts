import { isInactiveGeneratedGuest } from "./user-member-number.service.js";

export type ContactUser = {
  email?: unknown;
  customId?: unknown;
  isAccessGranted?: unknown;
  guestContact?: { email?: unknown; locale?: unknown } | null;
};

/** Delivery/display only. Never use this to resolve an authentication identity. */
export const getGuestContact = (user: ContactUser | null | undefined) =>
  user && isInactiveGeneratedGuest(user) ? user.guestContact : null;

export const getCustomerContactEmail = (user: ContactUser | null | undefined) =>
  String(user?.email || getGuestContact(user)?.email || "").trim();

/** Workspace readers may display the contact without exposing its private storage. */
export const withWorkspaceContact = <T extends ContactUser>(user: T) => {
  const { guestContact: _privateContact, ...safe } = user;
  return { ...safe, email: getCustomerContactEmail(user) };
};
