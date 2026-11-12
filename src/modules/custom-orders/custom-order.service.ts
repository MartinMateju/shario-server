import type { Request } from "express";
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { AUTH_CONTEXT } from "@/modules/auth/auth.constants.js";
import {
  getAuthenticatedUserId,
  getAuthenticatedUserName,
} from "@/modules/auth/auth.utils.js";
import { assertAuthContext } from "@/modules/auth/middleware/requireAuthContext.js";
import { requireTenantId } from "@/modules/tenants/tenant.utils.js";
import Tenant from "@/modules/tenants/tenant.model.js";
import Location from "@/modules/location/location.model.js";
import User from "@/modules/user/user.model.js";
import TenantMembership from "@/modules/tenant-access/tenant-membership.model.js";
import {
  assertLocationIdsWithinWorkspaceScope,
  getAllowedWorkspaceLocationIds,
  hasWorkspacePermission,
  canAccessWorkspaceLocation,
  resolveWorkspaceAccessForUser,
  type AllowedWorkspaceLocationIds,
  type WorkspaceAccessRequest,
} from "@/modules/tenant-access/index.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import { DEFAULT_TIMEZONE } from "@/shared/time/time.utils.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "@/shared/http/httpErrors.js";
import {
  CustomOrder,
  CustomOrderEvent,
  type CustomOrderRecord,
} from "./custom-order.model.js";
import {
  cleanupCustomOrderAttachments,
  storeCustomOrderAttachments,
  signedCustomOrderAttachmentUrl,
} from "./custom-order.media.js";
import {
  createCustomOrderInput,
  updateCustomOrderInput,
  listCustomOrdersInput,
} from "./custom-order.validators.js";
import type { z } from "zod";

export type CustomOrderContext = {
  tenantId: string;
  userId: string;
  actorName: string;
  locations: AllowedWorkspaceLocationIds;
};
const oid = (value: string) => new mongoose.Types.ObjectId(value);
const name = (user: any) =>
  [user?.firstname, user?.lastname].filter(Boolean).join(" ") ||
  user?.name ||
  "";
const missing = (): never =>
  notFound({
    code: "CUSTOM_ORDER_NOT_FOUND",
    message: "Custom order not found.",
  });
const stale = (): never =>
  conflict({
    code: "CUSTOM_ORDER_STALE",
    message: "This order changed. Refresh it before saving again.",
  });
export const customOrderContext = async (
  req: Request,
  manage = false,
): Promise<CustomOrderContext> => {
  assertAuthContext(req, AUTH_CONTEXT.WORKSPACE);
  const tenantId = requireTenantId(req);
  const userId = getAuthenticatedUserId(req);
  const cached = req as WorkspaceAccessRequest;
  const access =
    cached.workspaceAccessResolved &&
    (!cached.workspaceAccess ||
      (cached.workspaceAccess.tenantId === tenantId &&
        cached.workspaceAccess.userId === userId))
      ? cached.workspaceAccess
      : await resolveWorkspaceAccessForUser({ tenantId, userId });
  if (
    !hasWorkspacePermission(
      access,
      manage
        ? WORKSPACE_PERMISSION.ORDERS_MANAGE
        : WORKSPACE_PERMISSION.ORDERS_VIEW,
    )
  )
    forbidden("Custom order access is not permitted.");
  return {
    tenantId,
    userId,
    actorName: getAuthenticatedUserName(req) || "Staff",
    locations: getAllowedWorkspaceLocationIds(access),
  };
};
export const customOrderScope = (
  ctx: CustomOrderContext,
  locationId?: string,
) => {
  if (locationId)
    assertLocationIdsWithinWorkspaceScope([locationId], ctx.locations);
  return {
    tenant: ctx.tenantId,
    ...(locationId
      ? { location: locationId }
      : ctx.locations === null
        ? {}
        : { location: { $in: ctx.locations } }),
  };
};
export const loadCustomOrder = async (
  ctx: CustomOrderContext,
  orderId: string,
) => {
  const order = await CustomOrder.findOne({
    _id: orderId,
    ...customOrderScope(ctx),
  })
    .lean()
    .exec();
  if (!order) missing();
  return order;
};
const active = (order: CustomOrderRecord, revision: number) => {
  if (order.status !== "active")
    conflict({
      code: "CUSTOM_ORDER_CLOSED",
      message: "Reopen this order before changing it.",
    });
  if (order.revision !== revision) stale();
};
export const customOrderDeadlineAt = (deadline: string, timeZone: string) => {
  const date = new Date(`${deadline}T00:00:00Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== deadline
  )
    badRequest("Enter a valid deadline.");
  date.setUTCDate(date.getUTCDate() + 1);
  const nextDate = date.toISOString().slice(0, 10);
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localDate = (time: number) => {
    const parts = format.formatToParts(new Date(time));
    const part = (type: string) =>
      parts
        .find((item) => item.type === type)!
        .value.padStart(type === "year" ? 4 : 2, "0");
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  // Find the first instant of the next local calendar day, including DST and
  // zones that skip midnight. This does not depend on the server's local zone.
  let low = date.getTime() - 36 * 3600000;
  let high = date.getTime() + 36 * 3600000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDate(middle) >= nextDate) high = middle;
    else low = middle + 1;
  }
  return new Date(low);
};
const history = (
  ctx: CustomOrderContext,
  action: string,
  body = "",
  changes: Array<{ field: string; from: string; to: string }> = [],
) => ({
  _id: new mongoose.Types.ObjectId(),
  action,
  actor: oid(ctx.userId),
  actorName: ctx.actorName,
  createdAt: new Date(),
  body,
  changes,
});
const eventDto = (event: any) => ({
  id: String(event._id),
  action: event.action,
  actorName: event.actorName,
  createdAt: event.createdAt,
  body: event.body,
  changes: event.changes,
});
const loadHistory = async (
  order: Pick<CustomOrderRecord, "_id" | "tenant">,
  page = 1,
) => {
  const filter = { tenant: order.tenant, order: order._id };
  const limit = 50;
  const [events, total] = await Promise.all([
    CustomOrderEvent.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    CustomOrderEvent.countDocuments(filter),
  ]);
  return {
    items: events.map(eventDto),
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
};
const transaction = async <T>(
  task: (session: mongoose.ClientSession) => Promise<T>,
): Promise<T> => {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => task(session));
  } finally {
    await session.endSession();
  }
};
const locationFor = async (ctx: CustomOrderContext, locationId: string) => {
  assertLocationIdsWithinWorkspaceScope([locationId], ctx.locations);
  const location = await Location.findOne({
    tenant: ctx.tenantId,
    _id: locationId,
    isActive: true,
  })
    .select("name booking.timezone")
    .lean()
    .exec();
  if (!location) notFound("Active studio location not found.");
  return location;
};
const customerFilter = (tenantId: string) => ({
  tenant: tenantId,
  isAccessGranted: true,
  tenantRole: {
    $in: [
      "customer" as const,
      "owner" as const,
      "admin" as const,
      "staff" as const,
    ],
  },
  platformRole: { $in: ["none" as const, null] },
});
export const findCustomOrderCustomer = async (
  ctx: CustomOrderContext,
  identifier: string,
  locationId?: string,
) => {
  if (locationId) await locationFor(ctx, locationId);
  const value = identifier.trim();
  if (!value || value.length > 80) badRequest("Enter an exact customer ID.");
  const memberNumber = /^#?\d+$/.test(value)
    ? Number(value.replace(/^#/, ""))
    : null;
  const select = "firstname lastname email phone memberNumber customId";
  let user =
    Number.isSafeInteger(memberNumber) && Number(memberNumber) > 0
      ? await User.findOne({ ...customerFilter(ctx.tenantId), memberNumber })
          .select(select)
          .lean()
      : null;
  if (!user)
    user = await User.findOne({
      ...customerFilter(ctx.tenantId),
      customId: value,
    })
      .select(select)
      .lean();
  if (!user)
    notFound({
      code: "CUSTOM_ORDER_CUSTOMER_NOT_FOUND",
      message: "No customer has this ID in your studio.",
    });
  return {
    customer: {
      id: String(user._id),
      name: name(user),
      email: user.email || "",
      phone: user.phone || "",
      memberNumber: user.memberNumber,
      customId: user.customId,
    },
  };
};
const assigneeAllowed = async (
  tenantId: string,
  userId: string,
  locationId: string,
) => {
  if (
    !(await User.exists({
      _id: userId,
      tenant: tenantId,
      isAccessGranted: true,
    }))
  )
    return false;
  const access = await resolveWorkspaceAccessForUser({ tenantId, userId });
  return (
    hasWorkspacePermission(access, WORKSPACE_PERMISSION.ORDERS_VIEW) &&
    canAccessWorkspaceLocation(access, locationId)
  );
};
export const customOrderOptions = async (
  ctx: CustomOrderContext,
  locationId?: string,
) => {
  if (locationId) await locationFor(ctx, locationId);
  const [locations, memberships, tenant] = await Promise.all([
    Location.find({
      tenant: ctx.tenantId,
      isActive: true,
      ...(ctx.locations === null ? {} : { _id: { $in: ctx.locations } }),
    })
      .select("name booking.timezone")
      .sort({ name: 1 })
      .lean(),
    TenantMembership.find({ tenant: ctx.tenantId, status: "active" })
      .select("user")
      .lean(),
    Tenant.findById(ctx.tenantId).select("settings.currency").lean(),
  ]);
  const staff = await User.find({
    _id: { $in: memberships.map((row) => row.user) },
    tenant: ctx.tenantId,
    isAccessGranted: true,
  })
    .select("firstname lastname")
    .lean();
  const permitted = await Promise.all(
    staff.map(async (user) => {
      const access = await resolveWorkspaceAccessForUser({
        tenantId: ctx.tenantId,
        userId: String(user._id),
      });
      const available =
        hasWorkspacePermission(access, WORKSPACE_PERMISSION.ORDERS_VIEW) &&
        (locationId
          ? canAccessWorkspaceLocation(access, locationId)
          : locations.some((location) =>
              canAccessWorkspaceLocation(access, location._id),
            ));
      return available ? { id: String(user._id), name: name(user) } : null;
    }),
  );
  return {
    locations: locations.map((location) => ({
      id: String(location._id),
      name: location.name,
      timeZone: location.booking?.timezone || DEFAULT_TIMEZONE,
    })),
    assignees: permitted.filter(Boolean),
    currency: tenant?.settings?.currency || "CZK",
  };
};
const valuesFor = async (
  ctx: CustomOrderContext,
  input: z.infer<typeof createCustomOrderInput>,
) => {
  const location = await locationFor(ctx, input.locationId);
  let customer = input.customer;
  if (input.customerId) {
    const user = await User.findOne({
      ...customerFilter(ctx.tenantId),
      _id: input.customerId,
    })
      .select("firstname lastname email phone")
      .lean();
    if (!user) notFound("Customer not found in this studio.");
    customer = {
      name: name(user),
      email: user.email || "",
      phone: user.phone || "",
    };
  }
  if (
    input.assigneeId &&
    !(await assigneeAllowed(ctx.tenantId, input.assigneeId, input.locationId))
  )
    badRequest({
      code: "CUSTOM_ORDER_ASSIGNEE_INVALID",
      message:
        "Choose an active staff member with access to this studio location.",
    });
  const timeZone = location.booking?.timezone || DEFAULT_TIMEZONE;
  return {
    title: input.title,
    description: input.description,
    materials: input.materials,
    finish: input.finish,
    pieceCount: input.pieceCount,
    startDate: input.startDate,
    deadline: input.deadline,
    location: oid(input.locationId),
    timeZone,
    deadlineAt: customOrderDeadlineAt(input.deadline, timeZone),
    customerId: input.customerId ? oid(input.customerId) : null,
    customer,
    assignee: input.assigneeId ? oid(input.assigneeId) : null,
    quotedAmount: input.quotedAmount,
    currency: input.currency,
  };
};
export const customOrderDto = async (
  order: any,
  detail = true,
  now = new Date(),
  related?: { location: any; assignee: any },
) => {
  const [location, assignee] = related
    ? [related.location, related.assignee]
    : await Promise.all([
        Location.findOne({ _id: order.location, tenant: order.tenant })
          .select("name")
          .lean(),
        order.assignee
          ? User.findOne({ _id: order.assignee, tenant: order.tenant })
              .select("firstname lastname")
              .lean()
          : null,
      ]);
  const events = detail ? await loadHistory(order) : null;
  return {
    id: String(order._id),
    _id: String(order._id),
    reference: order.reference,
    title: order.title,
    description: order.description,
    materials: order.materials,
    finish: order.finish,
    pieceCount: order.pieceCount,
    startDate: order.startDate,
    deadline: order.deadline,
    locationId: String(order.location),
    location: { id: String(order.location), name: location?.name || "" },
    timeZone: order.timeZone,
    customerId: order.customerId ? String(order.customerId) : null,
    customer: order.customer,
    assigneeId: order.assignee ? String(order.assignee) : null,
    assignee: assignee
      ? { id: String(assignee._id), name: name(assignee) }
      : null,
    quotedAmount: order.quotedAmount,
    currency: order.currency,
    status: order.status,
    closeReason: order.closeReason,
    closedAt: order.closedAt,
    revision: order.revision,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    isOverdue: order.status === "active" && new Date(order.deadlineAt) <= now,
    ...(detail
      ? {
          attachments: order.attachments.map((file: any) => ({
            id: String(file._id),
            name: file.name,
            kind: file.kind,
            contentType: file.contentType,
            size: file.size,
            url: signedCustomOrderAttachmentUrl(order, file),
          })),
          history: events!.items,
          historyPagination: {
            page: events!.page,
            limit: events!.limit,
            total: events!.total,
            pages: events!.pages,
          },
        }
      : {}),
  };
};
const commitRaw = async (
  ctx: CustomOrderContext,
  order: CustomOrderRecord,
  revision: number,
  values: Record<string, any>,
  event: ReturnType<typeof history>,
  extra: Record<string, any> = {},
) => {
  const updated = await transaction(async (session) => {
    const updated = await CustomOrder.findOneAndUpdate(
      {
        _id: order._id,
        ...customOrderScope(ctx),
        revision,
        status: order.status,
      },
      { $set: values, $inc: { revision: 1 }, ...extra },
      { returnDocument: "after", runValidators: true, session },
    ).lean();
    if (!updated) stale();
    await CustomOrderEvent.create(
      [{ ...event, tenant: order.tenant, order: order._id }],
      { session },
    );
    return updated;
  });
  return updated;
};
const commit = async (...args: Parameters<typeof commitRaw>) =>
  customOrderDto(await commitRaw(...args));
export const customOrderService = {
  async list(
    ctx: CustomOrderContext,
    input: z.infer<typeof listCustomOrdersInput>,
    now = new Date(),
  ) {
    const search = input.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const filter = {
      ...customOrderScope(ctx, input.locationId),
      ...(input.status !== "all"
        ? {
            status:
              input.status === "closed"
                ? ("closed" as const)
                : ("active" as const),
          }
        : {}),
      ...(input.status === "overdue" ? { deadlineAt: { $lte: now } } : {}),
      ...(search
        ? {
            $or: [
              { title: { $regex: search, $options: "i" } },
              { reference: { $regex: search, $options: "i" } },
              { "customer.name": { $regex: search, $options: "i" } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      CustomOrder.find(filter)
        .select("-attachments -description -materials -finish")
        .sort({ updatedAt: -1, _id: -1 })
        .skip((input.page - 1) * input.limit)
        .limit(input.limit)
        .lean(),
      CustomOrder.countDocuments(filter),
    ]);
    const [locations, staff] = await Promise.all([
      Location.find({
        tenant: ctx.tenantId,
        _id: { $in: rows.map((order) => order.location) },
      })
        .select("name")
        .lean(),
      User.find({
        tenant: ctx.tenantId,
        _id: {
          $in: rows.flatMap((order) =>
            order.assignee ? [order.assignee] : [],
          ),
        },
      })
        .select("firstname lastname")
        .lean(),
    ]);
    const locationsById = new Map(
      locations.map((location) => [String(location._id), location]),
    );
    const staffById = new Map(staff.map((user) => [String(user._id), user]));
    return {
      items: await Promise.all(
        rows.map((order) =>
          customOrderDto(order, false, now, {
            location: locationsById.get(String(order.location)),
            assignee: staffById.get(String(order.assignee)),
          }),
        ),
      ),
      total,
      page: input.page,
      limit: input.limit,
      pages: Math.max(1, Math.ceil(total / input.limit)),
    };
  },
  async detail(ctx: CustomOrderContext, orderId: string) {
    return customOrderDto(await loadCustomOrder(ctx, orderId));
  },
  async history(ctx: CustomOrderContext, orderId: string, page = 1) {
    return loadHistory(await loadCustomOrder(ctx, orderId), page);
  },
  async create(ctx: CustomOrderContext, raw: unknown) {
    const input = createCustomOrderInput.parse(raw);
    const values = await valuesFor(ctx, input);
    const order = await transaction(async (session) => {
      const [order] = await CustomOrder.create(
        [
          {
            tenant: oid(ctx.tenantId),
            reference: `Z-${randomBytes(6).toString("hex").toUpperCase()}`,
            ...values,
          },
        ],
        { session },
      );
      await CustomOrderEvent.create(
        [
          {
            ...history(ctx, "created"),
            tenant: order.tenant,
            order: order._id,
          },
        ],
        { session },
      );
      return order;
    });
    return customOrderDto(order.toObject());
  },
  async update(ctx: CustomOrderContext, orderId: string, raw: unknown) {
    const input = updateCustomOrderInput.parse(raw);
    const order = await loadCustomOrder(ctx, orderId);
    active(order, input.revision);
    const values = await valuesFor(ctx, input);
    const changed = Object.entries(values).filter(
      ([key, value]) =>
        JSON.stringify((order as any)[key]) !== JSON.stringify(value),
    );
    const stringify = (value: any) =>
      value == null
        ? ""
        : typeof value === "object"
          ? value instanceof mongoose.Types.ObjectId
            ? String(value)
            : JSON.stringify(value)
          : String(value);
    const [locations, users] = await Promise.all([
      Location.find({
        tenant: ctx.tenantId,
        _id: { $in: [order.location, values.location] },
      })
        .select("name")
        .lean(),
      User.find({
        tenant: ctx.tenantId,
        _id: { $in: [order.assignee, values.assignee].filter(Boolean) },
      })
        .select("firstname lastname")
        .lean(),
    ]);
    const locationNames = new Map(
      locations.map((location) => [String(location._id), location.name]),
    );
    const userNames = new Map(
      users.map((user) => [String(user._id), name(user)]),
    );
    const changes = changed
      .filter(([key]) => key !== "deadlineAt")
      .flatMap(([field, value]) => {
        if (field === "location")
          return [
            {
              field: "locationId",
              from: locationNames.get(String(order.location)) || "",
              to: locationNames.get(String(value)) || "",
            },
          ];
        if (field === "assignee")
          return [
            {
              field: "assigneeId",
              from: userNames.get(String(order.assignee)) || "",
              to: userNames.get(String(value)) || "",
            },
          ];
        if (field === "customerId")
          return [
            {
              field,
              from: order.customerId ? order.customer.name : "",
              to: value ? values.customer.name : "",
            },
          ];
        if (field === "customer")
          return (["name", "email", "phone"] as const)
            .filter((key) => order.customer[key] !== values.customer[key])
            .map((key) => ({
              field: `customer${key[0].toUpperCase()}${key.slice(1)}`,
              from: order.customer[key],
              to: values.customer[key],
            }));
        return [
          {
            field,
            from: stringify((order as any)[field]),
            to: stringify(value),
          },
        ];
      });
    const reset =
      order.deadline !== values.deadline ||
      String(order.location) !== String(values.location) ||
      order.timeZone !== values.timeZone;
    return commit(
      ctx,
      order,
      input.revision,
      {
        ...values,
        ...(reset
          ? {
              reminderCycle: order.reminderCycle + 1,
              dueSoonReminderAt: null,
              overdueReminderAt: null,
            }
          : {}),
      },
      history(ctx, "updated", "", changes),
    );
  },
  async comment(
    ctx: CustomOrderContext,
    orderId: string,
    revision: number,
    body: string,
  ) {
    const order = await loadCustomOrder(ctx, orderId);
    active(order, revision);
    return commit(
      ctx,
      order,
      revision,
      {},
      history(ctx, "comment_added", body),
    );
  },
  async close(
    ctx: CustomOrderContext,
    orderId: string,
    revision: number,
    reason: "completed" | "cancelled",
    note: string,
  ) {
    const order = await loadCustomOrder(ctx, orderId);
    active(order, revision);
    return commit(
      ctx,
      order,
      revision,
      { status: "closed", closeReason: reason, closedAt: new Date() },
      history(ctx, "closed", note, [
        { field: "closeReason", from: "", to: reason },
      ]),
    );
  },
  async reopen(
    ctx: CustomOrderContext,
    orderId: string,
    revision: number,
    reason: string,
  ) {
    const order = await loadCustomOrder(ctx, orderId);
    if (order.status !== "closed")
      conflict({
        code: "CUSTOM_ORDER_NOT_CLOSED",
        message: "This order is already active.",
      });
    if (order.revision !== revision) stale();
    return commit(
      ctx,
      order,
      revision,
      {
        status: "active",
        closeReason: null,
        closedAt: null,
        reminderCycle: order.reminderCycle + 1,
        dueSoonReminderAt: null,
        overdueReminderAt: null,
      },
      history(ctx, "reopened", reason),
    );
  },
  async attach(
    ctx: CustomOrderContext,
    orderId: string,
    revision: number,
    files: Express.Multer.File[],
  ) {
    const order = await loadCustomOrder(ctx, orderId);
    active(order, revision);
    const uploaded = await storeCustomOrderAttachments(
      files,
      order,
      ctx.tenantId,
    );
    let updated;
    const event = history(
      ctx,
      "attachment_added",
      uploaded.map((file) => file.name).join(", "),
    );
    try {
      updated = await commitRaw(ctx, order, revision, {}, event, {
        $push: { attachments: { $each: uploaded } },
      });
    } catch (error) {
      // A driver/network error can leave a transaction's commit result unknown.
      // Verify that the files were not committed before compensating; when the
      // database is unavailable retaining encrypted objects is safer than data loss.
      try {
        const referenced = await CustomOrder.exists({
          _id: order._id,
          tenant: ctx.tenantId,
          "attachments._id": { $in: uploaded.map((file) => file._id) },
        });
        if (!referenced) await cleanupCustomOrderAttachments(uploaded);
      } catch {
        /* Keep encrypted objects intact when the commit result cannot be checked. */
      }
      throw error;
    }
    // Only compensate a failed database mutation. A later read/URL error must
    // never delete files that are already referenced by a committed order.
    return customOrderDto(updated);
  },
  async removeAttachment(
    ctx: CustomOrderContext,
    orderId: string,
    attachmentId: string,
    revision: number,
  ) {
    const order = await loadCustomOrder(ctx, orderId);
    active(order, revision);
    const file = order.attachments.find(
      (attachment) => String(attachment._id) === attachmentId,
    );
    if (!file) notFound("Attachment not found.");
    const result = await commit(
      ctx,
      order,
      revision,
      {},
      history(ctx, "attachment_removed", file.name),
      { $pull: { attachments: { _id: file._id } } },
    );
    await cleanupCustomOrderAttachments([file]);
    return result;
  },
};
