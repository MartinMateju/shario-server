import type { Request, Response } from "express";

import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import { badRequest, notFound } from "../../../shared/http/httpErrors.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import {
  canAccessWorkspaceLocation,
  getAllowedWorkspaceLocationIds,
} from "@/modules/tenant-access/services/authorization.service.js";
import { getResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.middleware.js";
import type { WorkspaceAccessRequest } from "@/modules/tenant-access/tenant-access.types.js";
import { eventService } from "../services/event.service.js";
import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  createEventSchema,
  eventIdParamsSchema,
  listEventsSchema,
  updateEventSchema,
} from "../event.validators.js";

type EventWithLocation = {
  location?: unknown;
};

const getEventLocationId = (event: unknown): string | null => {
  if (!event || typeof event !== "object") {
    return null;
  }

  const location = (event as EventWithLocation).location;

  return location ? String(location) : null;
};

const assertEventLocationAccess = (
  req: Request,
  locationId: string | null,
): void => {
  const access = getResolvedWorkspaceAccess(req as WorkspaceAccessRequest);

  if (!canAccessWorkspaceLocation(access, locationId)) {
    // Use 404 so an assigned-location member cannot probe another location.
    notFound("Event not found.");
  }
};


export const getEvents = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const input = listEventsSchema.parse(req.query);
    const access = getResolvedWorkspaceAccess(req as WorkspaceAccessRequest);
    const allowedLocationIds = getAllowedWorkspaceLocationIds(access);

    if (
      input.location &&
      Array.isArray(allowedLocationIds) &&
      !allowedLocationIds.includes(input.location)
    ) {
      notFound("Event not found.");
    }

    const result = await eventService.list(tenantId, input, allowedLocationIds);

    res.json(result);
  },
);

export const getEvent = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = eventIdParamsSchema.parse(req.params);

    const event = await eventService.getById(tenantId, id);
    assertEventLocationAccess(req, getEventLocationId(event));

    res.json(event);
  },
);

export const createEvent = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const createdBy = getAuthenticatedUserId(req);
    const input = createEventSchema.parse(req.body);
    assertEventLocationAccess(req, input.location);

    const event = await eventService.create(
      tenantId,
      createdBy,
      input,
    );

    res.status(201).json(event);
  },
);

export const updateEvent = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = eventIdParamsSchema.parse(req.params);
    const existing = await eventService.getById(tenantId, id);
    assertEventLocationAccess(req, getEventLocationId(existing));

    if (Object.keys(req.body || {}).length === 0) {
      badRequest("No update payload provided.");
    }

    const input = updateEventSchema.parse({
      ...req.body,
      id,
    });

    if (Object.prototype.hasOwnProperty.call(input, "location")) {
      assertEventLocationAccess(req, input.location ?? null);
    }

    const event = await eventService.update(tenantId, input);

    res.json(event);
  },
);

export const deleteEvent = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = eventIdParamsSchema.parse(req.params);
    const existing = await eventService.getById(tenantId, id);
    assertEventLocationAccess(req, getEventLocationId(existing));

    const result = await eventService.delete(tenantId, id);

    res.json(result);
  },
);
