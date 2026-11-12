import "dotenv/config";

import mongoose, { Types } from "mongoose";

import connectDB from "@/infrastructure/database/connect-db.js";
import {
  normalizeStudioCommerceCurrency,
  toCurrencyMinorUnits,
} from "@/shared/money/currency.js";

const apply = process.argv.includes("--apply");
const allowUnmappedLegacyStripe = process.argv.includes(
  "--allow-unmapped-legacy-stripe",
);
const now = new Date();

type RawDocument = Record<string, any> & { _id: any };

type PreparedPlanMigration = {
  plan: RawDocument;
  version: RawDocument;
  published: boolean;
};

type PreparedMembershipMigration = {
  membership: RawDocument;
  version: RawDocument;
  isOpen: boolean;
  start: Date;
  end: Date;
  available: number;
};

type InvalidPlanPriceRecord = {
  planId: string;
  tenantId: string;
  currency: unknown;
  monthlyPrice: unknown;
  reasons: string[];
};

type InvalidSelectedLocationRecord = {
  planId: string;
  tenantId: string;
  locationId: string;
  reason:
    | "missing_location_id"
    | "invalid_location_id"
    | "location_not_found"
    | "location_tenant_mismatch";
};

type UnresolvedMembershipPlanRecord = {
  membershipId: string;
  tenantId: string;
  userId: string;
  planId: string;
  reason:
    | "plan_not_found"
    | "plan_version_not_found"
    | "plan_tenant_mismatch";
};

const id = (value: unknown): string => String(value ?? "");

const buildBenefits = (plan: RawDocument): any[] => {
  const benefits: any[] = [];
  if (Number(plan.monthlyCredits || 0) > 0) {
    benefits.push({
      key: "credits",
      label: "Credits",
      type: "allowance",
      unit: "credit",
      quantity: Math.max(0, Math.round(Number(plan.monthlyCredits))),
      expiresAfterDays: Math.max(
        1,
        Math.round(Number(plan.creditsExpireAfterDays || 31)),
      ),
      adjustable: true,
    });
  }
  if (Number(plan.displayedHours || 0) > 0) {
    benefits.push({
      key: "studio_minutes",
      label: "Studio time",
      type: "allowance",
      unit: "minute",
      quantity: Math.max(0, Math.round(Number(plan.displayedHours) * 60)),
      adjustable: true,
    });
  }
  if (Number(plan.bookingDiscountPercent || 0) > 0) {
    benefits.push({
      key: "booking_discount",
      label: "Booking discount",
      type: "percentage",
      percentageBps: Math.min(
        10_000,
        Math.round(Number(plan.bookingDiscountPercent) * 100),
      ),
      appliesTo: "bookings",
    });
  }
  if (Number(plan.priorityBookingDays || 0) > 0) {
    benefits.push({
      key: "priority_booking",
      label: "Priority booking",
      type: "limit",
      limit: Math.round(Number(plan.priorityBookingDays)),
      unit: "priority_days",
    });
  }
  if (Number(plan.maxActiveBookings || 0) > 0) {
    benefits.push({
      key: "max_active_bookings",
      label: "Maximum active bookings",
      type: "limit",
      limit: Math.round(Number(plan.maxActiveBookings)),
      unit: "active_bookings",
    });
  }
  return benefits;
};

const main = async () => {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB connection is unavailable.");

  const plans = db.collection("membershipplans");
  const versions = db.collection("membershipplanversions");
  const memberships = db.collection("usermemberships");
  const balances = db.collection("membershipentitlementbalances");
  const ledger = db.collection("membershipentitlementledgers");
  const locations = db.collection("locations");

  const unmappedLegacyStripe = await memberships
    .find({
      planSnapshot: { $exists: false },
      stripeSubscriptionId: { $type: "string", $gt: "" },
    })
    .project({ tenant: 1, user: 1, stripeSubscriptionId: 1 })
    .toArray();

  const report = {
    mode: apply ? "apply" : "dry-run",
    plans: 0,
    memberships: 0,
    openConflictsClosed: 0,
    legacyStripeIdsForReview: 0,
    legacyStripeRecords: unmappedLegacyStripe.map((item) => ({
      membershipId: id(item._id),
      tenantId: id(item.tenant),
      userId: id(item.user),
      stripeSubscriptionId: item.stripeSubscriptionId,
    })),
    openConflictRecords: [] as Array<{
      membershipId: string;
      tenantId: string;
      userId: string;
      keptMembershipId: string;
    }>,
    ledgerBalances: 0,
    invalidPlanPrices: [] as InvalidPlanPriceRecord[],
    invalidSelectedLocationScopes: [] as InvalidSelectedLocationRecord[],
    unresolvedMembershipPlans: [] as UnresolvedMembershipPlanRecord[],
    preflightBlockers: 0,
  };
  report.legacyStripeIdsForReview = report.legacyStripeRecords.length;

  // Phase 1: build the exact plan versions and pointers that apply will write.
  // Keeping these synthetic records in memory lets dry-run resolve legacy
  // memberships exactly as apply does without mutating the database.
  const preparedPlans: PreparedPlanMigration[] = [];
  const preparedPlanById = new Map<string, PreparedPlanMigration>();
  const legacyPlans = await plans
    .find({ currentPublishedVersion: { $exists: false } })
    .toArray();

  for (const plan of legacyPlans) {
    report.plans += 1;

    const priceReasons: string[] = [];
    let currency: string = id(plan.currency).trim().toUpperCase();
    let amountMinor = 0;
    try {
      currency = normalizeStudioCommerceCurrency(plan.currency);
    } catch (error) {
      priceReasons.push(
        error instanceof Error
          ? error.message
          : "Unsupported membership currency.",
      );
    }

    if (priceReasons.length === 0) {
      try {
        amountMinor = toCurrencyMinorUnits(
          Number(plan.monthlyPrice),
          currency as any,
        );
        if (amountMinor <= 0) {
          priceReasons.push(
            "Membership price must be greater than zero minor units.",
          );
        }
      } catch (error) {
        priceReasons.push(
          error instanceof Error ? error.message : "Invalid membership price.",
        );
      }
    } else {
      const numericPrice = Number(plan.monthlyPrice);
      if (!Number.isFinite(numericPrice) || numericPrice < 0) {
        priceReasons.push(`Invalid money amount: ${String(plan.monthlyPrice)}`);
      } else if (numericPrice === 0) {
        priceReasons.push(
          "Membership price must be greater than zero minor units.",
        );
      }
    }

    if (priceReasons.length > 0) {
      report.invalidPlanPrices.push({
        planId: id(plan._id),
        tenantId: id(plan.tenant),
        currency: plan.currency ?? null,
        monthlyPrice: plan.monthlyPrice ?? null,
        reasons: priceReasons,
      });
    }

    const selected = plan.appliesToAllLocations === false;
    const rawLocationId = plan.location;
    let selectedLocationId: Types.ObjectId | null = null;
    if (selected) {
      if (
        rawLocationId === null ||
        rawLocationId === undefined ||
        id(rawLocationId) === ""
      ) {
        report.invalidSelectedLocationScopes.push({
          planId: id(plan._id),
          tenantId: id(plan.tenant),
          locationId: "",
          reason: "missing_location_id",
        });
      } else if (!Types.ObjectId.isValid(rawLocationId)) {
        report.invalidSelectedLocationScopes.push({
          planId: id(plan._id),
          tenantId: id(plan.tenant),
          locationId: id(rawLocationId),
          reason: "invalid_location_id",
        });
      } else {
        selectedLocationId = new Types.ObjectId(id(rawLocationId));
        const location = await locations.findOne(
          { _id: selectedLocationId },
          { projection: { tenant: 1 } },
        );
        if (!location) {
          report.invalidSelectedLocationScopes.push({
            planId: id(plan._id),
            tenantId: id(plan.tenant),
            locationId: id(rawLocationId),
            reason: "location_not_found",
          });
        } else if (id(location.tenant) !== id(plan.tenant)) {
          report.invalidSelectedLocationScopes.push({
            planId: id(plan._id),
            tenantId: id(plan.tenant),
            locationId: id(rawLocationId),
            reason: "location_tenant_mismatch",
          });
        }
      }
    }

    const existingVersion = await versions.findOne({
      tenant: plan.tenant,
      plan: plan._id,
      version: 1,
    });
    const versionId = existingVersion?._id ?? new Types.ObjectId();
    const published = plan.isActive !== false;
    const candidateVersion: RawDocument = {
      _id: versionId,
      tenant: plan.tenant,
      plan: plan._id,
      version: 1,
      status: published ? "published" : "draft",
      name: String(plan.name || "Membership").trim(),
      description: String(plan.description || "").trim(),
      terms: "",
      prices: [{ currency, amountMinor }],
      billing: { type: "recurring", interval: "month", intervalCount: 1 },
      locationScope: selected
        ? {
            type: "selected",
            locationIds: selectedLocationId ? [selectedLocationId] : [],
          }
        : { type: "all", locationIds: [] },
      benefits: buildBenefits(plan),
      createdAt: plan.createdAt || now,
      updatedAt: now,
      publishedAt: published ? plan.createdAt || now : null,
    };
    const prepared = {
      plan,
      version: (existingVersion as RawDocument | null) ?? candidateVersion,
      published,
    };
    preparedPlans.push(prepared);
    preparedPlanById.set(id(plan._id), prepared);
  }

  const persistedPlanCache = new Map<string, RawDocument | null>();
  const persistedVersionCache = new Map<string, RawDocument | null>();
  const resolvePlanVersion = async (
    planId: unknown,
  ): Promise<{ plan: RawDocument | null; version: RawDocument | null }> => {
    const key = id(planId);
    const prepared = preparedPlanById.get(key);
    if (prepared) return { plan: prepared.plan, version: prepared.version };

    if (!persistedPlanCache.has(key)) {
      const objectId = Types.ObjectId.isValid(key)
        ? new Types.ObjectId(key)
        : planId;
      persistedPlanCache.set(
        key,
        (await plans.findOne({ _id: objectId as any })) as RawDocument | null,
      );
    }
    const plan = persistedPlanCache.get(key) ?? null;
    const versionId = plan?.currentPublishedVersion || plan?.currentDraftVersion;
    if (!versionId) return { plan, version: null };

    const versionKey = id(versionId);
    if (!persistedVersionCache.has(versionKey)) {
      persistedVersionCache.set(
        versionKey,
        (await versions.findOne({ _id: versionId })) as RawDocument | null,
      );
    }
    return { plan, version: persistedVersionCache.get(versionKey) ?? null };
  };

  // Phase 2: simulate every membership mutation. The report counters and
  // conflict choices below are the same prepared operations used by apply.
  const openByUser = new Set<string>();
  const keptOpenMembershipByUser = new Map<string, string>();
  for await (const existing of memberships
    .find({ planSnapshot: { $exists: true }, isOpen: true })
    .sort({ createdAt: -1, _id: -1 })
    .project({ tenant: 1, user: 1 })) {
    const key = `${existing.tenant}:${existing.user}`;
    if (openByUser.has(key)) continue;
    openByUser.add(key);
    keptOpenMembershipByUser.set(key, id(existing._id));
  }

  const preparedMemberships: PreparedMembershipMigration[] = [];
  const legacyMemberships = await memberships
    .find({ planSnapshot: { $exists: false } })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();

  for (const membership of legacyMemberships) {
    report.memberships += 1;
    const resolved = await resolvePlanVersion(membership.plan);
    let unresolvedReason: UnresolvedMembershipPlanRecord["reason"] | null = null;
    if (!resolved.plan) unresolvedReason = "plan_not_found";
    else if (id(resolved.plan.tenant) !== id(membership.tenant)) {
      unresolvedReason = "plan_tenant_mismatch";
    } else if (!resolved.version) unresolvedReason = "plan_version_not_found";

    if (unresolvedReason || !resolved.version) {
      report.unresolvedMembershipPlans.push({
        membershipId: id(membership._id),
        tenantId: id(membership.tenant),
        userId: id(membership.user),
        planId: id(membership.plan),
        reason: unresolvedReason ?? "plan_version_not_found",
      });
      continue;
    }

    const key = `${membership.tenant}:${membership.user}`;
    const legacyOpen = ["active", "paused"].includes(membership.status);
    const isOpen = legacyOpen && !openByUser.has(key);
    if (isOpen) {
      openByUser.add(key);
      keptOpenMembershipByUser.set(key, id(membership._id));
    } else if (legacyOpen) {
      report.openConflictsClosed += 1;
      report.openConflictRecords.push({
        membershipId: id(membership._id),
        tenantId: id(membership.tenant),
        userId: id(membership.user),
        keptMembershipId: keptOpenMembershipByUser.get(key) ?? "",
      });
    }

    const start = membership.startedAt || membership.createdAt || now;
    const end =
      membership.renewsAt ||
      new Date(new Date(start).getTime() + 31 * 86_400_000);
    const available = Math.max(
      0,
      Math.round(
        Number(membership.currentPeriodCreditsGranted || 0) -
          Number(membership.currentPeriodCreditsUsed || 0),
      ),
    );
    if (available > 0) report.ledgerBalances += 1;
    preparedMemberships.push({
      membership: membership as RawDocument,
      version: resolved.version,
      isOpen,
      start,
      end,
      available,
    });
  }

  report.preflightBlockers =
    report.invalidPlanPrices.length +
    report.invalidSelectedLocationScopes.length +
    report.unresolvedMembershipPlans.length;

  const printReport = () => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  };

  if (!apply) {
    printReport();
    return;
  }

  // Refuse all known blockers before the first database write. The legacy
  // Stripe acknowledgement is separate because it is an explicit quarantine,
  // while invalid V1 snapshots can never be acknowledged into the new schema.
  if (report.preflightBlockers > 0) {
    printReport();
    throw new Error(
      "Refusing to apply: membership V1 preflight found invalid plan prices, " +
        "location scopes, or unresolved membership plan versions.",
    );
  }
  if (report.legacyStripeIdsForReview > 0 && !allowUnmappedLegacyStripe) {
    printReport();
    throw new Error(
      "Refusing to apply: unmapped legacy Stripe subscription IDs require review. " +
        "Cancel/migrate them using the runbook, or rerun with the explicit " +
        "--allow-unmapped-legacy-stripe acknowledgement.",
    );
  }

  // Phase 3: apply exactly the records prepared and counted above.
  for (const { plan, version, published } of preparedPlans) {
    await versions.updateOne(
      { _id: version._id },
      { $setOnInsert: version },
      { upsert: true },
    );
    await plans.updateOne(
      { _id: plan._id, currentPublishedVersion: { $exists: false } },
      {
        $set: {
          status: published ? "published" : "archived",
          versionCounter: 1,
          currentPublishedVersion: published ? version._id : null,
          currentDraftVersion: published ? null : version._id,
          sortOrder: Number(plan.sortOrder || 0),
          publishedAt: published ? plan.createdAt || now : null,
          archivedAt: published ? null : now,
          updatedAt: now,
        },
      },
    );
  }

  for (const prepared of preparedMemberships) {
    const { membership, version, isOpen, start, end, available } = prepared;
    const price = version.prices[0];
    await memberships.updateOne(
      { _id: membership._id, planSnapshot: { $exists: false } },
      {
        $set: {
          planVersion: version._id,
          planSnapshot: {
            version: version.version,
            name: version.name,
            description: version.description,
            terms: version.terms || "",
            prices: version.prices,
            billing: version.billing,
            locationScope: version.locationScope,
            benefits: version.benefits,
          },
          selectedLocation:
            version.locationScope.type === "selected"
              ? version.locationScope.locationIds[0]
              : null,
          currency: price.currency,
          amountMinor: price.amountMinor,
          status: isOpen
            ? membership.status
            : ["active", "paused"].includes(membership.status)
              ? "expired"
              : membership.status,
          isOpen,
          currentPeriodStart: start,
          currentPeriodEnd: end,
          renewsAt: end,
          assignmentSource: "migration",
          assignmentReason: "migration",
          legacyStripeSubscriptionIdForReview:
            membership.stripeSubscriptionId || "",
          updatedAt: now,
        },
      },
    );

    if (available <= 0) continue;
    const balanceId = new Types.ObjectId();
    await balances.updateOne(
      { membership: membership._id, benefitKey: "credits" },
      {
        $setOnInsert: {
          _id: balanceId,
          tenant: membership.tenant,
          user: membership.user,
          membership: membership._id,
          benefitKey: "credits",
          unit: "credit",
          currency: "",
          granted: available,
          redeemed: 0,
          adjusted: 0,
          expired: 0,
          available,
          sequence: 1,
          expiresAt: membership.currentPeriodCreditsExpireAt || end,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    await ledger.updateOne(
      {
        membership: membership._id,
        idempotencyKey: "migration:legacy-credit-balance",
      },
      {
        $setOnInsert: {
          tenant: membership.tenant,
          user: membership.user,
          membership: membership._id,
          benefitKey: "credits",
          type: "grant",
          amount: available,
          balanceAfter: available,
          sequence: 1,
          reason: "migration",
          note: "Migrated legacy membership credit balance.",
          actor: null,
          reference: { type: "migration", id: "membership-v1" },
          relatedEntry: null,
          idempotencyKey: "migration:legacy-credit-balance",
          identityHash: "legacy-membership-v1-migration",
          expiresAt: membership.currentPeriodCreditsExpireAt || end,
          createdAt: now,
        },
      },
      { upsert: true },
    );
  }

  const indexes = await plans.indexes();
  const legacyNameIndex = indexes.find(
    (index) => index.unique && index.key?.tenant === 1 && index.key?.name === 1,
  );
  if (legacyNameIndex?.name) await plans.dropIndex(legacyNameIndex.name);

  printReport();
};

main()
  .then(() => mongoose.disconnect())
  .catch(async (error) => {
    console.error(error);
    await mongoose.disconnect();
    process.exitCode = 1;
  });
