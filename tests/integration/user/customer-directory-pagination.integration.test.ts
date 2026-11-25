import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import UserMembership from "@/modules/membership/user-membership.model.js";
import User from "@/modules/user/user.model.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import Booking from "@/modules/booking/booking.model.js";
import Order from "@/modules/order/order.model.js";
import { ALL_WORKSPACE_PERMISSIONS } from "@/modules/tenant-access/tenant-access.permissions.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";
import {
  listCustomerDirectory,
  getCustomerDirectorySummary,
  exportCustomerDirectory,
} from "@/modules/user/services/user.directory.service.js";
import {
  readCustomerDirectory,
  readCustomerDirectorySummary,
  downloadCustomerDirectory,
} from "@/modules/user/controllers/user.directory.controller.js";
import * as metrics from "@/modules/user/services/user.directory-metrics.service.js";
import {
  clearTestDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} from "../../helpers/mongoMemory.js";

const tenant = new mongoose.Types.ObjectId();
const foreign = new mongoose.Types.ObjectId();
const location = new mongoose.Types.ObjectId();
const now = new Date("2026-11-16T12:00:00Z");
const access = (patch: Record<string, unknown> = {}) =>
  ({
    tenantId: String(tenant),
    status: "active",
    permissions: ALL_WORKSPACE_PERMISSIONS,
    locationAccess: { mode: "all", locationIds: [] },
    ...patch,
  }) as ResolvedWorkspaceAccess;
const context = () => ({ tenantId: String(tenant), access: access(), now });
const user = (n: number, patch: Record<string, unknown> = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  tenant,
  tenantRole: "customer",
  platformRole: "none",
  firstname: "Customer",
  lastname: String(n),
  customId: `legacy-${n}`,
  memberNumber: n,
  email: `customer-${n}@example.test`,
  isAccessGranted: true,
  moneyCredits: 1,
  createdAt: new Date("2026-10-20T10:00:00Z"),
  ...patch,
});
const membership = (
  userId: mongoose.Types.ObjectId,
  name: string,
  patch: Record<string, unknown> = {},
) => ({
  _id: new mongoose.Types.ObjectId(),
  tenant,
  user: userId,
  status: "active",
  selectedLocation: location,
  planSnapshot: {
    name,
    locationScope: { type: "selected", locationIds: [location] },
  },
  startedAt: new Date("2026-11-01T00:00:00Z"),
  currentPeriodStart: new Date("2026-11-01T00:00:00Z"),
  currentPeriodEnd: new Date("2026-12-01T00:00:00Z"),
  ...patch,
});
const list = (input: Record<string, unknown> = {}) =>
  listCustomerDirectory({ ...context(), input });
const summary = (input: Record<string, unknown> = {}) =>
  getCustomerDirectorySummary({ ...context(), input });
const exported = async (input: Record<string, unknown> = {}) => {
  const rows: any[] = [];
  for await (const batch of exportCustomerDirectory({ ...context(), input }))
    rows.push(...batch);
  return rows;
};
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  Object.assign(req, {
    userInfo: { tenant: String(tenant) },
    workspaceAccess: access(req.get("x-deny") ? { permissions: [] } : {}),
  });
  next();
});
app.get("/users/directory", readCustomerDirectory);
app.get("/users/directory/summary", readCustomerDirectorySummary);
app.post("/users/directory/export", downloadCustomerDirectory);
app.use(
  (
    error: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (res.headersSent) return res.destroy();
    res
      .status(error.statusCode || 400)
      .json({ code: error.code || "INVALID_INPUT" });
  },
);

describe("bounded customer directory", () => {
  beforeAll(async () => {
    await connectTestDatabase();
    await UserMembership.createIndexes();
  });
  afterAll(disconnectTestDatabase);
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await clearTestDatabase();
    await Tenant.collection.insertOne({
      _id: tenant,
      settings: { currency: "CZK" },
      modules: { memberships: true },
      plan: "professional",
      planVersion: 3,
    });
  });

  it("pages beyond 2,000, enriches only that page, and returns uncapped global cards/facets without metric work or repair writes", async () => {
    const rows = Array.from({ length: 2005 }, (_, index) =>
      user(index + 1, {
        ...(index === 0
          ? {
              activeMembership: { name: "Clay Club", slug: "clay_club" },
              createdAt: now,
            }
          : {}),
        ...(index === 1 ? { memberNumber: undefined } : {}),
      }),
    );
    await User.collection.insertMany([
      ...rows,
      user(9001, { tenant: foreign }),
      user(9002, { tenantRole: "owner" }),
      user(9003, { platformRole: "support" }),
    ]);
    const hydration = vi.spyOn(metrics, "withCustomerDirectoryMetrics");
    await UserMembership.collection.insertOne(
      membership(rows[0]._id, "Clay Club"),
    );
    const update = vi.spyOn(User.collection, "updateOne");
    const started = performance.now();
    const result = await list({ page: 201, limit: 10 });
    const listMs = performance.now() - started;
    expect(result).toMatchObject({
      totalCount: 2005,
      totalPages: 201,
      currentPage: 201,
      pageSize: 10,
    });
    expect(result.data).toHaveLength(5);
    expect(hydration).toHaveBeenCalledOnce();
    expect(hydration.mock.calls[0][0].users).toHaveLength(5);
    const expected = rows.sort(
      (a, b) =>
        +b.createdAt - +a.createdAt ||
        String(b._id).localeCompare(String(a._id)),
    );
    expect(result.data.map((row: any) => String(row._id))).toEqual(
      expected.slice(2000).map((row) => String(row._id)),
    );
    hydration.mockClear();
    expect(await summary()).toMatchObject({
      summary: {
        totalCustomers: 2005,
        credits: 2005,
        activeMemberships: 1,
        newThisMonth: 1,
        needsAttention: 0,
      },
      membershipOptions: [{ value: "clay_club", label: "Clay Club" }],
    });
    expect(hydration).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    const searchStarted = performance.now();
    expect((await list({ search: "customer 2005" })).data).toHaveLength(1);
    const searchMs = Math.round(performance.now() - searchStarted);
    const firstStarted = performance.now();
    expect((await list({ page: 1, limit: 10 })).data).toHaveLength(10);
    process.stdout.write(
      `${JSON.stringify({
        benchmark: "directory synthetic 2005",
        ...{
          listMs: Math.round(listMs),
          searchMs,
          firstPageMs: Math.round(performance.now() - firstStarted),
        },
      })}\n`,
    );
  });

  it("round-trips actual Unicode membership facets while ignoring legacy user snapshots", async () => {
    const rows = [
      user(1, { activeMembership: "Stale" }),
      user(2, { membership: "Old" }),
    ];
    await User.collection.insertMany(rows);
    await UserMembership.collection.insertMany([
      membership(rows[0]._id, "ΟΔΥΣΣΕΥΣ"),
      membership(rows[1]._id, "Clay Club"),
    ]);
    const facets = (await summary()).membershipOptions;
    const greek = facets.find((option) => option.label === "ΟΔΥΣΣΕΥΣ")!;
    expect((await list({ membership: greek.value })).data[0].memberNumber).toBe(
      1,
    );
    expect(facets.map((option) => option.label).sort()).toEqual([
      "Clay Club",
      "ΟΔΥΣΣΕΥΣ",
    ]);
    expect((await list({ membership: "stale" })).totalCount).toBe(0);
  });

  it("uses the stable directory index without a blocking sort for an unfiltered first page", async () => {
    await User.createIndexes();
    await User.collection.insertMany(
      Array.from({ length: 2005 }, (_, index) => user(index + 1)),
    );
    const queries = vi.spyOn(User, "aggregate");
    await list({ page: 1, limit: 10 });
    const pipeline = queries.mock.calls.find(([stages]) =>
      stages.some((stage) => "$limit" in stage),
    )![0];
    queries.mockRestore();
    const explanation: any =
      await User.aggregate(pipeline).explain("executionStats");
    const cursor =
      explanation.stages?.find((stage: any) => stage.$cursor)?.$cursor ??
      explanation;
    expect(JSON.stringify(cursor.queryPlanner.winningPlan)).toContain(
      "tenant_customer_directory_order",
    );
    expect(JSON.stringify(cursor.executionStats.executionStages)).not.toMatch(
      /"stage":"SORT"/,
    );
    expect(cursor.executionStats.totalDocsExamined).toBeLessThanOrEqual(10);
    process.stdout.write(
      `${JSON.stringify({ benchmark: "directory index", returned: cursor.executionStats.nReturned, documentsExamined: cursor.executionStats.totalDocsExamined, keysExamined: cursor.executionStats.totalKeysExamined })}\n`,
    );
  });

  it.each([
    ["Jiří", "Novák", "jiri novak"],
    ["Z\u030Colmanova\u0301", "", "zolmanova"],
    ["ﬁona", "Maker", "fiona"],
    ["Ｆｒａｎｃｅ", "", "france"],
    ["Maker.*", "", ".*"],
    ["ΟΔΥΣΣΕΥΣ", "", "οδυσσευς"],
  ])(
    "retains folded substring search for %s %s",
    async (firstname, lastname, search) => {
      const match = user(42, { firstname, lastname });
      await User.collection.insertMany([match, user(43)]);
      const result = await list({ search });
      expect(result.totalCount).toBe(1);
      expect(String(result.data[0]._id)).toBe(String(match._id));
    },
  );

  it("keeps status precedence, actual memberships, member IDs, guest contact and safe projection consistent", async () => {
    const guest = user(74, {
      firstname: "Guest",
      email: "",
      customId: "G-1234567890abcdef1234",
      isAccessGranted: false,
      guestContact: { email: "guest@example.test", locale: "cs" },
      password: "secret",
      passwordResetOtpHash: "private",
      sessionVersion: 7,
    });
    const rows = [
      user(71, {
        customerStatus: "pending-invitation",
        isAccessGranted: false,
        activeMembership: "Cláy Club",
      }),
      user(72, {
        customerStatus: "disabled",
        invitedAt: now,
        currentMembership: { title: "Pack", key: "pack" },
      }),
      user(73, {
        invitedAt: now,
        lastLoginAt: null,
        membershipPlan: { planName: "Clay Club", slug: "clay_club" },
      }),
      guest,
    ];
    await User.collection.insertMany(rows);
    await UserMembership.collection.insertMany([
      membership(rows[0]._id, "Cláy Club"),
      membership(rows[2]._id, "Clay Club"),
    ]);
    expect(
      (await list({ status: "invited", membership: "clay_club" })).data
        .map((row: any) => row.memberNumber)
        .sort(),
    ).toEqual([71, 73]);
    expect((await list({ status: "inactive" })).totalCount).toBe(2);
    expect((await list({ search: "#73" })).data[0].memberNumber).toBe(73);
    const response = await list({ search: "guest@example.test" });
    expect(response.data[0]).toMatchObject({
      email: "guest@example.test",
      customerStatus: "inactive",
      memberNumber: 74,
    });
    const serialized = JSON.stringify(response);
    for (const privateField of [
      "guestContact",
      "password",
      "sessionVersion",
      "private",
      "secret",
    ])
      expect(serialized).not.toContain(privateField);
  });

  it("retains page financial currency semantics and location/permission masks", async () => {
    const customer = user(1);
    await User.collection.insertOne(customer);
    await Order.collection.insertMany(
      ["CZK", "EUR"].map((currency) => ({
        _id: new mongoose.Types.ObjectId(),
        tenant,
        createdBy: customer._id,
        isPaid: true,
        currency,
        paidAmountMinor: 500,
        locationIds: [location],
      })),
    );
    expect((await list()).data[0]).toMatchObject({
      totalSpent: null,
      totalSpentByCurrency: [
        { currency: "CZK", amountMinor: 500 },
        { currency: "EUR", amountMinor: 500 },
      ],
    });
    const restricted = await listCustomerDirectory({
      ...context(),
      access: access({
        locationAccess: { mode: "selected", locationIds: [String(location)] },
      }),
      input: {},
    });
    expect(restricted.data[0]).toMatchObject({
      totalSpentByCurrency: null,
      totalSpent: null,
    });
    const denied = access({ permissions: ["customers.view"] });
    expect(
      (await listCustomerDirectory({ ...context(), access: denied, input: {} }))
        .data[0],
    ).toMatchObject({ totalSpentByCurrency: null, lastBookingAt: null });
  });

  it("counts month boundaries in the supplied IANA timezone", async () => {
    await User.collection.insertOne(
      user(1, { createdAt: new Date("2026-11-01T00:30:00Z") }),
    );
    expect(
      (await summary({ timeZone: "Europe/Prague" })).summary.newThisMonth,
    ).toBe(1);
    expect(
      (await summary({ timeZone: "America/New_York" })).summary.newThisMonth,
    ).toBe(0);
    await expect(summary({ timeZone: "not-a-timezone" })).rejects.toThrow();
  });

  it("exports every filtered match above 2,000 in bounded metric batches and completes a valid HTTP envelope", async () => {
    const rows = Array.from({ length: 2005 }, (_, index) =>
      user(index + 1, { membership: "Stale" }),
    );
    const other = user(3001);
    const foreignUser = user(3002, { tenant: foreign });
    await User.collection.insertMany([...rows, other, foreignUser]);
    await UserMembership.collection.insertMany([
      ...rows.map((row) => membership(row._id, "Clay Club")),
      membership(other._id, "Other"),
      membership(foreignUser._id, "Clay Club", { tenant: foreign }),
    ]);
    const hydration = vi.spyOn(metrics, "withCustomerDirectoryMetrics");
    const response = await request(app)
      .post("/users/directory/export")
      .send({ membership: "clay_club" })
      .expect(200);
    expect(response.body).toMatchObject({ complete: true, totalCount: 2005 });
    expect(response.body.data).toHaveLength(2005);
    expect(new Set(response.body.data.map((row: any) => row.id)).size).toBe(
      2005,
    );
    expect(hydration.mock.calls).toHaveLength(21);
    expect(
      Math.max(...hydration.mock.calls.map(([input]) => input.users.length)),
    ).toBe(100);
  });

  it("exports selected customers across pages, rejects missing/foreign/noncustomer IDs and never accepts body scope overrides", async () => {
    const first = user(1);
    const second = user(2);
    const outsider = user(3, { tenant: foreign });
    const staff = user(4, { tenantRole: "staff" });
    await User.collection.insertMany([first, second, outsider, staff]);
    expect(
      (await exported({ ids: [String(first._id), String(second._id)] }))
        .map((row) => row.memberNumber)
        .sort(),
    ).toEqual([1, 2]);
    for (const id of [outsider._id, staff._id, new mongoose.Types.ObjectId()]) {
      await request(app)
        .post("/users/directory/export")
        .send({ ids: [String(first._id), String(id)] })
        .expect(404);
    }
    for (const input of [
      { ids: [String(first._id)], search: "Customer" },
      { tenant: String(foreign) },
      { access: { permissions: ALL_WORKSPACE_PERMISSIONS } },
    ]) {
      await request(app)
        .post("/users/directory/export")
        .send(input)
        .expect(400);
    }
  });

  it("rejects invalid pagination and denied scopes before any metrics", async () => {
    const hydration = vi.spyOn(metrics, "withCustomerDirectoryMetrics");
    for (const query of [
      { page: "Infinity" },
      { page: "1.5" },
      { page: 0 },
      { limit: 51 },
      { limit: 0 },
      { sortBy: "password" },
      { status: "staff" },
    ]) {
      await request(app).get("/users/directory").query(query).expect(400);
    }
    await request(app)
      .get("/users/directory")
      .set("x-deny", "true")
      .expect(403);
    await request(app)
      .get("/users/directory/summary")
      .set("x-deny", "true")
      .expect(403);
    await request(app)
      .post("/users/directory/export")
      .set("x-deny", "true")
      .send({})
      .expect(403);
    await expect(
      listCustomerDirectory({
        ...context(),
        access: access({ tenantId: String(foreign) }),
        input: {},
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(hydration).not.toHaveBeenCalled();
  });

  it("closes a failed export without a successful or partial download envelope", async () => {
    await User.collection.insertMany(
      Array.from({ length: 101 }, (_, index) => user(index + 1)),
    );
    vi.spyOn(metrics, "withCustomerDirectoryMetrics")
      .mockImplementationOnce(async ({ users }) => users as any)
      .mockRejectedValueOnce(new Error("Financial snapshots unavailable"));
    await expect(
      request(app).post("/users/directory/export").send({}),
    ).rejects.toThrow();
  });
  it("uses only the latest eligible membership for rows, filters, facets and exports", async () => {
    const customer = user(1, {
      activeMembership: "Stale",
      currentMembership: "Hidden legacy",
    });
    await User.collection.insertOne(customer);
    await UserMembership.collection.insertMany([
      membership(customer._id, "Old", { startedAt: new Date("2026-10-01") }),
      membership(customer._id, "Current", { status: "cancel_scheduled" }),
      membership(customer._id, "Expired", { currentPeriodEnd: now }),
      membership(customer._id, "Future", {
        currentPeriodStart: new Date("2026-11-17"),
      }),
      membership(customer._id, "Paused", { status: "paused" }),
    ]);
    const result = await list();
    expect(result.data[0]).toMatchObject({
      membershipAvailable: true,
      activeMembership: { name: "Current", status: "cancel_scheduled" },
    });
    expect((await list({ membership: "old" })).totalCount).toBe(0);
    expect((await list({ membership: "current" })).totalCount).toBe(1);
    expect((await summary()).membershipOptions).toEqual([
      { value: "current", label: "Current" },
    ]);
    expect(
      (await exported({ membership: "current" }))[0].activeMembership.name,
    ).toBe("Current");
  });

  it("reports unknown-only memberships as unavailable rather than none, while preserving main's known-active precedence", async () => {
    const rows = [user(1), user(2), user(3)];
    await User.collection.insertMany(rows);
    await UserMembership.collection.insertMany([
      membership(rows[0]._id, "Unknown", { currentPeriodEnd: null }),
      membership(rows[1]._id, "Known"),
      membership(rows[1]._id, "Malformed newer", {
        startedAt: now,
        currentPeriodEnd: null,
      }),
    ]);
    const result = await list({ limit: 10 });
    expect(result.data.find((row) => row.memberNumber === 1)).toMatchObject({
      membershipAvailable: false,
      activeMembership: null,
    });
    expect(result.data.find((row) => row.memberNumber === 2)).toMatchObject({
      membershipAvailable: true,
      activeMembership: { name: "Known" },
    });
    expect(
      (await list({ membership: "none" })).data.map((row) => row.memberNumber),
    ).toEqual([3]);
    expect(await summary()).toMatchObject({
      summary: { activeMemberships: null },
      membershipAvailable: false,
      membershipOptions: [],
      membershipScope: "workspace",
      asOf: now.toISOString(),
    });
  });

  it("keeps membership plan/module/permission and selected/shared location boundaries authoritative", async () => {
    const otherLocation = new mongoose.Types.ObjectId();
    const rows = [
      user(1, { activeMembership: "Private stale plan" }),
      user(2),
      user(3),
    ];
    await User.collection.insertMany(rows);
    await UserMembership.collection.insertMany([
      membership(rows[0]._id, "Hidden", { selectedLocation: otherLocation }),
      membership(rows[1]._id, "Local"),
      membership(rows[2]._id, "Shared", {
        selectedLocation: null,
        planSnapshot: { name: "Shared", locationScope: { type: "all" } },
      }),
    ]);
    const restricted = {
      ...context(),
      access: access({
        locationAccess: { mode: "selected", locationIds: [String(location)] },
      }),
    };
    const visible = await listCustomerDirectory({ ...restricted, input: {} });
    expect(visible.data.find((row) => row.memberNumber === 1)).toMatchObject({
      membershipAvailable: true,
      activeMembership: null,
    });
    expect(
      await getCustomerDirectorySummary({ ...restricted, input: {} }),
    ).toMatchObject({
      summary: { activeMemberships: 2 },
      membershipScope: "authorized_locations",
      membershipOptions: [
        { value: "local", label: "Local" },
        { value: "shared", label: "Shared" },
      ],
    });
    const denied = {
      ...context(),
      access: access({ permissions: ["customers.view"] }),
    };
    const deniedRows = await listCustomerDirectory({ ...denied, input: {} });
    expect(
      deniedRows.data.every(
        (row) =>
          row.membershipAvailable === false && row.activeMembership === null,
      ),
    ).toBe(true);
    expect(JSON.stringify(deniedRows)).not.toContain("Private stale plan");
    await expect(
      listCustomerDirectory({ ...denied, input: { membership: "none" } }),
    ).rejects.toMatchObject({ statusCode: 403 });
    for (const patch of [
      { "modules.memberships": false },
      { "modules.memberships": true, plan: "starter" },
    ]) {
      await Tenant.collection.updateOne({ _id: tenant }, { $set: patch });
      expect(await summary()).toMatchObject({
        summary: { activeMemberships: null },
        membershipAvailable: false,
        membershipOptions: [],
      });
      expect(
        (await list()).data.every(
          (row) => !row.membershipAvailable && row.activeMembership === null,
        ),
      ).toBe(true);
    }
  });

  it("preserves shared-selected studio entitlements across page, membership filter, facets and export", async () => {
    const otherLocation = new mongoose.Types.ObjectId();
    const rows = [
      user(1),
      user(2),
      user(3),
      user(4),
      user(5, { tenant: foreign }),
    ];
    await User.collection.insertMany(rows);
    const shared = {
      name: "Shared studios",
      locationScope: {
        type: "shared_selected",
        locationIds: [location, otherLocation],
      },
    };
    await UserMembership.collection.insertMany([
      membership(rows[0]._id, "Older local"),
      membership(rows[0]._id, "Shared studios", {
        selectedLocation: null,
        startedAt: new Date("2026-11-05"),
        planSnapshot: shared,
      }),
      membership(rows[1]._id, "Shared studios", {
        selectedLocation: null,
        status: "cancel_scheduled",
        planSnapshot: shared,
      }),
      membership(rows[2]._id, "Choose one", {
        selectedLocation: otherLocation,
        planSnapshot: {
          name: "Choose one",
          locationScope: {
            type: "selected",
            locationIds: [location, otherLocation],
          },
        },
      }),
      membership(rows[3]._id, "Other shared", {
        selectedLocation: null,
        planSnapshot: {
          name: "Other shared",
          locationScope: {
            type: "shared_selected",
            locationIds: [otherLocation],
          },
        },
      }),
      membership(rows[4]._id, "Shared studios", {
        tenant: foreign,
        selectedLocation: null,
        planSnapshot: shared,
      }),
    ]);
    const restricted = {
      ...context(),
      access: access({
        locationAccess: { mode: "selected", locationIds: [String(location)] },
      }),
    };
    const page = await listCustomerDirectory({
      ...restricted,
      input: { limit: 10 },
    });
    expect(page.totalCount).toBe(4);
    for (const number of [1, 2]) {
      expect(
        page.data.find((row) => row.memberNumber === number),
      ).toMatchObject({
        membershipAvailable: true,
        activeMembership: { name: "Shared studios" },
      });
    }
    for (const number of [3, 4]) {
      expect(
        page.data.find((row) => row.memberNumber === number),
      ).toMatchObject({ membershipAvailable: true, activeMembership: null });
    }
    const filtered = await listCustomerDirectory({
      ...restricted,
      input: { membership: "shared_studios", limit: 1 },
    });
    expect(filtered.totalCount).toBe(2);
    expect(filtered.data).toHaveLength(1);
    expect(filtered.data[0].activeMembership?.name).toBe("Shared studios");
    expect(
      await getCustomerDirectorySummary({ ...restricted, input: {} }),
    ).toMatchObject({
      summary: { activeMemberships: 2 },
      membershipScope: "authorized_locations",
      membershipAvailable: true,
      membershipOptions: [{ value: "shared_studios", label: "Shared studios" }],
    });
    const exportedRows: any[] = [];
    for await (const batch of exportCustomerDirectory({
      ...restricted,
      input: { membership: "shared_studios" },
    }))
      exportedRows.push(...batch);
    expect(exportedRows.map((row) => row.memberNumber).sort()).toEqual([1, 2]);
    const empty = {
      ...restricted,
      access: access({ locationAccess: { mode: "selected", locationIds: [] } }),
    };
    expect(
      await getCustomerDirectorySummary({ ...empty, input: {} }),
    ).toMatchObject({
      summary: { activeMemberships: 0 },
      membershipOptions: [],
    });
    expect(
      (
        await listCustomerDirectory({
          ...empty,
          input: { membership: "shared_studios" },
        })
      ).totalCount,
    ).toBe(0);
  });

  it("uses the nonpartial membership lookup index and enriches only a returned page", async () => {
    const rows = Array.from({ length: 25 }, (_, index) => user(index + 1));
    await User.collection.insertMany(rows);
    await UserMembership.collection.insertMany(
      rows.map((row) => membership(row._id, "Club")),
    );
    const queries = vi.spyOn(User, "aggregate");
    const result = await list({ limit: 10 });
    expect(result.data).toHaveLength(10);
    const pipeline = queries.mock.calls.find(([stages]) =>
      stages.some((stage) => "$limit" in stage),
    )![0];
    expect(pipeline.findIndex((stage) => "$lookup" in stage)).toBeGreaterThan(
      pipeline.findIndex((stage) => "$limit" in stage),
    );
    queries.mockRestore();
    const explain: any =
      await User.aggregate(pipeline).explain("executionStats");
    const lookup = explain.stages.find((stage: any) => stage.$lookup);
    expect(lookup.indexesUsed).toContain(
      "customer_membership_directory_lookup",
    );
    expect(lookup.totalDocsExamined).toBe(10);
    expect(await summary()).toMatchObject({
      summary: { activeMemberships: 25 },
    });
  });
});
