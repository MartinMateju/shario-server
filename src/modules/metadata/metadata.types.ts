import type { HydratedDocument, InferSchemaType, Types } from "mongoose";

import type { MetadataTag } from "./metadata.constants.js";
import type { metadataSchema } from "./metadata.schema.js";

export type Metadata = InferSchemaType<typeof metadataSchema>;

export type MetadataDocument = HydratedDocument<Metadata>;

export type MetadataId = string;
export type TenantId = string;
export type UserId = string;
export type OrderId = string;
export type ProductId = string;
export type BookingId = string;

export type IdLike = string | Types.ObjectId;

export type CreateMetadataInput = {
  tenant: IdLike;
  createdBy: IdLike;
  order?: IdLike | null;
  product?: IdLike | null;
  booking?: IdLike | null;
  quantity: number;
  tag?: MetadataTag;
};

export type MetadataListFilters = {
  tenantId: TenantId;
  createdBy?: UserId;
  order?: OrderId;
  product?: ProductId;
  booking?: BookingId;
  tag?: MetadataTag;
  page?: number;
  limit?: number;
};