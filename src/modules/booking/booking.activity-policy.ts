import {
  PLANNED_ACTIVITY,
  type PlannedActivity,
} from "@/modules/booking/booking.constants.js";
import { LOCATION_ACTIVITY_SELECTION_MODE } from "@/modules/location/location.constants.js";
import { resolveLocationActivitySelectionMode } from "@/modules/location/location.utils.js";
import { badRequest } from "@/shared/http/httpErrors.js";

type LocationActivityPolicy = {
  booking?: {
    activitySelectionMode?: unknown;
    activityCapacities?: Array<{ activity?: unknown }>;
  };
};

export const resolveLocationBookingPlannedActivity = ({
  location,
  plannedActivity,
}: {
  location: LocationActivityPolicy;
  plannedActivity: PlannedActivity;
}): PlannedActivity => {
  const activitySelectionMode = resolveLocationActivitySelectionMode(
    location.booking?.activitySelectionMode,
  );

  if (activitySelectionMode === LOCATION_ACTIVITY_SELECTION_MODE.HIDDEN) {
    return PLANNED_ACTIVITY.UNDEFINED;
  }

  if (
    activitySelectionMode === LOCATION_ACTIVITY_SELECTION_MODE.REQUIRED &&
    plannedActivity === PLANNED_ACTIVITY.UNDEFINED
  ) {
    badRequest({
      message: "Select an activity for this booking.",
      code: "BOOKING_ACTIVITY_REQUIRED",
    });
  }

  if (plannedActivity !== PLANNED_ACTIVITY.UNDEFINED) {
    const selectableActivities = new Set(
      (location.booking?.activityCapacities || []).map((entry) =>
        String(entry.activity),
      ),
    );

    if (!selectableActivities.has(plannedActivity)) {
      badRequest({
        message: "The selected activity is not offered at this location.",
        code: "BOOKING_ACTIVITY_NOT_AVAILABLE",
      });
    }
  }

  return plannedActivity;
};
