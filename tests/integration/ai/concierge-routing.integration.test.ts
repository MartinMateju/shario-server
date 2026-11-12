import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindOne: vi.fn(),
  loadTenant: vi.fn(),
  config: vi.fn((_req, res) => res.json({ data: { enabled: true } })),
  message: vi.fn((req, res) => res.json({
    data: { answer: "Studio answer", tenantId: String(req.tenant._id) },
  })),
  unused: vi.fn((_req, res) => res.sendStatus(501)),
}));

// Only persistence and the final controllers are substituted. JWT verification,
// customer-session validation, authenticated tenant loading, and plan capability
// middleware all execute for real, in the production router's actual order.
vi.mock("@/modules/user/user.model.js", () => ({
  default: { findOne: mocks.userFindOne },
}));
vi.mock("@/modules/tenants/services/tenant.service.js", () => ({
  getTenantOrThrow: mocks.loadTenant,
}));
vi.mock("@/modules/ai/ai.controller.js", () => ({
  ...Object.fromEntries([
    "analyzeFiring", "confirmAction", "confirmAssistantAction",
    "createAssistantConversation", "dismissAction", "dismissAssistantAction",
    "firingInsight", "firingOverview", "generateBriefing", "generateBusinessAdvisor",
    "generateReportInsights", "generateStaffPlanningBriefing", "generateStaffPlanningDailyDraft",
    "getAssistantConversation", "getAction", "getCapabilities", "getBusinessAdvisorRecommendations",
    "getKnowledgeCoverage", "getProviderHealth", "getSettings", "getUsage", "latestBriefing",
    "listActions", "listAssistantConversations", "patchSettings", "publicConcierge",
    "publicConciergeConfig", "sendAssistantMessage", "submitFeedback",
  ].map((name) => [name, mocks.unused])),
  customerConcierge: mocks.message,
  customerConciergeConfig: mocks.config,
}));

import { customerAiRouter } from "@/modules/ai/ai.routes.js";
import { errorHandler } from "@/shared/http/errorHandler.js";

const TENANT_ID = "507f1f77bcf86cd799439011";
const OTHER_TENANT_ID = "507f1f77bcf86cd799439099";
const USER_ID = "507f1f77bcf86cd799439012";
let tenant: Record<string, unknown>;

const token = (overrides: Record<string, unknown> = {}) => jwt.sign({
  UserInfo: {
    id: USER_ID,
    email: "customer@example.test",
    tenant: TENANT_ID,
    authContext: "customer",
    sessionVersion: 0,
    ...overrides,
  },
}, process.env.ACCESS_TOKEN_SECRET!, { algorithm: "HS256", expiresIn: "5m" });

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  // A hostname resolver's context must never outrank the verified principal.
  if (req.get("x-unrelated-context")) {
    Object.assign(req, {
      tenant: { _id: OTHER_TENANT_ID, plan: "studio_plus", planVersion: 3 },
      tenantId: OTHER_TENANT_ID,
    });
  }
  next();
});
app.use("/ai/customer", customerAiRouter);
app.use(errorHandler);

describe("customer concierge authenticated tenant routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenant = { _id: TENANT_ID, plan: "studio_plus", planVersion: 3 };
    mocks.loadTenant.mockImplementation(async (id) => {
      if (id !== TENANT_ID) throw new Error("Unexpected tenant lookup");
      return tenant;
    });
    mocks.userFindOne.mockImplementation((filter) => ({
      select: () => ({ lean: () => ({ exec: async () => (
        filter._id === USER_ID && filter.tenant === TENANT_ID
          ? { sessionVersion: 0, isAccessGranted: true }
          : null
      ) }) }),
    }));
  });

  it("supports enabled configuration followed by the first customer message", async () => {
    const authorization = `Bearer ${token()}`;
    await request(app).get("/ai/customer/concierge/config")
      .set("Authorization", authorization)
      .expect(200, { data: { enabled: true } });
    expect(mocks.loadTenant).not.toHaveBeenCalled();

    await request(app).post("/ai/customer/concierge")
      .set("Authorization", authorization)
      .send({ message: "Kdy máte otevřeno?", locale: "cs" })
      .expect(200, { data: { answer: "Studio answer", tenantId: TENANT_ID } });
    expect(mocks.loadTenant).toHaveBeenCalledExactlyOnceWith(TENANT_ID);
    expect(mocks.message).toHaveBeenCalledOnce();
    expect(mocks.message.mock.calls[0]?.[0].tenant).toBe(tenant);
  });

  it("rejects an excluded plan even when a different tenant's context is present", async () => {
    tenant.plan = "professional";
    const response = await request(app)
      .post(`/ai/customer/concierge?tenantId=${OTHER_TENANT_ID}`)
      .set("Authorization", `Bearer ${token()}`)
      .set("x-unrelated-context", "yes")
      .send({ message: "Hello", tenantId: OTHER_TENANT_ID })
      .expect(403);
    expect(response.body.code).toBe("TENANT_PLAN_CAPABILITY_NOT_ENTITLED");
    expect(mocks.loadTenant).toHaveBeenCalledExactlyOnceWith(TENANT_ID);
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it("keeps entitled requests bound to the authenticated tenant", async () => {
    await request(app)
      .post(`/ai/customer/concierge?tenantId=${OTHER_TENANT_ID}`)
      .set("Authorization", `Bearer ${token()}`)
      .set("x-unrelated-context", "yes")
      .send({ message: "Hello" })
      .expect(200, { data: { answer: "Studio answer", tenantId: TENANT_ID } });
    expect(mocks.loadTenant).toHaveBeenCalledExactlyOnceWith(TENANT_ID);
  });

  it("rejects invalid cross-tenant identity claims before tenant or message access", async () => {
    await request(app).post("/ai/customer/concierge")
      .set("Authorization", `Bearer ${token({ tenant: OTHER_TENANT_ID })}`)
      .send({ message: "Hello" })
      .expect(401);
    expect(mocks.loadTenant).not.toHaveBeenCalled();
    expect(mocks.message).not.toHaveBeenCalled();
  });

  it("still requires a customer session before loading the tenant", async () => {
    await request(app).post("/ai/customer/concierge").send({ message: "Hello" }).expect(401);
    await request(app).post("/ai/customer/concierge")
      .set("Authorization", `Bearer ${token({ authContext: "workspace" })}`)
      .send({ message: "Hello" })
      .expect(403);
    expect(mocks.loadTenant).not.toHaveBeenCalled();
    expect(mocks.message).not.toHaveBeenCalled();
  });
});
