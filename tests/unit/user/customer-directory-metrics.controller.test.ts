import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listUsers: vi.fn(),
  listUsersWithFilters: vi.fn(),
  getCustomerMembershipSummary: vi.fn(),
}));
vi.mock("@/modules/user/services/user.membership-summary.service.js", () => ({
  getCustomerMembershipSummary: mocks.getCustomerMembershipSummary,
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
  getCustomerSummary,
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
app.get("/users/summary", getCustomerSummary);
app.post("/users/filter", getUsersWithFilters);

describe("customer-directory metric authorization context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listUsers.mockResolvedValue([]);
    mocks.listUsersWithFilters.mockResolvedValue({ data: [], totalCount: 0 });
    mocks.getCustomerMembershipSummary.mockResolvedValue({ activeMemberships: 7 });
  });
  it("ignores client filters and scope overrides for the authoritative summary", async () => {
    const response = await request(app).get("/users/summary?page=2&search=nobody&locationId=other").expect(200);
    expect(mocks.getCustomerMembershipSummary).toHaveBeenCalledWith({ tenantId, access: trustedAccess });
    expect(response.body.activeMemberships).toBe(7);
    expect(response.headers["cache-control"]).toBe("private, no-store");
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
