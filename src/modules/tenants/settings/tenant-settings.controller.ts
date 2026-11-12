import type { Response } from "express";

import type { AuthenticatedRequest } from "@/modules/auth/auth.types.js";
import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  PUBLIC_SITE_MEDIA_SLOTS,
  type PublicSiteMediaSlot,
} from "@/modules/tenants/public-site/tenant-public-site.constants.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { badRequest } from "@/shared/http/httpErrors.js";
import { z } from "zod";

import {
  getTenantPublicSiteEditorState,
  getTenantWorkspaceSettings,
  getTenantPublicSitePreview,
  listTenantPublicSiteVersions,
  getTenantWorkspaceConfiguration,
  publishTenantPublicSiteDraft,
  resetTenantPublicSiteDraft,
  restoreTenantPublicSiteVersion,
  updateTenantPublicSiteDraft,
  updateTenantWorkspaceConfiguration,
  updateTenantWorkspaceSettings,
} from "./tenant-settings.service.js";
import {
  updateTenantSettingsSchema,
  updateTenantWorkspaceConfigurationSchema,
} from "./tenant-settings.validators.js";
import {
  mutateTenantPublicSiteDraftSchema,
  publicSiteRevisionSchema,
  publicSiteVersionParamsSchema,
} from "../public-site/tenant-public-site.validators.js";
import { uploadTenantPublicSiteMedia } from "./public-site-media.service.js";

export const getCurrentTenantSettings = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const settings = await getTenantWorkspaceSettings(requireTenantId(req));
    res.status(200).json({ settings });
  },
);

export const updateCurrentTenantSettings = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const settings = await updateTenantWorkspaceSettings({
      tenantId: requireTenantId(req),
      input: updateTenantSettingsSchema.parse(req.body),
    });

    res.status(200).json({ settings });
  },
);

export const getCurrentTenantWorkspaceConfiguration = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const configuration = await getTenantWorkspaceConfiguration(
      requireTenantId(req),
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).json({ configuration });
  },
);

export const updateCurrentTenantWorkspaceConfiguration = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const configuration = await updateTenantWorkspaceConfiguration({
      tenantId: requireTenantId(req),
      actorUserId: getAuthenticatedUserId(req),
      input: updateTenantWorkspaceConfigurationSchema.parse(req.body),
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).json({ configuration });
  },
);

export const getCurrentTenantPublicSite = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const state = await getTenantPublicSiteEditorState(requireTenantId(req));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Authorization");
    res.status(200).json(state);
  },
);

export const getCurrentTenantPublicSitePreview = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const preview = await getTenantPublicSitePreview(requireTenantId(req));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Authorization");
    res.status(200).json(preview);
  },
);

export const getCurrentTenantPublicSiteVersions = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const versions = await listTenantPublicSiteVersions(requireTenantId(req));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Authorization");
    res.status(200).json(versions);
  },
);

export const updateCurrentTenantPublicSite = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const input = mutateTenantPublicSiteDraftSchema.parse(req.body);
    const state = await updateTenantPublicSiteDraft({
      tenantId: requireTenantId(req),
      patch: input.patch,
      revision: "revision" in input ? input.revision : undefined,
    });

    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Authorization");
    res.status(200).json(state);
  },
);

export const publishCurrentTenantPublicSite = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { revision } = publicSiteRevisionSchema.parse(req.body);
    const state = await publishTenantPublicSiteDraft({
      tenantId: requireTenantId(req),
      userId: getAuthenticatedUserId(req),
      revision,
    });

    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Authorization");
    res.status(200).json(state);
  },
);

export const resetCurrentTenantPublicSiteDraft = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { revision } = publicSiteRevisionSchema.parse(req.body);
    const state = await resetTenantPublicSiteDraft({
      tenantId: requireTenantId(req),
      revision,
    });

    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Authorization");
    res.status(200).json(state);
  },
);

export const restoreCurrentTenantPublicSiteVersion = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { versionId } = publicSiteVersionParamsSchema.parse(req.params);
    const { revision } = publicSiteRevisionSchema.parse(req.body);
    const state = await restoreTenantPublicSiteVersion({
      tenantId: requireTenantId(req),
      versionId,
      revision,
    });

    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Authorization");
    res.status(200).json(state);
  },
);

const mediaBodySchema = z
  .object({
    locationId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
    revision: z
      .union([z.literal(""), z.coerce.number().int().min(0)])
      .optional()
      .transform((value) => (value === "" ? undefined : value)),
  })
  .strict();

export const uploadCurrentTenantPublicSiteMedia = asyncHandler(
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const slot = String(req.params.slot ?? "").trim();
    if (!PUBLIC_SITE_MEDIA_SLOTS.includes(slot as PublicSiteMediaSlot)) {
      badRequest({
        message: "Unknown public-site media slot.",
        code: "PUBLIC_SITE_MEDIA_SLOT_INVALID",
      });
    }
    const { revision, locationId } = mediaBodySchema.parse(req.body ?? {});
    const state = await uploadTenantPublicSiteMedia({
      tenantId: requireTenantId(req),
      slot: slot as PublicSiteMediaSlot,
      file: req.file,
      revision,
      locationId,
    });

    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Authorization");
    res.status(201).json(state);
  },
);
