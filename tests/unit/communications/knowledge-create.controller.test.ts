import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(async (_context, input) => ({ _id: "article-id", ...input })),
}));

vi.mock("@/modules/auth/auth.utils.js", () => ({
  getAuthenticatedUserId: () => "user-id",
}));
vi.mock("@/modules/tenant-access/index.js", () => ({
  getResolvedWorkspaceAccess: () => ({ role: "owner" }),
  getAllowedWorkspaceLocationIds: () => null,
}));
vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: () => "tenant-id",
}));
vi.mock("@/modules/communications/services/communications.service.js", () => ({
  communicationManagementService: { createKnowledge: mocks.create },
}));
vi.mock("@/modules/communications/services/knowledge.service.js", () => ({
  knowledgePortalService: {},
}));
vi.mock("@/config/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { createWorkspaceKnowledge } from "@/modules/communications/controllers/knowledge.controller.js";
import { errorHandler } from "@/shared/http/errorHandler.js";

const payload = {
  type: "link",
  title: "Pravidla samostatné návštěvy",
  language: "cs",
  audience: "customer",
  status: "published",
  aiEnabled: true,
  sourceUrl: "https://www.atelierklei.cz/rady-a-navody/",
  videoUrl: "",
  fileUrl: "",
  content: "Pravidla samostatné návštěvy ateliéru.",
  locationIds: [],
  targetCourseIds: [],
  targetMembershipIds: [],
  targetOwnerIds: [],
};
const app = express();
app.use(express.json());
app.post("/knowledge", createWorkspaceKnowledge);
app.use(errorHandler);

beforeEach(() => mocks.create.mockClear());

describe("knowledge create URL validation", () => {
  it("accepts the Czech link form with blank irrelevant URLs unchanged", async () => {
    const response = await request(app).post("/knowledge").send(payload);
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject(payload);
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it.each([
    "not a URL",
    "https://[invalid",
    "javascript:alert(1)",
    "https://user:password@example.test/article",
    "ftp://example.test/article",
  ])(
    "returns a validation 400 for %s without calling persistence",
    async (sourceUrl) => {
      const response = await request(app)
        .post("/knowledge")
        .send({ ...payload, sourceUrl });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("VALIDATION_ERROR");
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );

  it("still rejects a missing required link URL", async () => {
    const response = await request(app)
      .post("/knowledge")
      .send({ ...payload, sourceUrl: "" });
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
