export const buildGuestIncreaseCapacityHoldRequirement = ({
  orderId,
  addGuests,
  capacityReserved,
  now = new Date(),
}: {
  orderId: unknown;
  addGuests: number;
  capacityReserved: boolean;
  now?: Date;
}) =>
  capacityReserved
    ? {
        capacityReservations: {
          $elemMatch: {
            order: orderId,
            quantity: addGuests,
            expiresAt: { $gt: now },
          },
        },
      }
    : {};
