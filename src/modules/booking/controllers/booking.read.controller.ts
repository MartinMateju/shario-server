import type { Request, Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import type { ParsedQs } from "qs";
import validator from "validator";
import { z } from "zod";

import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import { badRequest, notFound } from "../../../shared/http/httpErrors.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { createUserRepository } from "@/modules/user/user.repository.js";
import { createBookingRepository } from "../booking.repository.js";
import {
  listBookingHistory,
  listBookingsWithFilters,
  listCourseBookings,
  listUserBookings,
  listVisibleBookings,
} from "../services/booking.read.service.js";
import { listCustomerBookingsForWorkspace } from "../booking.customer.service.js";
import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  getAllowedWorkspaceLocationIds,
  resolveWorkspaceAccessForUser,
} from "@/modules/tenant-access/services/authorization.service.js";

type SortOrder = "asc" | "desc";
type SortDirection = 1 | -1;

type GetBookingsByUserIdBody = {
  userId?: string;
  sortBy?: "start" | "name";
  sortOrder?: SortOrder;
};

type AuthenticatedRequest = Request & {
  userInfo?: {
    id?: string;
    email?: string;
    roles?: string[];
  };
};

type TypedBodyRequest<TBody> = Request<
  ParamsDictionary,
  unknown,
  TBody,
  ParsedQs
>;

const customerBookingHistoryParamsSchema = z.object({
  id: z
    .string()
    .trim()
    .refine((value) => validator.isMongoId(value), {
      message: "Invalid customer id.",
    }),
});

const customerBookingHistoryQuerySchema = z
  .object({
    scope: z.enum(["upcoming", "history", "all"]).default("upcoming"),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

const getLocationId = (req: Request): string | undefined => {
  const locationId = req.query.locationId;

  if (locationId === undefined) return undefined;

  if (typeof locationId === "string" && validator.isMongoId(locationId)) {
    return locationId;
  }

  badRequest("Invalid locationId.");
};

const getLocationScope = async (
  req: Request,
  tenantId: string,
  requestedLocationId?: string,
): Promise<{
  locationId?: string;
  allowedLocationIds?: readonly string[] | null;
}> => {
  const access = await resolveWorkspaceAccessForUser({
    tenantId,
    userId: getAuthenticatedUserId(req),
  });

  if (!access) {
    return { locationId: requestedLocationId };
  }

  const allowedLocationIds = getAllowedWorkspaceLocationIds(access);

  if (
    requestedLocationId &&
    Array.isArray(allowedLocationIds) &&
    !allowedLocationIds.includes(requestedLocationId)
  ) {
    notFound("Location not found.");
  }

  return {
    locationId: requestedLocationId,
    allowedLocationIds,
  };
};

export const getBookings = asyncHandler(async (req: Request, res: Response) => {
  const tenantId = requireTenantId(req);
  const scope = await getLocationScope(req, tenantId, getLocationId(req));

  const bookings = await listVisibleBookings({
    tenantId,
    ...scope,
  });

  res.json(bookings);
});

export const getBookingsHistory = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const scope = await getLocationScope(req, tenantId, getLocationId(req));

    const bookings = await listBookingHistory({
      tenantId,
      ...scope,
    });

    res.json(bookings);
  },
);

export const getCustomerBookingHistory = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id: customerId } = customerBookingHistoryParamsSchema.parse(
      req.params,
    );
    const query = customerBookingHistoryQuerySchema.parse(req.query);
    const scope = await getLocationScope(req, tenantId);

    const result = await listCustomerBookingsForWorkspace({
      tenantId,
      userId: customerId,
      allowedLocationIds: scope.allowedLocationIds,
      ...query,
    });

    res.json(result);
  },
);

export const getCourseBookings = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const scope = await getLocationScope(req, tenantId);

    const bookings = await listCourseBookings({
      tenantId,
      allowedLocationIds: scope.allowedLocationIds,
    });

    res.json(bookings);
  },
);

export const getUserBookings = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const tenantId = requireTenantId(req);

    const result = await listUserBookings({
      tenantId,
      userId: req.userInfo?.id,
    });

    res.json(result);
  },
);

export const getBookingsWithFilters = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const requestedLocationId =
      typeof req.body?.locationId === "string"
        ? req.body.locationId.trim()
        : undefined;
    const scope = await getLocationScope(
      req,
      tenantId,
      requestedLocationId,
    );

    const result = await listBookingsWithFilters({
      tenantId,
      input: {
        ...req.body,
        ...scope,
      },
    });

    res.json(result);
  },
);

export const getBookingsByUserId = asyncHandler(
  async (req: TypedBodyRequest<GetBookingsByUserIdBody>, res: Response) => {
    const tenantId = requireTenantId(req);

    const { userId, sortBy = "start", sortOrder = "asc" } = req.body;

    if (!userId) {
      badRequest("All fields are required");
    }

    if (!validator.isMongoId(userId)) {
      badRequest("Not valid user id");
    }

    const user = await createUserRepository({ tenantId }).findById(userId, {
      select: "_id",
    });

    if (!user) {
      badRequest("User not found");
    }

    const sortDirection: SortDirection = sortOrder === "asc" ? 1 : -1;
    const scope = await getLocationScope(req, tenantId);

    const sort: Record<string, SortDirection> =
      sortBy === "name"
        ? { "author.name": sortDirection }
        : { start: sortDirection };

    const bookings = await createBookingRepository({ tenantId }).find(
      {
        createdBy: userId,
        start: { $gte: new Date() },
        ...(Array.isArray(scope.allowedLocationIds)
          ? {
              location: {
                $in: scope.allowedLocationIds,
              },
            }
          : {}),
      },
      { sort },
    );

    res.json(bookings);
  },
);

export const getBookingsByProductId = asyncHandler(
  async (_req: Request, res: Response) => {
    res.status(200).json({ message: "Not implemented" });
  },
);
