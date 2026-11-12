import type { Request, Response } from "express";
import { Router } from "express";
import bcrypt from "bcryptjs";
import mongoose, { Types } from "mongoose";

import {
  assertE2ETestMode,
  isE2ETestMode,
} from "@/config/e2e-mode.js";
import {
  BOOKING_LANGUAGE,
  BOOKING_STATUS,
  BOOKING_TAG,
  BOOKING_TYPE,
  PAYMENT_STATUS,
  PLANNED_ACTIVITY,
} from "@/modules/booking/booking.constants.js";
import BookingModel from "@/modules/booking/booking.model.js";
import { AccessCodeNotification as AccessCodeNotificationModel } from "@/modules/access-codes/access-code.model.js";
import LocationModel from "@/modules/location/location.model.js";
import {
  LOCATION_ACTIVITY,
  type LocationActivity,
} from "@/modules/location/location.constants.js";
import ProductModel from "@/modules/product/product.model.js";
import { PRODUCT_TYPE } from "@/modules/product/product.constants.js";
import {
  WORKSPACE_GUIDE_DEFINITIONS,
  WORKSPACE_GUIDE_IDS,
  WORKSPACE_GUIDE_STATUS,
} from "@/modules/workspace-guides/workspace-guide.constants.js";
import {
  SETUP_CENTER_DEFINITION_VERSION,
  SETUP_PUBLICATION_STATUS,
} from "@/modules/setup-center/setup-center.constants.js";
import { SetupCenterStateModel } from "@/modules/setup-center/setup-center.model.js";
import {
  LOCATION_ACCESS_MODE,
  TENANT_MEMBERSHIP_STATUS,
  WORKSPACE_ROLE,
} from "@/modules/tenant-access/tenant-access.constants.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import {
  BILLING_INTERVAL,
  TENANT_SUBSCRIPTION_STATUS,
} from "@/modules/tenant-subscription/tenant-subscription.constants.js";
import TenantSubscriptionModel from "@/modules/tenant-subscription/tenant-subscription.schema.js";
import TenantPaymentAccountModel from "@/modules/tenant-payments/tenant-payment-account.schema.js";
import { TENANT_PAYMENT_ONBOARDING_STATUS } from "@/modules/tenant-payments/tenant-payment-account.constants.js";
import { E2E_STRIPE_ACCOUNT_ID } from "./e2e-stripe-transport.js";
import {
  TENANT_DOMAIN_STATUS,
  TENANT_DOMAIN_TYPE,
  TENANT_LANGUAGE,
  TENANT_PLAN,
  TENANT_STATUS,
} from "@/modules/tenants/tenant.constants.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import {
  getCurrentPlanVersion,
  getPlanConfig,
} from "@/modules/tenants/tenant.plan.js";
import {
  LEGACY_ROLE,
  PLATFORM_ROLE,
  TENANT_ROLE,
} from "@/modules/user/user.constants.js";
import UserModel from "@/modules/user/user.model.js";
import { Coupon } from "@/modules/coupon/coupon.model.js";
import { VoucherLedger, VoucherReservation } from "@/modules/coupon/voucher-ledger.model.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { e2eRequestBarrier } from "./e2e-request-barrier.js";
import { resetE2ERedis } from "./e2e-redis.js";
import { createE2ETeamInvitationsRouter } from "./e2e-team-invitations.js";
import { resetTeamInvitationRateLimitsForE2E } from "@/modules/tenant-access/team-invitation.limiter.js";
import { resetPublicCommerceRateLimitsForE2E } from "@/modules/checkout/checkout.public-limiter.js";
import { createE2EBookingLifecycleRouter } from "./e2e-booking-lifecycle.js";
import { createActiveBookingScenario } from "./e2e-active-booking.js";

export const E2E_CONTROL_KEY =
  process.env.E2E_TEST_KEY?.trim() ||
  "shario-e2e-local-key";
export const E2E_PASSWORD =
  "Playwright!123";

/*
 * A fixed bcrypt hash keeps reset fast and makes the stored fixture itself
 * deterministic. It was generated from E2E_PASSWORD with bcrypt cost 10.
 */
const E2E_PASSWORD_HASH =
  "$2a$10$sentsYzVHRvj2zTTqa46IuV2RF5ApQZiXfGzw5Fcx5MF0T1zNf/e2";

const ids = {
  tenantAlpha:
    "100000000000000000000001",
  tenantBeta:
    "100000000000000000000002",
  alphaOwner:
    "200000000000000000000001",
  alphaViewer:
    "200000000000000000000002",
  alphaCustomer:
    "200000000000000000000003",
  betaOwner:
    "200000000000000000000004",
  alphaBookingCustomer:
    "200000000000000000000005",
  alphaLocation:
    "300000000000000000000001",
  betaLocation:
    "300000000000000000000002",
  alphaProduct:
    "400000000000000000000001",
  betaProduct:
    "400000000000000000000002",
  alphaOpenStudioProduct:
    "400000000000000000000003",
  alphaCourseSlot:
    "450000000000000000000001",
  alphaGuestVoucher:
    "460000000000000000000001",
  alphaSubscription:
    "500000000000000000000001",
  betaSubscription:
    "500000000000000000000002",
  alphaOwnerMembership:
    "600000000000000000000001",
  alphaViewerMembership:
    "600000000000000000000002",
  betaOwnerMembership:
    "600000000000000000000003",
  alphaSetup:
    "700000000000000000000001",
  betaSetup:
    "700000000000000000000002",
} as const;

const id = (
  value: string,
): Types.ObjectId =>
  new Types.ObjectId(value);

const FIXED_NOW = new Date(
  "2026-01-15T12:00:00.000Z",
);
const ACTIVE_PERIOD_END = new Date(
  "2036-01-15T12:00:00.000Z",
);

const completedContextualGuidePreferences = () =>
  Object.fromEntries(
    WORKSPACE_GUIDE_IDS.map((guideId) => {
      const definition = WORKSPACE_GUIDE_DEFINITIONS[guideId];

      return [
        guideId,
        {
          version: definition.version,
          status: WORKSPACE_GUIDE_STATUS.COMPLETED,
          lastStep: definition.terminalStep,
          updatedAt: FIXED_NOW,
        },
      ] as const;
    }),
  );

export type E2EFixtureManifest =
  ReturnType<typeof fixtureManifest>;

const fixtureManifest = () => ({
  password: E2E_PASSWORD,
  tenants: {
    alpha: {
      id: ids.tenantAlpha,
      name: "Studio Alpha",
      slug: "studio-alpha",
      published: true,
      customDomain:
        "studio-alpha.test",
    },
    beta: {
      id: ids.tenantBeta,
      name: "Studio Beta",
      slug: "studio-beta",
      published: false,
    },
  },
  users: {
    alphaOwner: {
      id: ids.alphaOwner,
      email: "owner@studio-alpha.test",
      tenantSlug: "studio-alpha",
      role: WORKSPACE_ROLE.OWNER,
    },
    alphaViewer: {
      id: ids.alphaViewer,
      email: "viewer@studio-alpha.test",
      tenantSlug: "studio-alpha",
      role: WORKSPACE_ROLE.VIEWER,
    },
    alphaCustomer: {
      id: ids.alphaCustomer,
      email: "customer@studio-alpha.test",
      tenantSlug: "studio-alpha",
      role: TENANT_ROLE.CUSTOMER,
    },
    alphaBookingCustomer: {
      id: ids.alphaBookingCustomer,
      email: "booking-customer@studio-alpha.test",
      tenantSlug: "studio-alpha",
      role: TENANT_ROLE.CUSTOMER,
      moneyCreditsMinor: 50_000,
      currency: "EUR",
    },
    betaOwner: {
      id: ids.betaOwner,
      email: "owner@studio-beta.test",
      tenantSlug: "studio-beta",
      role: WORKSPACE_ROLE.OWNER,
    },
  },
  locations: {
    alpha: {
      id: ids.alphaLocation,
      name: "Alpha Main Studio",
      slug: "alpha-main-studio",
    },
    beta: {
      id: ids.betaLocation,
      name: "Beta Main Studio",
      slug: "beta-main-studio",
    },
  },
  products: {
    alpha: {
      id: ids.alphaProduct,
      name: "Alpha Workshop",
      type: PRODUCT_TYPE.COURSE,
    },
    beta: {
      id: ids.betaProduct,
      name: "Beta Workshop",
      type: PRODUCT_TYPE.COURSE,
    },
    alphaOpenStudio: {
      id: ids.alphaOpenStudioProduct,
      name: "Alpha Open Studio",
      type: PRODUCT_TYPE.WORKSHOP,
      locationId: ids.alphaLocation,
      price: 25,
      currency: "EUR",
    },
  },
  courseSessions: {
    alpha: {
      id: ids.alphaCourseSlot,
      productId: ids.alphaProduct,
      locationId:
        ids.alphaLocation,
    },
  },
  vouchers: {
    alphaGuest: {
      id: ids.alphaGuestVoucher,
      code: "E2E-GUEST-COURSE-5000",
      currency: "EUR",
      valueMinor: 5000,
    },
  },
});

const assertSafeDatabase = (): void => {
  assertE2ETestMode();

  const databaseName =
    mongoose.connection.name
      .trim()
      .toLowerCase();

  if (
    !/(^|[-_])(e2e|test)([-_]|$)/.test(
      databaseName,
    )
  ) {
    throw new Error(
      `Refusing to reset MongoDB database "${databaseName}". The E2E database name must contain a standalone "e2e" or "test" segment.`,
    );
  }
};

const fixtureModels = [
  TenantModel,
  UserModel,
  LocationModel,
  ProductModel,
  BookingModel,
  TenantMembershipModel,
  TenantSubscriptionModel,
  TenantPaymentAccountModel,
  SetupCenterStateModel,
  Coupon,
  VoucherLedger,
  VoucherReservation,
] as const;

const initializeFixtureCollections =
  async (): Promise<void> => {
    await Promise.all(
      fixtureModels.map((model) =>
        model.init(),
      ),
    );
  };

const clearDatabase =
  async (): Promise<void> => {
    assertSafeDatabase();

    const database =
      mongoose.connection.db;

    if (!database) {
      throw new Error(
        "MongoDB is not connected.",
      );
    }

    const collections =
      await database
        .listCollections(
          {},
          { nameOnly: true },
        )
        .toArray();

    await Promise.all(
      collections
        .filter(
          ({ name }) =>
            !name.startsWith("system."),
        )
        .map(({ name }) =>
          database
            .collection(name)
            .deleteMany({}),
        ),
    );
  };

const tenantInput = ({
  tenantId,
  name,
  slug,
  customDomain,
}: {
  tenantId: string;
  name: string;
  slug: string;
  customDomain?: string;
}) => {
  const plan = TENANT_PLAN.STUDIO_PLUS;
  const planConfig =
    getPlanConfig(plan);

  return {
    _id: id(tenantId),
    name,
    slug,
    status: TENANT_STATUS.ACTIVE,
    plan,
    planVersion:
      planConfig.version,
    accessControlVersion: 0,
    domains: [
      {
        hostname: `${slug}.shario.localhost`,
        type: TENANT_DOMAIN_TYPE.SUBDOMAIN,
        status:
          TENANT_DOMAIN_STATUS.ACTIVE,
        isPrimary: true,
      },
      ...(customDomain
        ? [
            {
              hostname:
                customDomain,
              type:
                TENANT_DOMAIN_TYPE.CUSTOM,
              status:
                TENANT_DOMAIN_STATUS.ACTIVE,
              isPrimary: false,
            },
          ]
        : []),
    ],
    modules: planConfig.modules,
    limits: planConfig.limits,
    settings: {
      defaultLanguage:
        TENANT_LANGUAGE.EN,
      supportedPublicLanguages: ["en", "cs"],
      currency: "EUR",
      timezone: "UTC",
    },
    onboarding: {
      completed: true,
      currentStep: 4,
      businessType:
        "coworking_space",
      teamSize: "2_5",
      businessDetails: {
        country: "Czechia",
        city: "Prague",
        address: "E2E Test Street 1",
        phone: "+420000000000",
      },
      bookingSetup: {
        bookingTypes: [
          "open_studio",
          "classes_courses",
        ],
        confirmationMode: "instant",
      },
      completedAt: FIXED_NOW,
      lastSavedAt: FIXED_NOW,
    },
  };
};

const userInput = ({
  userId,
  tenantId,
  firstname,
  lastname,
  email,
  customId,
  tenantRole,
  roles,
}: {
  userId: string;
  tenantId: string;
  firstname: string;
  lastname: string;
  email: string;
  customId: string;
  tenantRole:
    | typeof TENANT_ROLE.OWNER
    | typeof TENANT_ROLE.STAFF
    | typeof TENANT_ROLE.CUSTOMER;
  roles: Array<
    (typeof LEGACY_ROLE)[keyof typeof LEGACY_ROLE]
  >;
}) => ({
  _id: id(userId),
  tenant: id(tenantId),
  firstname,
  lastname,
  email,
  phone: "",
  password: E2E_PASSWORD_HASH,
  tenantRole,
  platformRole: PLATFORM_ROLE.NONE,
  roles,
  customId,
  isAccessGranted: true,
  isEmailVerified: true,
  refreshToken: [],
  moneyCredits: 0,
  membershipCredits: 0,
  membershipCreditsExpireAt: null,
  lastLoginAt: null,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
});

const locationInput = ({
  locationId,
  tenantId,
  name,
  slug,
  code,
  activityCapacities = [],
}: {
  locationId: string;
  tenantId: string;
  name: string;
  slug: string;
  code: string;
  activityCapacities?: Array<{ activity: LocationActivity; capacity: number }>;
}) => ({
  _id: id(locationId),
  tenant: id(tenantId),
  name,
  slug,
  code,
  isActive: true,
  isPrimary: true,
  address: {
    line1: "E2E Test Street 1",
    city: "Prague",
    postalCode: "11000",
    country: "Czechia",
  },
  contact: {
    email: `hello@${slug}.test`,
    phone: "+420000000000",
  },
  booking: {
    enabled: true,
    timezone: "UTC",
    slotStepMinutes: 30,
    minBookingMinutes: 60,
    maxBookingMinutes: 240,
    allowPublicSoloOverlap: false,
    maxPublicSoloOverlaps: 1,
    globalCapacity: 12,
    activityCapacities,
    privateSessionBlocksAll: true,
    groupBookingBlocksAll: true,
    doorCodeMinutesBefore: 15,
  },
  access: {
    publicInstructions:
      "Use the main E2E entrance.",
    privateInstructions: "",
    doorCode: "",
  },
  notes: "Deterministic Playwright fixture",
});

const productInput = ({
  productId,
  tenantId,
  ownerId,
  name,
  sku,
  sortOrder,
}: {
  productId: string;
  tenantId: string;
  ownerId: string;
  name: string;
  sku: string;
  sortOrder: number;
}) => ({
  _id: id(productId),
  tenant: id(tenantId),
  createdBy: id(ownerId),
  name,
  description:
    "Deterministic workshop for browser tests.",
  sku,
  type: PRODUCT_TYPE.COURSE,
  price: 45,
  extraCharge: 0,
  maxNumberOfParticipants: 12,
  currency: "EUR",
  imageSrc: "",
  label: "",
  stripeProductId: "",
  stripePriceId: "",
  voucherTemplate: "",
  couponProduct: null,
  isActive: true,
  sortOrder,
});

const membershipInput = ({
  membershipId,
  tenantId,
  userId,
  role,
  locationId,
}: {
  membershipId: string;
  tenantId: string;
  userId: string;
  role:
    | typeof WORKSPACE_ROLE.OWNER
    | typeof WORKSPACE_ROLE.VIEWER;
  locationId: string;
}) => ({
  _id: id(membershipId),
  tenant: id(tenantId),
  user: id(userId),
  status:
    TENANT_MEMBERSHIP_STATUS.ACTIVE,
  role,
  customRole: null,
  locationAccess: {
    mode: LOCATION_ACCESS_MODE.ALL,
    locationIds: [],
  },
  workspaceProfile: {
    jobTitle:
      role === WORKSPACE_ROLE.OWNER
        ? "Studio owner"
        : "Read-only reviewer",
    displayName: "",
    calendarColor: "#74869a",
  },
  preferences: {
    language: "en",
    displayTimezone: "UTC",
    defaultLocation: id(locationId),
    defaultCalendarView: "week",
    weekStartsOn: 1,
    defaultLandingPage: "/app",
    productTour: {
      version: 1,
      status: "completed",
      lastStep: "settings",
      updatedAt: FIXED_NOW,
    },
    firstBookingCelebrationSeen: true,
    contextualGuides: completedContextualGuidePreferences(),
    notifications: {
      bookingAssigned: true,
      bookingCancelled: true,
      taskAssigned: true,
      inventoryAlerts: true,
      email: false,
      inApp: true,
    },
  },
  accessVersion: 1,
  createdBy: id(userId),
  updatedBy: id(userId),
  acceptedAt: FIXED_NOW,
});

const subscriptionInput = ({
  subscriptionId,
  tenantId,
}: {
  subscriptionId: string;
  tenantId: string;
}) => ({
  _id: id(subscriptionId),
  tenant: id(tenantId),
  status:
    TENANT_SUBSCRIPTION_STATUS.ACTIVE,
  trialPlan:
    TENANT_PLAN.PROFESSIONAL,
  trialPlanVersion:
    getCurrentPlanVersion(
      TENANT_PLAN.PROFESSIONAL,
    ),
  billingPlan:
    TENANT_PLAN.STUDIO_PLUS,
  planVersion:
    getCurrentPlanVersion(
      TENANT_PLAN.STUDIO_PLUS,
    ),
  billingInterval:
    BILLING_INTERVAL.MONTHLY,
  billingCurrency: "EUR",
  currentPeriodStart: FIXED_NOW,
  currentPeriodEnd:
    ACTIVE_PERIOD_END,
  cancelAtPeriodEnd: false,
  lastSyncedAt: FIXED_NOW,
});

const seedFixtureData =
  async (): Promise<void> => {
    if (
      !(await bcrypt.compare(
        E2E_PASSWORD,
        E2E_PASSWORD_HASH,
      ))
    ) {
      throw new Error(
        "The E2E fixture password hash does not match E2E_PASSWORD.",
      );
    }

    await TenantModel.insertMany([
      { ...tenantInput({
        tenantId: ids.tenantAlpha,
        name: "Studio Alpha",
        slug: "studio-alpha",
        customDomain:
          "studio-alpha.test",
      }), publicSite: {
        customerPortal: { courses: { enabled: true, guestCheckoutEnabled: true } },
        footer: { legal: { terms: "https://studio-alpha.example.test/terms", cancellation: "https://studio-alpha.example.test/cancellation" } },
      } },
      tenantInput({
        tenantId: ids.tenantBeta,
        name: "Studio Beta",
        slug: "studio-beta",
      }),
    ]);

    // Public guest checkout requires a ready account snapshot. This local-only
    // placeholder never identifies a real provider account; full voucher
    // purchases below must complete without calling Stripe.
    await TenantPaymentAccountModel.create({
      tenant: id(ids.tenantAlpha),
      stripeAccountId: E2E_STRIPE_ACCOUNT_ID,
      accountCreateIdempotencyKey: "e2e:alpha:payment-account",
      onboardingStatus: TENANT_PAYMENT_ONBOARDING_STATUS.COMPLETE,
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      livemode: false,
      country: "CZ",
      defaultCurrency: "eur",
    });

    /*
     * collection.insertMany intentionally bypasses the password save hook:
     * E2E_PASSWORD_HASH is already bcrypt encoded and must not be re-hashed.
     */
    await UserModel.collection.insertMany([
      userInput({
        userId: ids.alphaOwner,
        tenantId: ids.tenantAlpha,
        firstname: "Alpha",
        lastname: "Owner",
        email:
          "owner@studio-alpha.test",
        customId: "ALPHA-OWNER",
        tenantRole: TENANT_ROLE.OWNER,
        roles: [LEGACY_ROLE.ADMIN],
      }),
      userInput({
        userId: ids.alphaViewer,
        tenantId: ids.tenantAlpha,
        firstname: "Alpha",
        lastname: "Viewer",
        email:
          "viewer@studio-alpha.test",
        customId: "ALPHA-VIEWER",
        tenantRole: TENANT_ROLE.STAFF,
        roles: [LEGACY_ROLE.MODERATOR],
      }),
      userInput({
        userId: ids.alphaCustomer,
        tenantId: ids.tenantAlpha,
        firstname: "Alpha",
        lastname: "Customer",
        email:
          "customer@studio-alpha.test",
        customId: "ALPHA-CUSTOMER",
        tenantRole:
          TENANT_ROLE.CUSTOMER,
        roles: [LEGACY_ROLE.CUSTOMER],
      }),
      userInput({
        userId: ids.betaOwner,
        tenantId: ids.tenantBeta,
        firstname: "Beta",
        lastname: "Owner",
        email:
          "owner@studio-beta.test",
        customId: "BETA-OWNER",
        tenantRole: TENANT_ROLE.OWNER,
        roles: [LEGACY_ROLE.ADMIN],
      }),
      {
        ...userInput({
          userId: ids.alphaBookingCustomer,
          tenantId: ids.tenantAlpha,
          firstname: "Booking",
          lastname: "Customer",
          email: "booking-customer@studio-alpha.test",
          customId: "ALPHA-BOOKING-CUSTOMER",
          tenantRole: TENANT_ROLE.CUSTOMER,
          roles: [LEGACY_ROLE.CUSTOMER],
        }),
        moneyCredits: 500,
        moneyCreditsMinor: 50_000,
      },
    ]);

    await LocationModel.insertMany([
      locationInput({
        locationId: ids.alphaLocation,
        tenantId: ids.tenantAlpha,
        name: "Alpha Main Studio",
        slug: "alpha-main-studio",
        code: "ALPHA",
        activityCapacities: [
          { activity: LOCATION_ACTIVITY.SHARED_TABLE, capacity: 12 },
        ],
      }),
      locationInput({
        locationId: ids.betaLocation,
        tenantId: ids.tenantBeta,
        name: "Beta Main Studio",
        slug: "beta-main-studio",
        code: "BETA",
      }),
    ]);

    await ProductModel.insertMany([
      { ...productInput({
        productId: ids.alphaProduct,
        tenantId: ids.tenantAlpha,
        ownerId: ids.alphaOwner,
        name: "Alpha Workshop",
        sku: "E2E-ALPHA-COURSE",
        sortOrder: 1,
      }), kind: "class", kindContractVersion: 2, bookingMode: "public",
        location: id(ids.alphaLocation), courseContent: {
          title: { en: "Alpha Workshop" }, description: { en: "A local guest checkout test course." },
          details: { en: "This is a local checkout test. No real payment will be taken." },
          locationIds: [id(ids.alphaLocation)],
        },
      },
      productInput({
        productId: ids.betaProduct,
        tenantId: ids.tenantBeta,
        ownerId: ids.betaOwner,
        name: "Beta Workshop",
        sku: "E2E-BETA-COURSE",
        sortOrder: 1,
      }),
      {
        ...productInput({
          productId: ids.alphaOpenStudioProduct,
          tenantId: ids.tenantAlpha,
          ownerId: ids.alphaOwner,
          name: "Alpha Open Studio",
          sku: "E2E-ALPHA-OPEN-STUDIO",
          sortOrder: 2,
        }),
        description: "Open Studio for payment and cancellation browser tests.",
        type: PRODUCT_TYPE.WORKSHOP,
        kind: "open-studio",
        kindContractVersion: 2,
        bookingMode: "public",
        location: id(ids.alphaLocation),
        price: 25,
      },
    ]);

    const courseStart =
      new Date(
        Date.now() +
          30 * 24 * 60 * 60 * 1000,
      );
    courseStart.setUTCHours(
      10,
      0,
      0,
      0,
    );
    const courseEnd = new Date(
      courseStart.getTime() +
        2 * 60 * 60 * 1000,
    );

    await BookingModel.create({
      _id: id(ids.alphaCourseSlot),
      tenant: id(ids.tenantAlpha),
      location:
        id(ids.alphaLocation),
      createdBy:
        id(ids.alphaOwner),
      participants: [],
      orders: [],
      start: courseStart,
      end: courseEnd,
      bookingProduct:
        id(ids.alphaProduct),
      author: {
        name: "Alpha Owner",
        customId: "ALPHA-OWNER",
      },
      numberOfHours: 2,
      lecturer: "Alpha Teacher",
      bookingType:
        BOOKING_TYPE.PUBLIC,
      language:
        BOOKING_LANGUAGE.EN,
      description:
        "E2E public course session",
      archive: false,
      status:
        BOOKING_STATUS.PROCESSED,
      paymentStatus:
        PAYMENT_STATUS.CONFIRMED,
      plannedActivity:
        PLANNED_ACTIVITY.UNDEFINED,
      tag: BOOKING_TAG.COURSE,
      numberOfGuests: 0,
      capacityReservations: [],
    });

    // This local-only bearer covers the EUR 45 course without any Stripe call.
    await Coupon.create({
      _id: id(ids.alphaGuestVoucher), tenant: id(ids.tenantAlpha), product: id(ids.alphaProduct),
      promoCode: "E2E-GUEST-COURSE-5000", lifecycleVersion: 1, voucherTypeSnapshot: "value",
      valueMinorSnapshot: 5000, currencySnapshot: "EUR", remainingValueMinor: 5000,
      reservedValueMinor: 0, reservedQuantity: 0, isActive: true, expiresAt: null,
      voucherSettingsSnapshot: { version: 1, type: "value", validity: { mode: "none" } },
    });
    await VoucherLedger.create({
      tenant: id(ids.tenantAlpha), coupon: id(ids.alphaGuestVoucher), kind: "issue",
      operationId: "e2e:guest-course:issue", currency: "EUR", amountMinor: 5000,
      quantity: 0, referenceId: "e2e-fixture", actor: id(ids.alphaOwner),
    });

    await TenantMembershipModel.insertMany([
      membershipInput({
        membershipId:
          ids.alphaOwnerMembership,
        tenantId: ids.tenantAlpha,
        userId: ids.alphaOwner,
        role: WORKSPACE_ROLE.OWNER,
        locationId: ids.alphaLocation,
      }),
      membershipInput({
        membershipId:
          ids.alphaViewerMembership,
        tenantId: ids.tenantAlpha,
        userId: ids.alphaViewer,
        role: WORKSPACE_ROLE.VIEWER,
        locationId: ids.alphaLocation,
      }),
      membershipInput({
        membershipId:
          ids.betaOwnerMembership,
        tenantId: ids.tenantBeta,
        userId: ids.betaOwner,
        role: WORKSPACE_ROLE.OWNER,
        locationId: ids.betaLocation,
      }),
    ]);

    await TenantSubscriptionModel.insertMany([
      subscriptionInput({
        subscriptionId:
          ids.alphaSubscription,
        tenantId: ids.tenantAlpha,
      }),
      subscriptionInput({
        subscriptionId:
          ids.betaSubscription,
        tenantId: ids.tenantBeta,
      }),
    ]);

    await SetupCenterStateModel.insertMany([
      {
        _id: id(ids.alphaSetup),
        tenant: id(ids.tenantAlpha),
        definitionVersion:
          SETUP_CENTER_DEFINITION_VERSION,
        publication: {
          status:
            SETUP_PUBLICATION_STATUS.LIVE,
          publishedAt: FIXED_NOW,
          publishedBy:
            id(ids.alphaOwner),
          unpublishedAt: null,
          unpublishedBy: null,
        },
        practice: null,
      },
      {
        _id: id(ids.betaSetup),
        tenant: id(ids.tenantBeta),
        definitionVersion:
          SETUP_CENTER_DEFINITION_VERSION,
        publication: {
          status:
            SETUP_PUBLICATION_STATUS.DRAFT,
          publishedAt: null,
          publishedBy: null,
          unpublishedAt: null,
          unpublishedBy: null,
        },
        practice: null,
      },
    ]);
  };

export const resetE2EFixtures =
  async (): Promise<E2EFixtureManifest> => {
    assertSafeDatabase();
    await initializeFixtureCollections();
    await resetE2ERedis();
    await clearDatabase();
    await seedFixtureData();
    await resetPublicCommerceRateLimitsForE2E();
    await resetTeamInvitationRateLimitsForE2E();

    return fixtureManifest();
  };

let resetTail:
  Promise<unknown> = Promise.resolve();

const enqueueReset =
  (): Promise<E2EFixtureManifest> => {
    const reset = resetTail.then(
      () => e2eRequestBarrier.runReset(resetE2EFixtures),
      () => e2eRequestBarrier.runReset(resetE2EFixtures),
    );

    resetTail = reset.then(
      () => undefined,
      () => undefined,
    );

    return reset;
  };

export const createE2EControlRouter =
  (): Router => {
    assertE2ETestMode();

    const router = Router();
    router.use(createE2ETeamInvitationsRouter(E2E_CONTROL_KEY, ids.tenantAlpha));
    router.use(createE2EBookingLifecycleRouter());

    router.post(
      "/reset",
      asyncHandler(
        async (
          req: Request,
          res: Response,
        ): Promise<void> => {
          if (!isE2ETestMode()) {
            res.status(404).json({
              message: "Not found.",
            });
            return;
          }

          if (
            req.get("x-e2e-key") !==
            E2E_CONTROL_KEY
          ) {
            res.status(403).json({
              message:
                "Invalid E2E control key.",
              code:
                "E2E_CONTROL_FORBIDDEN",
            });
            return;
          }

          res.status(200).json(
            await enqueueReset(),
          );
        },
      ),
    );

    // Adjust only an already-paid booking belonging to the fixed local test
    // customer. This lets browser tests exercise an active session and a nearby
    // private reservation without moving the wall clock or touching real data.
    router.post(
      "/booking-edit-scenario",
      asyncHandler(async (req: Request, res: Response): Promise<void> => {
        if (!isE2ETestMode()) {
          res.status(404).json({ message: "Not found." });
          return;
        }
        if (req.get("x-e2e-key") !== E2E_CONTROL_KEY) {
          res.status(403).json({ code: "E2E_CONTROL_FORBIDDEN" });
          return;
        }
        assertSafeDatabase();
        const scenario = req.body?.scenario;
        if (
          ![
            "active",
            "private-neighbor",
            "issued-access",
            "legacy-access",
            "access-processing",
          ].includes(scenario) ||
          !mongoose.isValidObjectId(req.body?.bookingId)
        ) {
          res.status(400).json({ message: "Unknown booking edit scenario." });
          return;
        }
        const booking = await BookingModel.findOne({
          _id: req.body.bookingId,
          tenant: id(ids.tenantAlpha),
          createdBy: id(ids.alphaBookingCustomer),
          location: id(ids.alphaLocation),
          bookingProduct: id(ids.alphaOpenStudioProduct),
          status: BOOKING_STATUS.PROCESSED,
          paymentStatus: PAYMENT_STATUS.CONFIRMED,
        }).select("+atelierKleiMigration");
        if (!booking) {
          res
            .status(404)
            .json({ message: "Paid local fixture booking not found." });
          return;
        }
        if (
          ["issued-access", "legacy-access", "access-processing"].includes(
            scenario,
          )
        ) {
          const claimedAt = new Date();
          if (scenario === "legacy-access") {
            booking.set("atelierKleiMigration", {
              ...(booking.atelierKleiMigration || {}),
              suppressAccessNotifications: true,
            });
          } else {
            const processing = scenario === "access-processing";
            const claimToken = `e2e-${scenario}-${String(booking._id)}`;
            const leaseExpiresAt = processing
              ? new Date(claimedAt.getTime() + 15 * 60_000)
              : null;
            booking.set("accessCodeDelivery", {
              status: processing ? "processing" : "sent",
              claimToken,
              leaseExpiresAt,
              deliveredAt: processing ? null : claimedAt,
            });
            await AccessCodeNotificationModel.findOneAndUpdate(
              {
                tenant: id(ids.tenantAlpha),
                booking: booking._id,
                channel: "email",
              },
              {
                $set: {
                  user: id(ids.alphaBookingCustomer),
                  accessCode: new Types.ObjectId(),
                  bookingStart: booking.start,
                  status: processing ? "processing" : "sent",
                  claimToken,
                  leaseExpiresAt,
                  sentAt: processing ? null : claimedAt,
                  provider: processing ? "" : "postmark",
                  providerAttemptStartedAt: processing ? null : claimedAt,
                  providerMessageId: processing
                    ? ""
                    : `e2e-issued-${String(booking._id)}`,
                  recipientEmail: "booking-customer@studio-alpha.test",
                },
              },
              { upsert: true, runValidators: true },
            );
          }
          await booking.save();
          res.json({
            bookingId: String(booking._id),
            start: booking.start,
            end: booking.end,
          });
          return;
        }
        const activeBooking =
          scenario === "active"
            ? createActiveBookingScenario(
                booking.end.getTime() - booking.start.getTime(),
              )
            : null;
        await LocationModel.updateOne(
          { _id: id(ids.alphaLocation) },
          {
            $set: {
              openingHours:
                activeBooking?.openingHours ||
                Object.fromEntries(
                  [
                    "monday",
                    "tuesday",
                    "wednesday",
                    "thursday",
                    "friday",
                    "saturday",
                    "sunday",
                  ].map((day) => [
                    day,
                    { isOpen: true, openTime: "00:00", closeTime: "23:59" },
                  ]),
                ),
            },
          },
        );
        if (activeBooking) {
          const { start, end } = activeBooking;
          booking.start = start;
          booking.end = end;
          booking.set("accessCodeDelivery", {
            status: "sent",
            deliveredAt: new Date(),
          });
          await booking.save();
          res.json({ bookingId: String(booking._id), start, end: booking.end });
          return;
        }
        const neighborStart = new Date(booking.end.getTime() + 1_800_000);
        const neighbor = await BookingModel.create({
          tenant: id(ids.tenantAlpha),
          location: id(ids.alphaLocation),
          createdBy: id(ids.alphaCustomer),
          bookingProduct: id(ids.alphaOpenStudioProduct),
          start: neighborStart,
          end: new Date(neighborStart.getTime() + 3_600_000),
          numberOfHours: 1,
          numberOfGuests: 1,
          bookingType: BOOKING_TYPE.PRIVATE,
          bookingMode: BOOKING_TYPE.PRIVATE,
          tag: BOOKING_TAG.OPEN_STUDIO,
          plannedActivity: PLANNED_ACTIVITY.SHARED_TABLE,
          status: BOOKING_STATUS.PROCESSED,
          paymentStatus: PAYMENT_STATUS.CONFIRMED,
          author: { name: "Other local customer", customId: "E2E-NEIGHBOR" },
          language: BOOKING_LANGUAGE.EN,
        });
        res.json({
          bookingId: String(booking._id),
          neighborId: String(neighbor._id),
          neighborStart,
          neighborEnd: neighbor.end,
        });
      }),
    );

    return router;
  };
