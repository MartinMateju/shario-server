import { metadataRepository } from "../metadata.repository.js";
import type { MetadataTag } from "../metadata.constants.js";
import type {
  CreateMetadataInput,
  MetadataListFilters,
} from "../metadata.types.js";
import type {
  CreateMetadataDto,
  ListMetadataDto,
} from "../metadata.validators.js";

const toCreateMetadataInput = (
  tenantId: string,
  input: CreateMetadataDto,
): CreateMetadataInput => ({
  tenant: tenantId,
  createdBy: input.createdBy,
  order: input.order,
  product: input.product,
  booking: input.booking,
  quantity: input.quantity,
  tag: input.tag as MetadataTag | undefined,
});

const toMetadataListFilters = (
  tenantId: string,
  filters: ListMetadataDto,
): MetadataListFilters => ({
  tenantId,
  createdBy: filters.createdBy,
  order: filters.order,
  product: filters.product,
  booking: filters.booking,
  tag: filters.tag as MetadataTag | undefined,
  page: filters.page,
  limit: filters.limit,
});

export const metadataService = {
  async create(tenantId: string, input: CreateMetadataDto) {
    return metadataRepository.create(toCreateMetadataInput(tenantId, input));
  },

  async createMany(tenantId: string, items: CreateMetadataDto[]) {
    const metadata = await metadataRepository.createMany(
      items.map((item) => toCreateMetadataInput(tenantId, item)),
    );

    return metadata.map((item) => item._id);
  },

  async list(tenantId: string, filters: ListMetadataDto) {
    const query = toMetadataListFilters(tenantId, filters);

    const [metadata, total] = await Promise.all([
      metadataRepository.list(query),
      metadataRepository.count(query),
    ]);

    const page = filters.page;
    const limit = filters.limit;

    return {
      metadata,
      total,
      page,
      pages: Math.ceil(total / limit),
    };
  },
};