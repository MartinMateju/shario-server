import Booking from "@/modules/booking/booking.model.js";
import {
  InventoryItem,
  ReorderRequest,
} from "@/modules/inventory/inventory.model.js";
import Product from "@/modules/product/product.model.js";
import { COURSE_PRODUCT_TYPES } from "@/modules/product/product.constants.js";
import type { AllowedWorkspaceLocationIds } from "@/modules/tenant-access/index.js";
import UserModel from "@/modules/user/user.model.js";
import { notFound } from "@/shared/http/httpErrors.js";

import { STAFF_TASK_LINK_TYPE } from "./staff.constants.js";

type TaskLink = {
  type: string;
  resourceId: unknown;
  label?: string;
};

type ResolvedLink = {
  exists: boolean;
  // null means tenant-global; [] means location-bound but currently unscoped.
  locationIds: string[] | null;
};

const oneLocation = (resource: any, key = "location"): ResolvedLink => ({
  exists: Boolean(resource),
  locationIds: resource?.[key] ? [String(resource[key])] : [],
});

const resolveTaskLink = async (
  tenantId: string,
  link: TaskLink,
): Promise<ResolvedLink> => {
  switch (link.type) {
    case STAFF_TASK_LINK_TYPE.BOOKING:
      return oneLocation(
        await Booking.findOne({
          _id: link.resourceId,
          tenant: tenantId,
        })
          .select("location")
          .lean(),
      );
    case STAFF_TASK_LINK_TYPE.COURSE:
      return {
        exists: Boolean(
          await Product.findOne({
            _id: link.resourceId,
            tenant: tenantId,
            type: { $in: COURSE_PRODUCT_TYPES },
          })
            .select("_id")
            .lean(),
        ),
        locationIds: null,
      };
    case STAFF_TASK_LINK_TYPE.CUSTOMER:
      return {
        exists: Boolean(
          await UserModel.findOne({
            _id: link.resourceId,
            tenant: tenantId,
          })
            .select("_id")
            .lean(),
        ),
        locationIds: null,
      };
    case STAFF_TASK_LINK_TYPE.INVENTORY_ITEM: {
      const resource: any = await InventoryItem.findOne({
        _id: link.resourceId,
        tenant: tenantId,
      })
        .select("locations")
        .lean();
      return {
        exists: Boolean(resource),
        locationIds: resource
          ? (resource.locations || []).map(String)
          : [],
      };
    }
    case STAFF_TASK_LINK_TYPE.REORDER_REQUEST:
      return oneLocation(
        await ReorderRequest.findOne({
          _id: link.resourceId,
          tenant: tenantId,
        })
          .select("location")
          .lean(),
      );
    default:
      return { exists: false, locationIds: [] };
  }
};

const overlaps = (
  locationIds: string[],
  allowedLocationIds: readonly string[],
) => {
  const allowed = new Set(allowedLocationIds.map(String));
  return locationIds.some((id) => allowed.has(id));
};

export const assertValidStaffTaskLinks = async ({
  tenantId,
  allowedLocationIds,
  taskLocationId = null,
  links,
}: {
  tenantId: string;
  allowedLocationIds: AllowedWorkspaceLocationIds;
  taskLocationId?: string | null;
  links: readonly TaskLink[];
}): Promise<void> => {
  for (const link of links) {
    const resource = await resolveTaskLink(tenantId, link);
    const compatibleWithTask =
      resource.locationIds === null ||
      (taskLocationId
        ? resource.locationIds.includes(String(taskLocationId))
        : allowedLocationIds === null ||
          overlaps(resource.locationIds, allowedLocationIds));
    if (!resource.exists || !compatibleWithTask) {
      notFound({
        message: "Linked resource not found.",
        code: "STAFF_TASK_LINK_NOT_FOUND",
      });
    }
  }
};

export const filterVisibleStaffTaskLinks = async ({
  tenantId,
  allowedLocationIds,
  taskLocationId,
  links,
}: {
  tenantId: string;
  allowedLocationIds: AllowedWorkspaceLocationIds;
  taskLocationId?: unknown;
  links: readonly TaskLink[];
}) => {
  const visible: Array<{ type: string; resourceId: string; label: string }> = [];
  for (const link of links || []) {
    const resource = await resolveTaskLink(tenantId, link);
    if (!resource.exists) continue;
    const compatibleWithTask =
      resource.locationIds === null ||
      !taskLocationId ||
      resource.locationIds.includes(String(taskLocationId));
    const visibleToReader =
      allowedLocationIds === null ||
      resource.locationIds === null ||
      overlaps(resource.locationIds, allowedLocationIds);
    if (!compatibleWithTask || !visibleToReader) continue;
    visible.push({
      type: link.type,
      resourceId: String(link.resourceId),
      label: link.label || "",
    });
  }
  return visible;
};
