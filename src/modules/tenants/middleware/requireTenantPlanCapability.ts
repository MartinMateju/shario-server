import type { NextFunction, Response } from "express";

import { getPlanConfig, type PlanCapabilities } from "../tenant.plan.js";
import type { RequestWithTenant } from "../tenant.types.js";

type BooleanCapabilityKeys<T> = {
  [K in keyof T]-?: Exclude<T[K], undefined> extends boolean ? K : never;
}[keyof T];

export type TenantOperationCapability = BooleanCapabilityKeys<
  PlanCapabilities["operations"]
>;
export type TenantAiCapability = BooleanCapabilityKeys<PlanCapabilities["ai"]>;
export type TenantCommunicationCapability = BooleanCapabilityKeys<
  PlanCapabilities["communications"]
>;

const requireTenantBooleanCapability = (
  section: "operations" | "ai" | "communications",
  capability: string,
  minimumPlanVersion: number,
) => {
  return (req: RequestWithTenant, res: Response, next: NextFunction): void => {
    if (!req.tenant) {
      res.status(400).json({ message: "Tenant context is required." });
      return;
    }

    const planVersion = Number(req.tenant.planVersion ?? 1);
    if (planVersion < minimumPlanVersion) {
      next();
      return;
    }

    const capabilities = getPlanConfig(req.tenant.plan, planVersion)
      .capabilities?.[section] as Record<string, unknown> | undefined;

    if (capabilities?.[capability] === false) {
      res.status(403).json({
        message: `The "${capability}" capability is not included in the current plan.`,
        code: "TENANT_PLAN_CAPABILITY_NOT_ENTITLED",
        details: {
          capability,
          currentPlan: req.tenant.plan,
          planVersion,
        },
        currentPlan: req.tenant.plan,
      });
      return;
    }

    next();
  };
};

/**
 * Gates a granular operation that cannot be represented by a whole module.
 * Historical V1 plans have no capability contract and retain their legacy
 * behavior; V2/V3 explicitly opt individual operations in or out.
 */
export const requireTenantOperationCapability = (
  capability: TenantOperationCapability,
) => requireTenantBooleanCapability("operations", capability, 1);

/** V3 is the first version that enforces granular AI product tiers. */
export const requireTenantAiCapability = (capability: TenantAiCapability) =>
  requireTenantBooleanCapability("ai", capability, 3);

/** Preserve historical messaging access while enforcing the V3 inbox tiers. */
export const requireTenantCommunicationCapability = (
  capability: TenantCommunicationCapability,
) => requireTenantBooleanCapability("communications", capability, 3);
