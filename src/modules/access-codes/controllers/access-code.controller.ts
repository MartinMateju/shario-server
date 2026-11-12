import type { Request, Response } from "express";

import { getAuthenticatedUserId } from "@/modules/auth/auth.utils.js";
import {
  getAllowedWorkspaceLocationIds,
  getResolvedWorkspaceAccess,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import { asyncHandler } from "@/shared/http/asyncHandler.js";

import { accessCodeService } from "../services/access-code.service.js";
import {
  accessCodeIdParamsSchema,
  accessCodePoolIdParamsSchema,
  bulkCreateAccessCodesSchema,
  createAccessCodePoolSchema,
  createAccessCodeSchema,
  listAccessCodeAlertsSchema,
  listAccessCodeAuditSchema,
  listAccessCodePoolsSchema,
  listAccessCodesSchema,
  updateAccessCodePoolSchema,
  updateAccessCodeSchema,
} from "../access-code.validators.js";

const allowedLocations = (req: Request) =>
  getAllowedWorkspaceLocationIds(
    getResolvedWorkspaceAccess(req as WorkspaceAccessRequest),
  );

const auditContext = (req: Request) => ({
  actorId: getAuthenticatedUserId(req),
  ipAddress: req.ip || req.socket.remoteAddress || "",
  userAgent: req.get("user-agent") || "",
});

export const listAccessCodePools = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const result = await accessCodeService.listPools(
      requireTenantId(req),
      listAccessCodePoolsSchema.parse(req.query),
      allowedLocations(req),
    );
    res.json(result);
  },
);

export const createAccessCodePool = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const result = await accessCodeService.createPool(
      requireTenantId(req),
      createAccessCodePoolSchema.parse(req.body),
      auditContext(req),
      allowedLocations(req),
    );
    res.status(201).json(result);
  },
);

export const updateAccessCodePool = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const result = await accessCodeService.updatePool(
      requireTenantId(req),
      updateAccessCodePoolSchema.parse({
        ...req.body,
        id: req.params.poolId,
      }),
      auditContext(req),
      allowedLocations(req),
    );
    res.json(result);
  },
);

export const archiveAccessCodePool = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { poolId } = accessCodePoolIdParamsSchema.parse(req.params);
    const result = await accessCodeService.archivePool(
      requireTenantId(req),
      poolId,
      auditContext(req),
      allowedLocations(req),
    );
    res.json(result);
  },
);

export const listAccessCodes = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const result = await accessCodeService.list(
      requireTenantId(req),
      listAccessCodesSchema.parse(req.query),
      allowedLocations(req),
    );
    res.json(result);
  },
);

export const getAccessCodeById = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { id } = accessCodeIdParamsSchema.parse(req.params);
    res.json(
      await accessCodeService.getById(
        requireTenantId(req),
        id,
        allowedLocations(req),
      ),
    );
  },
);

export const createAccessCode = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const result = await accessCodeService.create(
      requireTenantId(req),
      createAccessCodeSchema.parse(req.body),
      auditContext(req),
      allowedLocations(req),
    );
    res.status(201).json(result);
  },
);

export const bulkCreateAccessCodes = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const input = bulkCreateAccessCodesSchema.parse(req.body);
    const result = await accessCodeService.bulkCreate(
      requireTenantId(req),
      input.poolId,
      input.codes,
      auditContext(req),
      allowedLocations(req),
    );
    res.status(result.failed ? 207 : 201).json(result);
  },
);

export const updateAccessCode = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const result = await accessCodeService.update(
      requireTenantId(req),
      updateAccessCodeSchema.parse({ ...req.body, id: req.params.id }),
      auditContext(req),
      allowedLocations(req),
    );
    res.json(result);
  },
);

export const retireAccessCode = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { id } = accessCodeIdParamsSchema.parse(req.params);
    const result = await accessCodeService.retire(
      requireTenantId(req),
      id,
      auditContext(req),
      allowedLocations(req),
    );
    res.json(result);
  },
);

export const revealAccessCode = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { id } = accessCodeIdParamsSchema.parse(req.params);
    res.set("Cache-Control", "private, no-store, max-age=0");
    res.set("Pragma", "no-cache");
    const result = await accessCodeService.reveal(
      requireTenantId(req),
      id,
      auditContext(req),
      allowedLocations(req),
    );
    res.json(result);
  },
);

export const listAccessCodeAlerts = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { locationId } = listAccessCodeAlertsSchema.parse(req.query);
    res.json(
      await accessCodeService.listAlerts(
        requireTenantId(req),
        locationId,
        allowedLocations(req),
      ),
    );
  },
);

export const listAccessCodeAudit = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    res.json(
      await accessCodeService.listAudit(
        requireTenantId(req),
        listAccessCodeAuditSchema.parse(req.query),
        allowedLocations(req),
      ),
    );
  },
);
