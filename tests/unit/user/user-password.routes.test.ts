import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pass: vi.fn((_req, _res, next) => next()),
  requireWorkspaceSession: vi.fn((_req, _res, next) => next()),
  denyPermission: vi.fn((_req, res, _next) =>
    res.status(403).json({
      code: "WORKSPACE_PERMISSION_REQUIRED",
    }),
  ),
  updateUserPassword: vi.fn((_req, res) =>
    res.status(200).json({
      updated: true,
    }),
  ),
}));

vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: mocks.pass,
}));

vi.mock("@/modules/auth/middleware/requireAuthContext.js", () => ({
  requireWorkspaceSession: mocks.requireWorkspaceSession,
}));

vi.mock("@/modules/tenant-access/tenant-access.middleware.js", () => ({
  requirePermission: vi.fn(
    () => (req: Request, res: Response, next: NextFunction) =>
      mocks.denyPermission(req, res, next),
  ),
}));

vi.mock("@/modules/booking/controllers/booking.read.controller.js", () => ({
  getCustomerBookingHistory: mocks.pass,
}));

vi.mock("@/modules/user/controllers/user.read.controller.js", () => ({
  getCustomerById: mocks.pass,
  getAllUsers: mocks.pass,
  getUserbyCustomId: mocks.pass,
  getUsersWithFilters: mocks.pass,
  lookupUser: mocks.pass,
}));

vi.mock("@/modules/user/controllers/user.write.controller.js", () => ({
  createNewUser: mocks.pass,
  deleteUser: mocks.pass,
  updateUser: mocks.pass,
  updateUserPassword: mocks.updateUserPassword,
}));

import userRouter from "@/modules/user/user.routes.js";

const app = express();
app.use(express.json());
app.use("/users", userRouter);

describe("legacy self-password route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not require customer-management permission for the authenticated user", async () => {
    await request(app)
      .patch("/users/pass")
      .send({
        id: "507f1f77bcf86cd799439011",
        currentPass: "old-password",
        newPass: "new-password",
        newPassConfirm: "new-password",
      })
      .expect(200, {
        updated: true,
      });

    expect(mocks.updateUserPassword).toHaveBeenCalledOnce();
    expect(mocks.requireWorkspaceSession).toHaveBeenCalledOnce();
    expect(mocks.denyPermission).not.toHaveBeenCalled();
  });
});
