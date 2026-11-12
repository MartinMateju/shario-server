import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
  listUsersWithFilters: vi.fn(),
}));
vi.mock("@/modules/user/services/user.read.service.js", () => ({
  ...mocks,
  getCustomerById: vi.fn(),
  getUserByCustomIdOrContact: vi.fn(),
  lookupUser: vi.fn(),
}));
import {
  getAllUsers,
  getUsersWithFilters,
} from "@/modules/user/controllers/user.read.controller.js";

const tenantId = "64b000000000000000000201";
const trustedAccess = {
  tenantId,
  status: "active",
  permissions: ["customers.view"],
  locationAccess: {
    mode: "selected",
    locationIds: ["64b000000000000000000211"],
  },
};
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  Object.assign(req, {
    userInfo: { tenant: tenantId },
    workspaceAccess: trustedAccess,
  });
  next();
});
app.get("/users", getAllUsers);
app.post("/users/filter", getUsersWithFilters);

describe("customer-directory metric authorization context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listUsers.mockResolvedValue([]);
    mocks.listUsersWithFilters.mockResolvedValue({ data: [], totalCount: 0 });
  });
  it("passes trusted middleware access to the bare directory", async () => {
    await request(app)
      .get("/users?tenantRole=customer&locationId=ignored")
      .expect(200);
    expect(mocks.listUsers).toHaveBeenCalledWith({
      tenantId,
      tenantRole: "customer",
      access: trustedAccess,
    });
  });
  it("does not let filtered request data replace trusted metric permissions", async () => {
    const input = {
      page: 2,
      access: {
        permissions: ["payments.view"],
        locationAccess: { mode: "all" },
      },
    };
    await request(app).post("/users/filter").send(input).expect(200);
    expect(mocks.listUsersWithFilters).toHaveBeenCalledWith({
      tenantId,
      input,
      access: trustedAccess,
    });
  });
});
