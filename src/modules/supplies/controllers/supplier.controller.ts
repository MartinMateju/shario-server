import type { Request, Response } from "express";

import { asyncHandler } from "../../../shared/http/asyncHandler.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";

import { supplierService } from "../services/supply-order.service.js";
import {
  createSupplierSchema,
  listSuppliersSchema,
  supplierIdParamsSchema,
  updateSupplierSchema,
} from "../supply-order.validators.js";

export const getSuppliers = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const input = listSuppliersSchema.parse(req.query);

    const suppliers = await supplierService.list(tenantId, input);

    res.json(suppliers);
  },
);

export const createSupplier = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const input = createSupplierSchema.parse(req.body);

    const supplier = await supplierService.create(tenantId, input);

    res.status(201).json(supplier);
  },
);

export const updateSupplier = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = supplierIdParamsSchema.parse(req.params);
    const input = updateSupplierSchema.parse(req.body);

    const supplier = await supplierService.update(tenantId, id, input);

    res.json(supplier);
  },
);

export const deleteSupplier = asyncHandler(
  async (req: Request, res: Response) => {
    const tenantId = requireTenantId(req);
    const { id } = supplierIdParamsSchema.parse(req.params);

    const result = await supplierService.deactivate(tenantId, id);

    res.json(result);
  },
);
