import { Router } from "express";

import { verifyJWT } from "@/modules/auth/middleware/verifyJWT.js";
import { requirePermission } from "@/modules/tenant-access/tenant-access.middleware.js";
import { TENANT_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

import {
  getCurrentTenantPublicSite,
  getCurrentTenantPublicSitePreview,
  getCurrentTenantPublicSiteVersions,
  getCurrentTenantSettings,
  getCurrentTenantWorkspaceConfiguration,
  publishCurrentTenantPublicSite,
  resetCurrentTenantPublicSiteDraft,
  restoreCurrentTenantPublicSiteVersion,
  uploadCurrentTenantPublicSiteMedia,
  updateCurrentTenantPublicSite,
  updateCurrentTenantSettings,
  updateCurrentTenantWorkspaceConfiguration,
} from "./tenant-settings.controller.js";
import { publicSiteMediaUpload } from "./public-site-media.middleware.js";

export const tenantSettingsRouter = Router();

tenantSettingsRouter.use(verifyJWT);
tenantSettingsRouter.get(
  "/workspace-configuration",
  requirePermission(TENANT_PERMISSION.WORKSPACE_CONFIGURATION_MANAGE),
  getCurrentTenantWorkspaceConfiguration,
);
tenantSettingsRouter.patch(
  "/workspace-configuration",
  requirePermission(TENANT_PERMISSION.WORKSPACE_CONFIGURATION_MANAGE),
  updateCurrentTenantWorkspaceConfiguration,
);
tenantSettingsRouter.get(
  "/public-site/preview",
  requirePermission(TENANT_PERMISSION.WORKSPACE_VIEW),
  getCurrentTenantPublicSitePreview,
);
tenantSettingsRouter.get(
  "/public-site/versions",
  requirePermission(TENANT_PERMISSION.WORKSPACE_VIEW),
  getCurrentTenantPublicSiteVersions,
);
tenantSettingsRouter.post(
  "/public-site/versions/:versionId/restore",
  requirePermission(TENANT_PERMISSION.WORKSPACE_UPDATE),
  restoreCurrentTenantPublicSiteVersion,
);
tenantSettingsRouter.get(
  "/public-site",
  requirePermission(TENANT_PERMISSION.WORKSPACE_VIEW),
  getCurrentTenantPublicSite,
);
tenantSettingsRouter.patch(
  "/public-site",
  requirePermission(TENANT_PERMISSION.WORKSPACE_UPDATE),
  updateCurrentTenantPublicSite,
);
tenantSettingsRouter.post(
  "/public-site/publish",
  requirePermission(TENANT_PERMISSION.WORKSPACE_PUBLISH),
  publishCurrentTenantPublicSite,
);
tenantSettingsRouter.post(
  "/public-site/reset-draft",
  requirePermission(TENANT_PERMISSION.WORKSPACE_UPDATE),
  resetCurrentTenantPublicSiteDraft,
);
tenantSettingsRouter.post(
  "/public-site/media/:slot",
  requirePermission(TENANT_PERMISSION.WORKSPACE_UPDATE),
  publicSiteMediaUpload,
  uploadCurrentTenantPublicSiteMedia,
);
tenantSettingsRouter.get(
  "/",
  requirePermission(TENANT_PERMISSION.WORKSPACE_VIEW),
  getCurrentTenantSettings,
);
tenantSettingsRouter.patch(
  "/",
  requirePermission(TENANT_PERMISSION.WORKSPACE_UPDATE),
  updateCurrentTenantSettings,
);

export default tenantSettingsRouter;
