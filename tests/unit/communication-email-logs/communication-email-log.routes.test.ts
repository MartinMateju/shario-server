import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  retry: vi.fn(),
  list: vi.fn(),
  tenant: "507f1f77bcf86cd799439011",
  actor: "507f1f77bcf86cd799439012",
  locations: ["507f1f77bcf86cd799439013"],
}));
vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: (req, res, next) =>
    req.headers.authorization === "test-session"
      ? next()
      : res.status(401).json({ code: "UNAUTHORIZED" }),
}));
vi.mock("@/modules/auth/auth.utils.js", () => ({
  getAuthenticatedUserId: () => state.actor,
}));
vi.mock("@/modules/tenants/tenant.utils.js", () => ({
  requireTenantId: () => state.tenant,
}));
vi.mock("@/modules/tenant-access/index.js", () => ({
  getResolvedWorkspaceAccess: () => ({}),
  getAllowedWorkspaceLocationIds: () => state.locations,
}));
vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => {
  const guard =
    (...permissions: string[]) =>
    (req, res, next) =>
      permissions.some((value) =>
        String(req.headers["x-permissions"] || "")
          .split(",")
          .includes(value),
      )
        ? next()
        : res.status(403).json({ code: "FORBIDDEN" });
  return { requirePermission: guard, requireAnyPermission: guard };
});
vi.mock(
  "@/modules/communication-email-logs/services/communication-email-log-retry.service.js",
  () => ({ retryCommunicationEmailLog: state.retry }),
);
vi.mock(
  "@/modules/communication-email-logs/services/communication-email-log.service.js",
  () => ({ communicationEmailLogService: { list: state.list } }),
);
import router from "@/modules/communication-email-logs/routes/communication-email-log.routes.js";

const logId = "507f1f77bcf86cd799439014";
const app = express();
app.use(express.json());
app.use("/communication-email-logs", router);
app.use((error, _req, res, _next) =>
  res
    .status(error.statusCode || 400)
    .json({ code: error.code || "INVALID_INPUT", details: error.details }),
);

beforeEach(() => {
  vi.clearAllMocks();
  state.retry.mockResolvedValue({
    log: { _id: logId, status: "queued", canRetry: false },
    queued: true,
  });
  state.list.mockResolvedValue({ logs: [] });
});

describe("communication email history retry route", () => {
  it("requires authentication and sending permission, not just history viewing", async () => {
    await request(app)
      .post(`/communication-email-logs/${logId}/retry`)
      .send({ expectedManualRetryCount: 0 })
      .expect(401);
    await request(app)
      .post(`/communication-email-logs/${logId}/retry`)
      .set("authorization", "test-session")
      .set("x-permissions", "communications.view")
      .send({ expectedManualRetryCount: 0 })
      .expect(403);
    expect(state.retry).not.toHaveBeenCalled();
  });
  it.each(["communications.send", "communications.manage"])(
    "accepts %s and passes only the authenticated tenant/actor/location scope",
    async (permission) => {
      const response = await request(app)
        .post(`/communication-email-logs/${logId}/retry`)
        .set("authorization", "test-session")
        .set("x-permissions", permission)
        .send({ expectedManualRetryCount: 2 })
        .expect(202);
      expect(response.body).toMatchObject({
        queued: true,
        log: { _id: logId },
      });
      expect(state.retry).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: state.tenant,
          actorId: state.actor,
          logId,
          expectedManualRetryCount: 2,
          allowedLocationIds: state.locations,
        }),
      );
    },
  );
  it.each([
    ["invalid-id", { expectedManualRetryCount: 0 }],
    [logId, {}],
    [logId, { expectedManualRetryCount: 0, force: true }],
    [
      logId,
      { expectedManualRetryCount: 0, recipientEmail: "other@example.test" },
    ],
  ])(
    "rejects unsafe input %s %j before touching the outbox",
    async (id, body) => {
      await request(app)
        .post(`/communication-email-logs/${id}/retry`)
        .set("authorization", "test-session")
        .set("x-permissions", "communications.send")
        .send(body)
        .expect(400);
      expect(state.retry).not.toHaveBeenCalled();
    },
  );
  it("returns structured blocking reasons", async () => {
    state.retry.mockRejectedValueOnce(
      Object.assign(new Error("Blocked"), {
        statusCode: 409,
        code: "COMMUNICATION_EMAIL_RETRY_BLOCKED",
        details: { reason: "recipient_suppressed" },
      }),
    );
    const response = await request(app)
      .post(`/communication-email-logs/${logId}/retry`)
      .set("authorization", "test-session")
      .set("x-permissions", "communications.send")
      .send({ expectedManualRetryCount: 0 })
      .expect(409);
    expect(response.body).toEqual({
      code: "COMMUNICATION_EMAIL_RETRY_BLOCKED",
      details: { reason: "recipient_suppressed" },
    });
  });
});
