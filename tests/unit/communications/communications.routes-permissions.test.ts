import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const routeMocks = vi.hoisted(() => ({
  requireAnyPermission: vi.fn((...permissions: string[]) => {
    const middleware = (_req: unknown, _res: unknown, next: () => void) =>
      next();
    Object.assign(middleware, { workspacePermissions: permissions });
    return middleware;
  }),
  requirePermission: vi.fn((permission: string) => {
    const middleware = (_req: unknown, _res: unknown, next: () => void) =>
      next();
    Object.assign(middleware, { workspacePermission: permission });
    return middleware;
  }),
  handler: vi.fn(),
  verifyJwt: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: routeMocks.verifyJwt,
}));

vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requireAnyPermission: routeMocks.requireAnyPermission,
  requirePermission: routeMocks.requirePermission,
}));

vi.mock(
  "@/modules/communications/controllers/communications.controller.js",
  () => ({
    addConversationNote: routeMocks.handler,
    analyzeConversation: routeMocks.handler,
    assignConversation: routeMocks.handler,
    beginInstagramConnection: routeMocks.handler,
    composeMessage: routeMocks.handler,
    createConversation: routeMocks.handler,
    createCustomerFromConversation: routeMocks.handler,
    createKnowledge: routeMocks.handler,
    createRoutingRule: routeMocks.handler,
    createTaskFromConversation: routeMocks.handler,
    decideConversationAction: routeMocks.handler,
    deleteKnowledge: routeMocks.handler,
    deleteRoutingRule: routeMocks.handler,
    disconnectInstagramConnection: routeMocks.handler,
    draftConversationReply: routeMocks.handler,
    fallbackDelivery: routeMocks.handler,
    getCommunicationOverview: routeMocks.handler,
    getCommunicationSettings: routeMocks.handler,
    getConversation: routeMocks.handler,
    getKnowledge: routeMocks.handler,
    getCustomerCommunicationTimeline: routeMocks.handler,
    getCustomerConsents: routeMocks.handler,
    getSatisfactionAnalytics: routeMocks.handler,
    listCommunicationAudit: routeMocks.handler,
    listConversationMessages: routeMocks.handler,
    listConversations: routeMocks.handler,
    listKnowledge: routeMocks.handler,
    listRoutingRules: routeMocks.handler,
    replyToConversation: routeMocks.handler,
    resolveConversation: routeMocks.handler,
    retryDelivery: routeMocks.handler,
    runCommunicationRetention: routeMocks.handler,
    transcribeMessage: routeMocks.handler,
    translateMessage: routeMocks.handler,
    updateCommunicationSettings: routeMocks.handler,
    updateConversation: routeMocks.handler,
    updateCustomerConsents: routeMocks.handler,
    updateKnowledge: routeMocks.handler,
    updateRoutingRule: routeMocks.handler,
  }),
);

import communicationsRouter from "@/modules/communications/routes/communications.routes.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";

type RouterLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{
      method?: string;
      handle: {
        workspacePermission?: string;
        workspacePermissions?: string[];
      };
    }>;
  };
};

const permissionsFor = (path: string, method: string): string[] => {
  const layer = (communicationsRouter.stack as unknown as RouterLayer[]).find(
    (candidate) =>
      candidate.route?.path === path && candidate.route.methods[method],
  );
  expect(
    layer,
    `${method.toUpperCase()} ${path} must be registered`,
  ).toBeDefined();
  return (
    layer?.route?.stack
      .filter((entry) => !entry.method || entry.method === method)
      .flatMap(({ handle }) => [
        ...(handle.workspacePermissions ?? []),
        ...(handle.workspacePermission ? [handle.workspacePermission] : []),
      ]) ?? []
  );
};

const expectAnyPermission = (
  path: string,
  method: string,
  permission: string,
) => {
  expect(permissionsFor(path, method)).toEqual(
    expect.arrayContaining([
      permission,
      WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
    ]),
  );
};

describe("communications route authorization", () => {
  const tenantApp = (plan: string, planVersion = 3, ai = true) => {
    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, { tenant: { plan, planVersion, modules: { ai } } });
      next();
    });
    app.use(communicationsRouter);
    routeMocks.handler.mockImplementation((_req, res) =>
      res.json({ ok: true }),
    );
    return app;
  };

  it.each([
    ["get", "/knowledge"],
    ["post", "/knowledge"],
    ["get", "/knowledge/article-id"],
    ["patch", "/knowledge/article-id"],
    ["delete", "/knowledge/article-id"],
  ] as const)(
    "rejects Starter knowledge aliases: %s %s",
    async (method, path) => {
      const response = await request(tenantApp("starter"))[method](path);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        code: "TENANT_PLAN_CAPABILITY_NOT_ENTITLED",
        details: { capability: "knowledgeHub" },
      });
    },
  );

  it("allows entitled knowledge aliases while retaining the AI module switch", async () => {
    await request(tenantApp("professional")).get("/knowledge").expect(200);
    const disabled = await request(tenantApp("professional", 3, false))
      .get("/knowledge")
      .expect(403);
    expect(disabled.body).toMatchObject({ code: "TENANT_MODULE_DISABLED" });
  });

  it.each([
    ["get", "/overview"],
    ["post", "/compose"],
    ["get", "/conversations"],
    ["post", "/conversations/id/reply"],
    ["post", "/messages/id/translate"],
    ["post", "/deliveries/id/retry"],
    ["get", "/customers/id/timeline"],
    ["get", "/routing-rules"],
    ["get", "/audit"],
    ["get", "/satisfaction"],
  ] as const)(
    "requires the V3 Inbox entitlement: %s %s",
    async (method, path) => {
      const response = await request(tenantApp("starter"))[method](path);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        code: "TENANT_PLAN_CAPABILITY_NOT_ENTITLED",
        details: { capability: "unifiedInbox" },
      });
    },
  );

  it.each([
    ["starter", 1],
    ["starter", 2],
    ["professional", 3],
    ["studio_plus", 3],
    ["enterprise", 3],
  ])("preserves %s V%s Inbox access", async (plan, version) => {
    await request(tenantApp(plan, version)).get("/conversations").expect(200);
  });

  it("keeps consent, sender settings and retention manageable without Inbox entitlement", async () => {
    const app = tenantApp("starter");
    await request(app).get("/consents/customer-id").expect(200);
    await request(app).get("/settings").expect(200);
    await request(app).post("/retention/run").expect(200);
  });

  it.each([
    ["/overview", "get"],
    ["/conversations", "get"],
    ["/conversations/:id", "get"],
    ["/conversations/:id/messages", "get"],
    ["/customers/:customerId/timeline", "get"],
    ["/consents/:customerId", "get"],
  ] as const)("requires inbox view for %s %s", (path, method) => {
    expectAnyPermission(path, method, WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW);
  });

  it.each([
    ["/compose", "post"],
    ["/conversations", "post"],
    ["/conversations/:id/reply", "post"],
    ["/conversations/:id/notes", "post"],
    ["/conversations/:id/ai/analyze", "post"],
    ["/conversations/:id/ai/draft", "post"],
    ["/messages/:id/translate", "post"],
    ["/messages/:id/transcribe", "post"],
    ["/deliveries/:id/retry", "post"],
    ["/deliveries/:id/fallback", "post"],
  ] as const)("requires send for %s %s", (path, method) => {
    expectAnyPermission(path, method, WORKSPACE_PERMISSION.COMMUNICATIONS_SEND);
  });

  it.each([
    ["/conversations/:id", "patch"],
    ["/conversations/:id/assign", "post"],
    ["/conversations/:id/resolve", "post"],
    ["/conversations/:id/actions/:actionId", "post"],
  ] as const)("requires assign for %s %s", (path, method) => {
    expectAnyPermission(
      path,
      method,
      WORKSPACE_PERMISSION.COMMUNICATIONS_ASSIGN,
    );
  });

  it.each([
    ["/consents/:customerId", "put"],
    ["/routing-rules", "get"],
    ["/routing-rules", "post"],
    ["/routing-rules/:id", "patch"],
    ["/routing-rules/:id", "delete"],
    ["/settings", "get"],
    ["/settings", "patch"],
    ["/retention/run", "post"],
  ] as const)("requires settings management for %s %s", (path, method) => {
    expectAnyPermission(
      path,
      method,
      WORKSPACE_PERMISSION.COMMUNICATIONS_SETTINGS_MANAGE,
    );
  });

  it.each([
    ["/audit", "get"],
    ["/satisfaction", "get"],
  ] as const)("requires audit visibility for %s %s", (path, method) => {
    expectAnyPermission(
      path,
      method,
      WORKSPACE_PERMISSION.COMMUNICATIONS_AUDIT_VIEW,
    );
  });

  it("uses dedicated knowledge permissions instead of inbox/settings permissions", () => {
    expect(permissionsFor("/knowledge", "get")).toEqual([
      WORKSPACE_PERMISSION.KNOWLEDGE_VIEW,
    ]);
    expect(permissionsFor("/knowledge/:id", "get")).toEqual([
      WORKSPACE_PERMISSION.KNOWLEDGE_VIEW,
    ]);
    for (const [path, method] of [
      ["/knowledge", "post"],
      ["/knowledge/:id", "patch"],
      ["/knowledge/:id", "delete"],
    ] as const) {
      expect(permissionsFor(path, method)).toEqual([
        WORKSPACE_PERMISSION.KNOWLEDGE_MANAGE,
      ]);
    }
  });

  it.each([
    ["/conversations/:id/ai/analyze", "post"],
    ["/conversations/:id/ai/draft", "post"],
    ["/messages/:id/translate", "post"],
    ["/messages/:id/transcribe", "post"],
  ] as const)(
    "also requires AI entitlement permission for %s",
    (path, method) => {
      expect(permissionsFor(path, method)).toContain(
        WORKSPACE_PERMISSION.AI_USE,
      );
    },
  );

  it("requires both send and task management for inbox-to-task conversion", () => {
    expect(permissionsFor("/conversations/:id/task", "post")).toEqual(
      expect.arrayContaining([
        WORKSPACE_PERMISSION.COMMUNICATIONS_SEND,
        WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
        WORKSPACE_PERMISSION.TASKS_MANAGE,
      ]),
    );
  });

  it("requires both assignment and customer management to create a matched customer", () => {
    expect(permissionsFor("/conversations/:id/customer", "post")).toEqual(
      expect.arrayContaining([
        WORKSPACE_PERMISSION.COMMUNICATIONS_ASSIGN,
        WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
        WORKSPACE_PERMISSION.CUSTOMERS_MANAGE,
      ]),
    );
  });

  it("requires task management before approving a create-task AI action", () => {
    expect(
      permissionsFor("/conversations/:id/actions/:actionId", "post"),
    ).toEqual(
      expect.arrayContaining([
        WORKSPACE_PERMISSION.COMMUNICATIONS_ASSIGN,
        WORKSPACE_PERMISSION.COMMUNICATIONS_MANAGE,
        WORKSPACE_PERMISSION.TASKS_MANAGE,
      ]),
    );
  });
});
