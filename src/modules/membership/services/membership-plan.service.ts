import mongoose from "mongoose";
import ProductModel from "@/modules/product/product.model.js";
import { COURSE_PRODUCT_TYPES } from "@/modules/product/product.constants.js";

import {
  assertCanAccessAllWorkspaceLocations,
  assertLocationIdsWithinWorkspaceScope,
  assertTenantLocationsWithinWorkspaceScope,
  type AllowedWorkspaceLocationIds,
} from "@/modules/tenant-access/index.js";
import { findTenantById, findTenantBySlug } from "@/modules/tenants/tenant.repository.js";
import type { TenantDocument } from "@/modules/tenants/tenant.types.js";
import { TENANT_MODULE, TENANT_STATUS } from "@/modules/tenants/tenant.constants.js";
import { resolveTenantLocaleSettings } from "@/modules/tenants/tenant-locale.js";
import { badRequest, conflict, forbidden, notFound } from "@/shared/http/httpErrors.js";
import MembershipPlanModel from "../membership-plan.model.js";
import MembershipPlanVersionModel from "../membership-plan-version.model.js";
import { membershipRepository } from "../membership.repository.js";
import { recordMembershipAudit } from "../membership-audit-event.schema.js";
import { MEMBERSHIP_PLAN_STATUS, MEMBERSHIP_PLAN_VERSION_STATUS } from "../membership.constants.js";
import { serializePlan } from "../membership.serializers.js";
import type {
  CreateMembershipPlanInput,
  ListMembershipPlansInput,
  UpdateMembershipPlanInput,
} from "../membership.validators.js";
import { toObjectId } from "../membership.utils.js";
import { membershipVersionConfigSchema } from "../membership.validators.js";
import { assertMembershipTranslationLanguages, plainMembershipTranslations } from "../membership.localization.js";

const versionLocationIds = (version: any): string[] =>
  (version?.locationScope?.locationIds ?? []).map(String);

const assertVersionScope = async (
  tenantId: string,
  version: { locationScope?: { type?: string; locationIds?: unknown[] } },
  allowedLocationIds: AllowedWorkspaceLocationIds,
): Promise<void> => {
  if (version.locationScope?.type === "all") {
    assertCanAccessAllWorkspaceLocations(allowedLocationIds);
    return;
  }
  const ids = versionLocationIds(version);
  await assertTenantLocationsWithinWorkspaceScope({
    tenantId,
    locationIds: ids,
    allowedLocationIds,
  });
};

const isVersionVisibleInScope = (
  version: any,
  allowedLocationIds: AllowedWorkspaceLocationIds,
): boolean => {
  if (!version) return false;
  if (allowedLocationIds === null) return true;
  if (version.locationScope?.type === "all") return false;
  const allowed = new Set(allowedLocationIds.map(String));
  return versionLocationIds(version).every((locationId) => allowed.has(locationId));
};

const versionMatchesLocation = (version: any, locationId?: string): boolean => {
  if (!version) return false;
  if (!locationId || version.locationScope?.type === "all") return true;
  return versionLocationIds(version).includes(locationId);
};

const snapshotInput = (input: any) => ({
  name: input.name,
  description: input.description ?? "",
  terms: input.terms ?? "",
  sourceLanguage: input.sourceLanguage,
  translations: input.translations,
  prices: input.prices,
  billing: input.billing,
  locationScope: {
    type: input.locationScope.type,
    locationIds: input.locationScope.locationIds.map(toObjectId),
  },
  benefits: input.benefits ?? [],
});

// Validate the complete resulting draft, including partial edits and publication.
// A billing-only edit must not bypass the monthly rollover contract.
export const validatedMembershipVersion = (version: any) => membershipVersionConfigSchema.parse({
  name: version.name,
  description: version.description ?? "",
  terms: version.terms ?? "",
  sourceLanguage: version.sourceLanguage,
  translations: version.translations ? plainMembershipTranslations(version.translations) : undefined,
  prices: version.prices.map((price: any) => ({ currency: price.currency, amountMinor: price.amountMinor })),
  billing: version.billing.type === "fixed"
    ? { type: "fixed", durationDays: version.billing.durationDays }
    : { type: "recurring", interval: version.billing.interval, intervalCount: version.billing.intervalCount },
  locationScope: { type: version.locationScope.type, locationIds: versionLocationIds(version) },
  benefits: version.benefits.map((benefit: any) => ({
    ...(benefit.toObject?.() ?? benefit),
    ...(benefit.translations ? { translations: plainMembershipTranslations(benefit.translations) } : {}),
  })),
});

const assertTranslationSettings = async (tenantId: string, config: any, previous?: any) => {
  if (!config.sourceLanguage && !Object.keys(config.translations ?? {}).length &&
      !(config.benefits ?? []).some((benefit: any) => Object.keys(benefit.translations ?? {}).length)) return;
  const tenant = await findTenantById(tenantId);
  if (!tenant) notFound("Workspace not found.");
  assertMembershipTranslationLanguages(tenant, config, previous);
};

export const assertMembershipPrimaryPrice = (tenant: any, version: any): void => {
  if (!(version.prices ?? []).some((price: any) => price.currency === tenant.settings.currency)) {
    conflict({ message: "Add a price in the studio's primary currency before publishing this membership.", code: "MEMBERSHIP_PRIMARY_CURRENCY_PRICE_REQUIRED" });
  }
};

const assertSelectedCourses = async (tenantId: string, version: any) => {
  const ids = [...new Set<string>(version.benefits.flatMap((benefit: any) => benefit.eligibleProductIds ?? []))];
  if (!ids.length) return;
  const count = await ProductModel.countDocuments({
    _id: { $in: ids.map(toObjectId) },
    tenant: toObjectId(tenantId),
    type: { $in: COURSE_PRODUCT_TYPES },
  });
  if (count !== ids.length) badRequest({
    message: "Member discounts can only reference this workspace's courses.",
    code: "MEMBERSHIP_COURSE_SELECTION_INVALID",
  });
};

const populated = (plan: any) => plan.populate([
  { path: "currentPublishedVersion", ordered: true },
  { path: "currentDraftVersion", ordered: true },
]);

const sourceVersion = (plan: any): any =>
  plan.currentDraftVersion?._id ? plan.currentDraftVersion : plan.currentPublishedVersion;

const publishedCatalog = async (tenant: TenantDocument, locationId?: string) => {
  if (tenant.status !== TENANT_STATUS.ACTIVE) notFound("Workspace not found.");
  if (!tenant.modules?.[TENANT_MODULE.MEMBERSHIPS]) forbidden({ message: "Memberships are not available for this workspace.", code: "MEMBERSHIPS_MODULE_DISABLED" });

  if (locationId) {
    const LocationModel = mongoose.model("Location");
    const exists = await LocationModel.exists({ _id: toObjectId(locationId), tenant: tenant._id });
    if (!exists) notFound("Location not found.");
  }

  // Both public and authenticated catalogs use the stable published pointer,
  // never the latest version or the workspace owner's draft projection.
  const plans = await MembershipPlanModel.find({
    tenant: tenant._id,
    status: MEMBERSHIP_PLAN_STATUS.PUBLISHED,
    currentPublishedVersion: { $ne: null },
  })
    .populate({ path: "currentPublishedVersion", match: { status: MEMBERSHIP_PLAN_VERSION_STATUS.PUBLISHED } })
    .sort({ sortOrder: 1, createdAt: 1 })
    .exec();
  const visible = plans.filter((plan: any) =>
    plan.currentPublishedVersion && versionMatchesLocation(plan.currentPublishedVersion, locationId),
  );
  const referencedLocationIds = [...new Set(
    visible.flatMap((plan: any) => versionLocationIds(plan.currentPublishedVersion)),
  )];
  const LocationModel = mongoose.model("Location");
  const locationDocs = referencedLocationIds.length
    ? await LocationModel.find({
        _id: { $in: referencedLocationIds.map(toObjectId) },
        tenant: tenant._id,
        isActive: true,
      }).select("name").lean().exec()
    : [];
  const locations = locationDocs.map((item: any) => ({ id: String(item._id), name: item.name }));
  const locationsById = new Map(locations.map((item) => [item.id, item]));
  const serializedPlans = visible.map((plan: any) => {
    const serialized: any = serializePlan(plan);
    if (serialized.publishedVersion?.locationScope) {
      serialized.publishedVersion.locationScope.locations =
        serialized.publishedVersion.locationScope.locationIds
          .map((id: string) => locationsById.get(id))
          .filter(Boolean);
    }
    return serialized;
  });
  return {
    tenant: {
      id: String(tenant._id),
      slug: tenant.slug,
      name: tenant.name,
      currency: tenant.settings.currency,
      primaryLanguage: resolveTenantLocaleSettings(tenant.settings).publicDefaultLanguage,
      supportedLanguages: resolveTenantLocaleSettings(tenant.settings).supportedPublicLanguages,
    },
    locations,
    plans: serializedPlans,
  };
};

export const membershipPlanService = {
  async list(
    tenantId: string,
    input: ListMembershipPlansInput,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const filters = {
      tenantId,
      locationId: input.locationId,
      allowedLocationIds,
      includeInactive: input.includeInactive,
      status: input.status,
      page: input.page,
      limit: input.limit,
    };
    const { plans, total } = await membershipRepository.listPlansWithScope(filters);
    return {
      plans: plans.map((plan: any) => serializePlan(plan, { owner: true })),
      total,
      page: input.page,
      pages: Math.ceil(total / input.limit),
    };
  },

  async get(
    tenantId: string,
    planId: string,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const plan = await membershipRepository.findPlanByIdForTenant(tenantId, planId);
    if (!plan) notFound("Membership plan not found.");
    const version = sourceVersion(plan);
    if (!isVersionVisibleInScope(version, allowedLocationIds)) notFound("Membership plan not found.");
    return serializePlan(plan, { owner: true });
  },

  async create(
    tenantId: string,
    input: CreateMembershipPlanInput,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
    actorId?: string,
    translationSource?: any,
  ) {
    const tenant = await findTenantById(tenantId);
    if (!tenant) notFound("Workspace not found.");
    const validated = validatedMembershipVersion({
      ...input,
      sourceLanguage: input.sourceLanguage ?? resolveTenantLocaleSettings(tenant.settings).publicDefaultLanguage,
    });
    assertMembershipTranslationLanguages(tenant, validated, translationSource);
    await assertVersionScope(tenantId, validated, allowedLocationIds);
    await assertSelectedCourses(tenantId, validated);
    const session = await mongoose.startSession();
    try {
      let result: any;
      await session.withTransaction(async () => {
        const [plan] = await MembershipPlanModel.create([{
          tenant: toObjectId(tenantId),
          status: MEMBERSHIP_PLAN_STATUS.DRAFT,
          versionCounter: 1,
          sortOrder: input.sortOrder,
          createdBy: actorId ? toObjectId(actorId) : null,
          updatedBy: actorId ? toObjectId(actorId) : null,
        }], { session });
        const [version] = await MembershipPlanVersionModel.create([{
          tenant: toObjectId(tenantId),
          plan: plan._id,
          version: 1,
          status: MEMBERSHIP_PLAN_VERSION_STATUS.DRAFT,
          ...snapshotInput(validated),
          createdBy: actorId ? toObjectId(actorId) : null,
        }], { session });
        plan.currentDraftVersion = version._id;
        await plan.save({ session });
        await recordMembershipAudit({ tenantId, actorId, planId: String(plan._id), type: "membership.plan.created", source: "owner", session });
        result = await populated(plan);
      });
      return serializePlan(result, { owner: true });
    } finally {
      await session.endSession();
    }
  },

  async update(
    tenantId: string,
    input: UpdateMembershipPlanInput,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
    actorId?: string,
  ) {
    const session = await mongoose.startSession();
    try {
      let result: any;
      await session.withTransaction(async () => {
        const plan = await MembershipPlanModel.findOne({ _id: toObjectId(input.id), tenant: toObjectId(tenantId) })
          .populate({ path: "currentPublishedVersion", ordered: true })
          .populate({ path: "currentDraftVersion", ordered: true })
          .session(session)
          .exec();
        if (!plan || plan.status === MEMBERSHIP_PLAN_STATUS.ARCHIVED) notFound("Membership plan not found.");
        const existingSource: any = sourceVersion(plan);
        await assertVersionScope(tenantId, existingSource, allowedLocationIds);
        const merged = {
          name: input.name ?? existingSource.name,
          description: input.description ?? existingSource.description,
          terms: input.terms ?? existingSource.terms,
          sourceLanguage: input.sourceLanguage ?? existingSource.sourceLanguage,
          translations: input.translations ?? (existingSource.translations ? plainMembershipTranslations(existingSource.translations) : undefined),
          prices: input.prices ?? existingSource.prices.map((price: any) => price.toObject?.() ?? price),
          billing: input.billing ?? (existingSource.billing.toObject?.() ?? existingSource.billing),
          locationScope: input.locationScope ?? {
            type: existingSource.locationScope.type,
            locationIds: versionLocationIds(existingSource),
          },
          benefits: input.benefits ?? existingSource.benefits.map((benefit: any) => benefit.toObject?.() ?? benefit),
        };
        await assertVersionScope(tenantId, merged as any, allowedLocationIds);
        const validated = validatedMembershipVersion(merged);
        await assertTranslationSettings(tenantId, validated, existingSource);
        await assertSelectedCourses(tenantId, validated);

        let draft: any = plan.currentDraftVersion?._id ? plan.currentDraftVersion : null;
        if (!draft) {
          plan.versionCounter += 1;
          [draft] = await MembershipPlanVersionModel.create([{
            tenant: toObjectId(tenantId),
            plan: plan._id,
            version: plan.versionCounter,
            status: MEMBERSHIP_PLAN_VERSION_STATUS.DRAFT,
            ...snapshotInput(validated),
            createdBy: actorId ? toObjectId(actorId) : null,
          }], { session });
          plan.currentDraftVersion = draft._id;
        } else {
          Object.assign(draft, snapshotInput(validated));
          await draft.save({ session });
        }
        if (input.sortOrder !== undefined) plan.sortOrder = input.sortOrder;
        plan.updatedBy = actorId ? toObjectId(actorId) : null;
        await plan.save({ session });
        await recordMembershipAudit({ tenantId, actorId, planId: String(plan._id), type: "membership.plan.draft_updated", source: "owner", metadata: { version: draft.version }, session });
        result = await populated(plan);
      });
      return serializePlan(result, { owner: true });
    } finally {
      await session.endSession();
    }
  },

  async publish(
    tenantId: string,
    planId: string,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
    actorId?: string,
  ) {
    const session = await mongoose.startSession();
    try {
      let result: any;
      await session.withTransaction(async () => {
        const plan = await MembershipPlanModel.findOne({ _id: toObjectId(planId), tenant: toObjectId(tenantId) })
          .populate({ path: "currentDraftVersion", ordered: true })
          .populate({ path: "currentPublishedVersion", ordered: true })
          .session(session)
          .exec();
        if (!plan || plan.status === MEMBERSHIP_PLAN_STATUS.ARCHIVED) notFound("Membership plan not found.");
        const draft: any = plan.currentDraftVersion;
        if (!draft) conflict({ message: "Membership plan has no draft to publish.", code: "MEMBERSHIP_DRAFT_REQUIRED" });
        await assertVersionScope(tenantId, draft, allowedLocationIds);
        const validated = validatedMembershipVersion(draft);
        await assertSelectedCourses(tenantId, validated);
        const tenant = await findTenantById(tenantId);
        if (!tenant) notFound("Workspace not found.");
        assertMembershipPrimaryPrice(tenant, validated);
        const now = new Date();
        draft.status = MEMBERSHIP_PLAN_VERSION_STATUS.PUBLISHED;
        draft.publishedAt = now;
        draft.publishedBy = actorId ? toObjectId(actorId) : null;
        await draft.save({ session });
        plan.currentPublishedVersion = draft._id;
        plan.currentDraftVersion = null;
        plan.status = MEMBERSHIP_PLAN_STATUS.PUBLISHED;
        plan.publishedAt = now;
        plan.archivedAt = null;
        plan.updatedBy = actorId ? toObjectId(actorId) : null;
        await plan.save({ session });
        await recordMembershipAudit({ tenantId, actorId, planId, type: "membership.plan.published", source: "owner", metadata: { version: draft.version }, session });
        result = await populated(plan);
      });
      return serializePlan(result, { owner: true });
    } finally {
      await session.endSession();
    }
  },

  async archive(
    tenantId: string,
    planId: string,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
    actorId?: string,
  ) {
    const plan = await membershipRepository.findPlanByIdForTenant(tenantId, planId);
    if (!plan) notFound("Membership plan not found.");
    await assertVersionScope(tenantId, sourceVersion(plan), allowedLocationIds);
    plan.status = MEMBERSHIP_PLAN_STATUS.ARCHIVED;
    plan.archivedAt = new Date();
    plan.updatedBy = actorId ? toObjectId(actorId) : null;
    await plan.save();
    await recordMembershipAudit({ tenantId, actorId, planId, type: "membership.plan.archived", source: "owner" });
    return serializePlan(await populated(plan), { owner: true });
  },

  async duplicate(
    tenantId: string,
    planId: string,
    name: string | undefined,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
    actorId?: string,
  ) {
    const plan = await membershipRepository.findPlanByIdForTenant(tenantId, planId);
    if (!plan) notFound("Membership plan not found.");
    const version: any = sourceVersion(plan);
    await assertVersionScope(tenantId, version, allowedLocationIds);
    const config: any = {
      name: name ?? `${version.name} (copy)`,
      description: version.description ?? "",
      terms: version.terms ?? "",
      sourceLanguage: version.sourceLanguage,
      translations: version.translations ? plainMembershipTranslations(version.translations) : undefined,
      prices: version.prices.map((price: any) => ({ currency: price.currency, amountMinor: price.amountMinor })),
      billing: version.billing.toObject?.() ?? version.billing,
      locationScope: { type: version.locationScope.type, locationIds: versionLocationIds(version) },
      benefits: version.benefits.map((benefit: any) => benefit.toObject?.() ?? benefit),
      sortOrder: plan.sortOrder,
    };
    const duplicate = await this.create(tenantId, config, allowedLocationIds, actorId, version);
    await recordMembershipAudit({ tenantId, actorId, planId: duplicate.id, type: "membership.plan.duplicated", source: "owner", metadata: { sourcePlanId: planId } });
    return duplicate;
  },

  async publicCatalog(tenantSlug: string, locationId?: string) {
    const tenant = await findTenantBySlug(tenantSlug);
    if (!tenant) notFound("Workspace not found.");
    return publishedCatalog(tenant, locationId);
  },

  async customerCatalog(tenantId: string, locationId?: string) {
    const tenant = await findTenantById(tenantId);
    if (!tenant) notFound("Workspace not found.");
    return publishedCatalog(tenant, locationId);
  },

  // Legacy alias.
  disable(tenantId: string, planId: string, allowed: AllowedWorkspaceLocationIds = null, actorId?: string) {
    return this.archive(tenantId, planId, allowed, actorId);
  },
};

export { assertVersionScope, isVersionVisibleInScope, versionMatchesLocation };
