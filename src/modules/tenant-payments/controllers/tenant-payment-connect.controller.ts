import type { Response } from "express";

import {
  getResolvedWorkspaceAccess,
} from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { hasWorkspacePermission } from "@/modules/tenant-access/services/authorization.service.js";
import type { WorkspaceAccessRequest } from "@/modules/tenant-access/tenant-access.types.js";
import { getTenantOrThrow } from "@/modules/tenants/services/tenant.service.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";

import {
  createTenantPaymentOnboarding,
  getTenantPaymentConnectStatus,
  getTenantPaymentDashboardLink,
} from "../services/tenant-payment-connect.service.js";
import {
  tenantPaymentConnectOnboardingSchema,
  validateTenantPaymentInput,
} from "../tenant-payment.validators.js";

const noStore = (res: Response): void => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
};

export const getCurrentTenantPaymentConnect = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const account = await getTenantPaymentConnectStatus(tenantId);
    const access = getResolvedWorkspaceAccess(req);

    noStore(res);
    res.status(200).json({
      account,
      permissions: {
        canManage: hasWorkspacePermission(
          access,
          WORKSPACE_PERMISSION.PAYMENTS_CONNECT_MANAGE,
        ),
      },
    });
  },
);

export const startCurrentTenantPaymentOnboarding = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const { locale, setupStep } = validateTenantPaymentInput(
      tenantPaymentConnectOnboardingSchema,
      req.body,
    );
    const tenant = await getTenantOrThrow(tenantId);
    const result = await createTenantPaymentOnboarding({
      tenantId,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      ownerEmail: req.userInfo?.email,
      locale,
      setupStep,
    });

    noStore(res);
    res.status(200).json(result);
  },
);

export const openCurrentTenantPaymentDashboard = asyncHandler(
  async (req: WorkspaceAccessRequest, res: Response): Promise<void> => {
    const tenantId = requireTenantId(req);
    const result = await getTenantPaymentDashboardLink(tenantId);

    noStore(res);
    res.status(200).json(result);
  },
);


