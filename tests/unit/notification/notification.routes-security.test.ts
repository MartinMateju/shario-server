import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handler: vi.fn((_req, res) => res.status(204).end()) }));
vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({ verifyJWT: (_req, _res, next) => next() }));
vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requirePermission: (permission: string) => (req, res, next) => {
    const permissions = String(req.headers["x-test-permissions"] || "").split(",");
    return permissions.includes(permission) ? next() : res.status(403).json({ code: "MISSING_PERMISSION" });
  },
}));
vi.mock("@/modules/notification/controllers/notification.controller.js", () => ({
  createEmailNotification: mocks.handler,
  getEmailNotificationById: mocks.handler,
  getEmailNotifications: mocks.handler,
  getNotificationLogs: mocks.handler,
}));
import notificationRouter from "@/modules/notification/routes/notification.routes.js";
const app = express();
app.use(express.json());
app.use("/notifications", notificationRouter);

describe("generic notification history and removed pottery delivery", () => {
  beforeEach(() => vi.clearAllMocks());
  it("does not expose the pottery reminder sender even with email send permission", async () => {
    await request(app).post("/notifications/send-out-emails").set("x-test-permissions", "communications.send").send({ message: "first-reminder" }).expect(404);
    expect(mocks.handler).not.toHaveBeenCalled();
  });
  it("requires view permission to read generic email history", async () => {
    await request(app).get("/notifications/logs").expect(403);
    await request(app).get("/notifications/logs").set("x-test-permissions", "communications.view").expect(204);
    await request(app).get("/notifications/email-notifications").set("x-test-permissions", "communications.view").expect(204);
    expect(mocks.handler).toHaveBeenCalledTimes(2);
  });
  it("requires management permission to create a generic email history record", async () => {
    await request(app).post("/notifications/email-notifications").set("x-test-permissions", "communications.view").send({}).expect(403);
    await request(app).post("/notifications/email-notifications").set("x-test-permissions", "communications.manage").send({}).expect(204);
    expect(mocks.handler).toHaveBeenCalledOnce();
  });
});
