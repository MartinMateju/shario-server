import mongoose from "mongoose";

import { MetadataModel } from "./metadata.model.js";
import type {
  CreateMetadataInput,
  Metadata,
  MetadataDocument,
  MetadataListFilters,
} from "./metadata.types.js";

const toObjectId = (
  value: string | mongoose.Types.ObjectId,
): mongoose.Types.ObjectId =>
  typeof value === "string" ? new mongoose.Types.ObjectId(value) : value;

const toNullableObjectId = (
  value?: string | mongoose.Types.ObjectId | null,
): mongoose.Types.ObjectId | null => {
  if (!value) return null;

  return toObjectId(value);
};

const buildMetadataPayload = (input: CreateMetadataInput): Partial<Metadata> => ({
  tenant: toObjectId(input.tenant),
  createdBy: toObjectId(input.createdBy),
  order: toNullableObjectId(input.order),
  product: toNullableObjectId(input.product),
  booking: toNullableObjectId(input.booking),
  quantity: input.quantity,
  tag: input.tag,
});

const buildMetadataListQuery = (
  filters: MetadataListFilters,
): Partial<Metadata> => {
  const query: Partial<Metadata> = {
    tenant: toObjectId(filters.tenantId),
  };

  if (filters.createdBy) query.createdBy = toObjectId(filters.createdBy);
  if (filters.order) query.order = toObjectId(filters.order);
  if (filters.product) query.product = toObjectId(filters.product);
  if (filters.booking) query.booking = toObjectId(filters.booking);
  if (filters.tag) query.tag = filters.tag;

  return query;
};

export const metadataRepository = {
  async create(input: CreateMetadataInput): Promise<MetadataDocument> {
    return MetadataModel.create(buildMetadataPayload(input));
  },

  async createMany(inputs: CreateMetadataInput[]): Promise<MetadataDocument[]> {
    if (!inputs.length) return [];

    return MetadataModel.create(inputs.map(buildMetadataPayload), {
      ordered: true,
    });
  },

  async list(filters: MetadataListFilters): Promise<MetadataDocument[]> {
    const page = Math.max(Number(filters.page || 1), 1);
    const limit = Math.min(Math.max(Number(filters.limit || 50), 1), 100);
    const skip = (page - 1) * limit;

    return MetadataModel.find(buildMetadataListQuery(filters))
      .populate("createdBy", "firstname lastname email customId")
      .populate("order")
      .populate("product")
      .populate("booking")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();
  },

  async count(filters: MetadataListFilters): Promise<number> {
    return MetadataModel.countDocuments(buildMetadataListQuery(filters)).exec();
  },
};