import { logger } from "@/config/logger.js";
import { CommunicationKnowledgeArticleModel } from "@/modules/communications/communications.models.js";
import MembershipPlanModel from "@/modules/membership/membership-plan.model.js";
import MembershipPlanVersionModel from "@/modules/membership/membership-plan-version.model.js";
import {
  MEMBERSHIP_PLAN_STATUS,
  MEMBERSHIP_PLAN_VERSION_STATUS,
} from "@/modules/membership/membership.constants.js";
import ProductModel from "@/modules/product/product.model.js";
import {
  LEGACY_BOOKING_PRODUCT_TYPE,
  PRODUCT_TYPE,
  PUBLIC_COURSE_PRODUCT_TYPES,
} from "@/modules/product/product.constants.js";
import { TENANT_PAYMENT_ONBOARDING_STATUS } from "@/modules/tenant-payments/tenant-payment-account.constants.js";
import { findTenantPaymentAccountByTenant } from "@/modules/tenant-payments/tenant-payment-account.repository.js";
import { getTenantSubscriptionAccess } from "@/modules/tenant-subscription/services/tenant-subscription.service.js";

import { TENANT_MODULE } from "../tenant.constants.js";
import type { TenantDocument } from "../tenant.types.js";
import {
  isCourseBrowsingVisible,
  isGuestCourseCheckoutEnabled,
} from "./tenant-course-visibility.js";
import type { TenantPublicSiteSnapshot } from "./tenant-public-site.serializers.js";

export type PublicTenantCapabilities = {
  bookStudio: boolean;
  courses: boolean;
  memberships: boolean;
  vouchers: boolean;
  help: boolean;
  guestCourseCheckout: boolean;
  registration: boolean;
};

const PUBLIC_BOOKING_PRODUCT_TYPES = [
  PRODUCT_TYPE.WORKSHOP,
  PRODUCT_TYPE.SERVICE,
  LEGACY_BOOKING_PRODUCT_TYPE.PUBLIC_WORKSHOP,
] as const;

const fulfilledWithValue = (result: PromiseSettledResult<unknown>): boolean =>
  result.status === "fulfilled" && Boolean(result.value);

const warnRejectedCapability = (
  tenantId: unknown,
  capability: string,
  result: PromiseSettledResult<unknown>,
) => {
  if (result.status !== "rejected") return;
  logger.warn(
    {
      tenantId: String(tenantId),
      capability,
      err: result.reason,
    },
    "Public tenant capability lookup failed; capability hidden.",
  );
};

const hasPublishedMembership = async (
  tenantId: TenantDocument["_id"],
): Promise<boolean> => {
  const plans = await MembershipPlanModel.find({
    tenant: tenantId,
    status: MEMBERSHIP_PLAN_STATUS.PUBLISHED,
    currentPublishedVersion: { $ne: null },
  })
    .select("_id currentPublishedVersion")
    .lean()
    .exec();

  if (plans.length === 0) return false;

  return Boolean(
    await MembershipPlanVersionModel.exists({
      tenant: tenantId,
      status: MEMBERSHIP_PLAN_VERSION_STATUS.PUBLISHED,
      $or: plans.map((plan: any) => ({
        _id: plan.currentPublishedVersion,
        plan: plan._id,
      })),
    }),
  );
};

const hasCheckoutReadyPaymentSnapshot = async (
  tenantId: TenantDocument["_id"],
): Promise<boolean> => {
  const account = await findTenantPaymentAccountByTenant(String(tenantId));

  return Boolean(
    account?.stripeAccountId &&
    account.onboardingStatus === TENANT_PAYMENT_ONBOARDING_STATUS.COMPLETE &&
    account.detailsSubmitted &&
    account.chargesEnabled &&
    account.payoutsEnabled,
  );
};

/**
 * Public capabilities are deny-by-default. Module flags are used only on the
 * server and are never included in the response. A failed content lookup
 * hides that capability without widening the public surface.
 */
export const derivePublicTenantCapabilities = async (
  tenant: TenantDocument,
  now = new Date(),
  options: { snapshot?: TenantPublicSiteSnapshot } = {},
): Promise<PublicTenantCapabilities> => {
  const tenantId = tenant._id;
  const modules = tenant.modules;
  const guestCourseCheckoutEnabled = isGuestCourseCheckoutEnabled(
    tenant,
    options,
  );
  const bookableTypes = modules?.[TENANT_MODULE.BOOKINGS]
    ? PUBLIC_BOOKING_PRODUCT_TYPES
    : [];

  const [
    subscriptionResult,
    bookableResult,
    courseResult,
    membershipResult,
    voucherResult,
    checkoutPaymentResult,
    helpResult,
  ] = await Promise.allSettled([
    getTenantSubscriptionAccess(String(tenantId)),
    bookableTypes.length > 0 && modules?.[TENANT_MODULE.PAYMENTS]
      ? ProductModel.exists({
          tenant: tenantId,
          isActive: true,
          maxNumberOfParticipants: { $ne: null },
          type: { $in: bookableTypes },
        })
      : Promise.resolve(null),
    modules?.[TENANT_MODULE.COURSES] &&
    modules?.[TENANT_MODULE.PAYMENTS] &&
    isCourseBrowsingVisible(tenant, options)
      ? ProductModel.exists({
          tenant: tenantId,
          isActive: true,
          isArchived: { $ne: true },
          maxNumberOfParticipants: { $ne: null },
          type: { $in: PUBLIC_COURSE_PRODUCT_TYPES },
        })
      : Promise.resolve(null),
    modules?.[TENANT_MODULE.MEMBERSHIPS] && modules?.[TENANT_MODULE.PAYMENTS]
      ? hasPublishedMembership(tenantId)
      : Promise.resolve(null),
    modules?.[TENANT_MODULE.VOUCHERS] && modules?.[TENANT_MODULE.PAYMENTS]
      ? ProductModel.exists({
          tenant: tenantId,
          type: PRODUCT_TYPE.COUPON,
          isActive: true,
          "voucherSettings.type": { $ne: "experience" },
          // Designs are validated before product writes. Only the boolean
          // existence result crosses the public capability boundary.
          $or: [
            {
              voucherTemplate: {
                $exists: true,
                $type: "string",
                $regex: /\S/,
              },
            },
            {
              "voucherDesign.version": 1,
              "voucherDesign.layout": "split",
            },
          ],
          price: { $gt: 0 },
        })
      : Promise.resolve(null),
    modules?.[TENANT_MODULE.PAYMENTS] &&
    (modules?.[TENANT_MODULE.VOUCHERS] ||
      (modules?.[TENANT_MODULE.COURSES] && guestCourseCheckoutEnabled))
      ? hasCheckoutReadyPaymentSnapshot(tenantId)
      : Promise.resolve(null),
    CommunicationKnowledgeArticleModel.exists({
      tenantId,
      audience: "public",
      status: "published",
      deletedAt: null,
      $and: [
        {
          $or: [
            { effectiveFrom: null },
            { effectiveFrom: { $exists: false } },
            { effectiveFrom: { $lte: now } },
          ],
        },
        {
          $or: [
            { effectiveUntil: null },
            { effectiveUntil: { $exists: false } },
            { effectiveUntil: { $gt: now } },
          ],
        },
      ],
    }),
  ]);

  [
    ["subscription", subscriptionResult],
    ["bookStudio", bookableResult],
    ["courses", courseResult],
    ["memberships", membershipResult],
    ["vouchers", voucherResult],
    ["checkoutPayments", checkoutPaymentResult],
    ["help", helpResult],
  ].forEach(([capability, result]) =>
    warnRejectedCapability(
      tenantId,
      String(capability),
      result as PromiseSettledResult<unknown>,
    ),
  );

  const subscriptionUsable =
    subscriptionResult.status === "fulfilled" &&
    subscriptionResult.value?.access?.canUseFeatures === true;
  const bookStudio = subscriptionUsable && fulfilledWithValue(bookableResult);
  const courses = subscriptionUsable && fulfilledWithValue(courseResult);
  const memberships =
    subscriptionUsable && fulfilledWithValue(membershipResult);
  const vouchers =
    subscriptionUsable &&
    fulfilledWithValue(voucherResult) &&
    fulfilledWithValue(checkoutPaymentResult);
  const help = fulfilledWithValue(helpResult);

  return {
    bookStudio,
    courses,
    memberships,
    vouchers,
    help,
    guestCourseCheckout:
      courses &&
      guestCourseCheckoutEnabled &&
      fulfilledWithValue(checkoutPaymentResult),
    registration: true,
  };
};
