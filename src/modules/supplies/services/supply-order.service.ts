import { getTenantOrThrow } from "@/modules/tenants/services/tenant.service.js";
import { badRequest, notFound } from "@/shared/http/httpErrors.js";
import { normalizeStudioCommerceCurrency } from "@/shared/money/currency.js";
import {
  assertCurrencyAmountFields,
  resolveFinancialRecordCurrency,
} from "@/shared/money/financial-record.js";
import UserModel from "@/modules/user/user.model.js";
import {
  assertCanAccessAllWorkspaceLocations,
  assertLocationIdsWithinWorkspaceScope,
  assertTenantLocationsWithinWorkspaceScope,
  type AllowedWorkspaceLocationIds,
} from "@/modules/tenant-access/index.js";

import {
  supplierRepository,
  supplyOrderRepository,
} from "../supply-order.repository.js";
import type {
  SortDirection,
  SupplyOrderPriority,
  SupplyOrderSortField,
  SupplyOrderStatus,
} from "../supply-order.constants.js";
import type { SupplyOrderListFilters } from "../supply-order.types.js";
import type {
  CreateSupplierInput,
  CreateSupplyOrderInput,
  ListSuppliersInput,
  ListSupplyOrdersInput,
  UpdateSupplierInput,
  UpdateSupplyOrderInput,
} from "../supply-order.validators.js";

const toSupplyOrderStatus = (
  value?: string,
): SupplyOrderStatus | undefined => {
  if (!value || value === "all") return undefined;

  return value as SupplyOrderStatus;
};

const toSupplyOrderPriority = (
  value?: string,
): SupplyOrderPriority | undefined => {
  if (!value || value === "all") return undefined;

  return value as SupplyOrderPriority;
};

const getTenantCurrency = async (tenantId: string) => {
  const tenant = await getTenantOrThrow(tenantId);

  return normalizeStudioCommerceCurrency(tenant.settings.currency);
};

const hasMoneyPatch = (input: UpdateSupplyOrderInput): boolean =>
  input.price !== undefined || input.depositPaid !== undefined;

const validateDeposit = (depositPaid: number, price: number): void => {
  if (price > 0 && depositPaid > price) {
    badRequest("Deposit paid cannot be greater than the order price.");
  }
};

const assertOrderWithinLocationScope = (
  order: { location?: unknown },
  allowedLocationIds: AllowedWorkspaceLocationIds,
): void => {
  const locationId = String((order.location as any)?._id ?? order.location ?? "");

  if (!locationId) {
    assertCanAccessAllWorkspaceLocations(allowedLocationIds);
    return;
  }

  assertLocationIdsWithinWorkspaceScope([locationId], allowedLocationIds);
};

const assertReferencedUsersBelongToTenant = async (
  tenantId: string,
  userIds: readonly unknown[],
): Promise<void> => {
  const ids = [...new Set(userIds.map((value) => String(value ?? "")).filter(Boolean))];

  if (!ids.length) return;

  const count = await UserModel.countDocuments({
    _id: { $in: ids },
    tenant: tenantId,
  }).exec();

  if (count !== ids.length) {
    notFound("One or more selected users were not found.");
  }
};

export const supplyOrderService = {
  async list(
    tenantId: string,
    input: ListSupplyOrdersInput,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const filters: SupplyOrderListFilters = {
      tenantId,
      allowedLocationIds,
      status: toSupplyOrderStatus(input.status),
      priority: toSupplyOrderPriority(input.priority),
      location: input.location || undefined,
      assignedTo: input.assignedTo || undefined,
      search: input.search,
      page: input.page,
      limit: input.limit,
      sortBy: input.sortBy as SupplyOrderSortField,
      sortDirection: input.sortDirection as SortDirection,
    };

    const { orders, total } = await supplyOrderRepository.list(filters);

    return {
      orders,
      total,
      page: input.page,
      pages: Math.ceil(total / input.limit),
    };
  },

  async getById(
    tenantId: string,
    id: string,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const order = await supplyOrderRepository.findByIdForTenant(tenantId, id);

    if (!order) {
      notFound("Supply order not found.");
    }

    assertOrderWithinLocationScope(order, allowedLocationIds);

    return order;
  },

  async create(
    tenantId: string,
    createdBy: string,
    input: CreateSupplyOrderInput,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    if (input.location) {
      await assertTenantLocationsWithinWorkspaceScope({
        tenantId,
        locationIds: [input.location],
        allowedLocationIds,
      });
    } else {
      assertCanAccessAllWorkspaceLocations(allowedLocationIds);
    }

    await assertReferencedUsersBelongToTenant(tenantId, [
      input.assignedTo,
      input.requestedByUser,
    ]);

    const currency = await getTenantCurrency(tenantId);

    assertCurrencyAmountFields(
      {
        price: input.price,
        depositPaid: input.depositPaid,
      },
      currency,
    );
    validateDeposit(input.depositPaid, input.price);

    return supplyOrderRepository.create(tenantId, createdBy, {
      ...input,
      currency,
    });
  },

  async update(
    tenantId: string,
    id: string,
    input: UpdateSupplyOrderInput,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const existing = await supplyOrderRepository.findByIdForTenant(
      tenantId,
      id,
    );

    if (!existing) {
      notFound("Supply order not found.");
    }

    assertOrderWithinLocationScope(existing, allowedLocationIds);

    if (input.location !== undefined) {
      if (input.location) {
        await assertTenantLocationsWithinWorkspaceScope({
          tenantId,
          locationIds: [input.location],
          allowedLocationIds,
        });
      } else {
        assertCanAccessAllWorkspaceLocations(allowedLocationIds);
      }
    }

    await assertReferencedUsersBelongToTenant(tenantId, [
      input.assignedTo,
      input.requestedByUser,
    ]);

    let currencyPatch = {};

    if (hasMoneyPatch(input)) {
      const tenantCurrency = await getTenantCurrency(tenantId);
      const resolution = resolveFinancialRecordCurrency({
        tenantCurrency,
        recordCurrency: existing.currency,
        existingAmounts: [
          Number(existing.price || 0),
          Number(existing.depositPaid || 0),
        ],
      });

      assertCurrencyAmountFields(
        {
          price: input.price,
          depositPaid: input.depositPaid,
        },
        resolution.currency,
      );
      validateDeposit(
        input.depositPaid ?? Number(existing.depositPaid || 0),
        input.price ?? Number(existing.price || 0),
      );

      if (resolution.persistSnapshot) {
        currencyPatch = { currency: resolution.currency };
      }
    }

    const order = await supplyOrderRepository.update(tenantId, id, {
      ...input,
      ...currencyPatch,
    });

    if (!order) {
      notFound("Supply order not found.");
    }

    return order;
  },

  async delete(
    tenantId: string,
    id: string,
    allowedLocationIds: AllowedWorkspaceLocationIds = null,
  ) {
    const existing = await supplyOrderRepository.findByIdForTenant(
      tenantId,
      id,
    );

    if (!existing) {
      notFound("Supply order not found.");
    }

    assertOrderWithinLocationScope(existing, allowedLocationIds);

    const order = await supplyOrderRepository.delete(tenantId, id);

    if (!order) {
      notFound("Supply order not found.");
    }

    return {
      message: "Supply order deleted.",
      id,
    };
  },
};

export const supplierService = {
  async list(tenantId: string, input: ListSuppliersInput) {
    return supplierRepository.list({
      tenantId,
      search: input.search,
      isActive: input.isActive === "all" ? undefined : input.isActive,
    });
  },

  async create(tenantId: string, input: CreateSupplierInput) {
    return supplierRepository.create(tenantId, input);
  },

  async update(tenantId: string, id: string, input: UpdateSupplierInput) {
    const supplier = await supplierRepository.update(tenantId, id, input);

    if (!supplier) {
      notFound("Supplier not found.");
    }

    return supplier;
  },

  async deactivate(tenantId: string, id: string) {
    const supplier = await supplierRepository.deactivate(tenantId, id);

    if (!supplier) {
      notFound("Supplier not found.");
    }

    return {
      message: "Supplier deactivated.",
      supplier,
    };
  },
};
