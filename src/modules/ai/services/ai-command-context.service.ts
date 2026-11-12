import { isNativeInvoicingEnabled } from "@/modules/invoice/invoice.feature.js";
import mongoose from "mongoose";

import { InventoryItem } from "@/modules/inventory/inventory.model.js";
import LocationModel from "@/modules/location/location.model.js";
import ProductModel from "@/modules/product/product.model.js";
import { PRODUCT_KIND } from "@/modules/product/product-kind-v2.contract.js";
import { resolveProductKindV2 } from "@/modules/product/product.utils.js";
import { STAFF_TASK_STATUS } from "@/modules/staff/staff.constants.js";
import StaffTaskModel from "@/modules/staff/staff-task.model.js";
import {
  canAccessWorkspaceLocation,
  hasWorkspacePermission,
} from "@/modules/tenant-access/services/authorization.service.js";
import { WORKSPACE_PERMISSION } from "@/modules/tenant-access/tenant-access.permissions.js";
import type { ResolvedWorkspaceAccess } from "@/modules/tenant-access/tenant-access.types.js";
import { TENANT_MODULE } from "@/modules/tenants/tenant.constants.js";
import TenantModel from "@/modules/tenants/tenant.model.js";

import { AI_ACTION_KEY, AI_ACTION_RISK } from "../ai.constants.js";
import type {
  AiCommandContext,
  AssistantCapabilityDomain,
} from "../ai-action.types.js";

const objectIds = (values: readonly string[]) =>
  values.map((value) => new mongoose.Types.ObjectId(value));

export const emptyAiCommandContext = (): AiCommandContext => ({
  generatedAt: new Date().toISOString(),
  capabilities: [],
  assistantCapabilities: {
    readableDomains: [],
    preparableActions: [],
    bookingComposer: {
      enabled: false,
      prefillEnabled: false,
      directMutation: false,
    },
  },
  locations: [],
  bookingProducts: [],
  openTasks: [],
  lowStockItems: [],
});

const buildBaseAiCommandContext = async ({
  tenantId,
  userId,
  access,
  locationId,
}: {
  tenantId: string;
  userId: string;
  access: ResolvedWorkspaceAccess;
  locationId?: string | null;
}): Promise<AiCommandContext> => {
  if (
    access.status !== "active" ||
    access.tenantId !== tenantId ||
    access.userId !== userId
  ) {
    return emptyAiCommandContext();
  }
  if (locationId && !canAccessWorkspaceLocation(access, locationId)) {
    return emptyAiCommandContext();
  }

  const tenant = await TenantModel.findById(tenantId).select("modules").lean();
  if (!tenant) return emptyAiCommandContext();
  const modules = (tenant as any).modules || {};

  const taskManagementEnabled =
    modules[TENANT_MODULE.STAFF_TASKS] === true &&
    hasWorkspacePermission(access, WORKSPACE_PERMISSION.TASKS_MANAGE);
  const taskTargetsEnabled =
    taskManagementEnabled &&
    hasWorkspacePermission(access, WORKSPACE_PERMISSION.TASKS_VIEW);
  const inventoryTargetsEnabled =
    modules[TENANT_MODULE.INVENTORY] === true &&
    hasWorkspacePermission(access, WORKSPACE_PERMISSION.INVENTORY_MANAGE) &&
    hasWorkspacePermission(access, WORKSPACE_PERMISSION.INVENTORY_VIEW);
  const bookingComposerEnabled =
    modules[TENANT_MODULE.BOOKINGS] === true &&
    hasWorkspacePermission(access, WORKSPACE_PERMISSION.BOOKINGS_CREATE) &&
    hasWorkspacePermission(access, WORKSPACE_PERMISSION.LOCATIONS_VIEW) &&
    hasWorkspacePermission(access, WORKSPACE_PERMISSION.PRODUCTS_VIEW);
  const bookingPrefillEnabled = bookingComposerEnabled;

  const readableDomains: AssistantCapabilityDomain[] = [];
  const addReadableDomain = (
    domain: AssistantCapabilityDomain,
    permission: (typeof WORKSPACE_PERMISSION)[keyof typeof WORKSPACE_PERMISSION],
    module?: (typeof TENANT_MODULE)[keyof typeof TENANT_MODULE],
  ) => {
    if (
      hasWorkspacePermission(access, permission) &&
      (!module || modules[module] === true)
    ) {
      readableDomains.push(domain);
    }
  };
  addReadableDomain(
    "bookings",
    WORKSPACE_PERMISSION.BOOKINGS_VIEW,
    TENANT_MODULE.BOOKINGS,
  );
  addReadableDomain(
    "customers",
    WORKSPACE_PERMISSION.CUSTOMERS_VIEW,
    TENANT_MODULE.CUSTOMERS,
  );
  addReadableDomain(
    "inventory",
    WORKSPACE_PERMISSION.INVENTORY_VIEW,
    TENANT_MODULE.INVENTORY,
  );
  addReadableDomain(
    "memberships",
    WORKSPACE_PERMISSION.MEMBERSHIPS_VIEW,
    TENANT_MODULE.MEMBERSHIPS,
  );
  if (isNativeInvoicingEnabled()) {
    addReadableDomain(
      "invoices",
      WORKSPACE_PERMISSION.INVOICES_VIEW,
      TENANT_MODULE.PAYMENTS,
    );
  }
  addReadableDomain("team", WORKSPACE_PERMISSION.TEAM_VIEW);
  addReadableDomain(
    "tasks",
    WORKSPACE_PERMISSION.TASKS_VIEW,
    TENANT_MODULE.STAFF_TASKS,
  );
  addReadableDomain(
    "communications",
    WORKSPACE_PERMISSION.COMMUNICATIONS_VIEW,
    TENANT_MODULE.COMMUNICATIONS,
  );
  addReadableDomain("reports", WORKSPACE_PERMISSION.REPORTS_VIEW);
  addReadableDomain("locations", WORKSPACE_PERMISSION.LOCATIONS_VIEW);
  addReadableDomain("products", WORKSPACE_PERMISSION.PRODUCTS_VIEW);
  addReadableDomain(
    "courses",
    WORKSPACE_PERMISSION.COURSES_VIEW,
    TENANT_MODULE.COURSES,
  );

  const capabilities: AiCommandContext["capabilities"] = [];
  if (taskManagementEnabled) {
    capabilities.push({
      key: AI_ACTION_KEY.CREATE_TASK,
      requiredPermission: WORKSPACE_PERMISSION.TASKS_MANAGE,
      riskLevel: AI_ACTION_RISK.LOW,
    });
  }
  if (taskTargetsEnabled) {
    capabilities.push({
      key: AI_ACTION_KEY.COMPLETE_TASK,
      requiredPermission: WORKSPACE_PERMISSION.TASKS_MANAGE,
      riskLevel: AI_ACTION_RISK.LOW,
    });
  }
  if (inventoryTargetsEnabled) {
    capabilities.push({
      key: AI_ACTION_KEY.CREATE_INVENTORY_REORDER_REQUEST,
      requiredPermission: WORKSPACE_PERMISSION.INVENTORY_MANAGE,
      riskLevel: AI_ACTION_RISK.MEDIUM,
    });
  }
  const assistantCapabilities: AiCommandContext["assistantCapabilities"] = {
    readableDomains,
    preparableActions: capabilities.map(({ key }) => key),
    bookingComposer: {
      enabled: bookingComposerEnabled,
      prefillEnabled: bookingPrefillEnabled,
      directMutation: false,
    },
  };

  const actorLocationIds =
    access.locationAccess.mode === "all"
      ? null
      : access.locationAccess.locationIds.map(String);
  const effectiveLocationIds = locationId ? [locationId] : actorLocationIds;
  if (effectiveLocationIds !== null && effectiveLocationIds.length === 0) {
    return {
      ...emptyAiCommandContext(),
      capabilities,
      assistantCapabilities,
    };
  }

  const locationQuery = {
    tenant: tenantId,
    isActive: true,
    ...(effectiveLocationIds === null
      ? {}
      : { _id: { $in: objectIds(effectiveLocationIds) } }),
  };
  const needsLocationTargets =
    taskManagementEnabled || bookingComposerEnabled;
  const locations = needsLocationTargets
    ? await LocationModel.find(locationQuery)
        .select("name booking openingHours")
        .sort({ isPrimary: -1, name: 1 })
        .limit(50)
        .lean()
    : [];
  const safeLocations = (locations as any[]).map((entry) => ({
    id: String(entry._id),
    name: String(entry.name || "")
      .trim()
      .slice(0, 160),
    booking: {
      enabled: entry.booking?.enabled === true,
      timezone: String(entry.booking?.timezone || "UTC").slice(0, 100),
      slotStepMinutes: Number(entry.booking?.slotStepMinutes || 30),
      minBookingMinutes: Number(entry.booking?.minBookingMinutes || 60),
      maxBookingMinutes: Number(entry.booking?.maxBookingMinutes || 360),
    },
    openingHours:
      entry.openingHours && typeof entry.openingHours === "object"
        ? entry.openingHours
        : {},
  }));
  const locationNames = new Map(
    safeLocations.map((entry) => [entry.id, entry.name]),
  );
  const visibleLocationIds = safeLocations.map(({ id }) => id);

  const [taskRows, inventoryRows, productRows] = await Promise.all([
    taskTargetsEnabled
      ? StaffTaskModel.find({
          tenantId,
          status: { $ne: STAFF_TASK_STATUS.DONE },
          ...(effectiveLocationIds === null
            ? {}
            : {
                $or: [
                  {
                    appliesToAllLocations: { $ne: true },
                    locationId: { $in: objectIds(visibleLocationIds) },
                  },
                  {
                    assignedTo: userId,
                    $or: [
                      { appliesToAllLocations: true },
                      { locationId: null },
                    ],
                  },
                ],
              }),
        } as never)
          .select(
            "title status locationId appliesToAllLocations assignedTo updatedAt dueDate priority",
          )
          .sort({ dueDate: 1, updatedAt: -1 })
          .limit(30)
          .lean()
      : Promise.resolve([]),
    inventoryTargetsEnabled && visibleLocationIds.length
      ? InventoryItem.find({
          tenant: tenantId,
          isActive: true,
          "stockLevels.location": { $in: objectIds(visibleLocationIds) },
        })
          .select("name unit stockLevels updatedAt")
          .sort({ name: 1 })
          .limit(100)
          .lean()
      : Promise.resolve([]),
    bookingPrefillEnabled
      ? ProductModel.find({
          tenant: tenantId,
          isActive: true,
          $or: [
            {
              kind: {
                $in: [PRODUCT_KIND.CLASS, PRODUCT_KIND.PRIVATE_STUDIO],
              },
            },
            {
              type: {
                $in: [
                  "course",
                  "public-course",
                  "private-course",
                  "blocker",
                ],
              },
            },
          ],
        })
          .select("name kind type")
          .sort({ sortOrder: 1, name: 1 })
          .limit(100)
          .lean()
      : Promise.resolve([]),
  ]);

  const openTasks = (taskRows as any[]).map((task) => ({
    id: String(task._id),
    title: String(task.title || "")
      .trim()
      .slice(0, 180),
    status: String(task.status || ""),
    locationId: task.locationId ? String(task.locationId) : null,
    locationName: task.locationId
      ? locationNames.get(String(task.locationId)) || null
      : null,
    appliesToAllLocations: task.appliesToAllLocations === true,
    assignedTo: task.assignedTo ? String(task.assignedTo) : null,
    updatedAt: new Date(task.updatedAt).toISOString(),
  }));

  const visibleLocationSet = new Set(visibleLocationIds);
  const lowStockItems = (inventoryRows as any[])
    .flatMap((item) =>
      (item.stockLevels || [])
        .filter((level: any) => {
          const id = String(level.location || "");
          const minimum = Number(level.minimumQuantity || 0);
          return (
            visibleLocationSet.has(id) &&
            minimum > 0 &&
            Number(level.currentQuantity || 0) <= minimum
          );
        })
        .map((level: any) => {
          const currentQuantity = Number(level.currentQuantity || 0);
          const minimumQuantity = Number(level.minimumQuantity || 0);
          const targetQuantity = Math.max(minimumQuantity * 2, 1);
          return {
            itemId: String(item._id),
            itemName: String(item.name || "")
              .trim()
              .slice(0, 160),
            locationId: String(level.location),
            locationName: locationNames.get(String(level.location)) || "",
            unit: String(item.unit || "")
              .trim()
              .slice(0, 40),
            currentQuantity,
            minimumQuantity,
            suggestedQuantity: Math.max(targetQuantity - currentQuantity, 1),
            updatedAt: new Date(item.updatedAt).toISOString(),
          };
        }),
    )
    .sort(
      (left, right) =>
        left.currentQuantity -
        left.minimumQuantity -
        (right.currentQuantity - right.minimumQuantity),
    )
    .slice(0, 30);

  const bookingProducts = (productRows as any[])
    .map((product) => {
      const kind = resolveProductKindV2(product);
      if (
        kind !== PRODUCT_KIND.CLASS &&
        kind !== PRODUCT_KIND.PRIVATE_STUDIO
      ) {
        return null;
      }
      return {
        id: String(product._id),
        name: String(product.name || "")
          .trim()
          .slice(0, 160),
        kind,
      };
    })
    .filter(
      (
        product,
      ): product is {
        id: string;
        name: string;
        kind: "class" | "private-studio";
      } => Boolean(product?.id && product.name),
    );

  return {
    generatedAt: new Date().toISOString(),
    capabilities,
    assistantCapabilities,
    locations: safeLocations,
    bookingProducts,
    openTasks,
    lowStockItems,
  };
};

export const buildAiCommandContext = async (
  args: Parameters<typeof buildBaseAiCommandContext>[0],
): Promise<AiCommandContext> => {
  const context = await buildBaseAiCommandContext(args);
  const { access, tenantId, userId, locationId } = args;
  if (
    access.status !== "active" ||
    access.tenantId !== tenantId ||
    access.userId !== userId ||
    (locationId && !canAccessWorkspaceLocation(access, locationId)) ||
    !hasWorkspacePermission(access, WORKSPACE_PERMISSION.COURSES_MANAGE)
  ) {
    return context;
  }

  const tenant = await TenantModel.findById(tenantId).select("modules").lean();
  if ((tenant as any)?.modules?.[TENANT_MODULE.COURSES] !== true) {
    return context;
  }

  const actorLocationIds =
    access.locationAccess.mode === "all"
      ? null
      : access.locationAccess.locationIds.map(String);
  const effectiveLocationIds = locationId ? [locationId] : actorLocationIds;
  if (effectiveLocationIds !== null && effectiveLocationIds.length === 0) {
    return context;
  }

  if (!context.locations.length) {
    const rows = await LocationModel.find({
      tenant: tenantId,
      isActive: true,
      ...(effectiveLocationIds === null
        ? {}
        : { _id: { $in: objectIds(effectiveLocationIds) } }),
    })
      .select("name booking openingHours")
      .sort({ isPrimary: -1, name: 1 })
      .limit(50)
      .lean();
    context.locations = (rows as any[]).map((entry) => ({
      id: String(entry._id),
      name: String(entry.name || "")
        .trim()
        .slice(0, 160),
      booking: {
        enabled: entry.booking?.enabled === true,
        timezone: String(entry.booking?.timezone || "UTC").slice(0, 100),
        slotStepMinutes: Number(entry.booking?.slotStepMinutes || 30),
        minBookingMinutes: Number(entry.booking?.minBookingMinutes || 60),
        maxBookingMinutes: Number(entry.booking?.maxBookingMinutes || 360),
      },
      openingHours:
        entry.openingHours && typeof entry.openingHours === "object"
          ? entry.openingHours
          : {},
    }));
  }
  if (!context.locations.length) return context;

  context.capabilities.push({
    key: AI_ACTION_KEY.CREATE_EVENT,
    requiredPermission: WORKSPACE_PERMISSION.COURSES_MANAGE,
    riskLevel: AI_ACTION_RISK.MEDIUM,
  });
  context.assistantCapabilities.preparableActions.push(
    AI_ACTION_KEY.CREATE_EVENT,
  );
  return context;
};

