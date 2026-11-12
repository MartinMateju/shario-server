/** Legacy participants without an attendance status still occupy a place. */
export const isActiveBookingParticipant = (participant: any): boolean =>
  participant?.attendanceStatus !== "removed";

export const activeBookingParticipants = (booking: any): any[] =>
  (Array.isArray(booking?.participants) ? booking.participants : []).filter(
    isActiveBookingParticipant,
  );

const id = (value: any): string => String(value?._id ?? value ?? "");

/**
 * Financial order ownership survives attendance edits. Only attendance reminders
 * use this check; purchase confirmations and refunds must keep their order source.
 */
export const hasActiveOrderAttendance = (booking: any, orderId: unknown): boolean =>
  booking?.attendanceManaged !== true ||
  (Boolean(id(orderId)) &&
    activeBookingParticipants(booking).some(
      (participant) => id(participant.order) === id(orderId),
    ));
