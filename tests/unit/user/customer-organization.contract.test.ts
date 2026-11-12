import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  create: vi.fn(),
  createRepository: vi.fn(),
  ensureUserMemberNumbers: vi.fn(),
  find: vi.fn(),
}));

vi.mock("@/modules/user/user.repository.js", () => ({
  createUserRepository: mocks.createRepository,
}));

vi.mock("@/modules/user/user-member-number.assignment.service.js", () => ({
  ensureUserMemberNumber: vi.fn(),
  ensureUserMemberNumbers: mocks.ensureUserMemberNumbers,
}));

vi.mock("@/modules/user/user.validators.js", () => ({
  assertValidCreateUserInput: vi.fn(),
  assertValidUpdatePasswordInput: vi.fn(),
  assertValidUpdateUserInput: vi.fn(),
}));

vi.mock("@/modules/tenant-access/tenant-membership.model.js", () => ({
  default: { exists: vi.fn() },
}));

vi.mock("@/modules/account/account.service.js", () => ({
  changePasswordAndRevokeSessions: vi.fn(),
}));

import {
  listUsers,
  listUsersWithFilters,
} from "@/modules/user/services/user.read.service.js";
import { createUser } from "@/modules/user/services/user.write.service.js";

const TENANT_ID = "64b000000000000000000201";
const LOCATION_ID = "64b000000000000000000211";

const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

describe("organization-wide customer contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createRepository.mockReturnValue({
      count: mocks.count,
      create: mocks.create,
      find: mocks.find,
      findOne: vi.fn(),
    });
    mocks.count.mockResolvedValue(0);
    mocks.create.mockResolvedValue({ _id: "customer-1" });
    mocks.ensureUserMemberNumbers.mockResolvedValue(new Map());
    mocks.find.mockResolvedValue([]);
  });

  it("lists every customer in the tenant repository without a location filter", async () => {
    await listUsers({ tenantId: TENANT_ID });

    expect(mocks.createRepository).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
    });
    expect(mocks.find).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ sort: { createdAt: -1 } }),
    );
  });

  it("ignores locationId when applying customer-directory filters", async () => {
    await listUsersWithFilters({
      tenantId: TENANT_ID,
      input: {
        email: "anna@example.com",
        locationId: LOCATION_ID,
      } as Parameters<typeof listUsersWithFilters>[0]["input"],
    });

    const expectedFilter = {
      $and: [{
        $or: [
          { email: { $regex: "anna@example\\.com", $options: "i" } },
          { "guestContact.email": { $regex: "anna@example\\.com", $options: "i" } },
        ],
      }],
    };
    expect(mocks.find).toHaveBeenCalledWith(
      expectedFilter,
      expect.objectContaining({ skip: 0, limit: 50 }),
    );
    expect(mocks.count).toHaveBeenCalledWith(expectedFilter);
  });

  it("does not persist location provenance when creating a customer", async () => {
    await createUser({
      tenantId: TENANT_ID,
      input: {
        firstname: "Anna",
        lastname: "Novak",
        email: "anna@example.com",
        password: "secret",
        locationId: LOCATION_ID,
      } as Parameters<typeof createUser>[0]["input"],
    });

    const payload = mocks.create.mock.calls[0]?.[0];
    expect(payload).not.toHaveProperty("locationId");
    expect(payload).not.toHaveProperty("createdAtLocation");
    expect(payload).toMatchObject({
      firstname: "Anna",
      lastname: "Novak",
      email: "anna@example.com",
      tenantRole: "customer",
    });
  });

  it("keeps customer identity filters organization-wide while passing trusted metric access", () => {
    const readController = readSource(
      "src/modules/user/controllers/user.read.controller.ts",
    );
    const writeController = readSource(
      "src/modules/user/controllers/user.write.controller.ts",
    );

    expect(readController).toMatch(
      /listUsers\(\{\s*tenantId,\s*access: getResolvedWorkspaceAccess\(req as WorkspaceAccessRequest\),\s*tenantRole:/,
    );
    expect(readController).toMatch(
      /listUsersWithFilters\(\{\s*tenantId,\s*input: req\.body,\s*access: getResolvedWorkspaceAccess\(req as WorkspaceAccessRequest\),\s*\}\)/,
    );
    expect(readController).not.toContain("locationId");
    expect(writeController).not.toContain("locationId");
    expect(writeController).not.toContain("createdAtLocation");
  });

  it("documents the directory exception to active studio scoping", () => {
    const contract = readSource("src/modules/location/README.md");

    expect(contract).toContain(
      "The customer identity and directory are organization-wide.",
    );
    expect(contract).toMatch(
      /must neither send nor consume\s+`activeStudioId` or `locationId`/,
    );
    expect(contract).toContain("operational studio-scoped requests");
  });
});
