import express, { type Request } from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAccess: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@/modules/tenant-access/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveWorkspaceAccessForUser: mocks.resolveAccess,
}));
vi.mock("@/infrastructure/storage/r2.client.js", () => ({
  uploadBufferToR2: mocks.upload,
  deleteObjectFromR2: mocks.remove,
  getObjectBufferFromR2: mocks.read,
}));
vi.mock("@/config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import Location from "@/modules/location/location.model.js";
import User from "@/modules/user/user.model.js";
import {
  CustomOrder,
  CustomOrderEvent,
} from "@/modules/custom-orders/custom-order.model.js";
import {
  customOrderContext,
  customOrderDeadlineAt,
  customOrderService,
  findCustomOrderCustomer,
  type CustomOrderContext,
} from "@/modules/custom-orders/custom-order.service.js";
import { listCustomOrdersInput } from "@/modules/custom-orders/custom-order.validators.js";
import { customOrderRouter } from "@/modules/custom-orders/custom-order.routes.js";
import { readCustomOrderAttachment } from "@/modules/custom-orders/custom-order.media.js";
import { errorHandler } from "@/shared/http/errorHandler.js";

const ids = Object.fromEntries(
  [
    "tenant",
    "otherTenant",
    "location",
    "otherLocation",
    "foreignLocation",
    "staff",
    "customer",
    "foreignCustomer",
  ].map((key) => [key, new mongoose.Types.ObjectId()]),
);
const ctx: CustomOrderContext = {
  tenantId: String(ids.tenant),
  userId: String(ids.staff),
  actorName: "Studio manager",
  locations: [String(ids.location)],
};
const allLocations = { ...ctx, locations: null };
const otherTenant = { ...allLocations, tenantId: String(ids.otherTenant) };
const input = (overrides = {}) => ({
  title: "Blue dinner set",
  description: "Six handmade dinner plates with a narrow raised rim.",
  materials: "White stoneware",
  finish: "Food-safe blue glaze",
  pieceCount: 6,
  startDate: "2026-03-01",
  deadline: "2026-03-29",
  locationId: String(ids.location),
  currency: "CZK",
  customer: { name: "Guest customer", email: "guest@example.test", phone: "" },
  ...overrides,
});
const query = (overrides = {}) => listCustomOrdersInput.parse(overrides);
let db: MongoMemoryReplSet;
let picture: Buffer;
const objects = new Map<string, Buffer>();
const file = (name = "plate.png") =>
  ({
    originalname: name,
    mimetype: "image/png",
    buffer: picture,
    size: picture.length,
  }) as Express.Multer.File;
const app = (
  permissions = ["orders.view", "orders.manage"],
  authContext = "workspace",
) => {
  const server = express();
  server.use(express.json());
  server.get(
    "/custom-orders/media/:id/:attachmentId",
    readCustomOrderAttachment,
  );
  server.use((req, _res, next) => {
    Object.assign(req, {
      userInfo: {
        id: String(ids.staff),
        tenant: String(ids.tenant),
        authContext,
        firstname: "Studio",
        lastname: "manager",
      },
      workspaceAccessResolved: true,
      workspaceAccess: {
        tenantId: String(ids.tenant),
        userId: String(ids.staff),
        status: "active",
        permissions,
        locationAccess: {
          mode: "selected",
          locationIds: [String(ids.location)],
        },
      },
    });
    next();
  });
  server.use("/custom-orders", customOrderRouter);
  server.use(errorHandler);
  return server;
};

describe("custom orders isolation, lifecycle and concurrent writes", () => {
  beforeAll(async () => {
    db = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(db.getUri());
    await Promise.all(
      [CustomOrder, CustomOrderEvent, Location, User].map((model) =>
        model.init(),
      ),
    );
    picture = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#2255aa" },
    })
      .png()
      .toBuffer();
  }, 60000);
  afterAll(async () => {
    await mongoose.disconnect();
    await db?.stop();
  });
  beforeEach(async () => {
    await Promise.all(
      [CustomOrder, CustomOrderEvent, Location, User].map((model) =>
        model.collection.deleteMany({}),
      ),
    );
    vi.clearAllMocks();
    objects.clear();
    process.env.SERVER_URL = "https://api.example.test";
    mocks.resolveAccess.mockResolvedValue(null);
    mocks.upload.mockImplementation(async ({ key, buffer }) => {
      objects.set(key, buffer);
    });
    mocks.remove.mockImplementation(async ({ key }) => {
      objects.delete(key);
    });
    mocks.read.mockImplementation(async ({ key }) => objects.get(key));
    await Location.collection.insertMany([
      {
        _id: ids.location,
        tenant: ids.tenant,
        name: "Václavská",
        slug: "vaclavska",
        code: "V",
        isActive: true,
        booking: { timezone: "Europe/Prague" },
      },
      {
        _id: ids.otherLocation,
        tenant: ids.tenant,
        name: "Grohova",
        slug: "grohova",
        code: "G",
        isActive: true,
        booking: { timezone: "Europe/Prague" },
      },
      {
        _id: ids.foreignLocation,
        tenant: ids.otherTenant,
        name: "Another tenant",
        slug: "other",
        code: "O",
        isActive: true,
        booking: { timezone: "America/New_York" },
      },
    ] as any);
    await User.collection.insertMany([
      {
        _id: ids.customer,
        tenant: ids.tenant,
        firstname: "Local",
        lastname: "Customer",
        memberNumber: 1,
        customId: "CUSTOM-1",
        isAccessGranted: true,
        tenantRole: "customer",
        platformRole: "none",
      },
      {
        _id: ids.foreignCustomer,
        tenant: ids.otherTenant,
        firstname: "Private",
        lastname: "Customer",
        memberNumber: 1,
        customId: "SECRET",
        isAccessGranted: true,
        tenantRole: "customer",
        platformRole: "none",
      },
    ] as any);
  });

  it("lists only permitted tenant locations and rejects direct cross-scope detail, update and create", async () => {
    const local = await customOrderService.create(ctx, input());
    const restricted = await customOrderService.create(
      allLocations,
      input({ locationId: String(ids.otherLocation) }),
    );
    const foreign = await customOrderService.create(
      otherTenant,
      input({ locationId: String(ids.foreignLocation) }),
    );
    const list = await customOrderService.list(ctx, query());
    expect(list.items.map((row) => row.id)).toEqual([local.id]);
    expect(list.total).toBe(1);
    for (const hidden of [restricted, foreign]) {
      await expect(
        customOrderService.detail(ctx, hidden.id),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        customOrderService.update(ctx, hidden.id, {
          ...input(),
          revision: hidden.revision,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        customOrderService.attach(ctx, hidden.id, hidden.revision, [file()]),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
    await expect(
      customOrderService.create(
        ctx,
        input({ locationId: String(ids.otherLocation) }),
      ),
    ).rejects.toThrow();
    await expect(
      customOrderService.update(ctx, local.id, {
        ...input({ locationId: String(ids.foreignLocation) }),
        revision: local.revision,
      }),
    ).rejects.toThrow();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("never links or reveals another tenant's customer, even if its identifier is known", async () => {
    await expect(
      findCustomOrderCustomer(ctx, "SECRET", String(ids.location)),
    ).rejects.toMatchObject({ statusCode: 404 });
    const found = await findCustomOrderCustomer(
      ctx,
      "#1",
      String(ids.location),
    );
    expect(found.customer.id).toBe(String(ids.customer));
    await expect(
      customOrderService.create(
        ctx,
        input({ customerId: String(ids.foreignCustomer) }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await CustomOrder.countDocuments()).toBe(0);
  });

  it("customer-mode identity cannot use an underlying workspace membership", async () => {
    const req = {
      userInfo: {
        id: String(ids.staff),
        tenant: String(ids.tenant),
        authContext: "customer",
      },
    } as unknown as Request;
    mocks.resolveAccess.mockResolvedValue({
      status: "active",
      permissions: ["orders.view", "orders.manage"],
      locationAccess: { mode: "all", locationIds: [] },
    });
    await expect(customOrderContext(req, true)).rejects.toThrow();
    expect(mocks.resolveAccess).not.toHaveBeenCalled();
  });

  it("has no order deletion endpoint and read-only staff cannot mutate custom orders", async () => {
    const order = await customOrderService.create(ctx, input());
    const viewer = app(["orders.view"]);
    expect(
      (await request(viewer).get(`/custom-orders/${order.id}`)).status,
    ).toBe(200);
    expect(
      (await request(viewer).post("/custom-orders").send(input())).status,
    ).toBe(403);
    expect(
      (
        await request(viewer)
          .post(`/custom-orders/${order.id}/close`)
          .send({ revision: order.revision, reason: "completed" })
      ).status,
    ).toBe(403);
    expect(
      (await request(app()).delete(`/custom-orders/${order.id}`)).status,
    ).toBe(404);
    expect(
      (
        await request(app(["orders.view", "orders.manage"], "customer")).get(
          `/custom-orders/${order.id}`,
        )
      ).status,
    ).toBe(403);
    expect(await CustomOrder.countDocuments()).toBe(1);
  });

  it("validates mandatory content and refuses attempts to overwrite status or audit history", async () => {
    const server = app();
    for (const overrides of [
      { description: "  " },
      { materials: "" },
      { pieceCount: 0 },
      { deadline: "2026-02-30" },
      { deadline: "2026-02-28" },
      { status: "closed" },
      { history: [] },
      { tenant: String(ids.otherTenant) },
    ])
      expect(
        (await request(server).post("/custom-orders").send(input(overrides)))
          .status,
      ).toBe(400);
    expect(await CustomOrder.countDocuments()).toBe(0);
    const order = await customOrderService.create(ctx, input());
    const closed = await customOrderService.close(
      ctx,
      order.id,
      order.revision,
      "cancelled",
      "Customer cancelled.",
    );
    expect(
      (
        await request(server)
          .post(`/custom-orders/${order.id}/reopen`)
          .send({ revision: closed.revision, reason: "   " })
      ).status,
    ).toBe(400);
    expect((await customOrderService.detail(ctx, order.id)).status).toBe(
      "closed",
    );
  });

  it("serves only short-lived scoped attachment capabilities and revokes removed attachments", async () => {
    const order = await customOrderService.create(ctx, input());
    const attached = await customOrderService.attach(
      ctx,
      order.id,
      order.revision,
      [file()],
    );
    const link = new URL(attached.attachments[0].url);
    const server = app();
    const valid = await request(server).get(link.pathname + link.search);
    expect(valid.status).toBe(200);
    expect(valid.headers["cache-control"]).toBe("private, no-store");
    expect(valid.headers["x-content-type-options"]).toBe("nosniff");
    expect(valid.headers["content-type"]).toMatch(/^image\//);
    expect((await request(server).get(link.pathname)).status).toBe(404);
    const changed = new URL(link);
    changed.searchParams.set(
      "expires",
      String(Number(changed.searchParams.get("expires")) + 10000),
    );
    expect(
      (await request(server).get(changed.pathname + changed.search)).status,
    ).toBe(404);
    const differentOrder = await customOrderService.create(
      otherTenant,
      input({ locationId: String(ids.foreignLocation) }),
    );
    expect(
      (
        await request(server).get(
          link.pathname.replace(order.id, differentOrder.id) + link.search,
        )
      ).status,
    ).toBe(404);
    await customOrderService.removeAttachment(
      ctx,
      order.id,
      attached.attachments[0].id,
      attached.revision,
    );
    expect(
      (await request(server).get(link.pathname + link.search)).status,
    ).toBe(404);
    expect(objects.size).toBe(0);
  });

  it("stores quotations encrypted and downloads valid PDFs as attachments", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const bytes = Buffer.from(await pdf.save());
    const order = await customOrderService.create(ctx, input());
    const attached = await customOrderService.attach(
      ctx,
      order.id,
      order.revision,
      [
        {
          originalname: "Nabídka.pdf",
          mimetype: "application/pdf",
          buffer: bytes,
          size: bytes.length,
        } as Express.Multer.File,
      ],
    );
    expect(attached.attachments[0]).toMatchObject({
      kind: "document",
      contentType: "application/pdf",
      name: "Nabídka.pdf",
    });
    expect([...objects.values()][0].equals(bytes)).toBe(false);
    const url = new URL(attached.attachments[0].url);
    const response = await request(app()).get(url.pathname + url.search);
    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(response.headers["content-type"]).toMatch(/^application\/pdf/);
    expect(response.body).toEqual(bytes);
  });

  it("rolls back an order change if its durable audit record cannot be written", async () => {
    const order = await customOrderService.create(ctx, input());
    const eventWrite = vi
      .spyOn(CustomOrderEvent, "create")
      .mockRejectedValueOnce(new Error("Audit store temporarily unavailable"));
    await expect(
      customOrderService.update(ctx, order.id, {
        ...input({ title: "Unrecorded change" }),
        revision: order.revision,
      }),
    ).rejects.toThrow("Audit store temporarily unavailable");
    eventWrite.mockRestore();
    const current = await customOrderService.detail(ctx, order.id);
    expect(current.title).toBe(order.title);
    expect(current.revision).toBe(order.revision);
    expect(current.history).toEqual(order.history);
  });

  it("paginates durable progress history while retaining all older entries and enforcing order scope", async () => {
    const order = await customOrderService.create(ctx, input());
    await CustomOrderEvent.insertMany(
      Array.from({ length: 51 }, (_, index) => ({
        tenant: ids.tenant,
        order: new mongoose.Types.ObjectId(order.id),
        action: "comment_added",
        actor: ids.staff,
        actorName: "Studio manager",
        body: `Progress ${index + 1}`,
        createdAt: new Date(Date.now() + index + 1),
      })),
    );
    const detail = await customOrderService.detail(ctx, order.id);
    expect(detail.history).toHaveLength(50);
    expect(detail.historyPagination).toMatchObject({ total: 52, pages: 2 });
    const page = await customOrderService.history(ctx, order.id, 2);
    expect(page.items).toHaveLength(2);
    expect(
      new Set([...detail.history, ...page.items].map((event) => event.id)).size,
    ).toBe(52);
    await expect(
      customOrderService.history(otherTenant, order.id, 2),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("closed orders block every write and retain complete history after explicit reopening", async () => {
    const created = await customOrderService.create(ctx, input());
    const attached = await customOrderService.attach(
      ctx,
      created.id,
      created.revision,
      [file()],
    );
    const commented = await customOrderService.comment(
      ctx,
      created.id,
      attached.revision,
      "Glazing complete.",
    );
    const closed = await customOrderService.close(
      ctx,
      created.id,
      commented.revision,
      "completed",
      "Collected by customer.",
    );
    const fileId = closed.attachments[0].id;
    for (const operation of [
      () =>
        customOrderService.update(ctx, created.id, {
          ...input({ title: "Unexpected edit" }),
          revision: closed.revision,
        }),
      () =>
        customOrderService.comment(
          ctx,
          created.id,
          closed.revision,
          "Unexpected comment",
        ),
      () =>
        customOrderService.attach(ctx, created.id, closed.revision, [
          file("unexpected.png"),
        ]),
      () =>
        customOrderService.removeAttachment(
          ctx,
          created.id,
          fileId,
          closed.revision,
        ),
    ])
      await expect(operation()).rejects.toMatchObject({
        code: "CUSTOM_ORDER_CLOSED",
      });
    const reopened = await customOrderService.reopen(
      ctx,
      created.id,
      closed.revision,
      "Customer requested one replacement plate.",
    );
    expect(reopened.status).toBe("active");
    expect(
      reopened.history.filter((event) => event.action !== "reopened"),
    ).toEqual(closed.history);
    expect(
      reopened.history.find((event) => event.action === "reopened"),
    ).toMatchObject({
      action: "reopened",
      body: "Customer requested one replacement plate.",
    });
    expect(reopened.attachments).toHaveLength(1);
    expect(objects.size).toBe(1);
  });

  it("a concurrent close and progress comment cannot overwrite each other or lose audit events", async () => {
    const order = await customOrderService.create(ctx, input());
    const results = await Promise.allSettled([
      customOrderService.close(
        ctx,
        order.id,
        order.revision,
        "completed",
        "Finished",
      ),
      customOrderService.comment(
        ctx,
        order.id,
        order.revision,
        "Finishing touches",
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const stored = await customOrderService.detail(ctx, order.id);
    expect(stored.revision).toBe(order.revision + 1);
    expect(stored.history).toHaveLength(2);
    expect(
      stored.history.filter((event) => event.action === "created"),
    ).toHaveLength(1);
    expect(["closed", "comment_added"]).toContain(
      stored.history.find((event) => event.action !== "created")?.action,
    );
  });

  it("keeps the five-image total under competing uploads and cleans only the rejected upload", async () => {
    const order = await customOrderService.create(ctx, input());
    const four = await customOrderService.attach(
      ctx,
      order.id,
      order.revision,
      [file("1.png"), file("2.png"), file("3.png"), file("4.png")],
    );
    const originalKeys = new Set(objects.keys());
    const results = await Promise.allSettled([
      customOrderService.attach(ctx, order.id, four.revision, [
        file("5-a.png"),
      ]),
      customOrderService.attach(ctx, order.id, four.revision, [
        file("5-b.png"),
      ]),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const current = await customOrderService.detail(ctx, order.id);
    expect(current.attachments).toHaveLength(5);
    expect(objects.size).toBe(5);
    for (const key of originalKeys) expect(objects.has(key)).toBe(true);
    await expect(
      customOrderService.attach(ctx, order.id, current.revision, [
        file("sixth.png"),
      ]),
    ).rejects.toThrow();
    expect(
      (await customOrderService.detail(ctx, order.id)).attachments,
    ).toHaveLength(5);
    expect(objects.size).toBe(5);
  });

  it("retains uploaded bytes when a transaction committed but its acknowledgement failed", async () => {
    const order = await customOrderService.create(ctx, input());
    const session = await mongoose.startSession();
    const transact = session.withTransaction.bind(session);
    vi.spyOn(session, "withTransaction").mockImplementation(
      async (task, options) => {
        await transact(task, options);
        throw new Error("Unknown transaction commit result");
      },
    );
    vi.spyOn(mongoose, "startSession").mockResolvedValueOnce(session);

    await expect(
      customOrderService.attach(ctx, order.id, order.revision, [file()]),
    ).rejects.toThrow("Unknown transaction commit result");

    const current = await customOrderService.detail(ctx, order.id);
    expect(current.attachments).toHaveLength(1);
    expect(current.revision).toBe(order.revision + 1);
    expect(
      current.history.filter((event) => event.action === "attachment_added"),
    ).toHaveLength(1);
    expect(objects.size).toBe(1);
    expect(mocks.remove).not.toHaveBeenCalled();
    const stored = await CustomOrder.findById(order.id).lean();
    expect(objects.has(stored!.attachments[0].key)).toBe(true);
  });

  it.each([
    ["2026-03-29", "2026-03-29T22:00:00.000Z"],
    ["2026-10-25", "2026-10-25T23:00:00.000Z"],
  ])(
    "uses the studio's next midnight across DST for deadline %s",
    async (deadline, boundary) => {
      expect(
        customOrderDeadlineAt(deadline, "Europe/Prague").toISOString(),
      ).toBe(boundary);
      const order = await customOrderService.create(ctx, input({ deadline }));
      const before = await customOrderService.list(
        ctx,
        query({ status: "overdue" }),
        new Date(new Date(boundary).getTime() - 1),
      );
      expect(before.total).toBe(0);
      const at = await customOrderService.list(
        ctx,
        query({ status: "overdue" }),
        new Date(boundary),
      );
      expect(at.items.map((row) => row.id)).toEqual([order.id]);
      expect(at.items[0].isOverdue).toBe(true);
      await customOrderService.close(
        ctx,
        order.id,
        order.revision,
        "completed",
        "",
      );
      expect(
        (
          await customOrderService.list(
            ctx,
            query({ status: "overdue" }),
            new Date(boundary),
          )
        ).total,
      ).toBe(0);
    },
  );
});
