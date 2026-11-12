import {
  assertTenantLocationsWithinWorkspaceScope,
  type AllowedWorkspaceLocationIds,
} from "@/modules/tenant-access/services/location-scope.service.js";
import { notFound } from "@/shared/http/httpErrors.js";

import {
  findOrderByIdForRead,
  listOrdersWithFilters,
} from "../order.repository.js";
import type { PaginatedOrdersResult } from "../order.types.js";
import { parseOrderFilter } from "../order.validators.js";

export const getOrdersWithFilters = async ({
  tenantId,
  input,
  allowedLocationIds,
}: {
  tenantId: string;
  input: unknown;
  allowedLocationIds: AllowedWorkspaceLocationIds;
}): Promise<PaginatedOrdersResult> => {
  const normalized = parseOrderFilter(input);

  if (normalized.locationId) {
    await assertTenantLocationsWithinWorkspaceScope({
      tenantId,
      locationIds: [normalized.locationId],
      allowedLocationIds,
    });
  }

  return listOrdersWithFilters({
    tenantId,
    input: normalized,
    allowedLocationIds,
  });
};

export const getOrderById = async ({
  tenantId,
  orderId,
  allowedLocationIds,
}: {
  tenantId: string;
  orderId: string;
  allowedLocationIds: AllowedWorkspaceLocationIds;
}) => {
  const order = await findOrderByIdForRead({
    tenantId,
    orderId,
    allowedLocationIds,
  });

  if (!order) {
    notFound({
      message: "Order not found.",
      code: "ORDER_NOT_FOUND",
    });
  }

  return order;
};
