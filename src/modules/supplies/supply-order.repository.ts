import { Supplier } from "./supplier.model.js";
import { SupplyOrder } from "./supply-order.model.js";
import type { StudioCommerceCurrency } from "@/shared/money/currency.js";
import type {
  Supplier as SupplierAttributes,
  SupplierDocument,
  SupplierListFilters,
  SupplyOrderDocument,
  SupplyOrderListFilters,
} from "./supply-order.types.js";
import type {
  CreateSupplierInput,
  CreateSupplyOrderInput,
  UpdateSupplierInput,
  UpdateSupplyOrderInput,
} from "./supply-order.validators.js";
import {
  escapeRegex,
  toNullableObjectId,
  toObjectId,
} from "./supply-order.utils.js";

const supplyOrderPopulate = [
  { path: "assignedTo", select: "firstname lastname email customId" },
  { path: "requestedByUser", select: "firstname lastname email customId" },
  { path: "createdBy", select: "firstname lastname email customId" },
  { path: "location", select: "name slug code" },
];

type RegexSearch = {
  $regex: string;
  $options: "i";
};

type SupplyOrderSearchCondition = {
  title?: RegexSearch;
  customerName?: RegexSearch;
  customerEmail?: RegexSearch;
  customerPhone?: RegexSearch;
};

type SupplierSearchCondition = {
  name?: RegexSearch;
  ico?: RegexSearch;
  dic?: RegexSearch;
  contactPerson?: RegexSearch;
  email?: RegexSearch;
};

type SupplyOrderListQuery = Record<string, unknown> & {
  $or?: SupplyOrderSearchCondition[];
};

type SupplierListQuery = Partial<SupplierAttributes> & {
  $or?: SupplierSearchCondition[];
};

type CreateSupplyOrderPersistenceInput = CreateSupplyOrderInput & {
  currency: StudioCommerceCurrency;
};

type UpdateSupplyOrderPersistenceInput = UpdateSupplyOrderInput & {
  currency?: StudioCommerceCurrency;
};

const buildRegexSearch = (value: string): RegexSearch => ({
  $regex: escapeRegex(value),
  $options: "i",
});

const buildSupplyOrderListQuery = (
  filters: SupplyOrderListFilters,
): SupplyOrderListQuery => {
  const query: SupplyOrderListQuery = {
    tenant: toObjectId(filters.tenantId),
  };

  if (filters.allowedLocationIds !== null && filters.allowedLocationIds !== undefined) {
    query.location = { $in: filters.allowedLocationIds.map(toObjectId) };
  }

  if (filters.status) {
    query.status = filters.status;
  }

  if (filters.priority) {
    query.priority = filters.priority;
  }

  if (filters.location) {
    query.location =
      filters.allowedLocationIds === undefined ||
      filters.allowedLocationIds === null ||
      filters.allowedLocationIds.includes(filters.location)
        ? toObjectId(filters.location)
        : { $in: [] };
  }

  if (filters.assignedTo) {
    query.assignedTo = toObjectId(filters.assignedTo);
  }

  if (filters.search) {
    const search = buildRegexSearch(filters.search);

    query.$or = [
      { title: search },
      { customerName: search },
      { customerEmail: search },
      { customerPhone: search },
    ];
  }

  return query;
};

const buildSupplierListQuery = (
  filters: SupplierListFilters,
): SupplierListQuery => {
  const query: SupplierListQuery = {
    tenant: toObjectId(filters.tenantId),
  };

  if (typeof filters.isActive === "boolean") {
    query.isActive = filters.isActive;
  }

  if (filters.search) {
    const search = buildRegexSearch(filters.search);

    query.$or = [
      { name: search },
      { ico: search },
      { dic: search },
      { contactPerson: search },
      { email: search },
    ];
  }

  return query;
};

const buildSupplyOrderCreatePayload = (
  tenantId: string,
  createdBy: string,
  input: CreateSupplyOrderPersistenceInput,
): Record<string, unknown> => ({
  tenant: toObjectId(tenantId),
  title: input.title,
  location: toNullableObjectId(input.location),
  customerName: input.customerName,
  customerEmail: input.customerEmail,
  customerPhone: input.customerPhone,
  assignedTo: toNullableObjectId(input.assignedTo),
  registeredAt: input.registeredAt,
  deadline: input.deadline ?? null,
  status: input.status,
  priority: input.priority,
  currency: input.currency,
  price: input.price,
  depositPaid: input.depositPaid,
  units: input.units,
  unitLabel: input.unitLabel,
  publicNote: input.publicNote,
  internalNote: input.internalNote,
  requestedByUser: toNullableObjectId(input.requestedByUser),
  createdBy: toObjectId(createdBy),
});

const buildSupplyOrderUpdatePatch = (
  input: UpdateSupplyOrderPersistenceInput,
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {
    ...input,
  };

  if (input.location !== undefined) {
    patch.location = toNullableObjectId(input.location);
  }

  if (input.assignedTo !== undefined) {
    patch.assignedTo = toNullableObjectId(input.assignedTo);
  }

  if (input.requestedByUser !== undefined) {
    patch.requestedByUser = toNullableObjectId(input.requestedByUser);
  }

  return patch;
};

export const supplyOrderRepository = {
  async list(filters: SupplyOrderListFilters): Promise<{
    orders: unknown[];
    total: number;
  }> {
    const query = buildSupplyOrderListQuery(filters);
    const skip = (filters.page - 1) * filters.limit;
    const sortValue = filters.sortDirection === "asc" ? 1 : -1;

    const [orders, total] = await Promise.all([
      SupplyOrder.find(query)
        .select("+internalNote")
        .populate(supplyOrderPopulate)
        .sort({ [filters.sortBy]: sortValue })
        .skip(skip)
        .limit(filters.limit)
        .lean()
        .exec(),
      SupplyOrder.countDocuments(query).exec(),
    ]);

    return { orders, total };
  },

  async findByIdForTenant(
    tenantId: string,
    id: string,
  ): Promise<SupplyOrderDocument | null> {
    return SupplyOrder.findOne({
      _id: toObjectId(id),
      tenant: toObjectId(tenantId),
    })
      .select("+internalNote")
      .populate(supplyOrderPopulate)
      .exec();
  },

  async create(
    tenantId: string,
    createdBy: string,
    input: CreateSupplyOrderPersistenceInput,
  ): Promise<SupplyOrderDocument> {
    return SupplyOrder.create(
      buildSupplyOrderCreatePayload(tenantId, createdBy, input),
    );
  },

  async update(
    tenantId: string,
    id: string,
    input: UpdateSupplyOrderPersistenceInput,
  ): Promise<SupplyOrderDocument | null> {
    return SupplyOrder.findOneAndUpdate(
      {
        _id: toObjectId(id),
        tenant: toObjectId(tenantId),
      },
      {
        $set: buildSupplyOrderUpdatePatch(input),
      },
      {
        returnDocument: "after",
        runValidators: true,
      },
    )
      .select("+internalNote")
      .populate(supplyOrderPopulate)
      .exec();
  },

  async delete(tenantId: string, id: string): Promise<SupplyOrderDocument | null> {
    return SupplyOrder.findOneAndDelete({
      _id: toObjectId(id),
      tenant: toObjectId(tenantId),
    }).exec();
  },
};

export const supplierRepository = {
  async list(filters: SupplierListFilters): Promise<SupplierDocument[]> {
    return Supplier.find(buildSupplierListQuery(filters))
      .sort({ createdAt: -1 })
      .exec();
  },

  async create(
    tenantId: string,
    input: CreateSupplierInput,
  ): Promise<SupplierDocument> {
    return Supplier.create({
      ...input,
      tenant: toObjectId(tenantId),
    });
  },

  async update(
    tenantId: string,
    id: string,
    input: UpdateSupplierInput,
  ): Promise<SupplierDocument | null> {
    return Supplier.findOneAndUpdate(
      {
        _id: toObjectId(id),
        tenant: toObjectId(tenantId),
      },
      {
        $set: input,
      },
      {
        returnDocument: "after",
        runValidators: true,
      },
    ).exec();
  },

  async deactivate(
    tenantId: string,
    id: string,
  ): Promise<SupplierDocument | null> {
    return Supplier.findOneAndUpdate(
      {
        _id: toObjectId(id),
        tenant: toObjectId(tenantId),
      },
      {
        $set: {
          isActive: false,
        },
      },
      {
        returnDocument: "after",
        runValidators: true,
      },
    ).exec();
  },
};
