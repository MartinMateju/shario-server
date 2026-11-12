export const TENANT_ONBOARDING_STEP = {
  STUDIO_PROFILE: 1,
  BUSINESS_DETAILS: 2,
  BOOKINGS: 3,
  TEAM: 4,
} as const;

export const TENANT_BUSINESS_TYPE = {
  COWORKING_SPACE: "coworking_space",
  REHEARSAL_SPACE: "rehearsal_space",
  COMMUNITY_SPACE: "community_space",
  ART_STUDIO: "art_studio",
  PHOTOGRAPHY_STUDIO: "photography_studio",
  WELLNESS_STUDIO: "wellness_studio",
  OTHER: "other",
} as const;

export const TENANT_TEAM_SIZE = {
  JUST_ME: "just_me",
  TWO_TO_FIVE: "2_5",
  SIX_TO_FIFTEEN: "6_15",
  SIXTEEN_PLUS: "16_plus",
} as const;

export const TENANT_BOOKING_TYPE = {
  OPEN_STUDIO: "open_studio",
  CLASS: "class",
} as const;

/**
 * Historical onboarding answers remain readable during the additive product
 * taxonomy rollout. New writes are normalized to TENANT_BOOKING_TYPE.
 */
export const TENANT_LEGACY_BOOKING_TYPE = {
  CLASSES_COURSES: "classes_courses",
  PRIVATE_SESSIONS: "private_sessions",
  EVENTS: "events",
} as const;

export const TENANT_STORED_BOOKING_TYPES = [
  ...Object.values(TENANT_BOOKING_TYPE),
  ...Object.values(TENANT_LEGACY_BOOKING_TYPE),
] as const;

export const TENANT_CONFIRMATION_MODE = {
  INSTANT: "instant",
  MANUAL: "manual",
} as const;

export type TenantBusinessType =
  (typeof TENANT_BUSINESS_TYPE)[keyof typeof TENANT_BUSINESS_TYPE];

export type TenantTeamSize =
  (typeof TENANT_TEAM_SIZE)[keyof typeof TENANT_TEAM_SIZE];

export type TenantBookingType =
  (typeof TENANT_BOOKING_TYPE)[keyof typeof TENANT_BOOKING_TYPE];

export type TenantStoredBookingType =
  | TenantBookingType
  | (typeof TENANT_LEGACY_BOOKING_TYPE)[keyof typeof TENANT_LEGACY_BOOKING_TYPE];

export const normalizeTenantBookingType = (
  value: unknown,
): TenantBookingType | null => {
  switch (value) {
    case TENANT_BOOKING_TYPE.OPEN_STUDIO:
    case TENANT_LEGACY_BOOKING_TYPE.PRIVATE_SESSIONS:
      return TENANT_BOOKING_TYPE.OPEN_STUDIO;
    case TENANT_BOOKING_TYPE.CLASS:
    case TENANT_LEGACY_BOOKING_TYPE.CLASSES_COURSES:
    case TENANT_LEGACY_BOOKING_TYPE.EVENTS:
      return TENANT_BOOKING_TYPE.CLASS;
    default:
      return null;
  }
};

export const normalizeTenantBookingTypes = (
  values: readonly unknown[],
): TenantBookingType[] => [
  ...new Set(
    values
      .map(normalizeTenantBookingType)
      .filter((value): value is TenantBookingType => value !== null),
  ),
];

export type TenantConfirmationMode =
  (typeof TENANT_CONFIRMATION_MODE)[keyof typeof TENANT_CONFIRMATION_MODE];
