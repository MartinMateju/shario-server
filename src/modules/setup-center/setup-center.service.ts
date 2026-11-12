import { createHash, randomUUID } from "node:crypto";
import {
  assertNativeInvoicingEnabled,
  isNativeInvoicingEnabled,
} from "@/modules/invoice/invoice.feature.js";

import Booking from "@/modules/booking/booking.model.js";
import {
  COMMUNICATION_AUTOMATION_PURPOSE,
  COMMUNICATION_AUTOMATION_STATUS,
  COMMUNICATION_SCHEDULE_TYPE,
} from "@/modules/communication-automations/communication-automation.constants.js";
import { CommunicationAutomation } from "@/modules/communication-automations/communication-automation.model.js";
import { InventoryItem } from "@/modules/inventory/inventory-item.schema.js";
import LocationModel from "@/modules/location/location.model.js";
import { MembershipPlanModel } from "@/modules/membership/membership-plan.model.js";
import Product from "@/modules/product/product.model.js";
import { PRODUCT_KIND } from "@/modules/product/product-kind-v2.contract.js";
import { resolveProductKindV2 } from "@/modules/product/product.utils.js";
import {
  ManagedSenderNotReadyError,
  resolveManagedSender,
} from "@/modules/registered-sender-email/services/managed-sender-resolver.service.js";
import TenantMembershipModel from "@/modules/tenant-access/tenant-membership.model.js";
import { TENANT_MEMBERSHIP_STATUS } from "@/modules/tenant-access/tenant-access.constants.js";
import TenantPaymentAccountModel from "@/modules/tenant-payments/tenant-payment-account.schema.js";
import { getTenantSubscriptionAccess } from "@/modules/tenant-subscription/services/tenant-subscription.service.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import { publishTenantPublicSiteDraft } from "@/modules/tenants/settings/tenant-settings.service.js";

import { publicTenantCacheKey } from "./setup-publication.service.js";
import UserModel from "@/modules/user/user.model.js";
import { conflict, forbidden, notFound } from "@/shared/http/httpErrors.js";

import {
  SETUP_ACTIONS,
  SETUP_CENTER_DEFINITION_VERSION,
  SETUP_CENTER_PHASE,
  SETUP_LAUNCH_EVENT,
  SETUP_PRACTICE_ACTION,
  getAvailableSetupPracticeActions,
  SETUP_PRACTICE_STATUS,
  SETUP_PRACTICE_TTL_MS,
  SETUP_PUBLICATION_STATUS,
  SETUP_STEP,
  SETUP_STEP_ORDER,
  SETUP_STEPS,
  SETUP_STEP_REQUIREMENT,
  SETUP_STEP_STATUS,
  type SetupActionKey,
  type SetupLaunchEvent,
  type SetupLaunchEventSource,
  type SetupPracticeAction,
  type SetupStepId,
  type SetupStepRequirement,
} from "./setup-center.constants.js";
import {
  SetupAuditEventModel,
  SetupCenterStateModel,
  SetupLaunchEventModel,
} from "./setup-center.model.js";

const isCustomerBookableKind = (product: any): boolean => {
  const kind = resolveProductKindV2(product);
  return kind === PRODUCT_KIND.OPEN_STUDIO || kind === PRODUCT_KIND.CLASS;
};

const isClassProduct = (product: any): boolean =>
  resolveProductKindV2(product) === PRODUCT_KIND.CLASS;

const completeCheck = (
  id: string,
  complete: boolean,
  reasonCode: string,
  optional = false,
) => ({
  id,
  complete,
  optional,
  reasonCode: complete ? "complete" : reasonCode,
});

const isManagedSenderReady = async (tenantId: string): Promise<boolean> => {
  try {
    await resolveManagedSender({ tenantId });
    return true;
  } catch (error) {
    if (error instanceof ManagedSenderNotReadyError) return false;
    throw error;
  }
};

const action = (
  key: SetupActionKey,
  enabled = true,
  query: Readonly<Record<string, string>> = {},
) => {
  const [pathname, configuredQuery = ""] = SETUP_ACTIONS[key].href.split(
    "?",
    2,
  );
  const params = new URLSearchParams(configuredQuery);
  for (const [name, value] of Object.entries(query)) {
    params.set(name, value);
  }

  const serializedQuery = params.toString();
  return {
    key,
    href: serializedQuery ? `${pathname}?${serializedQuery}` : pathname,
    enabled,
  };
};

const normalizePractice = (practice: any, fingerprint: string) => {
  if (!practice) {
    return {
      status: SETUP_PRACTICE_STATUS.NOT_STARTED,
      runId: null,
      completedActions: [],
      artifacts: [],
      startedAt: null,
      completedAt: null,
      expiresAt: null,
      retestRecommended: false,
    };
  }

  const expired =
    practice.status === SETUP_PRACTICE_STATUS.IN_PROGRESS &&
    new Date(practice.expiresAt).getTime() <= Date.now();
  const status = expired ? SETUP_PRACTICE_STATUS.EXPIRED : practice.status;
  const availableActions = getAvailableSetupPracticeActions();

  return {
    status,
    runId: practice.runId,
    completedActions: (practice.completedActions ?? []).filter(
      (action: SetupPracticeAction) => availableActions.includes(action),
    ),
    artifacts: (practice.artifacts ?? []).filter(
      (artifact: { kind: string }) =>
        artifact.kind !== "invoice" || isNativeInvoicingEnabled(),
    ),
    startedAt: practice.startedAt ?? null,
    completedAt: practice.completedAt ?? null,
    expiresAt: practice.expiresAt ?? null,
    retestRecommended:
      status === SETUP_PRACTICE_STATUS.COMPLETE &&
      Boolean(fingerprint) &&
      practice.readinessFingerprint !== fingerprint,
  };
};

const fingerprintFor = ({
  product,
  location,
}: {
  product: any;
  location: any;
}) => {
  if (!product || !location) return "";

  return createHash("sha256")
    .update(
      JSON.stringify({
        productId: String(product._id),
        productUpdatedAt: product.updatedAt,
        productActive: product.isActive,
        price: product.price,
        currency: product.currency,
        capacity: product.maxNumberOfParticipants,
        locationId: String(location._id),
        locationUpdatedAt: location.updatedAt,
        locationActive: location.isActive,
        bookingEnabled: location.booking?.enabled,
      }),
    )
    .digest("hex");
};

const isProductBookable = (product: any): boolean =>
  Boolean(
    product &&
    product.isActive === true &&
    isCustomerBookableKind(product) &&
    Number(product.price) >= 0 &&
    product.currency &&
    Number.isSafeInteger(Number(product.maxNumberOfParticipants)) &&
    Number(product.maxNumberOfParticipants) > 0,
  );

const step = ({
  id,
  status,
  reasonCode,
  checks,
  actions,
  requirement,
}: {
  id: SetupStepId;
  status: string;
  reasonCode: string;
  checks: ReturnType<typeof completeCheck>[];
  actions: ReturnType<typeof action>[];
  requirement: SetupStepRequirement;
}) => ({
  id,
  status,
  complete:
    status === SETUP_STEP_STATUS.COMPLETE ||
    status === SETUP_STEP_STATUS.NOT_APPLICABLE,
  applicable: status !== SETUP_STEP_STATUS.NOT_APPLICABLE,
  requirement,
  // Compatibility for definition-v2 clients. New clients use requirement.
  optional:
    status === SETUP_STEP_STATUS.NOT_APPLICABLE ||
    requirement !== SETUP_STEP_REQUIREMENT.REQUIRED,
  reasonCode,
  checks,
  actions,
});

type SetupProgressStep = {
  applicable: boolean;
  complete: boolean;
  requirement: SetupStepRequirement;
};

const selectNextSetupStep = <T extends SetupProgressStep>(
  steps: readonly T[],
): T | undefined => {
  for (const requirement of [
    SETUP_STEP_REQUIREMENT.REQUIRED,
    SETUP_STEP_REQUIREMENT.RECOMMENDED,
    SETUP_STEP_REQUIREMENT.OPTIONAL,
  ] as const) {
    const candidate = steps.find(
      (item) =>
        item.requirement === requirement && item.applicable && !item.complete,
    );
    if (candidate) return candidate;
  }

  return undefined;
};

const dateOrNull = (value: unknown): Date | null => {
  if (!value) return null;
  const date = new Date(value as string | number | Date);
  return Number.isNaN(date.getTime()) ? null : date;
};

const buildLaunchMetrics = (analytics: any) => {
  const firstSeenAt = dateOrNull(analytics?.firstSeenAt);
  const firstPublishedOfferAt = dateOrNull(
    analytics?.firstPublishedOfferAt ?? analytics?.firstOfferReadyAt,
  );
  const timeToFirstPublishedOfferMs =
    firstSeenAt && firstPublishedOfferAt
      ? Math.max(0, firstPublishedOfferAt.getTime() - firstSeenAt.getTime())
      : null;

  const steps = Object.fromEntries(
    SETUP_STEPS.map((stepId) => {
      const metric = analytics?.steps?.[stepId] ?? {};
      const opened = Math.max(0, Number(metric.opened) || 0);
      const completed = Math.max(0, Number(metric.completed) || 0);
      const dropOffCount = Math.max(0, opened - completed);
      return [
        stepId,
        {
          opened,
          completed,
          dropOffCount,
          dropOffRate: opened
            ? Math.round((dropOffCount / opened) * 10_000) / 100
            : 0,
        },
      ];
    }),
  );

  return {
    firstSeenAt,
    lastActivityAt: dateOrNull(analytics?.lastActivityAt),
    firstPublishedOfferAt,
    // Compatibility alias for clients built against definition v7 previews.
    firstOfferReadyAt: firstPublishedOfferAt,
    // Studio publication is a separate milestone from first offer readiness.
    firstPublishedAt: dateOrNull(analytics?.firstPublishedAt),
    completedAt: dateOrNull(analytics?.completedAt),
    timeToFirstPublishedOfferMs,
    eventCounts: {
      launchCenterViewed: Math.max(
        0,
        Number(analytics?.eventCounts?.launchCenterViewed) || 0,
      ),
      studioReady: Math.max(
        0,
        Number(analytics?.eventCounts?.studioReady) || 0,
      ),
      publicSiteOpened: Math.max(
        0,
        Number(analytics?.eventCounts?.publicSiteOpened) || 0,
      ),
      testBookingOpened: Math.max(
        0,
        Number(analytics?.eventCounts?.testBookingOpened) || 0,
      ),
      productTourStarted: Math.max(
        0,
        Number(analytics?.eventCounts?.productTourStarted) || 0,
      ),
      productTourCompleted: Math.max(
        0,
        Number(analytics?.eventCounts?.productTourCompleted) || 0,
      ),
      productTourSkipped: Math.max(
        0,
        Number(analytics?.eventCounts?.productTourSkipped) || 0,
      ),
      productTourLaunchCenterOpened: Math.max(
        0,
        Number(analytics?.eventCounts?.productTourLaunchCenterOpened) || 0,
      ),
    },
    steps,
  };
};

export const buildSetupCenterSnapshot = async ({
  tenantId,
  actorUserId,
}: {
  tenantId: string;
  actorUserId: string;
}) => {
  const now = new Date();
  const [
    tenant,
    locations,
    existingLocationCount,
    products,
    payment,
    managedSenderReady,
    activeTeamCount,
    existingTeamCount,
    state,
    publishedMembershipCount,
    draftMembershipCount,
    activeBookingReminderCount,
    customerCount,
    activeInventoryItemCount,
    existingInventoryItemCount,
  ] = await Promise.all([
    TenantModel.findById(tenantId)
      .select(
        "name slug status settings onboarding workspaceIntent modules publicSiteEditor.draftRevision publicSiteEditor.publishedRevision publicSiteEditor.draftUpdatedAt publicSiteEditor.publishedAt",
      )
      .lean(),
    LocationModel.find({ tenant: tenantId, isActive: true })
      .select("_id name isActive isPrimary booking updatedAt")
      .sort({ isPrimary: -1, createdAt: 1 })
      .lean(),
    LocationModel.countDocuments({ tenant: tenantId }),
    Product.find({ tenant: tenantId })
      .select(
        "_id name type kind kindContractVersion bookingMode price currency maxNumberOfParticipants studioFlow isActive updatedAt",
      )
      .sort({ createdAt: 1 })
      .lean(),
    TenantPaymentAccountModel.findOne({ tenant: tenantId }).lean(),
    isManagedSenderReady(tenantId),
    TenantMembershipModel.countDocuments({
      tenant: tenantId,
      status: TENANT_MEMBERSHIP_STATUS.ACTIVE,
    }),
    TenantMembershipModel.countDocuments({ tenant: tenantId }),
    SetupCenterStateModel.findOne({ tenant: tenantId }).lean(),
    MembershipPlanModel.countDocuments({
      tenant: tenantId,
      status: "published",
    }),
    MembershipPlanModel.countDocuments({
      tenant: tenantId,
      status: "draft",
    }),
    CommunicationAutomation.countDocuments({
      tenant: tenantId,
      isActive: true,
      automationStatus: COMMUNICATION_AUTOMATION_STATUS.ACTIVE,
      scheduleType: {
        $in: [
          COMMUNICATION_SCHEDULE_TYPE.BEFORE_BOOKING,
          // Compatibility alias used by the existing automation editor.
          COMMUNICATION_SCHEDULE_TYPE.BEFORE_PURCHASE,
        ],
      },
      purpose: { $ne: COMMUNICATION_AUTOMATION_PURPOSE.MARKETING },
    }),
    UserModel.countDocuments({
      tenant: tenantId,
      tenantRole: "customer",
    }),
    InventoryItem.countDocuments({ tenant: tenantId, isActive: true }),
    InventoryItem.countDocuments({ tenant: tenantId }),
  ]);

  if (!tenant) notFound("Workspace not found.");

  const answers = tenant.workspaceIntent?.answers;
  const pricingMode = tenant.workspaceIntent?.pricingMode;

  const modules = (tenant.modules ?? {}) as Record<string, boolean | undefined>;
  const bookingsEnabled = modules[TENANT_MODULE.BOOKINGS] !== false;
  const coursesEnabled = modules[TENANT_MODULE.COURSES] === true;
  const bookingWorkflowEnabled = bookingsEnabled || coursesEnabled;
  const paymentsEnabled = modules[TENANT_MODULE.PAYMENTS] !== false;
  const inventoryEnabled = modules[TENANT_MODULE.INVENTORY] !== false;
  const communicationsEnabled = modules[TENANT_MODULE.COMMUNICATIONS] !== false;
  const membershipsEnabled = modules[TENANT_MODULE.MEMBERSHIPS] === true;
  const publicFacingEnabled = bookingWorkflowEnabled || membershipsEnabled;
  const paymentsApplicable =
    paymentsEnabled && publicFacingEnabled;
  // Answers prioritize checklist tasks; configured products and completed work
  // still surface even when the owner's stated preference changes.
  const bookingPreferred =
    !answers ||
    answers.sharedStudio ||
    answers.classes ||
    products.some(
      (product: any) =>
        isCustomerBookableKind(product),
    );
  const membershipPreferred =
    !answers ||
    answers.memberships ||
    publishedMembershipCount > 0 ||
    draftMembershipCount > 0;
  const inventoryPreferred =
    !answers || answers.inventory || existingInventoryItemCount > 0;
  const commercePreferred =
    !answers ||
    Boolean(pricingMode) ||
    bookingPreferred ||
    membershipPreferred ||
    answers.vouchers;
  const publicSitePreferred =
    bookingPreferred ||
    membershipPreferred ||
    answers?.vouchers === true ||
    Boolean(tenant.publicSiteEditor?.publishedAt);
  const bookingChecklistEnabled = bookingWorkflowEnabled && bookingPreferred;
  const publicSiteChecklistEnabled = publicFacingEnabled && publicSitePreferred;
  const inventoryFocused =
    inventoryEnabled && !publicFacingEnabled;
  const locationApplicable =
    bookingWorkflowEnabled || inventoryEnabled;

  const bookingEnabledLocations = locations.filter(
    (location: any) => location.booking?.enabled === true,
  );
  const existingCustomerBookableProduct =
    products.find((product: any) => isCustomerBookableKind(product)) ?? null;
  const reviewOfferCategory =
    existingCustomerBookableProduct &&
    resolveProductKindV2(existingCustomerBookableProduct) === PRODUCT_KIND.CLASS
      ? "classes"
      : "openStudio";
  const eligibleProducts = products.filter((product: any) =>
    isProductBookable(product),
  );
  const timedProducts = eligibleProducts.filter(
    (product: any) => !isClassProduct(product),
  );
  const courseProducts = eligibleProducts.filter((product: any) =>
    isClassProduct(product),
  );
  const upcomingSchedule =
    bookingWorkflowEnabled &&
    bookingEnabledLocations.length > 0 &&
    timedProducts.length === 0 &&
    courseProducts.length > 0
      ? await Booking.findOne({
          tenant: tenantId,
          bookingProduct: {
            $in: courseProducts.map((product: any) => product._id),
          },
          location: {
            $in: bookingEnabledLocations.map((location: any) => location._id),
          },
          start: { $gt: now },
          archive: false,
          status: { $ne: "cancelled" },
        })
          .select("bookingProduct location")
          .lean()
      : null;
  const scheduledProductId = String(
    upcomingSchedule?.bookingProduct?._id ??
      upcomingSchedule?.bookingProduct ??
      "",
  );
  const scheduledLocationId = String(
    upcomingSchedule?.location?._id ?? upcomingSchedule?.location ?? "",
  );
  const scheduledProduct =
    courseProducts.find(
      (product: any) => String(product._id) === scheduledProductId,
    ) ?? null;
  const scheduledLocation =
    bookingEnabledLocations.find(
      (location: any) => String(location._id) === scheduledLocationId,
    ) ?? null;
  /*
   * Open Studio uses the location's booking availability, so it is launch-ready
   * without a synthetic future Booking record. Prefer it when present;
   * otherwise select the scheduled Class, then the first Class that still
   * needs a session.
   */
  const timedProduct = timedProducts[0] ?? null;
  const bookableProduct =
    timedProduct ?? scheduledProduct ?? courseProducts[0] ?? null;
  const activeLocation =
    (timedProduct ? bookingEnabledLocations[0] : scheduledLocation) ??
    bookingEnabledLocations[0] ??
    locations[0] ??
    null;
  const isTimedOffer = Boolean(
    bookableProduct && !isClassProduct(bookableProduct),
  );
  const hasActiveProduct = products.some(
    (product: any) =>
      product.isActive === true && isCustomerBookableKind(product),
  );
  const hasPaidOffer = products.some(
    (product: any) =>
      product.isActive === true &&
      isCustomerBookableKind(product) &&
      Number(product.price) > 0,
  );
  const paymentsRequired =
    paymentsApplicable &&
    ((bookingWorkflowEnabled && hasPaidOffer) ||
      (membershipsEnabled && publishedMembershipCount > 0));
  const hasCapacity = Boolean(
    bookableProduct && Number(bookableProduct.maxNumberOfParticipants) > 0,
  );
  const hasPrice = Boolean(
    bookableProduct &&
    Number(bookableProduct.price) >= 0 &&
    bookableProduct.currency,
  );
  const offerReady = Boolean(
    bookableProduct &&
    activeLocation?.booking?.enabled === true &&
    (isTimedOffer ||
      (upcomingSchedule && scheduledProduct && scheduledLocation)),
  );
  const readinessFingerprint = fingerprintFor({
    product: bookableProduct,
    location: activeLocation,
  });
  const practice = {
    ...normalizePractice(state?.practice, readinessFingerprint),
    manualConfirmation: state?.practiceConfirmation
      ? {
          confirmedAt: state.practiceConfirmation.confirmedAt,
          confirmedBy: String(state.practiceConfirmation.confirmedBy),
          current:
            Boolean(readinessFingerprint) &&
            state.practiceConfirmation.readinessFingerprint ===
              readinessFingerprint,
        }
      : null,
  };

  const studioChecks = [
    completeCheck(
      "bootstrap",
      tenant.onboarding?.completed === true,
      "bootstrap_incomplete",
    ),
    completeCheck("name", Boolean(tenant.name?.trim()), "studio_name_missing"),
    completeCheck(
      "business_type",
      Boolean(tenant.onboarding?.businessType),
      "business_type_missing",
    ),
    completeCheck(
      "country",
      Boolean(tenant.onboarding?.businessDetails?.country?.trim()),
      "country_missing",
    ),
    completeCheck(
      "currency",
      Boolean(tenant.settings?.currency),
      "currency_missing",
    ),
    completeCheck(
      "timezone",
      Boolean(tenant.settings?.timezone),
      "timezone_missing",
    ),
  ];
  const studioComplete = studioChecks.every((check) => check.complete);

  const locationChecks = [
    completeCheck(
      "active_location",
      locations.length > 0,
      "active_location_missing",
    ),
    completeCheck(
      "booking_enabled",
      !bookingChecklistEnabled || Boolean(activeLocation?.booking?.enabled),
      "location_booking_disabled",
      !bookingChecklistEnabled,
    ),
  ];
  const locationComplete = locationChecks.every((check) => check.complete);

  const paymentChecks = [
    completeCheck(
      "account_connected",
      Boolean(payment?.stripeAccountId),
      "stripe_not_connected",
    ),
    completeCheck(
      "details_submitted",
      payment?.detailsSubmitted === true,
      "stripe_details_incomplete",
    ),
    completeCheck(
      "charges_enabled",
      payment?.chargesEnabled === true,
      "stripe_charges_disabled",
    ),
    completeCheck(
      "payouts_enabled",
      payment?.payoutsEnabled === true,
      "stripe_payouts_disabled",
    ),
    completeCheck(
      "requirements_clear",
      !(payment?.requirements?.currentlyDue?.length > 0) &&
        !(payment?.requirements?.pastDue?.length > 0),
      "stripe_requirements_due",
    ),
  ];
  const paymentsComplete = paymentChecks.every((check) => check.complete);

  const offerChecks = [
    completeCheck("activity", hasActiveProduct, "bookable_activity_missing"),
    completeCheck("capacity", hasCapacity, "capacity_missing"),
    completeCheck("price", hasPrice, "price_missing"),
    completeCheck(
      "availability",
      isTimedOffer || Boolean(upcomingSchedule),
      "upcoming_schedule_missing",
    ),
    completeCheck(
      "location",
      Boolean(activeLocation?.booking?.enabled),
      "bookable_location_missing",
    ),
  ];

  const communicationChecks = [
    completeCheck(
      "sender_verified",
      managedSenderReady,
      "sender_email_not_verified",
    ),
  ];
  const communicationsComplete = managedSenderReady;

  const teamComplete = activeTeamCount > 1;
  const teamNotApplicable =
    !teamComplete &&
    existingTeamCount <= 1 &&
    tenant.onboarding?.teamSize === "just_me";
  const teamStatus = teamComplete
    ? SETUP_STEP_STATUS.COMPLETE
    : teamNotApplicable
      ? SETUP_STEP_STATUS.NOT_APPLICABLE
      : SETUP_STEP_STATUS.INCOMPLETE;

  const publicationStatus =
    state?.publication?.status ?? SETUP_PUBLICATION_STATUS.DRAFT;
  const publicSiteDraftRevision = Math.max(
    0,
    Number(tenant.publicSiteEditor?.draftRevision) || 0,
  );
  const publicSitePublishedRevision = Math.max(
    0,
    Number(tenant.publicSiteEditor?.publishedRevision) || 0,
  );
  const publicSiteReviewed = Boolean(
    tenant.publicSiteEditor?.draftUpdatedAt ||
    tenant.publicSiteEditor?.publishedAt,
  );
  const publicSiteHasUnpublishedChanges =
    publicSiteDraftRevision !== publicSitePublishedRevision;

  const required = SETUP_STEP_REQUIREMENT.REQUIRED;
  const recommended = SETUP_STEP_REQUIREMENT.RECOMMENDED;
  const optional = SETUP_STEP_REQUIREMENT.OPTIONAL;
  const steps = [
    step({
      id: SETUP_STEP.STUDIO,
      status: studioComplete
        ? SETUP_STEP_STATUS.COMPLETE
        : SETUP_STEP_STATUS.INCOMPLETE,
      reasonCode: studioComplete ? "complete" : "studio_profile_incomplete",
      checks: studioChecks,
      actions: [
        action(
          tenant.onboarding?.completed === true
            ? "edit_studio"
            : "complete_studio_profile",
        ),
      ],
      requirement: required,
    }),
    step({
      id: SETUP_STEP.LOCATION,
      status: !locationApplicable
        ? SETUP_STEP_STATUS.NOT_APPLICABLE
        : locationComplete
          ? SETUP_STEP_STATUS.COMPLETE
          : SETUP_STEP_STATUS.INCOMPLETE,
      reasonCode: !locationApplicable
        ? "location_not_required"
        : locationComplete
          ? "complete"
          : "location_incomplete",
      checks: locationChecks,
      actions: [
        existingLocationCount > 0
          ? action("review_location", locationApplicable)
          : action("add_location", locationApplicable),
      ],
      requirement: recommended,
    }),
    step({
      id: SETUP_STEP.INVENTORY,
      status: !inventoryEnabled
        ? SETUP_STEP_STATUS.NOT_APPLICABLE
        : activeInventoryItemCount > 0
          ? SETUP_STEP_STATUS.COMPLETE
          : SETUP_STEP_STATUS.INCOMPLETE,
      reasonCode: !inventoryEnabled
        ? "inventory_module_disabled"
        : activeInventoryItemCount > 0
          ? "complete"
          : "inventory_item_missing",
      checks: [
        completeCheck(
          "active_inventory_item",
          activeInventoryItemCount > 0,
          "inventory_item_missing",
        ),
      ],
      actions: [
        existingInventoryItemCount > 0
          ? action("review_inventory", inventoryEnabled)
          : action("configure_inventory", inventoryEnabled),
      ],
      requirement: recommended,
    }),
    step({
      id: SETUP_STEP.BOOKABLE_OFFER,
      status: !bookingWorkflowEnabled
          ? SETUP_STEP_STATUS.NOT_APPLICABLE
          : offerReady
            ? SETUP_STEP_STATUS.COMPLETE
            : locationComplete
              ? SETUP_STEP_STATUS.INCOMPLETE
              : SETUP_STEP_STATUS.BLOCKED,
      reasonCode: !bookingWorkflowEnabled
          ? "booking_workflow_disabled"
          : offerReady
            ? "complete"
            : locationComplete
              ? "bookable_offer_incomplete"
              : "location_required",
      checks: offerChecks,
      actions: [
            existingCustomerBookableProduct && !bookableProduct
              ? action(
                  "review_offer",
                  Boolean(
                    bookingWorkflowEnabled && locationComplete && !offerReady,
                  ),
                  {
                    category: reviewOfferCategory,
                    productId: String(existingCustomerBookableProduct._id),
                  },
                )
              : action(
                  "create_offer",
                  Boolean(
                    bookingWorkflowEnabled &&
                    locationComplete &&
                    !bookableProduct &&
                    !offerReady,
                  ),
                ),
            action(
              "schedule_offer",
              Boolean(
                bookingWorkflowEnabled &&
                bookableProduct &&
                !isTimedOffer &&
                !offerReady &&
                activeLocation?.booking?.enabled === true,
              ),
              bookingWorkflowEnabled &&
                bookableProduct &&
                !isTimedOffer &&
                !offerReady &&
                activeLocation?.booking?.enabled === true
                ? {
                    productId: String(bookableProduct._id),
                    locationId: String(activeLocation._id),
                    isRoot: "true",
                  }
                : {},
            ),
          ],
      requirement: recommended,
    }),
    step({
      id: SETUP_STEP.MEMBERSHIP,
      status: !membershipsEnabled
        ? SETUP_STEP_STATUS.NOT_APPLICABLE
        : publishedMembershipCount > 0
          ? SETUP_STEP_STATUS.COMPLETE
          : SETUP_STEP_STATUS.INCOMPLETE,
      reasonCode: !membershipsEnabled
        ? "memberships_module_disabled"
        : publishedMembershipCount > 0
          ? "complete"
          : "membership_missing",
      checks: [
        completeCheck(
          "published_membership",
          publishedMembershipCount > 0,
          "membership_missing",
        ),
      ],
      actions: [
        draftMembershipCount > 0
          ? action("review_membership", membershipsEnabled)
          : action("create_membership", membershipsEnabled),
      ],
      requirement: recommended,
    }),
    step({
      id: SETUP_STEP.PAYMENTS,
      status: !paymentsApplicable
        ? SETUP_STEP_STATUS.NOT_APPLICABLE
        : paymentsComplete
          ? SETUP_STEP_STATUS.COMPLETE
          : SETUP_STEP_STATUS.INCOMPLETE,
      reasonCode: !paymentsApplicable
        ? paymentsEnabled
          ? "payments_not_applicable"
          : "payments_module_disabled"
        : paymentsComplete
          ? "complete"
          : "payments_not_ready",
      checks: paymentChecks,
      actions: [action("connect_payments", paymentsApplicable)],
      requirement: paymentsApplicable ? required : recommended,
    }),
    step({
      id: SETUP_STEP.COMMUNICATIONS,
      status: !communicationsEnabled
        ? SETUP_STEP_STATUS.NOT_APPLICABLE
        : communicationsComplete
          ? SETUP_STEP_STATUS.COMPLETE
          : SETUP_STEP_STATUS.INCOMPLETE,
      reasonCode: !communicationsEnabled
        ? "communications_module_disabled"
        : communicationsComplete
          ? "complete"
          : "communications_incomplete",
      checks: communicationChecks,
      actions: [
        managedSenderReady
          ? action("configure_communications", communicationsEnabled)
          : action("verify_sender", communicationsEnabled),
      ],
      requirement: recommended,
    }),
    step({
      id: SETUP_STEP.TEAM,
      status: teamStatus,
      reasonCode: teamComplete
        ? "complete"
        : teamNotApplicable
          ? "solo_workspace"
          : "team_member_missing",
      checks: [
        completeCheck(
          "team_member",
          teamComplete,
          teamNotApplicable ? "solo_workspace" : "team_member_missing",
          teamNotApplicable,
        ),
      ],
      actions: [
        existingTeamCount > 1
          ? action("review_team", !teamNotApplicable)
          : action("invite_team", !teamNotApplicable),
      ],
      requirement: recommended,
    }),
    step({
      id: SETUP_STEP.PUBLIC_SITE,
      status: !publicFacingEnabled
        ? SETUP_STEP_STATUS.NOT_APPLICABLE
        : publicSiteReviewed
          ? SETUP_STEP_STATUS.COMPLETE
          : SETUP_STEP_STATUS.INCOMPLETE,
      reasonCode: !publicFacingEnabled
        ? "public_site_not_applicable"
        : publicSiteReviewed
          ? "complete"
          : "public_site_review_required",
      checks: [
        completeCheck(
          "public_site_reviewed",
          publicSiteReviewed,
          "public_site_review_required",
        ),
      ],
      actions: [action("customize_public_site", publicFacingEnabled)],
      requirement: publicFacingEnabled ? recommended : optional,
    }),
  ];

  const published = publicationStatus === SETUP_PUBLICATION_STATUS.LIVE;
  const simulatedPracticeComplete =
    practice.status === SETUP_PRACTICE_STATUS.COMPLETE &&
    !practice.retestRecommended;
  const manualPracticeComplete = practice.manualConfirmation?.current === true;
  const practiceComplete = manualPracticeComplete || simulatedPracticeComplete;
  const practiceRetestRecommended =
    !practiceComplete &&
    (Boolean(practice.manualConfirmation) || practice.retestRecommended);
  const launchPrerequisiteStepIds = new Set<SetupStepId>([SETUP_STEP.STUDIO]);
  if (
    locationApplicable &&
    (bookingPreferred || inventoryPreferred)
  )
    launchPrerequisiteStepIds.add(SETUP_STEP.LOCATION);
  if ((bookingWorkflowEnabled && bookingPreferred)) {
    launchPrerequisiteStepIds.add(SETUP_STEP.BOOKABLE_OFFER);
  }
  if (
    membershipsEnabled &&
    membershipPreferred &&
    (!bookingWorkflowEnabled || !bookingPreferred)
  ) {
    launchPrerequisiteStepIds.add(SETUP_STEP.MEMBERSHIP);
  }
  if (paymentsRequired) launchPrerequisiteStepIds.add(SETUP_STEP.PAYMENTS);
  if (inventoryFocused && inventoryPreferred) {
    launchPrerequisiteStepIds.add(SETUP_STEP.INVENTORY);
  }
  if (publicFacingEnabled && publicSitePreferred) {
    launchPrerequisiteStepIds.add(SETUP_STEP.PUBLIC_SITE);
  }
  const launchPrerequisiteSteps = steps.filter(
    (item) => item.applicable && launchPrerequisiteStepIds.has(item.id),
  );
  const ready = launchPrerequisiteSteps.every(
    (item) => item.status === SETUP_STEP_STATUS.COMPLETE,
  );
  const canStartPractice =
    bookingChecklistEnabled && offerReady && published && ready;
  steps.push(
    step({
      id: SETUP_STEP.PUBLISH,
      status: !publicFacingEnabled
        ? SETUP_STEP_STATUS.NOT_APPLICABLE
        : publicationStatus === SETUP_PUBLICATION_STATUS.LIVE
          ? SETUP_STEP_STATUS.COMPLETE
          : ready
            ? SETUP_STEP_STATUS.INCOMPLETE
            : SETUP_STEP_STATUS.BLOCKED,
      reasonCode: !publicFacingEnabled
        ? "public_site_not_applicable"
        : publicationStatus === SETUP_PUBLICATION_STATUS.LIVE
          ? "complete"
          : ready
            ? "ready_to_publish"
            : "required_setup_incomplete",
      checks: [
        completeCheck("required_setup", ready, "required_setup_incomplete"),
        completeCheck(
          "published",
          publicationStatus === SETUP_PUBLICATION_STATUS.LIVE,
          "not_published",
        ),
      ],
      actions: [action("publish_studio", publicFacingEnabled && ready)],
      requirement: publicFacingEnabled ? recommended : optional,
    }),
    step({
      id: SETUP_STEP.PRACTICE_BOOKING,
      status: !bookingWorkflowEnabled
        ? SETUP_STEP_STATUS.NOT_APPLICABLE
        : practiceComplete
          ? SETUP_STEP_STATUS.COMPLETE
          : !offerReady || !published || !ready
            ? SETUP_STEP_STATUS.BLOCKED
            : SETUP_STEP_STATUS.INCOMPLETE,
      reasonCode: !bookingWorkflowEnabled
        ? "booking_workflow_disabled"
        : practiceComplete
          ? "complete"
          : practiceRetestRecommended
            ? "configuration_changed_retest"
            : !offerReady
              ? "bookable_offer_required"
              : !published
                ? "public_site_publication_required"
                : !ready
                  ? "required_setup_incomplete"
                  : "practice_booking_incomplete",
      checks: [
        completeCheck(
          "launch_prerequisites",
          ready,
          "required_setup_incomplete",
        ),
        completeCheck(
          "public_site_published",
          published,
          "public_site_publication_required",
        ),
        completeCheck(
          "practice_run",
          practiceComplete,
          practiceRetestRecommended
            ? "configuration_changed_retest"
            : "practice_run_incomplete",
        ),
      ],
      actions: [action("practice_booking", canStartPractice)],
      requirement: recommended,
    }),
  );

  const stepOrder = new Map(
    SETUP_STEP_ORDER.map((stepId, index) => [stepId, index]),
  );
  steps.sort(
    (left, right) =>
      (stepOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (stepOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );

  const requiredSteps = steps.filter(
    (item) => item.applicable && item.requirement === required,
  );
  const requiredCompleted = requiredSteps.filter(
    (item) => item.status === SETUP_STEP_STATUS.COMPLETE,
  ).length;
  const requiredTotal = requiredSteps.length;
  const requiredPercentage = requiredTotal
    ? Math.round((requiredCompleted / requiredTotal) * 100)
    : 100;
  const paymentStepIds = new Set<SetupStepId>([
    SETUP_STEP.STUDIO,
    SETUP_STEP.PAYMENTS,
  ]);
  const paymentPrerequisiteSteps =
    paymentsApplicable && (commercePreferred || paymentsRequired)
      ? steps.filter((item) => item.applicable && paymentStepIds.has(item.id))
      : steps.filter(
          (item) => item.applicable && item.id === SETUP_STEP.STUDIO,
        );
  const paymentCompleted = paymentPrerequisiteSteps.filter(
    (item) => item.status === SETUP_STEP_STATUS.COMPLETE,
  ).length;
  const paymentTotal = paymentPrerequisiteSteps.length;
  const paymentPercentage = paymentTotal
    ? Math.round((paymentCompleted / paymentTotal) * 100)
    : 100;
  const launchPrerequisiteCompleted = launchPrerequisiteSteps.filter(
    (item) => item.status === SETUP_STEP_STATUS.COMPLETE,
  ).length;
  const incompleteLaunchStepIds = launchPrerequisiteSteps
    .filter((item) => item.status !== SETUP_STEP_STATUS.COMPLETE)
    .map((item) => item.id);
  const allLaunchSteps = steps.filter(
    (item) =>
      item.applicable &&
      (paymentStepIds.has(item.id) ||
        launchPrerequisiteStepIds.has(item.id) ||
        (item.id === SETUP_STEP.PUBLISH && publicSitePreferred) ||
        (item.id === SETUP_STEP.PRACTICE_BOOKING && bookingPreferred) ||
        (item.id === SETUP_STEP.MEMBERSHIP && answers?.memberships === true) ||
        (item.id === SETUP_STEP.INVENTORY && answers?.inventory === true)),
  );
  const launchChecklistSteps = allLaunchSteps.filter(
    (item) => !paymentStepIds.has(item.id),
  );
  const launchChecklistStepIds = new Set(
    launchChecklistSteps.map((item) => item.id),
  );
  const requiredChecklistStepIds = new Set(
    paymentPrerequisiteSteps.map((item) => item.id),
  );
  const availableLaterSteps = steps.filter(
    (item) =>
      !requiredChecklistStepIds.has(item.id) &&
      !launchChecklistStepIds.has(item.id),
  );
  const recommendedCompleted = launchChecklistSteps.filter(
    (item) => item.status === SETUP_STEP_STATUS.COMPLETE,
  ).length;
  const launchCompleted = allLaunchSteps.filter(
    (item) => item.status === SETUP_STEP_STATUS.COMPLETE,
  ).length;
  const launchTotal = allLaunchSteps.length;
  const launchPercentage = launchTotal
    ? Math.round((launchCompleted / launchTotal) * 100)
    : 100;
  const healthNeedsAttention = published && !ready;

  const recommendations = [
    ...(bookingWorkflowEnabled &&
    communicationsEnabled &&
    modules[TENANT_MODULE.AUTOMATIONS] !== false
      ? [
          {
            id: "reminders",
            complete: activeBookingReminderCount > 0,
            action: action("configure_reminders"),
          },
        ]
      : []),
    ...(modules[TENANT_MODULE.CUSTOMERS] !== false
      ? [
          {
            id: "customers",
            complete: customerCount > 0,
            action: action("import_customers"),
          },
        ]
      : []),
  ];

  const launchComplete =
    ready &&
    (published || !publicSiteChecklistEnabled) &&
    (!bookingChecklistEnabled || practiceComplete);
  const nextStep =
    selectNextSetupStep(paymentPrerequisiteSteps) ??
    selectNextSetupStep(launchChecklistSteps) ??
    (!answers ? selectNextSetupStep(availableLaterSteps) : null);
  const prioritizedNextAction = nextStep
    ? (nextStep.actions.find((item) => item.enabled) ?? null)
    : null;
  const stepGroups = {
    required: paymentPrerequisiteSteps.map((item) => item.id),
    // Compatibility alias for clients that used the old recommendation group.
    recommended: launchChecklistSteps.map((item) => item.id),
    launchChecklist: launchChecklistSteps.map((item) => item.id),
    availableLater: availableLaterSteps.map((item) => item.id),
  };

  return {
    definitionVersion: SETUP_CENTER_DEFINITION_VERSION,
    phase: launchComplete
      ? SETUP_CENTER_PHASE.LEARNING
      : SETUP_CENTER_PHASE.LAUNCH,
    ready,
    health: healthNeedsAttention ? "needs_attention" : "healthy",
    progress: {
      // Definition-v2 compatibility aliases. These now represent only the
      // prerequisites for accepting payments, never the launch checklist.
      completed: requiredCompleted,
      total: requiredTotal,
      percentage: requiredPercentage,
      required: {
        completed: requiredCompleted,
        total: requiredTotal,
        percentage: requiredPercentage,
      },
      payment: {
        completed: paymentCompleted,
        total: paymentTotal,
        percentage: paymentPercentage,
      },
      launch: {
        completed: launchCompleted,
        total: launchTotal,
        percentage: launchPercentage,
        remaining: launchTotal - launchCompleted,
      },
      recommended: {
        completed: recommendedCompleted,
        total: launchChecklistSteps.length,
        remaining: launchChecklistSteps.length - recommendedCompleted,
      },
    },
    publication: {
      status: publicationStatus,
      publishedAt: state?.publication?.publishedAt ?? null,
    },
    paymentReadiness: {
      applicable: paymentsApplicable,
      ready: paymentsApplicable && paymentsComplete,
      chargesEnabled: payment?.chargesEnabled === true,
      payoutsEnabled: payment?.payoutsEnabled === true,
      requirementsClear:
        !(payment?.requirements?.currentlyDue?.length > 0) &&
        !(payment?.requirements?.pastDue?.length > 0),
    },
    practice,
    steps,
    stepGroups,
    launchReview: {
      status: launchComplete
        ? "launched"
        : ready && publicSiteChecklistEnabled && !published
          ? "ready_to_publish"
          : "in_progress",
      readyToPublish: ready && publicSiteChecklistEnabled && !published,
      launchComplete,
      required: {
        complete: ready,
        completed: launchPrerequisiteCompleted,
        total: launchPrerequisiteSteps.length,
        incompleteStepIds: incompleteLaunchStepIds,
      },
      publicSite: {
        applicable: publicSiteChecklistEnabled,
        reviewed: publicSiteReviewed,
        published,
        tenantSlug: tenant.slug,
        publishedAt: state?.publication?.publishedAt ?? null,
        draftRevision: publicSiteDraftRevision,
        publishedRevision: publicSitePublishedRevision,
        hasUnpublishedChanges: publicSiteHasUnpublishedChanges,
        canPublish: publicSiteChecklistEnabled && ready && !published,
        // The client resolves this allowlisted relative path on the tenant host.
        publicPath: publicSiteChecklistEnabled ? "/" : null,
      },
      testBooking: {
        applicable: bookingChecklistEnabled,
        complete: practiceComplete,
        retestRecommended: practiceRetestRecommended,
        completedAt: manualPracticeComplete
          ? practice.manualConfirmation!.confirmedAt
          : simulatedPracticeComplete
            ? practice.completedAt
            : null,
        completionSource: manualPracticeComplete
          ? "manual"
          : simulatedPracticeComplete
            ? "practice"
            : null,
        canStart: canStartPractice,
        action: bookingChecklistEnabled
          ? action("practice_booking", canStartPractice)
          : null,
      },
    },
    launchMetrics: buildLaunchMetrics(state?.analytics),
    nextAction: prioritizedNextAction,
    recommendations,
    diagnostics: {
      paymentStatus: payment?.onboardingStatus ?? "not_started",
      paymentLastSyncedAt: payment?.lastSyncedAt ?? null,
      paymentRequirementsDue:
        (payment?.requirements?.currentlyDue?.length ?? 0) +
        (payment?.requirements?.pastDue?.length ?? 0),
      bookableProductId: bookableProduct ? String(bookableProduct._id) : null,
      bookableProductName: bookableProduct?.name ?? null,
      bookableProductPrice: bookableProduct?.price ?? null,
      bookableProductCurrency: bookableProduct?.currency ?? null,
      activeLocationId: activeLocation ? String(activeLocation._id) : null,

        activeInventoryItemCount,
      readinessFingerprint,
    },
  };
};

const ensureState = async (tenantId: string) =>
  SetupCenterStateModel.findOneAndUpdate(
    { tenant: tenantId },
    {
      $setOnInsert: {
        tenant: tenantId,
        definitionVersion: SETUP_CENTER_DEFINITION_VERSION,
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );

const audit = async ({
  tenantId,
  actorUserId,
  event,
  stepId = "",
  practiceRunId = "",
  metadata = {},
}: {
  tenantId: string;
  actorUserId: string;
  event: string;
  stepId?: string;
  practiceRunId?: string;
  metadata?: Record<string, unknown>;
}) =>
  SetupAuditEventModel.create({
    tenant: tenantId,
    actor: actorUserId,
    event,
    stepId,
    practiceRunId,
    metadata,
  });

/**
 * Busts the cached public-tenant-by-slug lookup right after a publish or
 * unpublish transition, so the change is visible to the next public request
 * immediately instead of waiting out the cache TTL. Best-effort: a tenant
 * missing at this point (deleted mid-request) just means there's nothing to
 * invalidate.
 */
const invalidatePublicTenantCache = async (tenantId: string): Promise<void> => {
  const tenant = await TenantModel.findById(tenantId).select("slug").lean();
  if (!tenant?.slug) return;

  const { deleteCache } = await import("@/infrastructure/redis/cache.js");
  await deleteCache(publicTenantCacheKey(tenant.slug));
};

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    Number((error as { code?: unknown }).code) === 11_000,
  );

const launchEventCounterPath = (event: SetupLaunchEvent): string | null => {
  switch (event) {
    case SETUP_LAUNCH_EVENT.LAUNCH_CENTER_VIEWED:
      return "analytics.eventCounts.launchCenterViewed";
    case SETUP_LAUNCH_EVENT.STUDIO_READY:
      return "analytics.eventCounts.studioReady";
    case SETUP_LAUNCH_EVENT.PUBLIC_SITE_OPENED:
      return "analytics.eventCounts.publicSiteOpened";
    case SETUP_LAUNCH_EVENT.TEST_BOOKING_OPENED:
      return "analytics.eventCounts.testBookingOpened";
    case SETUP_LAUNCH_EVENT.PRODUCT_TOUR_STARTED:
      return "analytics.eventCounts.productTourStarted";
    case SETUP_LAUNCH_EVENT.PRODUCT_TOUR_COMPLETED:
      return "analytics.eventCounts.productTourCompleted";
    case SETUP_LAUNCH_EVENT.PRODUCT_TOUR_SKIPPED:
      return "analytics.eventCounts.productTourSkipped";
    case SETUP_LAUNCH_EVENT.PRODUCT_TOUR_LAUNCH_CENTER_OPENED:
      return "analytics.eventCounts.productTourLaunchCenterOpened";
    default:
      return null;
  }
};

export const recordSetupLaunchEvent = async ({
  tenantId,
  actorUserId,
  eventId,
  sessionId,
  event,
  stepId,
  source,
  metadata = {},
}: {
  tenantId: string;
  actorUserId: string;
  eventId: string;
  sessionId: string;
  event: SetupLaunchEvent;
  stepId?: SetupStepId;
  source?: SetupLaunchEventSource;
  metadata?: Record<string, string | number | boolean | null>;
}) => {
  const now = new Date();
  const observesReadiness =
    event === SETUP_LAUNCH_EVENT.LAUNCH_CENTER_VIEWED ||
    event === SETUP_LAUNCH_EVENT.STEP_COMPLETED ||
    event === SETUP_LAUNCH_EVENT.STUDIO_READY;
  const snapshot = observesReadiness
    ? await buildSetupCenterSnapshot({ tenantId, actorUserId })
    : null;

  let inserted = false;
  try {
    const result = await SetupLaunchEventModel.updateOne(
      { tenant: tenantId, eventId },
      {
        $setOnInsert: {
          tenant: tenantId,
          actor: actorUserId,
          eventId,
          sessionId,
          event,
          ...(stepId ? { stepId } : {}),
          ...(source ? { source } : {}),
          metadata,
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );
    inserted = Boolean(result.upsertedCount || result.upsertedId);
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }

  if (!inserted) {
    return { accepted: true, eventId, deduplicated: true };
  }

  await ensureState(tenantId);
  const increments: Record<string, number> = {};
  const minimums: Record<string, Date> = {
    "analytics.firstSeenAt": now,
  };
  const maximums: Record<string, Date> = {
    "analytics.lastActivityAt": now,
  };
  const setValues: Record<string, unknown> = {};
  const counterPath = launchEventCounterPath(event);
  if (counterPath) increments[counterPath] = 1;

  if (stepId && event === SETUP_LAUNCH_EVENT.STEP_OPENED) {
    increments[`analytics.steps.${stepId}.opened`] = 1;
    minimums[`analytics.steps.${stepId}.firstOpenedAt`] = now;
    maximums[`analytics.steps.${stepId}.lastOpenedAt`] = now;
    setValues["analytics.lastStepId"] = stepId;
  }
  if (stepId && event === SETUP_LAUNCH_EVENT.STEP_COMPLETED) {
    increments[`analytics.steps.${stepId}.completed`] = 1;
    minimums[`analytics.steps.${stepId}.firstCompletedAt`] = now;
    maximums[`analytics.steps.${stepId}.lastCompletedAt`] = now;
    setValues["analytics.lastStepId"] = stepId;
  }

  if (snapshot?.launchReview.testBooking.canStart) {
    minimums["analytics.firstPublishedOfferAt"] = now;
  }
  const publishedAt = dateOrNull(snapshot?.publication.publishedAt);
  if (publishedAt) minimums["analytics.firstPublishedAt"] = publishedAt;
  if (snapshot?.launchReview.launchComplete) {
    minimums["analytics.completedAt"] = now;
  }

  await SetupCenterStateModel.findOneAndUpdate(
    { tenant: tenantId },
    {
      ...(Object.keys(increments).length ? { $inc: increments } : {}),
      ...(Object.keys(setValues).length ? { $set: setValues } : {}),
      $min: minimums,
      $max: maximums,
    },
    { returnDocument: "after" },
  );

  return { accepted: true, eventId, deduplicated: false };
};

const practiceArtifact = (
  actionKey: SetupPracticeAction,
  snapshot: Awaited<ReturnType<typeof buildSetupCenterSnapshot>>,
) => {
  const now = new Date();
  const productName =
    snapshot.diagnostics.bookableProductName ?? "Sample activity";
  const currency = String(snapshot.diagnostics.bookableProductCurrency ?? "");

  switch (actionKey) {
    case SETUP_PRACTICE_ACTION.CREATE_BOOKING:
      return {
        kind: "booking",
        title: "Practice booking",
        summary: `${productName} was reserved for the sample customer. No capacity was consumed.`,
        createdAt: now,
      };
    case SETUP_PRACTICE_ACTION.PREVIEW_INVOICE:
      return {
        kind: "invoice",
        title: "Practice invoice",
        summary:
          "A non-numbered invoice preview was generated. It is not an accounting document.",
        currency,
        createdAt: now,
      };
    case SETUP_PRACTICE_ACTION.PREVIEW_CONFIRMATION:
      return {
        kind: "confirmation",
        title: "Practice confirmation",
        summary:
          "A confirmation preview was prepared. No email, SMS or social message was sent.",
        createdAt: now,
      };
    case SETUP_PRACTICE_ACTION.PREVIEW_MEMBERSHIP:
      return {
        kind: "membership",
        title: "Practice membership",
        summary:
          "A sample membership benefit view was prepared without creating credits or a subscription.",
        createdAt: now,
      };
    case SETUP_PRACTICE_ACTION.CHECK_IN:
      return {
        kind: "check_in",
        title: "Practice check-in",
        summary:
          "The sample customer was checked in without changing a real booking.",
        createdAt: now,
      };
    case SETUP_PRACTICE_ACTION.CANCEL_BOOKING:
      return {
        kind: "cancellation",
        title: "Practice cancellation",
        summary:
          "The practice booking was cancelled. No refund, notification or capacity update occurred.",
        createdAt: now,
      };
  }
};

export const startSetupPractice = async ({
  tenantId,
  actorUserId,
  idempotencyKey,
}: {
  tenantId: string;
  actorUserId: string;
  idempotencyKey: string;
}) => {
  const snapshot = await buildSetupCenterSnapshot({ tenantId, actorUserId });
  const offerStep = snapshot.steps.find(
    (item) => item.id === SETUP_STEP.BOOKABLE_OFFER,
  );
  if (!offerStep?.complete) {
    conflict({
      message:
        "Create a complete bookable offer before starting Practice Mode.",
      code: "SETUP_PRACTICE_OFFER_REQUIRED",
    });
  }
  if (
    snapshot.launchReview.publicSite.applicable &&
    !snapshot.launchReview.publicSite.published
  ) {
    conflict({
      message:
        "Publish the public studio before testing the customer booking journey.",
      code: "SETUP_PRACTICE_PUBLICATION_REQUIRED",
    });
  }
  if (!snapshot.launchReview.required.complete) {
    conflict({
      message:
        "Complete the launch checklist before testing the customer booking journey.",
      code: "SETUP_PRACTICE_LAUNCH_REQUIREMENTS_REQUIRED",
      details: {
        blockers: snapshot.launchReview.required.incompleteStepIds,
      },
    });
  }

  const state = await ensureState(tenantId);
  if (
    state.practice?.idempotencyKey === idempotencyKey &&
    String(state.practice.actor) === actorUserId
  ) {
    return buildSetupCenterSnapshot({ tenantId, actorUserId });
  }

  const now = new Date();
  const runId = `practice_${randomUUID()}`;
  const practice = {
    runId,
    idempotencyKey,
    actor: actorUserId,
    status: SETUP_PRACTICE_STATUS.IN_PROGRESS,
    locationId: snapshot.diagnostics.activeLocationId,
    productId: snapshot.diagnostics.bookableProductId,
    readinessFingerprint: snapshot.diagnostics.readinessFingerprint,
    completedActions: [],
    artifacts: [],
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    expiresAt: new Date(now.getTime() + SETUP_PRACTICE_TTL_MS),
  };

  const started = await SetupCenterStateModel.findOneAndUpdate(
    {
      tenant: tenantId,
      $or: [
        { practice: null },
        { practice: { $exists: false } },
        {
          "practice.status": {
            $in: [
              SETUP_PRACTICE_STATUS.ABANDONED,
              SETUP_PRACTICE_STATUS.EXPIRED,
            ],
          },
        },
        {
          "practice.status": SETUP_PRACTICE_STATUS.IN_PROGRESS,
          "practice.expiresAt": { $lte: now },
        },
      ],
    },
    {
      $set: {
        practice,
      },
    },
    { returnDocument: "after" },
  );

  if (!started) {
    const current = await ensureState(tenantId);
    if (
      current.practice?.idempotencyKey === idempotencyKey &&
      String(current.practice.actor) === actorUserId
    ) {
      return buildSetupCenterSnapshot({ tenantId, actorUserId });
    }

    conflict({
      message:
        current.practice?.status === SETUP_PRACTICE_STATUS.COMPLETE
          ? "Reset the completed Practice Mode session before starting a new one."
          : "Another Practice Mode session is already active for this workspace.",
      code:
        current.practice?.status === SETUP_PRACTICE_STATUS.COMPLETE
          ? "SETUP_PRACTICE_RESET_REQUIRED"
          : "SETUP_PRACTICE_ALREADY_ACTIVE",
    });
  }

  await audit({
    tenantId,
    actorUserId,
    event: "practice_started",
    stepId: SETUP_STEP.PRACTICE_BOOKING,
    practiceRunId: runId,
  });
  return buildSetupCenterSnapshot({ tenantId, actorUserId });
};

export const applySetupPracticeAction = async ({
  tenantId,
  actorUserId,
  runId,
  actionKey,
}: {
  tenantId: string;
  actorUserId: string;
  runId: string;
  actionKey: SetupPracticeAction;
}) => {
  if (actionKey === SETUP_PRACTICE_ACTION.PREVIEW_INVOICE) {
    assertNativeInvoicingEnabled();
  }
  const state = await ensureState(tenantId);
  const practice = state.practice;
  if (
    !practice ||
    practice.runId !== runId ||
    String(practice.actor) !== actorUserId
  ) {
    notFound("Practice run not found.");
  }
  if (new Date(practice.expiresAt).getTime() <= Date.now()) {
    const expiredAt = new Date();
    await SetupCenterStateModel.findOneAndUpdate(
      {
        tenant: tenantId,
        "practice.runId": runId,
        "practice.actor": actorUserId,
        "practice.status": SETUP_PRACTICE_STATUS.IN_PROGRESS,
        "practice.expiresAt": { $lte: expiredAt },
      },
      {
        $set: {
          "practice.status": SETUP_PRACTICE_STATUS.EXPIRED,
          "practice.updatedAt": expiredAt,
        },
      },
      { returnDocument: "after" },
    );
    conflict({
      message: "This Practice Mode session has expired.",
      code: "SETUP_PRACTICE_EXPIRED",
    });
  }
  if (practice.status === SETUP_PRACTICE_STATUS.COMPLETE) {
    return buildSetupCenterSnapshot({ tenantId, actorUserId });
  }
  if (practice.status !== SETUP_PRACTICE_STATUS.IN_PROGRESS) {
    conflict({
      message: "This Practice Mode session is no longer active.",
      code: "SETUP_PRACTICE_INACTIVE",
    });
  }

  const availableActions = getAvailableSetupPracticeActions();
  const completedActions = new Set(
    practice.completedActions.filter((action) =>
      availableActions.includes(action),
    ),
  );
  if (completedActions.has(actionKey)) {
    return buildSetupCenterSnapshot({ tenantId, actorUserId });
  }
  const expectedAction = availableActions.find(
    (action) => !completedActions.has(action),
  );
  if (expectedAction !== actionKey) {
    conflict({
      message: "Complete the previous Practice Mode step first.",
      code: "SETUP_PRACTICE_INVALID_TRANSITION",
      details: { expectedAction },
    });
  }

  const snapshot = await buildSetupCenterSnapshot({ tenantId, actorUserId });
  if (
    snapshot.launchReview.publicSite.applicable &&
    !snapshot.launchReview.publicSite.published
  ) {
    conflict({
      message:
        "Publish the public studio before testing the customer booking journey.",
      code: "SETUP_PRACTICE_PUBLICATION_REQUIRED",
    });
  }
  if (!snapshot.launchReview.required.complete) {
    conflict({
      message:
        "Complete the launch checklist before testing the customer booking journey.",
      code: "SETUP_PRACTICE_LAUNCH_REQUIREMENTS_REQUIRED",
      details: {
        blockers: snapshot.launchReview.required.incompleteStepIds,
      },
    });
  }
  const now = new Date();
  const completesRun = completedActions.size + 1 === availableActions.length;
  const transitioned = await SetupCenterStateModel.findOneAndUpdate(
    {
      tenant: tenantId,
      "practice.runId": runId,
      "practice.actor": actorUserId,
      "practice.status": SETUP_PRACTICE_STATUS.IN_PROGRESS,
      "practice.expiresAt": { $gt: now },
      "practice.completedActions": [...practice.completedActions],
    },
    {
      $push: {
        "practice.completedActions": actionKey,
        "practice.artifacts": practiceArtifact(actionKey, snapshot),
      },
      $set: {
        "practice.updatedAt": now,
        ...(completesRun
          ? {
              "practice.status": SETUP_PRACTICE_STATUS.COMPLETE,
              "practice.completedAt": now,
            }
          : {}),
      },
      ...(completesRun ? { $min: { "analytics.completedAt": now } } : {}),
    },
    { returnDocument: "after" },
  );

  if (!transitioned) {
    const current = await ensureState(tenantId);
    const currentPractice = current.practice;
    if (
      !currentPractice ||
      currentPractice.runId !== runId ||
      String(currentPractice.actor) !== actorUserId
    ) {
      notFound("Practice run not found.");
    }
    if (currentPractice.completedActions.includes(actionKey)) {
      return buildSetupCenterSnapshot({ tenantId, actorUserId });
    }
    if (
      currentPractice.status === SETUP_PRACTICE_STATUS.EXPIRED ||
      new Date(currentPractice.expiresAt).getTime() <= Date.now()
    ) {
      conflict({
        message: "This Practice Mode session has expired.",
        code: "SETUP_PRACTICE_EXPIRED",
      });
    }

    conflict({
      message:
        "Practice Mode changed in another request. Refresh and continue.",
      code: "SETUP_PRACTICE_CONCURRENT_UPDATE",
    });
  }

  await audit({
    tenantId,
    actorUserId,
    event: completesRun ? "practice_completed" : "practice_advanced",
    stepId: SETUP_STEP.PRACTICE_BOOKING,
    practiceRunId: runId,
    metadata: { action: actionKey },
  });
  return buildSetupCenterSnapshot({ tenantId, actorUserId });
};

export const abandonSetupPractice = async ({
  tenantId,
  actorUserId,
}: {
  tenantId: string;
  actorUserId: string;
}) => {
  const state = await ensureState(tenantId);
  const runId = state.practice?.runId ?? "";
  if (state.practice && String(state.practice.actor) !== actorUserId) {
    notFound("Practice run not found.");
  }
  if (!runId) {
    return buildSetupCenterSnapshot({ tenantId, actorUserId });
  }

  const abandoned = await SetupCenterStateModel.findOneAndUpdate(
    {
      tenant: tenantId,
      "practice.runId": runId,
      "practice.actor": actorUserId,
    },
    {
      $set: {
        practice: null,
      },
    },
    { returnDocument: "after" },
  );

  if (abandoned) {
    await audit({
      tenantId,
      actorUserId,
      event: "practice_abandoned",
      stepId: SETUP_STEP.PRACTICE_BOOKING,
      practiceRunId: runId,
    });
  }

  return buildSetupCenterSnapshot({ tenantId, actorUserId });
};

export const confirmSetupPractice = async ({
  tenantId,
  actorUserId,
  expectedReadinessFingerprint,
}: {
  tenantId: string;
  actorUserId: string;
  expectedReadinessFingerprint: string;
}) => {
  const snapshot = await buildSetupCenterSnapshot({ tenantId, actorUserId });
  if (
    !snapshot.diagnostics.readinessFingerprint ||
    expectedReadinessFingerprint !== snapshot.diagnostics.readinessFingerprint
  ) {
    conflict({
      message:
        "The booking configuration changed. Refresh and confirm the current setup.",
      code: "SETUP_PRACTICE_CONFIGURATION_CHANGED",
    });
  }
  if (!snapshot.launchReview.testBooking.canStart) {
    conflict({
      message:
        "Complete the launch requirements and publish the studio before confirming a booking test.",
      code: "SETUP_PRACTICE_LAUNCH_REQUIREMENTS_REQUIRED",
      details: { blockers: snapshot.launchReview.required.incompleteStepIds },
    });
  }

  await ensureState(tenantId);
  const now = new Date();
  // An atomic fingerprint comparison makes repeat clicks idempotent, including
  // concurrent confirmations by different staff members of the same tenant.
  const confirmed = await SetupCenterStateModel.findOneAndUpdate(
    {
      tenant: tenantId,
      "practiceConfirmation.readinessFingerprint": {
        $ne: expectedReadinessFingerprint,
      },
    },
    {
      $set: {
        practiceConfirmation: {
          confirmedAt: now,
          confirmedBy: actorUserId,
          readinessFingerprint: expectedReadinessFingerprint,
        },
      },
      $min: { "analytics.completedAt": now },
    },
    { returnDocument: "after", runValidators: true },
  );
  if (confirmed) {
    await audit({
      tenantId,
      actorUserId,
      event: "practice_manually_confirmed",
      stepId: SETUP_STEP.PRACTICE_BOOKING,
      metadata: { readinessFingerprint: expectedReadinessFingerprint },
    });
  }
  return buildSetupCenterSnapshot({ tenantId, actorUserId });
};

export const clearSetupPracticeConfirmation = async ({
  tenantId,
  actorUserId,
}: {
  tenantId: string;
  actorUserId: string;
}) => {
  const cleared = await SetupCenterStateModel.findOneAndUpdate(
    { tenant: tenantId, practiceConfirmation: { $ne: null } },
    { $set: { practiceConfirmation: null } },
    { returnDocument: "after" },
  );
  if (cleared) {
    await audit({
      tenantId,
      actorUserId,
      event: "practice_manual_confirmation_cleared",
      stepId: SETUP_STEP.PRACTICE_BOOKING,
    });
  }
  return buildSetupCenterSnapshot({ tenantId, actorUserId });
};

export const publishStudio = async ({
  tenantId,
  actorUserId,
  expectedDefinitionVersion,
}: {
  tenantId: string;
  actorUserId: string;
  expectedDefinitionVersion: number;
}) => {
  if (expectedDefinitionVersion !== SETUP_CENTER_DEFINITION_VERSION) {
    conflict({
      message: "The Launch Center definition changed. Refresh and try again.",
      code: "SETUP_DEFINITION_CHANGED",
    });
  }
  const { access } = await getTenantSubscriptionAccess(tenantId);
  if (!access.canUseFeatures) {
    forbidden({
      message: "An active subscription or trial is required before publishing.",
      code: "TENANT_SUBSCRIPTION_REQUIRED",
      details: access,
    });
  }

  const snapshot = await buildSetupCenterSnapshot({ tenantId, actorUserId });
  if (snapshot.publication.status === SETUP_PUBLICATION_STATUS.LIVE) {
    return snapshot;
  }
  const blockers = snapshot.launchReview.required.incompleteStepIds;
  if (blockers.length) {
    conflict({
      message: "Complete the required launch steps before publishing.",
      code: "SETUP_LAUNCH_BLOCKED",
      details: { blockers },
    });
  }

  if (snapshot.launchReview.publicSite.applicable) {
    await publishTenantPublicSiteDraft({
      tenantId,
      userId: actorUserId,
      revision: snapshot.launchReview.publicSite.draftRevision,
    });
  }

  const now = new Date();
  const hasPublishedOffer = snapshot.steps.some(
    (item) =>
      item.id === SETUP_STEP.BOOKABLE_OFFER &&
      item.status === SETUP_STEP_STATUS.COMPLETE,
  );
  await ensureState(tenantId);
  const transitioned = await SetupCenterStateModel.findOneAndUpdate(
    {
      tenant: tenantId,
      "publication.status": {
        $ne: SETUP_PUBLICATION_STATUS.LIVE,
      },
    },
    {
      $set: {
        definitionVersion: SETUP_CENTER_DEFINITION_VERSION,
        "publication.status": SETUP_PUBLICATION_STATUS.LIVE,
        "publication.publishedAt": now,
        "publication.publishedBy": actorUserId,
      },
      $min: {
        "analytics.firstSeenAt": now,
        ...(hasPublishedOffer
          ? { "analytics.firstPublishedOfferAt": now }
          : {}),
        "analytics.firstPublishedAt": now,
      },
      $unset: {
        "publication.unpublishedAt": 1,
        "publication.unpublishedBy": 1,
      },
    },
    { returnDocument: "after" },
  );
  if (transitioned) {
    await audit({
      tenantId,
      actorUserId,
      event: "studio_published",
      stepId: SETUP_STEP.PUBLISH,
    });
    await invalidatePublicTenantCache(tenantId);
  }
  return buildSetupCenterSnapshot({ tenantId, actorUserId });
};

export const unpublishStudio = async ({
  tenantId,
  actorUserId,
}: {
  tenantId: string;
  actorUserId: string;
}) => {
  const snapshot = await buildSetupCenterSnapshot({
    tenantId,
    actorUserId,
  });
  if (snapshot.publication.status === SETUP_PUBLICATION_STATUS.DRAFT) {
    return snapshot;
  }

  const now = new Date();
  const transitioned = await SetupCenterStateModel.findOneAndUpdate(
    {
      tenant: tenantId,
      "publication.status": SETUP_PUBLICATION_STATUS.LIVE,
    },
    {
      $set: {
        definitionVersion: SETUP_CENTER_DEFINITION_VERSION,
        "publication.status": SETUP_PUBLICATION_STATUS.DRAFT,
        "publication.unpublishedAt": now,
        "publication.unpublishedBy": actorUserId,
      },
      $unset: {
        "publication.publishedAt": 1,
        "publication.publishedBy": 1,
      },
    },
    { returnDocument: "after" },
  );
  if (transitioned) {
    await audit({
      tenantId,
      actorUserId,
      event: "studio_unpublished",
      stepId: SETUP_STEP.PUBLISH,
    });
    await invalidatePublicTenantCache(tenantId);
  }
  return buildSetupCenterSnapshot({ tenantId, actorUserId });
};

export const getSetupNavigationForStep = (stepId: SetupStepId) => {
  const entry = Object.entries(SETUP_ACTIONS).find(
    ([, value]) => value.stepId === stepId,
  );
  if (!entry) return null;
  return {
    key: entry[0] as SetupActionKey,
    href: entry[1].href,
  };
};

export const getSetupDiagnosticFallback = ({
  snapshot,
  stepId,
  locale,
}: {
  snapshot: Awaited<ReturnType<typeof buildSetupCenterSnapshot>>;
  stepId?: SetupStepId;
  locale: string;
}) => {
  const selected =
    snapshot.steps.find((item) => item.id === stepId) ??
    selectNextSetupStep(snapshot.steps);
  const missing = selected?.checks.filter((check) => !check.complete) ?? [];
  const navigation = selected?.actions.find((item) => item.enabled) ?? null;
  const czech = locale.toLowerCase().startsWith("cs");
  const reasonDescriptions: Record<string, { en: string; cs: string }> = {
    bootstrap_incomplete: {
      en: "the initial workspace profile has not been completed",
      cs: "úvodní profil pracovního prostoru ještě není dokončen",
    },
    studio_name_missing: {
      en: "the studio name is missing",
      cs: "chybí název studia",
    },
    business_type_missing: {
      en: "the studio business type is missing",
      cs: "chybí typ podnikání studia",
    },
    country_missing: {
      en: "the studio country is missing",
      cs: "chybí země studia",
    },
    currency_missing: {
      en: "the workspace currency is missing",
      cs: "chybí měna pracovního prostoru",
    },
    timezone_missing: {
      en: "the workspace timezone is missing",
      cs: "chybí časové pásmo pracovního prostoru",
    },
    active_location_missing: {
      en: "there is no active location",
      cs: "není vytvořena žádná aktivní provozovna",
    },
    location_booking_disabled: {
      en: "online booking is disabled for the location",
      cs: "u provozovny není povoleno online rezervování",
    },
    membership_missing: {
      en: "no membership plan has been published",
      cs: "není zveřejněn žádný členský plán",
    },
    inventory_item_missing: {
      en: "no active inventory item has been added",
      cs: "nebyla přidána žádná aktivní skladová položka",
    },
    stripe_not_connected: {
      en: "a Stripe account has not been connected",
      cs: "není připojen účet Stripe",
    },
    stripe_details_incomplete: {
      en: "Stripe still needs business or identity details",
      cs: "Stripe stále potřebuje doplnit firemní nebo identifikační údaje",
    },
    stripe_charges_disabled: {
      en: "Stripe has not enabled customer charges yet",
      cs: "Stripe zatím nepovolil přijímání plateb od zákazníků",
    },
    stripe_payouts_disabled: {
      en: "Stripe has not enabled payouts yet",
      cs: "Stripe zatím nepovolil výplaty",
    },
    stripe_requirements_due: {
      en: "Stripe has outstanding verification requirements",
      cs: "Stripe vyžaduje dokončit ověření",
    },
    bookable_activity_missing: {
      en: "there is no active bookable activity",
      cs: "není vytvořena žádná aktivní rezervovatelná aktivita",
    },
    capacity_missing: {
      en: "the activity has no valid capacity",
      cs: "aktivita nemá nastavenou platnou kapacitu",
    },
    price_missing: {
      en: "the activity has no valid price and currency",
      cs: "aktivita nemá nastavenou platnou cenu a měnu",
    },
    upcoming_schedule_missing: {
      en: "the activity has no upcoming date",
      cs: "aktivita nemá žádný budoucí termín",
    },
    bookable_location_missing: {
      en: "the activity is not connected to a bookable location",
      cs: "aktivita není propojena s provozovnou, kde lze rezervovat",
    },
    practice_run_incomplete: {
      en: "the safe practice booking has not been completed",
      cs: "bezpečná zkušební rezervace ještě nebyla dokončena",
    },
    configuration_changed_retest: {
      en: "the booking configuration changed after the last practice run",
      cs: "nastavení rezervací se od poslední zkoušky změnilo",
    },
    sender_email_not_verified: {
      en: "the managed sender is not ready for email delivery",
      cs: "spravovaný odesílatel ještě není připraven k doručování e-mailů",
    },
    team_member_missing: {
      en: "no teammate has been added",
      cs: "nebyl přidán žádný člen týmu",
    },
    required_setup_incomplete: {
      en: "one or more required workspace steps are incomplete",
      cs: "jeden nebo více povinných kroků pracovního prostoru není dokončen",
    },
    not_published: {
      en: "the studio is still in draft",
      cs: "studio je stále v režimu konceptu",
    },
  };

  if (!selected) {
    return {
      answer: czech
        ? "Základní nastavení je dokončeno. V Centru spuštění nyní najdete doporučené další kroky."
        : "Your launch setup is complete. The Launch Center now shows recommended next steps.",
      navigation: [],
    };
  }
  if (selected.complete) {
    return {
      answer: czech
        ? "Tento krok je dokončen. V Centru spuštění můžete pokračovat dalším nedokončeným krokem."
        : "This step is complete. Continue with the next incomplete item in Launch Center.",
      navigation: [],
    };
  }

  const reason = missing[0]?.reasonCode ?? selected.reasonCode;
  const reasonDescription =
    reasonDescriptions[reason]?.[czech ? "cs" : "en"] ??
    (czech ? "chybí část požadovaného nastavení" : "required setup is missing");
  return {
    answer: czech
      ? `Tento krok ještě není dokončen: ${reasonDescription}. Otevřete doporučenou obrazovku a doplňte chybějící nastavení.`
      : `This step is not complete yet: ${reasonDescription}. Open the recommended screen and finish the missing configuration.`,
    navigation: navigation
      ? [
          {
            stepId: selected.id,
            label: czech ? "Pokračovat v nastavení" : "Continue setup",
            href: navigation.href,
          },
        ]
      : [],
  };
};

export const setupCenterService = {
  get: buildSetupCenterSnapshot,
  recordEvent: recordSetupLaunchEvent,
  startPractice: startSetupPractice,
  applyPracticeAction: applySetupPracticeAction,
  abandonPractice: abandonSetupPractice,
  confirmPractice: confirmSetupPractice,
  clearPracticeConfirmation: clearSetupPracticeConfirmation,
  publish: publishStudio,
  unpublish: unpublishStudio,
};

export default setupCenterService;
