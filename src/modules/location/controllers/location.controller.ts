import type { Request, Response } from "express";

import { listCustomerBookingLocations } from "@/modules/booking/booking.public.service.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { forbidden, notFound } from "@/shared/http/httpErrors.js";
import { getTenantOrThrow } from "@/modules/tenants/services/tenant.service.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import {
  deriveCustomerTenantCapabilities,
  getEffectiveCustomerPricingMode,
  type TenantForCustomerCapabilities,
} from "@/modules/tenants/tenant-customer-capabilities.js";
import {
  canAccessWorkspaceLocation,
  getAllowedWorkspaceLocationIds,
  hasWorkspacePermission,
} from "@/modules/tenant-access/services/authorization.service.js";
import { getResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.middleware.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import type { WorkspaceAccessRequest } from "@/modules/tenant-access/tenant-access.types.js";

import { locationService } from "@/modules/location/services/location.service.js";
import {
  createLocationSchema,
  listLocationsSchema,
  locationIdParamsSchema,
  setPrimaryLocationSchema,
  updateLocationSchema,
} from "@/modules/location/location.validators.js";

const serializeWorkspaceLocation = (
  location: any,
  tenant: TenantForCustomerCapabilities,
) => ({
  ...(typeof location.toObject === "function" ? location.toObject() : location),
  pricingMode: getEffectiveCustomerPricingMode(undefined, location),
  inheritedPricingMode: getEffectiveCustomerPricingMode(tenant),
  effectivePricingMode: getEffectiveCustomerPricingMode(tenant, location),
  customerCapabilities: deriveCustomerTenantCapabilities(tenant, location),
});

const workspaceLocationResponse = async (tenantId: string, location: any) =>
  serializeWorkspaceLocation(location, await getTenantOrThrow(tenantId));

export const getCustomerLocations = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const tenant = await getTenantOrThrow(requireTenantId(req));
    const result = await listCustomerBookingLocations(tenant);

    res.set("Cache-Control", "private, no-store, max-age=0");
    res.status(200).json(result);
  },
);

export const getLocations = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const filters = listLocationsSchema.parse(req.query);
    const access = getResolvedWorkspaceAccess(req as WorkspaceAccessRequest);

    const result = await locationService.list({
      tenantId,
      ...filters,
      allowedLocationIds: getAllowedWorkspaceLocationIds(access),
    });

    const tenant = await getTenantOrThrow(tenantId);
    res.json({
      ...result,
      inheritedPricingMode: getEffectiveCustomerPricingMode(tenant),
      locations: result.locations.map((location) =>
        serializeWorkspaceLocation(location, tenant),
      ),
    });
  },
);

export const getLocationById = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = locationIdParamsSchema.parse(req.params);
    const access = getResolvedWorkspaceAccess(req as WorkspaceAccessRequest);

    if (!canAccessWorkspaceLocation(access, id)) {
      notFound("Studio location not found.");
    }

    const includePrivateAccess = req.query.includePrivateAccess === "true";

    if (includePrivateAccess) {
      if (
        !hasWorkspacePermission(access, WORKSPACE_PERMISSION.LOCATIONS_MANAGE)
      ) {
        forbidden(
          "You do not have permission to view private location access details.",
        );
      }
    }

    const location = await locationService.getById(
      tenantId,
      id,
      includePrivateAccess,
    );

    res.json(await workspaceLocationResponse(tenantId, location));
  },
);

export const bootstrapLocation = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const location = await locationService.bootstrap(tenantId);

    res.status(200).json(await workspaceLocationResponse(tenantId, location));
  },
);

export const createLocation = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const input = createLocationSchema.parse(req.body);

    const location = await locationService.create(tenantId, input);

    res.status(201).json(await workspaceLocationResponse(tenantId, location));
  },
);

export const updateLocation = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = locationIdParamsSchema.parse(req.params);
    const input = updateLocationSchema.parse({
      ...req.body,
      id,
    });

    const location = await locationService.update(tenantId, input);

    res.json(await workspaceLocationResponse(tenantId, location));
  },
);

export const setPrimaryLocation = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = setPrimaryLocationSchema.parse(req.params);

    const location = await locationService.setPrimary(tenantId, id);

    res.json(await workspaceLocationResponse(tenantId, location));
  },
);

export const deactivateLocation = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = locationIdParamsSchema.parse(req.params);

    const location = await locationService.deactivate(tenantId, id);

    res.json(await workspaceLocationResponse(tenantId, location));
  },
);

export const activateLocation = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = locationIdParamsSchema.parse(req.params);

    const location = await locationService.activate(tenantId, id);

    res.json(await workspaceLocationResponse(tenantId, location));
  },
);

export const deleteLocation = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = locationIdParamsSchema.parse(req.params);

    await locationService.delete(tenantId, id);

    res.json({ message: "Studio location archived." });
  },
);
