import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import User from "@/modules/user/user.model.js";
import {
  getAllUsers,
  getCustomerById,
} from "@/modules/user/controllers/user.read.controller.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} from "../../helpers/mongoMemory.js";

const tenant = new mongoose.Types.ObjectId();
const otherTenant = new mongoose.Types.ObjectId();
const customerId = new mongoose.Types.ObjectId();
const inactiveId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const foreignId = new mongoose.Types.ObjectId();

const app = express();
app.use((req, _res, next) => {
  Object.assign(req, {
    userInfo: { tenant: String(tenant) },
    workspaceAccess: {
      status: "active",
      tenantId: String(tenant),
      permissions: ["customers.view"],
      locationAccess: { mode: "all", locationIds: [] },
    },
  });
  next();
});
app.get("/users", getAllUsers);
app.get("/users/:id", getCustomerById);
app.use(
  (
    error: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res.status(error.statusCode || 500).json({ code: error.code });
  },
);

const user = (
  memberNumber: number,
  tenantRole = "customer",
  overrides: Record<string, unknown> = {},
) => ({
  _id: new mongoose.Types.ObjectId(),
  tenant,
  tenantRole,
  platformRole: "none",
  firstname: "Customer",
  lastname: String(memberNumber),
  email: `customer-${memberNumber}@example.com`,
  memberNumber,
  customId: `member-${memberNumber}`,
  isAccessGranted: true,
  moneyCredits: 450.5,
  ...overrides,
});

describe("customer directory scope", () => {
  beforeAll(connectTestDatabase);
  afterAll(disconnectTestDatabase);
  beforeEach(async () => {
    await clearTestDatabase();
    await User.collection.insertMany([
      user(1, "customer", { _id: customerId }),
      user(2, "customer", { _id: inactiveId, isAccessGranted: false }),
      user(3, "owner", { _id: ownerId }),
      user(4, "admin"),
      user(5, "staff"),
      user(6, "customer", { platformRole: "support" }),
      user(7, "customer", { tenant: otherTenant, _id: foreignId }),
    ]);
  });

  it("lists only eligible customers from the authenticated tenant, including inactive accounts", async () => {
    const response = await request(app)
      .get("/users")
      .query({ tenantRole: "customer", tenantId: String(otherTenant) })
      .expect(200);
    expect(response.body.map((row: any) => row._id).sort()).toEqual(
      [String(customerId), String(inactiveId)].sort(),
    );
    expect(
      response.body.find((row: any) => row._id === String(inactiveId)),
    ).toMatchObject({ isAccessGranted: false, moneyCredits: 450.5 });
    for (const row of response.body) {
      expect(row.totalSpent).toBeNull();
      expect(row.totalSpentByCurrency).toBeNull();
      expect(row.lastBookingAt).toBeNull();
      await request(app).get(`/users/${row._id}`).expect(200);
    }
    for (const excludedId of [ownerId, foreignId]) {
      const detail = await request(app).get(`/users/${excludedId}`).expect(404);
      expect(detail.body.code).toBe("CUSTOMER_NOT_FOUND");
    }
  });

  it("preserves the unscoped shared directory for existing user selectors", async () => {
    const response = await request(app).get("/users").expect(200);
    const ids = response.body.map((row: any) => row._id);
    expect(ids).toHaveLength(6);
    expect(ids).toContain(String(ownerId));
    expect(ids).not.toContain(String(foreignId));
  });

  it("rejects unsupported or injected role filters", async () => {
    await request(app).get("/users?tenantRole=owner").expect(400);
    await request(app)
      .get("/users?tenantRole=customer&tenantRole=owner")
      .expect(400);
  });
});
