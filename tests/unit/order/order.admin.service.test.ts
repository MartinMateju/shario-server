import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertTenantLocationsWithinWorkspaceScope: vi.fn(),
  findOrderByIdForRead: vi.fn(),
  listOrdersWithFilters: vi.fn(),
}));

vi.mock(
  "@/modules/tenant-access/services/location-scope.service.js",
  () => ({
    assertTenantLocationsWithinWorkspaceScope:
      mocks.assertTenantLocationsWithinWorkspaceScope,
  }),
);

vi.mock("@/modules/order/order.repository.js", () => ({
  findOrderByIdForRead: mocks.findOrderByIdForRead,
  listOrdersWithFilters: mocks.listOrdersWithFilters,
}));

import {
  getOrderById,
  getOrdersWithFilters,
} from "@/modules/order/services/order.admin.service.js";

const TENANT_ID = "64b000000000000000000010";
const ORDER_ID = "64b000000000000000000020";
const LOCATION_A = "64b000000000000000000001";
const LOCATION_B = "64b000000000000000000002";

describe("order admin read service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listOrdersWithFilters.mockResolvedValue({
      orders: [],
      totalCount: 0,
      totalPages: 0,
      currentPage: 1,
      pageSize: 8,
    });
  });

  it("passes the member location allow-list into every list query", async () => {
    await getOrdersWithFilters({
      tenantId: TENANT_ID,
      input: {},
      allowedLocationIds: [LOCATION_A],
    });

    expect(mocks.listOrdersWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        allowedLocationIds: [LOCATION_A],
      }),
    );
    expect(
      mocks.assertTenantLocationsWithinWorkspaceScope,
    ).not.toHaveBeenCalled();
  });

  it("validates an explicit location filter before querying orders", async () => {
    await getOrdersWithFilters({
      tenantId: TENANT_ID,
      input: { locationId: LOCATION_A },
      allowedLocationIds: [LOCATION_A, LOCATION_B],
    });

    expect(
      mocks.assertTenantLocationsWithinWorkspaceScope,
    ).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      locationIds: [LOCATION_A],
      allowedLocationIds: [LOCATION_A, LOCATION_B],
    });
    expect(
      mocks.assertTenantLocationsWithinWorkspaceScope.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.listOrdersWithFilters.mock.invocationCallOrder[0]);
  });

  it("passes exact caller date boundaries through to the order query", async () => {
    await getOrdersWithFilters({
      tenantId: TENANT_ID,
      input: {
        dateFrom: "2026-10-18T22:00:00.000Z",
        dateTo: "2026-10-19T21:59:59.999Z",
      },
      allowedLocationIds: [LOCATION_A],
    });

    expect(mocks.listOrdersWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          dateFrom: new Date("2026-10-18T22:00:00.000Z"),
          dateTo: new Date("2026-10-19T21:59:59.999Z"),
        }),
      }),
    );
  });

  it("rejects inverted ranges before querying orders", async () => {
    await expect(
      getOrdersWithFilters({
        tenantId: TENANT_ID,
        input: {
          dateFrom: "2026-10-19T22:00:00.000Z",
          dateTo: "2026-10-19T21:59:59.999Z",
        },
        allowedLocationIds: [LOCATION_A],
      }),
    ).rejects.toThrow("Order end date must not be before its start date.");

    expect(mocks.listOrdersWithFilters).not.toHaveBeenCalled();
  });

  it("does not query orders when a location filter is outside the workspace scope", async () => {
    mocks.assertTenantLocationsWithinWorkspaceScope.mockRejectedValueOnce(
      Object.assign(new Error("Location not found."), {
        statusCode: 404,
        code: "WORKSPACE_LOCATION_NOT_FOUND",
      }),
    );

    await expect(
      getOrdersWithFilters({
        tenantId: TENANT_ID,
        input: { locationId: LOCATION_B },
        allowedLocationIds: [LOCATION_A],
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "WORKSPACE_LOCATION_NOT_FOUND",
    });

    expect(mocks.listOrdersWithFilters).not.toHaveBeenCalled();
  });

  it("uses one tenant-and-location-scoped lookup for order details", async () => {
    mocks.findOrderByIdForRead.mockResolvedValueOnce({ _id: ORDER_ID });

    await expect(
      getOrderById({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        allowedLocationIds: [LOCATION_A],
      }),
    ).resolves.toMatchObject({ _id: ORDER_ID });

    expect(mocks.findOrderByIdForRead).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      allowedLocationIds: [LOCATION_A],
    });
  });

  it("returns the same 404 for missing, cross-tenant and cross-location details", async () => {
    mocks.findOrderByIdForRead.mockResolvedValueOnce(null);

    await expect(
      getOrderById({
        tenantId: TENANT_ID,
        orderId: ORDER_ID,
        allowedLocationIds: [LOCATION_A],
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "ORDER_NOT_FOUND",
      message: "Order not found.",
    });
  });
});
