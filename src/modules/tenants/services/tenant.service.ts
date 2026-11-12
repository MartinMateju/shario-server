import type { ClientSession } from "mongoose";

import { notFound } from "@/shared/http/httpErrors.js";
import { applyPlanToTenant } from "../tenant.utils.js";
import {
  createTenant,
  findActiveTenantByHostname,
  findTenantById,
  findTenantBySlug,
  type CreateTenantInput,
} from "../tenant.repository.js";
import type { TenantDocument, TenantPlan } from "../tenant.types.js";

type TenantServiceOptions = {
  session?: ClientSession | null;
  planVersion?: number;
};

export const getTenantOrThrow = async (
  tenantId: string,
  options: TenantServiceOptions = {},
): Promise<TenantDocument> => {
  const tenant = await findTenantById(tenantId, options);

  if (!tenant) {
    return notFound("Tenant not found");
  }

  return tenant;
};

export const getTenantBySlug = async (
  slug: string,
  options: TenantServiceOptions = {},
): Promise<TenantDocument | null> => {
  return findTenantBySlug(slug, options);
};

export const getTenantByHostname = async (
  hostname: string,
  options: TenantServiceOptions = {},
): Promise<TenantDocument | null> => {
  return findActiveTenantByHostname(hostname, options);
};

export const createTenantWithPlan = async (
  input: CreateTenantInput,
  options: TenantServiceOptions = {},
): Promise<TenantDocument> => {
  const tenant = await createTenant(input, options);

  if (input.plan) {
    await updateTenantPlan(tenant, input.plan, options);
  }

  return tenant;
};

export const updateTenantPlan = async (
  tenant: TenantDocument,
  plan: TenantPlan,
  options: TenantServiceOptions = {},
): Promise<TenantDocument> => {
  applyPlanToTenant(tenant, plan, options.planVersion);

  await tenant.save(
    options.session ? { session: options.session } : undefined,
  );

  return tenant;
};
