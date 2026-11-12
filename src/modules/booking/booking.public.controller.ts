import type { Response } from "express";

import type { PublishedTenantRequest } from "@/modules/setup-center/setup-publication.middleware.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";
import { notFound } from "@/shared/http/httpErrors.js";

import {
  getPublicBookingAvailability,
  listPublicBookingOccupancy,
  listPublicBookingLocations,
} from "./booking.public.service.js";
import {
  publicBookingAvailabilityQuerySchema,
  publicBookingOccupancyQuerySchema,
} from "./booking.public.validators.js";

const tenantFrom = (req: PublishedTenantRequest) => {
  if (!req.tenant) {
    notFound({
      message: "Workspace not found.",
      code: "PUBLIC_WORKSPACE_NOT_FOUND",
    });
  }

  return req.tenant;
};

export const getPublicBookingLocations = asyncHandler(
  async (req: PublishedTenantRequest, res: Response): Promise<void> => {
    res.set("Cache-Control", "no-store, max-age=0");
    res.json(await listPublicBookingLocations(tenantFrom(req)));
  },
);

export const getPublicBookingSlots = asyncHandler(
  async (req: PublishedTenantRequest, res: Response): Promise<void> => {
    const query = publicBookingAvailabilityQuerySchema.parse(req.query);

    res.set("Cache-Control", "no-store, max-age=0");
    res.json(
      await getPublicBookingAvailability({
        tenant: tenantFrom(req),
        ...query,
      }),
    );
  },
);

export const getPublicBookingOccupancy = asyncHandler(
  async (req: PublishedTenantRequest, res: Response): Promise<void> => {
    const query = publicBookingOccupancyQuerySchema.parse(req.query);

    res.set("Cache-Control", "no-store, max-age=0");
    res.json(
      await listPublicBookingOccupancy({
        tenant: tenantFrom(req),
        ...query,
      }),
    );
  },
);
