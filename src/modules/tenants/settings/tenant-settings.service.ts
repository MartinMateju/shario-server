import mongoose, { Types } from "mongoose";
import { assertTenantLocationIdsExist } from "@/modules/tenant-access/services/location-scope.service.js";

import { getTenantOrThrow } from "@/modules/tenants/services/tenant.service.js";
import { assertTenantOperationalCurrencyCanChange } from "@/modules/tenants/services/tenant-currency.service.js";
import {
  getTenantPublicationState,
  publicTenantCacheKey,
} from "@/modules/setup-center/setup-publication.service.js";
import { SETUP_PUBLICATION_STATUS } from "@/modules/setup-center/setup-center.constants.js";
import { SetupAuditEventModel } from "@/modules/setup-center/setup-center.model.js";
import {
  TENANT_MODULE,
  TENANT_STATUS,
  TENANT_WORKSPACE_CONFIGURATION_DEFINITION_VERSION,
  TENANT_WORKSPACE_INTENT_ANSWER,
  TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
  TENANT_WORKSPACE_INTENT_SOURCE,
} from "@/modules/tenants/tenant.constants.js";
import {
  deriveEffectiveTenantModules,
  getLegacyWorkspaceModuleSelection,
  getTenantModuleEntitlements,
  materializeWorkspaceModuleSelections,
  setWorkspaceModuleSelection,
} from "@/modules/tenants/tenant-workspace-modules.js";
import { buildPublicTenantConfig } from "@/modules/tenants/public-site/tenant-public-site.config.js";
import { getTenantPublicSitePreviewData } from "@/modules/tenants/public-site/tenant-public-site-preview-data.service.js";
import { serializeTenantPublicSite } from "@/modules/tenants/public-site/tenant-public-site.serializers.js";
import TenantPublicSiteVersionModel from "@/modules/tenants/public-site/tenant-public-site-version.model.js";
import TenantModel from "@/modules/tenants/tenant.model.js";
import type {
  TenantDocument,
  TenantPublicSite,
  TenantWorkspaceIntentAnswers,
} from "@/modules/tenants/tenant.types.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "@/shared/http/httpErrors.js";
import { ROLLOUT_ELIGIBLE_APP_LOCALES } from "@/shared/i18n/locales.js";
import {
  LEGACY_TENANT_LANGUAGE,
  MAX_TENANT_PUBLIC_LANGUAGES,
  normalizeTenantPublicLanguageSelection,
  resolveTenantLocaleSettings,
  toLegacyTenantLanguage,
} from "@/modules/tenants/tenant-locale.js";

import type {
  UpdateTenantSettingsInput,
  UpdateTenantWorkspaceConfigurationInput,
} from "./tenant-settings.validators.js";
import {
  isSafePublicSiteUrl,
  type UpdateTenantPublicSiteInput,
} from "../public-site/tenant-public-site.validators.js";
import { cleanupDiscardedPublicSiteMedia } from "./public-site-media-cleanup.js";

const serializeWorkspaceSettings = (
  tenant: Awaited<ReturnType<typeof getTenantOrThrow>>,
) => {
  const localeSettings = resolveTenantLocaleSettings(tenant.settings);
  const effectiveModules = deriveEffectiveTenantModules({
    plan: tenant.plan,
    planVersion: tenant.planVersion,
    workspaceModules: tenant.workspaceModules,
    legacyModules: tenant.modules,
  });

  return {
    id: String(tenant._id),
    name: tenant.name,
    slug: tenant.slug,
    businessType: tenant.onboarding?.businessType ?? null,
    country: tenant.onboarding?.businessDetails?.country ?? "",
    status: tenant.status,
    plan: tenant.plan,
    planVersion: tenant.planVersion,
    ...localeSettings,
    currency: tenant.settings.currency,
    timezone: tenant.settings.timezone,
    navigation: tenant.settings.navigation ?? {
      hiddenGroups: [],
      hiddenItems: [],
    },
    domains: tenant.domains,
    modules: effectiveModules,
    limits: tenant.limits,
    updatedAt: tenant.updatedAt,
  };
};

export const getTenantWorkspaceSettings = async (tenantId: string) => {
  const tenant = await getTenantOrThrow(tenantId);
  return serializeWorkspaceSettings(tenant);
};

const workspaceIntentAnswerKeys = Object.values(TENANT_WORKSPACE_INTENT_ANSWER);

const serializeWorkspaceIntentAnswers = (
  answers: TenantWorkspaceIntentAnswers | undefined,
): TenantWorkspaceIntentAnswers | null =>
  answers
    ? (Object.fromEntries(
        workspaceIntentAnswerKeys
          .filter((answer) => typeof answers[answer] === "boolean")
          .map((answer) => [answer, answers[answer]]),
      ) as TenantWorkspaceIntentAnswers)
    : null;

const serializeWorkspaceConfiguration = (tenant: TenantDocument) => {
  const entitlements = getTenantModuleEntitlements({
    plan: tenant.plan,
    planVersion: tenant.planVersion,
  });
  const effectiveModules = deriveEffectiveTenantModules({
    plan: tenant.plan,
    planVersion: tenant.planVersion,
    workspaceModules: tenant.workspaceModules,
    legacyModules: tenant.modules,
  });
  const modules = Object.fromEntries(
    Object.values(TENANT_MODULE).map((moduleName) => {
      const state = tenant.workspaceModules?.[moduleName];
      const entitled = entitlements[moduleName] === true;
      const selected =
        state?.selected ??
        getLegacyWorkspaceModuleSelection({
          entitlements,
          modules: tenant.modules,
          moduleName,
        });

      return [
        moduleName,
        {
          entitled,
          selected,
          enabled: effectiveModules[moduleName],
          enabledAt: state?.enabledAt ?? null,
          disabledAt: state?.disabledAt ?? null,
          lastUsedAt: state?.lastUsedAt ?? null,
        },
      ];
    }),
  );

  const intent = tenant.workspaceIntent;

  return {
    definitionVersion: TENANT_WORKSPACE_CONFIGURATION_DEFINITION_VERSION,
    intent: {
      configured: Boolean(intent?.confirmedAt),
      definitionVersion:
        intent?.definitionVersion ?? TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
      answers: serializeWorkspaceIntentAnswers(intent?.answers),
      pricingMode: intent?.pricingMode ?? null,
      source: intent?.source ?? null,
      confirmedAt: intent?.confirmedAt ?? null,
      updatedAt: intent?.updatedAt ?? null,
    },
    modules,
    effectiveModules,
    navigation: {
      hiddenGroups: [...(tenant.settings.navigation?.hiddenGroups ?? [])],
      hiddenItems: [...(tenant.settings.navigation?.hiddenItems ?? [])],
    },
  };
};

export const getTenantWorkspaceConfiguration = async (tenantId: string) =>
  serializeWorkspaceConfiguration(await getTenantOrThrow(tenantId));

export const updateTenantWorkspaceConfiguration = async ({
  tenantId,
  actorUserId,
  input,
}: {
  tenantId: string;
  actorUserId: string;
  input: UpdateTenantWorkspaceConfigurationInput;
}) => {
  const tenant = await getTenantOrThrow(tenantId);
  const entitlements = getTenantModuleEntitlements({
    plan: tenant.plan,
    planVersion: tenant.planVersion,
  });
  const workspaceModules = materializeWorkspaceModuleSelections({
    entitlements,
    modules: tenant.modules,
    workspaceModules: tenant.workspaceModules,
  });
  const now = new Date();
  const wasIntentConfigured = Boolean(tenant.workspaceIntent?.confirmedAt);
  // Pricing intent controls customer My work, but never changes staff modules.
  // V1 clients also submitted a derived module map and navigation; ignore those.
  const questionnaireOnly =
    input.intent?.definitionVersion === 1 ||
    input.intent?.answers !== undefined ||
    input.intent?.pricingMode !== undefined;
  const modulePatch = questionnaireOnly ? {} : (input.modules ?? {});
  const changedModules: string[] = [];
  const previousAnswers = tenant.workspaceIntent?.answers;
  const requestedAnswers = input.intent?.answers
    ? { ...previousAnswers, ...input.intent.answers }
    : undefined;
  const pricingMode =
    input.intent?.pricingMode ?? tenant.workspaceIntent?.pricingMode;
  const pricingChanged = pricingMode !== tenant.workspaceIntent?.pricingMode;
  const changedAnswers =
    requestedAnswers === undefined
      ? []
      : workspaceIntentAnswerKeys.filter(
          (answer) => previousAnswers?.[answer] !== requestedAnswers[answer],
        );

  for (const [moduleName, selected] of Object.entries(modulePatch)) {
    const key = moduleName as keyof typeof entitlements;
    const current = workspaceModules[key];
    const currentSelected =
      current?.selected ??
      (entitlements[key] ? tenant.modules[key] !== false : true);
    if (selected === true && !entitlements[key] && !currentSelected) {
      forbidden({
        message: `The "${moduleName}" module is not included in the current plan.`,
        code: "TENANT_MODULE_NOT_ENTITLED",
        details: { module: moduleName, currentPlan: tenant.plan },
      });
    }

    if (currentSelected !== selected) changedModules.push(moduleName);
    setWorkspaceModuleSelection({
      workspaceModules,
      moduleName: key,
      selected,
      currentSelected,
      now,
    });
  }

  const confirmsIntent = input.intent !== undefined && !wasIntentConfigured;
  const updatesConfirmedIntent =
    wasIntentConfigured &&
    (changedModules.length > 0 || changedAnswers.length > 0 || pricingChanged);
  if (confirmsIntent || updatesConfirmedIntent) {
    const answers = serializeWorkspaceIntentAnswers(
      requestedAnswers ?? previousAnswers,
    );
    tenant.workspaceIntent = {
      definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
      ...(answers ? { answers } : {}),
      ...(pricingMode ? { pricingMode } : {}),
      confirmedAt: tenant.workspaceIntent?.confirmedAt ?? now,
      ...(tenant.workspaceIntent?.confirmedBy
        ? { confirmedBy: tenant.workspaceIntent.confirmedBy }
        : { confirmedBy: new Types.ObjectId(actorUserId) }),
      updatedAt: now,
      updatedBy: new Types.ObjectId(actorUserId),
      source: TENANT_WORKSPACE_INTENT_SOURCE.OWNER,
    };
  }

  if (!questionnaireOnly && input.modules) {
    tenant.workspaceModules = workspaceModules;
    tenant.modules = deriveEffectiveTenantModules({
      plan: tenant.plan,
      planVersion: tenant.planVersion,
      workspaceModules,
    });
  }
  if (!questionnaireOnly && input.navigation) {
    tenant.settings.navigation = {
      hiddenGroups:
        input.navigation.hiddenGroups ??
        tenant.settings.navigation?.hiddenGroups ??
        [],
      hiddenItems:
        input.navigation.hiddenItems ??
        tenant.settings.navigation?.hiddenItems ??
        [],
    };
  }

  await tenant.save();

  // Public capability responses must reflect the new answer on the next read.
  // Reuse the publication cache's bounded, best-effort invalidation; customer
  // mutation guards independently load the current tenant from the database.
  if (tenant.slug) {
    const { deleteCache } = await import("@/infrastructure/redis/cache.js");
    await deleteCache(publicTenantCacheKey(tenant.slug));
  }

  if (confirmsIntent || updatesConfirmedIntent) {
    const selectedModules = Object.values(TENANT_MODULE).filter(
      (moduleName) =>
        workspaceModules[moduleName]?.selected ??
        getLegacyWorkspaceModuleSelection({
          entitlements,
          modules: tenant.modules,
          moduleName,
        }),
    );
    await SetupAuditEventModel.create({
      tenant: tenantId,
      actor: actorUserId,
      event: wasIntentConfigured
        ? "workspace_intent_updated"
        : "workspace_intent_confirmed",
      metadata: {
        definitionVersion: TENANT_WORKSPACE_INTENT_DEFINITION_VERSION,
        selectedModules,
        deselectedModules: Object.values(TENANT_MODULE).filter(
          (moduleName) => !selectedModules.includes(moduleName),
        ),
        changedModules,
        changedAnswers,
        pricingMode: tenant.workspaceIntent.pricingMode ?? null,
        pricingChanged,
        ...(tenant.workspaceIntent.answers
          ? {
              answers: serializeWorkspaceIntentAnswers(
                tenant.workspaceIntent.answers,
              ),
            }
          : {}),
      },
    });
  }

  return serializeWorkspaceConfiguration(tenant);
};

export const updateTenantWorkspaceSettings = async ({
  tenantId,
  input,
}: {
  tenantId: string;
  input: UpdateTenantSettingsInput;
}) => {
  const tenant = await getTenantOrThrow(tenantId);

  if (input.currency !== undefined) {
    tenant.settings.currency = await assertTenantOperationalCurrencyCanChange({
      tenantId,
      currentCurrency: tenant.settings.currency,
      requestedCurrency: input.currency,
    });
  }

  if (input.name !== undefined) tenant.name = input.name;
  if (input.businessType !== undefined) {
    tenant.set("onboarding.businessType", input.businessType);
  }
  if (input.country !== undefined) {
    tenant.set("onboarding.businessDetails.country", input.country);
  }
  const currentLocales = resolveTenantLocaleSettings(tenant.settings);
  const legacyDefault = input.defaultLanguage;
  const adminLanguage =
    input.adminLanguage ?? legacyDefault ?? currentLocales.adminLanguage;
  const publicDefaultLanguage =
    input.publicDefaultLanguage ??
    legacyDefault ??
    currentLocales.publicDefaultLanguage;
  const requestedPublicLanguages =
    input.supportedPublicLanguages ?? currentLocales.supportedPublicLanguages;
  const normalizedPublicLanguages = normalizeTenantPublicLanguageSelection({
    publicDefaultLanguage,
    supportedPublicLanguages: requestedPublicLanguages,
  });

  if (
    input.supportedPublicLanguages !== undefined &&
    normalizedPublicLanguages.length > MAX_TENANT_PUBLIC_LANGUAGES
  ) {
    badRequest({
      message:
        "A public site can use a primary language and one optional secondary language.",
      code: "TENANT_PUBLIC_LANGUAGE_LIMIT_EXCEEDED",
      details: {
        maxLanguages: MAX_TENANT_PUBLIC_LANGUAGES,
        publicDefaultLanguage,
      },
    });
  }
  const supportedPublicLanguages = normalizedPublicLanguages.slice(
    0,
    MAX_TENANT_PUBLIC_LANGUAGES,
  );

  tenant.settings.adminLanguage = adminLanguage;
  tenant.settings.publicDefaultLanguage = publicDefaultLanguage;
  tenant.settings.supportedPublicLanguages = supportedPublicLanguages;
  // Keep untouched legacy readers aligned without changing their CZ/EN enum.
  tenant.settings.defaultLanguage =
    toLegacyTenantLanguage(publicDefaultLanguage) ?? LEGACY_TENANT_LANGUAGE.EN;
  if (input.timezone !== undefined) tenant.settings.timezone = input.timezone;

  await tenant.save();

  return serializeWorkspaceSettings(tenant);
};

export const getTenantPublicSitePreview = async (tenantId: string) => {
  const tenant = await getTenantOrThrow(tenantId);
  const [config, publication, data] = await Promise.all([
    buildPublicTenantConfig(tenant, { snapshot: "draft" }),
    getTenantPublicationState(tenant._id),
    getTenantPublicSitePreviewData(tenant),
  ]);

  return {
    tenant: config,
    preview: {
      mode: "authenticated" as const,
      publicationStatus: publication.status,
      hasExplicitPublicationState: publication.hasExplicitState,
      publiclyAvailable:
        tenant.status === TENANT_STATUS.ACTIVE &&
        publication.status === SETUP_PUBLICATION_STATUS.LIVE,
      publishAction:
        publication.status === SETUP_PUBLICATION_STATUS.LIVE
          ? ("publishChanges" as const)
          : ("publishWebsite" as const),
      data,
    },
  };
};

export type TenantPublicSiteEditorState = {
  publicSite: TenantPublicSite;
  draft: TenantPublicSite;
  published: TenantPublicSite;
  editor: {
    draftRevision: number;
    publishedRevision: number;
    hasUnpublishedChanges: boolean;
    draftUpdatedAt: string | null;
    publishedAt: string | null;
  };
};

const safeRevision = (value: unknown): number => {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
};

const isoDateOrNull = (value: unknown): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const toEditorState = (tenant: TenantDocument): TenantPublicSiteEditorState => {
  const draft = serializeTenantPublicSite(tenant, { snapshot: "draft" });
  const published = serializeTenantPublicSite(tenant, {
    snapshot: "published",
  });
  const editor = tenant.publicSiteEditor;

  return {
    // Kept as a compatibility alias for the pre-editor settings UI.
    publicSite: draft,
    draft,
    published,
    editor: {
      draftRevision: safeRevision(editor?.draftRevision),
      publishedRevision: safeRevision(editor?.publishedRevision),
      hasUnpublishedChanges:
        JSON.stringify(draft) !== JSON.stringify(published),
      draftUpdatedAt: isoDateOrNull(editor?.draftUpdatedAt),
      publishedAt: isoDateOrNull(editor?.publishedAt),
    },
  };
};

const assertExpectedRevision = (
  actual: number,
  expected: number | undefined,
): void => {
  if (expected !== undefined && expected !== actual) {
    conflict({
      message:
        "The public-site draft changed in another session. Reload it and try again.",
      code: "PUBLIC_SITE_REVISION_CONFLICT",
      details: { expectedRevision: expected, actualRevision: actual },
    });
  }
};

const revisionFilter = (revision: number) =>
  revision === 0
    ? {
        $or: [
          { "publicSiteEditor.draftRevision": 0 },
          { "publicSiteEditor.draftRevision": { $exists: false } },
        ],
      }
    : { "publicSiteEditor.draftRevision": revision };

const mergePatch = (
  target: Record<string, any>,
  patch: Record<string, unknown>,
): void => {
  Object.entries(patch).forEach(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const child =
        target[key] &&
        typeof target[key] === "object" &&
        !Array.isArray(target[key])
          ? target[key]
          : {};
      target[key] = child;
      mergePatch(child, value as Record<string, unknown>);
      return;
    }
    target[key] = value;
  });
};

const keepDerivedNamesInSync = ({
  draft,
  patch,
  previousDisplayName,
}: {
  draft: Record<string, any>;
  patch: UpdateTenantPublicSiteInput;
  previousDisplayName: string;
}): void => {
  const requestedDisplayName = patch.branding?.displayName;
  if (requestedDisplayName === undefined) return;

  const nextDisplayName = String(requestedDisplayName).trim();
  const homeHeadlinePatch = patch.pages?.home?.headline;
  const loginHeadlinePatch = patch.login?.headline;

  ROLLOUT_ELIGIBLE_APP_LOCALES.forEach((locale) => {
    if (
      homeHeadlinePatch?.[locale] === undefined &&
      draft.pages?.home?.headline?.[locale] === previousDisplayName
    ) {
      draft.pages.home.headline[locale] = nextDisplayName;
    }
  });

  (["cs", "en"] as const).forEach((locale) => {
    const previousLoginHeadline =
      locale === "cs"
        ? `Vítejte — ${previousDisplayName}`
        : `Welcome to ${previousDisplayName}`;
    if (
      loginHeadlinePatch?.[locale] === undefined &&
      draft.login?.headline?.[locale] === previousLoginHeadline
    ) {
      draft.login.headline[locale] =
        locale === "cs"
          ? `Vítejte — ${nextDisplayName}`
          : `Welcome to ${nextDisplayName}`;
    }
  });
};

const requireUpdatedTenant = (
  tenant: TenantDocument | null,
  actualRevision: number,
): TenantDocument => {
  if (!tenant) {
    conflict({
      message:
        "The public-site draft changed in another session. Reload it and try again.",
      code: "PUBLIC_SITE_REVISION_CONFLICT",
      details: { actualRevision },
    });
  }
  return tenant;
};

export const getTenantPublicSiteEditorState = async (
  tenantId: string,
): Promise<TenantPublicSiteEditorState> => {
  return toEditorState(await getTenantOrThrow(tenantId));
};

const serializePublicSiteVersion = (version: any) => ({
  id: String(version._id),
  sourceDraftRevision: safeRevision(version.sourceDraftRevision),
  publishedAt: isoDateOrNull(version.publishedAt),
  publishedBy: version.publishedBy ? String(version.publishedBy) : null,
  restoredFromVersion: version.restoredFromVersion
    ? String(version.restoredFromVersion)
    : null,
});

export const listTenantPublicSiteVersions = async (tenantId: string) => {
  const tenant = await getTenantOrThrow(tenantId);
  const versions = await TenantPublicSiteVersionModel.find({
    tenant: tenant._id,
  })
    .sort({ publishedAt: -1, _id: -1 })
    .limit(50)
    .select(
      "_id sourceDraftRevision publishedAt publishedBy restoredFromVersion",
    )
    .lean()
    .exec();

  return {
    versions: versions.map((version) => serializePublicSiteVersion(version)),
  };
};

export const updateTenantPublicSiteDraft = async ({
  tenantId,
  patch,
  revision,
}: {
  tenantId: string;
  patch: UpdateTenantPublicSiteInput;
  revision?: number;
}): Promise<TenantPublicSiteEditorState> => {
  const tenant = await getTenantOrThrow(tenantId);
  const currentRevision = safeRevision(tenant.publicSiteEditor?.draftRevision);
  assertExpectedRevision(currentRevision, revision);

  if (patch.customerPortal?.courses?.locations) {
    await assertTenantLocationIdsExist(
      tenantId,
      patch.customerPortal.courses.locations.map((entry) => entry.locationId),
    );
  }

  const beforeDraft = serializeTenantPublicSite(tenant, {
    snapshot: "draft",
  });
  const nextDraft = structuredClone(beforeDraft) as unknown as Record<
    string,
    any
  >;
  const previousDisplayName = String(nextDraft.branding?.displayName ?? "");
  mergePatch(nextDraft, patch as Record<string, unknown>);
  // Partial updates may enable a previously saved URL or clear a URL while the
  // link is still enabled. Validate their combined state before serialization.
  if (
    nextDraft.branding.logoRedirectEnabled === true &&
    (!nextDraft.branding.logoRedirectUrl?.trim() ||
      !isSafePublicSiteUrl(nextDraft.branding.logoRedirectUrl.trim()))
  ) {
    badRequest(
      "Enter an HTTPS or root-relative destination URL to enable the logo link.",
    );
  }
  keepDerivedNamesInSync({
    draft: nextDraft,
    patch,
    previousDisplayName,
  });
  const safeDraft = serializeTenantPublicSite({
    name: tenant.name,
    publicSite: nextDraft,
  } as TenantDocument);
  const now = new Date();

  const updated = await TenantModel.findOneAndUpdate(
    {
      _id: tenant._id,
      ...revisionFilter(currentRevision),
    },
    {
      $set: {
        "publicSiteEditor.draft": safeDraft,
        "publicSiteEditor.draftUpdatedAt": now,
      },
      $inc: { "publicSiteEditor.draftRevision": 1 },
    },
    { returnDocument: "after", runValidators: true },
  ).exec();

  const state = toEditorState(requireUpdatedTenant(updated, currentRevision));
  await cleanupDiscardedPublicSiteMedia({
    tenantId,
    beforeDraft,
    afterDraft: state.draft,
    published: state.published,
  });
  return state;
};

export const publishTenantPublicSiteDraft = async ({
  tenantId,
  userId,
  revision,
}: {
  tenantId: string;
  userId: string;
  revision?: number;
}): Promise<TenantPublicSiteEditorState> => {
  const tenant = await getTenantOrThrow(tenantId);
  const currentRevision = safeRevision(tenant.publicSiteEditor?.draftRevision);
  assertExpectedRevision(currentRevision, revision);
  const beforePublished = serializeTenantPublicSite(tenant, {
    snapshot: "published",
  });
  const snapshot = serializeTenantPublicSite(tenant, {
    snapshot: "draft",
  });
  const now = new Date();

  const session = await mongoose.startSession();
  let updated: TenantDocument | null = null;

  try {
    await session.withTransaction(async () => {
      const previousPublishedRevision = safeRevision(
        tenant.publicSiteEditor?.publishedRevision,
      );
      if (
        tenant.publicSiteEditor?.publishedAt &&
        previousPublishedRevision !== currentRevision
      ) {
        await TenantPublicSiteVersionModel.findOneAndUpdate(
          {
            tenant: tenant._id,
            sourceDraftRevision: previousPublishedRevision,
          },
          {
            $setOnInsert: {
              snapshot: beforePublished,
              publishedAt: tenant.publicSiteEditor.publishedAt,
              publishedBy: tenant.publicSiteEditor.publishedBy,
            },
          },
          { upsert: true, runValidators: true, session },
        ).exec();
      }

      updated = await TenantModel.findOneAndUpdate(
        {
          _id: tenant._id,
          ...revisionFilter(currentRevision),
        },
        {
          $set: {
            // `publicSite` remains the published mirror for old deployments
            // and authentication responses that predate the editor.
            publicSite: snapshot,
            "publicSiteEditor.published": snapshot,
            "publicSiteEditor.publishedRevision": currentRevision,
            "publicSiteEditor.publishedAt": now,
            "publicSiteEditor.publishedBy": userId,
          },
          $unset: {
            "publicSiteEditor.draftRestoredFromVersion": "",
          },
        },
        { returnDocument: "after", runValidators: true, session },
      ).exec();
      requireUpdatedTenant(updated, currentRevision);

      await TenantPublicSiteVersionModel.findOneAndUpdate(
        { tenant: tenant._id, sourceDraftRevision: currentRevision },
        {
          $setOnInsert: {
            snapshot,
            publishedAt: now,
            publishedBy: userId,
            ...(tenant.publicSiteEditor?.draftRestoredFromVersion
              ? {
                  restoredFromVersion:
                    tenant.publicSiteEditor.draftRestoredFromVersion,
                }
              : {}),
          },
        },
        { upsert: true, runValidators: true, session },
      ).exec();
    });
  } finally {
    await session.endSession();
  }

  const publishedTenant = requireUpdatedTenant(updated, currentRevision);
  const state = toEditorState(publishedTenant);
  // Public routes cache the whole tenant, including its published branding.
  // Invalidate cached published branding only after the transaction commits.
  if (publishedTenant.slug) {
    const { deleteCache } = await import("@/infrastructure/redis/cache.js");
    await deleteCache(publicTenantCacheKey(publishedTenant.slug));
  }
  await cleanupDiscardedPublicSiteMedia({
    tenantId,
    beforeDraft: beforePublished,
    afterDraft: state.draft,
    published: state.published,
  });
  return state;
};

export const restoreTenantPublicSiteVersion = async ({
  tenantId,
  versionId,
  revision,
}: {
  tenantId: string;
  versionId: string;
  revision?: number;
}): Promise<TenantPublicSiteEditorState> => {
  const tenant = await getTenantOrThrow(tenantId);
  const currentRevision = safeRevision(tenant.publicSiteEditor?.draftRevision);
  assertExpectedRevision(currentRevision, revision);
  const version = await TenantPublicSiteVersionModel.findOne({
    _id: versionId,
    tenant: tenant._id,
  })
    .lean()
    .exec();

  if (!version) {
    notFound({
      message: "Public-site version not found.",
      code: "PUBLIC_SITE_VERSION_NOT_FOUND",
    });
  }

  const beforeDraft = serializeTenantPublicSite(tenant, {
    snapshot: "draft",
  });
  const restoredDraft = serializeTenantPublicSite({
    name: tenant.name,
    publicSite: version.snapshot,
  } as TenantDocument);
  const now = new Date();
  const updated = await TenantModel.findOneAndUpdate(
    {
      _id: tenant._id,
      ...revisionFilter(currentRevision),
    },
    {
      $set: {
        "publicSiteEditor.draft": restoredDraft,
        "publicSiteEditor.draftUpdatedAt": now,
        "publicSiteEditor.draftRestoredFromVersion": version._id,
      },
      $inc: { "publicSiteEditor.draftRevision": 1 },
    },
    { returnDocument: "after", runValidators: true },
  ).exec();

  const state = toEditorState(requireUpdatedTenant(updated, currentRevision));
  await cleanupDiscardedPublicSiteMedia({
    tenantId,
    beforeDraft,
    afterDraft: state.draft,
    published: state.published,
  });
  return state;
};

export const resetTenantPublicSiteDraft = async ({
  tenantId,
  revision,
}: {
  tenantId: string;
  revision?: number;
}): Promise<TenantPublicSiteEditorState> => {
  const tenant = await getTenantOrThrow(tenantId);
  const currentRevision = safeRevision(tenant.publicSiteEditor?.draftRevision);
  assertExpectedRevision(currentRevision, revision);
  const beforeDraft = serializeTenantPublicSite(tenant, {
    snapshot: "draft",
  });
  const published = serializeTenantPublicSite(tenant, {
    snapshot: "published",
  });
  const now = new Date();

  const updated = await TenantModel.findOneAndUpdate(
    {
      _id: tenant._id,
      ...revisionFilter(currentRevision),
    },
    {
      $set: {
        "publicSiteEditor.draft": published,
        "publicSiteEditor.draftUpdatedAt": now,
      },
      $unset: {
        "publicSiteEditor.draftRestoredFromVersion": "",
      },
      $inc: { "publicSiteEditor.draftRevision": 1 },
    },
    { returnDocument: "after", runValidators: true },
  ).exec();

  const state = toEditorState(requireUpdatedTenant(updated, currentRevision));
  await cleanupDiscardedPublicSiteMedia({
    tenantId,
    beforeDraft,
    afterDraft: state.draft,
    published: state.published,
  });
  return state;
};
