import { describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => {
  const verifyJWT = vi.fn((_req, _res, next) => next());
  const requireWorkspaceAccess = vi.fn((_req, _res, next) => next());
  const requirePermission = vi.fn((...permissions: string[]) => {
    const middleware = (_req: unknown, _res: unknown, next: () => void) =>
      next();
    Object.assign(middleware, { workspacePermissions: permissions });
    return middleware;
  });
  const requireAnyPermission = vi.fn((...permissions: string[]) => {
    const middleware = (_req: unknown, _res: unknown, next: () => void) =>
      next();
    Object.assign(middleware, { workspacePermissions: permissions });
    return middleware;
  });
  const publicLookupLimiter = vi.fn((_req, _res, next) => next());
  const publicMessageLimiter = vi.fn((_req, _res, next) => next());
  const workspaceMessageLimiter = vi.fn((_req, _res, next) => next());
  const workspaceBriefingLimiter = vi.fn((_req, _res, next) => next());
  const loadPublishedTenant = vi.fn((_req, _res, next) => next());
  const requireTenantModule = vi.fn((_module: string) =>
    vi.fn((_req, _res, next) => next()),
  );
  return {
    verifyJWT,
    requireWorkspaceAccess,
    requirePermission,
    requireAnyPermission,
    publicLookupLimiter,
    publicMessageLimiter,
    workspaceMessageLimiter,
    workspaceBriefingLimiter,
    loadPublishedTenant,
    requireTenantModule,
    handler: vi.fn(),
  };
});

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: routeMocks.verifyJWT,
}));
vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requireWorkspaceAccess: routeMocks.requireWorkspaceAccess,
  requirePermission: routeMocks.requirePermission,
  requireAnyPermission: routeMocks.requireAnyPermission,
}));
vi.mock("@/modules/ai/ai.limiter.js", () => ({
  publicAiLookupLimiter: routeMocks.publicLookupLimiter,
  publicAiMessageLimiter: routeMocks.publicMessageLimiter,
  workspaceAiBriefingLimiter: routeMocks.workspaceBriefingLimiter,
  workspaceAiMessageLimiter: routeMocks.workspaceMessageLimiter,
}));
vi.mock("@/modules/setup-center/setup-publication.middleware.js", () => ({
  loadPublishedTenant: routeMocks.loadPublishedTenant,
}));
vi.mock("@/modules/tenants/middleware/requireTenantModule.js", () => ({
  requireTenantModule: routeMocks.requireTenantModule,
}));
vi.mock("@/modules/ai/ai.controller.js", () => ({
  analyzeFiring: routeMocks.handler,
  confirmAction: routeMocks.handler,
  confirmAssistantAction: routeMocks.handler,
  createAssistantConversation: routeMocks.handler,
  customerConcierge: routeMocks.handler,
  customerConciergeConfig: routeMocks.handler,
  dismissAction: routeMocks.handler,
  dismissAssistantAction: routeMocks.handler,
  firingInsight: routeMocks.handler,
  firingOverview: routeMocks.handler,
  generateBriefing: routeMocks.handler,
  generateBusinessAdvisor: routeMocks.handler,
  generateReportInsights: routeMocks.handler,
  generateStaffPlanningBriefing: routeMocks.handler,
  generateStaffPlanningDailyDraft: routeMocks.handler,
  getAssistantConversation: routeMocks.handler,
  getAction: routeMocks.handler,
  getCapabilities: routeMocks.handler,
  getBusinessAdvisorRecommendations: routeMocks.handler,
  getKnowledgeCoverage: routeMocks.handler,
  getProviderHealth: routeMocks.handler,
  getSettings: routeMocks.handler,
  getUsage: routeMocks.handler,
  latestBriefing: routeMocks.handler,
  listActions: routeMocks.handler,
  listAssistantConversations: routeMocks.handler,
  patchSettings: routeMocks.handler,
  publicConcierge: routeMocks.handler,
  publicConciergeConfig: routeMocks.handler,
  sendAssistantMessage: routeMocks.handler,
  submitFeedback: routeMocks.handler,
}));

import {
  aiRouter,
  customerAiRouter,
  publicAiRouter,
} from "@/modules/ai/ai.routes.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

type RouterLayer = {
  handle: unknown;
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{
      handle: {
        workspacePermissions?: string[];
      };
    }>;
  };
};

const findRoute = (
  router: { stack: RouterLayer[] },
  path: string,
  method: string,
) => {
  const layer = router.stack.find(
    (candidate) =>
      candidate.route?.path === path && candidate.route.methods[method],
  );
  expect(
    layer,
    `${method.toUpperCase()} ${path} must be registered`,
  ).toBeDefined();
  return layer!;
};

const permissionsFor = (path: string, method: string): string[] =>
  findRoute(
    aiRouter as unknown as { stack: RouterLayer[] },
    path,
    method,
  ).route!.stack.flatMap(({ handle }) => handle.workspacePermissions || []);

describe("AI route authorization", () => {
  it.each([
    ["/capabilities", "get"],
    ["/knowledge/coverage", "get"],
    ["/assistant/conversations", "get"],
    ["/assistant/conversations", "post"],
    ["/assistant/conversations/:id", "get"],
    ["/assistant/conversations/:id/messages", "post"],
    ["/assistant/conversations/:id/actions/:actionId/confirm", "post"],
    ["/assistant/conversations/:id/actions/:actionId/dismiss", "post"],
    ["/actions", "get"],
    ["/actions/:actionId", "get"],
    ["/actions/:actionId/confirm", "post"],
    ["/actions/:actionId/dismiss", "post"],
    ["/briefings/latest", "get"],
    ["/briefings/generate", "post"],
    ["/advisor/recommendations", "get"],
    ["/advisor/generate", "post"],
    ["/reports/briefing", "post"],
    ["/staff-planning/daily-draft", "post"],
    ["/staff-planning/briefing", "post"],
    ["/settings", "get"],
    ["/feedback", "post"],
  ] as const)("requires AI use for %s %s", (path, method) => {
    expect(permissionsFor(path, method)).toContain(WORKSPACE_PERMISSION.AI_USE);
  });

  it("rate-limits authenticated assistant messages before execution", () => {
    const handles = findRoute(
      aiRouter as unknown as { stack: RouterLayer[] },
      "/assistant/conversations/:id/messages",
      "post",
    ).route!.stack.map(({ handle }) => handle);

    expect(handles).toContain(routeMocks.workspaceMessageLimiter);
  });

  it("rate-limits proactive briefing generation before execution", () => {
    const handles = findRoute(
      aiRouter as unknown as { stack: RouterLayer[] },
      "/briefings/generate",
      "post",
    ).route!.stack.map(({ handle }) => handle);

    expect(handles).toContain(routeMocks.workspaceBriefingLimiter);
  });

  it("rate-limits explicit Business Advisor generation before execution", () => {
    const handles = findRoute(
      aiRouter as unknown as { stack: RouterLayer[] },
      "/advisor/generate",
      "post",
    ).route!.stack.map(({ handle }) => handle);

    expect(handles).toContain(routeMocks.workspaceBriefingLimiter);
  });

  it("allows AI settings managers to inspect capabilities without granting AI execution", () => {
    expect(permissionsFor("/capabilities", "get")).toEqual([
      WORKSPACE_PERMISSION.AI_USE,
      WORKSPACE_PERMISSION.AI_SETTINGS_MANAGE,
    ]);
    expect(permissionsFor("/settings", "get")).toEqual([
      WORKSPACE_PERMISSION.AI_USE,
      WORKSPACE_PERMISSION.AI_SETTINGS_MANAGE,
    ]);
  });

  it("requires report visibility in addition to AI use for report briefings", () => {
    expect(permissionsFor("/reports/briefing", "post")).toEqual([
      WORKSPACE_PERMISSION.AI_USE,
      WORKSPACE_PERMISSION.REPORTS_VIEW,
    ]);
  });

  it("requires Knowledge Hub visibility for coverage diagnostics", () => {
    expect(permissionsFor("/knowledge/coverage", "get")).toEqual([
      WORKSPACE_PERMISSION.AI_USE,
      WORKSPACE_PERMISSION.KNOWLEDGE_VIEW,
    ]);
  });

  it.each([
    ["/advisor/recommendations", "get"],
    ["/advisor/generate", "post"],
  ] as const)(
    "requires report visibility for Business Advisor %s",
    (path, method) => {
      expect(permissionsFor(path, method)).toEqual([
        WORKSPACE_PERMISSION.AI_USE,
        WORKSPACE_PERMISSION.REPORTS_VIEW,
      ]);
    },
  );

  it("separates personal staff drafts from team planning briefings", () => {
    expect(permissionsFor("/staff-planning/daily-draft", "post")).toEqual([
      WORKSPACE_PERMISSION.AI_USE,
      WORKSPACE_PERMISSION.PLANNING_SUBMIT,
      WORKSPACE_PERMISSION.TASKS_VIEW,
    ]);
    expect(permissionsFor("/staff-planning/briefing", "post")).toEqual([
      WORKSPACE_PERMISSION.AI_USE,
      WORKSPACE_PERMISSION.PLANNING_TEAM_VIEW,
      WORKSPACE_PERMISSION.PLANNING_MANAGE,
    ]);
  });

  it("allows audit or settings managers to inspect tenant usage", () => {
    expect(permissionsFor("/usage", "get")).toEqual([
      WORKSPACE_PERMISSION.AI_AUDIT_VIEW,
      WORKSPACE_PERMISSION.AI_SETTINGS_MANAGE,
    ]);
  });

  it("allows only audit or settings managers to inspect provider health", () => {
    expect(permissionsFor("/provider-health", "get")).toEqual([
      WORKSPACE_PERMISSION.AI_AUDIT_VIEW,
      WORKSPACE_PERMISSION.AI_SETTINGS_MANAGE,
    ]);
  });

  it.each([
    ["/firings/overview", "get"],
    ["/firings/:firingId/insight", "get"],
    ["/firings/:firingId/analyze", "post"],
  ] as const)(
    "does not expose the removed firing intelligence route %s",
    (path, method) => {
      expect(
        aiRouter.stack.some(
          (layer: any) =>
            layer.route?.path === path && layer.route.methods[method],
        ),
      ).toBe(false);
    },
  );

  it("requires AI settings management rather than ordinary AI use for settings mutation", () => {
    expect(permissionsFor("/settings", "patch")).toEqual([
      WORKSPACE_PERMISSION.AI_SETTINGS_MANAGE,
    ]);
  });

  it("keeps authenticated customer concierge on its own router without workspace permissions", () => {
    const stack = customerAiRouter.stack as unknown as RouterLayer[];
    const config = findRoute(
      customerAiRouter as unknown as { stack: RouterLayer[] },
      "/concierge/config",
      "get",
    );
    const message = findRoute(
      customerAiRouter as unknown as { stack: RouterLayer[] },
      "/concierge",
      "post",
    );

    expect(stack.some((layer) => layer.handle === routeMocks.verifyJWT)).toBe(
      true,
    );
    expect(
      stack.some((layer) => layer.handle === routeMocks.requireWorkspaceAccess),
    ).toBe(false);
    expect(
      config.route!.stack.flatMap(
        ({ handle }) => handle.workspacePermissions || [],
      ),
    ).toEqual([]);
    expect(
      message.route!.stack.flatMap(
        ({ handle }) => handle.workspacePermissions || [],
      ),
    ).toEqual([]);
  });

  it("rate-limits both unauthenticated public concierge discovery and messages", () => {
    const config = findRoute(
      publicAiRouter as unknown as { stack: RouterLayer[] },
      "/tenants/:tenantSlug/ai/concierge/config",
      "get",
    );
    const message = findRoute(
      publicAiRouter as unknown as { stack: RouterLayer[] },
      "/tenants/:tenantSlug/ai/concierge",
      "post",
    );

    expect(
      config.route!.stack.some(
        ({ handle }) => handle === routeMocks.publicLookupLimiter,
      ),
    ).toBe(true);
    expect(
      message.route!.stack.some(
        ({ handle }) => handle === routeMocks.publicMessageLimiter,
      ),
    ).toBe(true);
  });
});
