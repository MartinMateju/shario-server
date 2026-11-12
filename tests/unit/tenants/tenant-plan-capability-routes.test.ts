import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { requireTenantAiCapability } from "@/modules/tenants/middleware/requireTenantPlanCapability.js";
import { requireTenantModule } from "@/modules/tenants/middleware/requireTenantModule.js";
import {
  TENANT_MODULE,
  TENANT_PLAN,
} from "@/modules/tenants/tenant.constants.js";

const source = (relativeUrl: string) =>
  readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), "utf8");

describe("granular V3 operation gates", () => {
  const aiRoutes = source("../../../src/modules/ai/ai.routes.ts");
  const knowledgeRoutes = source(
    "../../../src/modules/communications/routes/knowledge.routes.ts",
  );

  it("enforces V3 AI tiers while preserving historical behavior", () => {
    const gate = requireTenantAiCapability("knowledgeHub");
    const run = (plan: string, planVersion: number) => {
      const next = vi.fn();
      const response = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };
      gate({ tenant: { plan, planVersion } } as never, response as never, next);
      return { next, response };
    };

    expect(run(TENANT_PLAN.STARTER, 3).response.status).toHaveBeenCalledWith(
      403,
    );
    expect(run(TENANT_PLAN.PROFESSIONAL, 3).next).toHaveBeenCalledOnce();
    expect(run(TENANT_PLAN.STUDIO_PLUS, 3).next).toHaveBeenCalledOnce();
    expect(run(TENANT_PLAN.STUDIO_PLUS, 2).next).toHaveBeenCalledOnce();
  });

  it.each([
    "knowledgeAwareCustomerAssistant",
    "commandCenter",
    "businessAdvisor",
    "crossLocationInsights",
  ] as const)("keeps Professional's unrelated %s restriction", (capability) => {
    const next = vi.fn();
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    requireTenantAiCapability(capability)(
      { tenant: { plan: TENANT_PLAN.PROFESSIONAL, planVersion: 3 } } as never,
      response as never,
      next,
    );
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("gates Knowledge Hub, concierge, briefings and advanced AI actions", () => {
    expect(
      knowledgeRoutes.match(/knowledgeHub/g)?.length,
    ).toBeGreaterThanOrEqual(5);
    for (const gate of [
      "knowledgeAwareCustomerAssistant",
      "dailyStudioBriefing",
      "commandCenter",
      "businessAdvisor",
    ]) {
      expect(aiRoutes).toContain(gate);
    }
    expect(aiRoutes).not.toContain("/firings/");
    expect(knowledgeRoutes.match(/aiModule/g)?.length).toBeGreaterThanOrEqual(
      6,
    );
  });

  it("keeps Knowledge Hub off when an entitled workspace disables AI", () => {
    const next = vi.fn();
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    requireTenantModule(TENANT_MODULE.AI)(
      {
        tenant: {
          plan: TENANT_PLAN.STUDIO_PLUS,
          planVersion: 3,
          modules: { [TENANT_MODULE.AI]: false },
        },
      } as never,
      response as never,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
  });
});
