import { buildCoursePublicationLocationFilter } from "./product.course-content.js";
import mongoose, {
  type ClientSession,
  type PopulateOptions,
  type UpdateQuery,
} from "mongoose";

import { buildProductLocationFilter } from "./product-location.policy.js";
import { Product } from "./product.model.js";
import type { ProductDocument, ProductListFilters } from "./product.types.js";
import type { ProductType } from "./product.constants.js";
import { escapeRegExp } from "./product.utils.js";
import type {
  CreateProductInput,
  UpdateProductInput,
} from "./product.validators.js";

type IdLike = string | mongoose.Types.ObjectId;

type ProductRepositoryOptions = {
  tenantId: IdLike;
  session?: ClientSession | null;
};

type SelectOption =
  | string
  | readonly string[]
  | Record<string, string | number | boolean | object>;

type SortDirection = 1 | -1;

type ProductFilter = Record<string, unknown>;

type ProductFindOptions = {
  select?: SelectOption;
  sort?: Record<string, SortDirection>;
  skip?: number;
  limit?: number;
  populate?: PopulateOptions | PopulateOptions[];
  lean?: boolean;
};

type ProductUpdate = UpdateQuery<ProductDocument>;

type ProductQuery = {
  tenant: mongoose.Types.ObjectId;
  isArchived: { $ne: true };
  type?:
    | ProductType
    | {
        $in: readonly ProductType[];
      };
  isActive?: boolean;
  $or?: Array<Record<string, unknown>>;
  $and?: Array<Record<string, unknown>>;
};

const toObjectId = (value: IdLike): mongoose.Types.ObjectId => {
  if (value instanceof mongoose.Types.ObjectId) return value;
  return new mongoose.Types.ObjectId(String(value));
};

const asPopulateArray = (
  populate?: PopulateOptions | PopulateOptions[],
): PopulateOptions[] => {
  if (!populate) return [];
  return Array.isArray(populate) ? populate : [populate];
};

const applySession = <
  TQuery extends { session: (session: ClientSession) => TQuery },
>(
  query: TQuery,
  session: ClientSession | null,
): TQuery => (session ? query.session(session) : query);

const buildListQuery = (
  tenantObjectId: mongoose.Types.ObjectId,
  filters: Omit<ProductListFilters, "tenantId">,
): ProductQuery => {
  const query: ProductQuery = {
    tenant: tenantObjectId,
    isArchived: { $ne: true },
  };

  if (filters.type) {
    query.type = filters.type;
  } else if (filters.types?.length) {
    query.type = { $in: filters.types };
  }
  if (typeof filters.isActive === "boolean") query.isActive = filters.isActive;

  const locationFilter = buildProductLocationFilter(filters);
  if (locationFilter) query.$and = [locationFilter];
  const publicationFilter = buildCoursePublicationLocationFilter(filters.coursePublicationLocationId);
  if (publicationFilter) query.$and = [...(query.$and ?? []), publicationFilter];

  if (filters.search) {
    const search = escapeRegExp(filters.search);

    query.$or = [
      { name: { $regex: search, $options: "i" } },
      { sku: { $regex: search, $options: "i" } },
      { classCategory: { $regex: search, $options: "i" } },
      { label: { $regex: search, $options: "i" } },
    ];
  }

  return query;
};

export const createProductRepository = ({
  tenantId,
  session = null,
}: ProductRepositoryOptions) => {
  if (!tenantId) throw new Error("ProductRepository requires tenantId");

  const tenantObjectId = toObjectId(tenantId);

  const scope = (filter: ProductFilter = {}): ProductFilter => ({
    ...filter,
    tenant: tenantObjectId,
  });

  return {
    scope,

    find(filter: ProductFilter = {}, options: ProductFindOptions = {}) {
      const query = Product.find(scope(filter) as never);

      if (options.select) query.select(options.select);
      if (options.sort) query.sort(options.sort);
      if (options.skip !== undefined) query.skip(options.skip);
      if (options.limit !== undefined) query.limit(options.limit);

      for (const populate of asPopulateArray(options.populate)) {
        query.populate(populate);
      }

      applySession(query, session);

      return options.lean === false ? query.exec() : query.lean().exec();
    },

    findOne(filter: ProductFilter = {}, options: ProductFindOptions = {}) {
      const query = Product.findOne(scope(filter) as never);

      if (options.select) query.select(options.select);

      for (const populate of asPopulateArray(options.populate)) {
        query.populate(populate);
      }

      applySession(query, session);

      return options.lean === false ? query.exec() : query.lean().exec();
    },

    findById(productId: IdLike, options: ProductFindOptions = {}) {
      return this.findOne({ _id: toObjectId(productId) }, options);
    },

    findDocumentById(productId: IdLike, options: ProductFindOptions = {}) {
      return this.findOne(
        { _id: toObjectId(productId) },
        { ...options, lean: false },
      );
    },

    async list(
      filters: Omit<ProductListFilters, "tenantId">,
    ): Promise<ProductDocument[]> {
      const page = Math.max(Number(filters.page || 1), 1);
      const limit = Math.min(Math.max(Number(filters.limit || 50), 1), 100);
      const skip = (page - 1) * limit;

      const query = Product.find(buildListQuery(tenantObjectId, filters))
        .sort({ sortOrder: 1, createdAt: -1 })
        .skip(skip)
        .limit(limit);

      applySession(query, session);

      return query.exec();
    },

    count(filters: Omit<ProductListFilters, "tenantId"> | ProductFilter = {}) {
      const queryFilter =
        "search" in filters ||
        "type" in filters ||
        "types" in filters ||
        "isActive" in filters ||
        "locationId" in filters ||
        "allowedLocationIds" in filters ||
        "includeUnassigned" in filters ||
        "assignedStudioOnly" in filters ||
        "coursePublicationLocationId" in filters
          ? buildListQuery(
              tenantObjectId,
              filters as Omit<ProductListFilters, "tenantId">,
            )
          : scope({ isArchived: { $ne: true }, ...filters as ProductFilter });

      const query = Product.countDocuments(queryFilter as never);
      applySession(query, session);
      return query.exec();
    },

    async create(
      createdBy: IdLike,
      input: CreateProductInput,
    ): Promise<ProductDocument> {
      const { locationId, ...fields } = input;
      const createPayload: any[] = [
        {
          ...fields,
          location: locationId ? toObjectId(locationId) : null,
          type: input.type as ProductDocument["type"],
          currency: input.currency as ProductDocument["currency"],
          tenant: tenantObjectId,
          createdBy: toObjectId(createdBy),
          couponProduct: input.couponProduct
            ? toObjectId(input.couponProduct)
            : null,
        },
      ];
      const products = (await Product.create(
        createPayload,
        session ? { session } : undefined,
      )) as unknown as ProductDocument[];

      return products[0];
    },

    async update(input: UpdateProductInput): Promise<ProductDocument | null> {
      const { id, couponProduct, locationId, ...patch } = input;

      const previousCapacity =
        input.maxNumberOfParticipants !== undefined
          ? Number(
              (
                await Product.findOne(scope({ _id: toObjectId(id) }) as never)
                  .select("maxNumberOfParticipants")
                  .lean()
                  .exec()
              )?.maxNumberOfParticipants ?? 0,
            )
          : null;

      const product = await Product.findOneAndUpdate(
        scope({ _id: toObjectId(id) }) as never,
        {
          $set: {
            ...patch,
            ...(locationId !== undefined ? { location: locationId ? toObjectId(locationId) : null } : {}),
            ...(couponProduct !== undefined
              ? {
                  couponProduct: couponProduct
                    ? toObjectId(couponProduct)
                    : null,
                }
              : {}),
          },
        },
        {
          returnDocument: "after",
          runValidators: true,
          ...(session ? { session } : {}),
        },
      ).exec();

      if (
        product &&
        !session &&
        previousCapacity !== null &&
        Number(product.maxNumberOfParticipants ?? 0) > previousCapacity
      ) {
        const { reconcileWaitlistCapacityForProduct } =
          await import("@/modules/waitlist/waitlist.reconciliation.service.js");
        await reconcileWaitlistCapacityForProduct({
          tenantId: String(tenantObjectId),
          productId: String(product._id),
        }).catch(() => 0);
      }

      return product;
    },

    updateById(
      id: IdLike,
      update: ProductUpdate,
    ): Promise<ProductDocument | null> {
      return Product.findOneAndUpdate(
        scope({ _id: toObjectId(id) }) as never,
        update,
        {
          returnDocument: "after",
          runValidators: true,
          ...(session ? { session } : {}),
        },
      ).exec();
    },

    delete(productId: IdLike): Promise<ProductDocument | null> {
      return Product.findOneAndDelete(
        scope({ _id: toObjectId(productId) }) as never,
        {
          ...(session ? { session } : {}),
        },
      ).exec();
    },

    deleteById(productId: IdLike): Promise<ProductDocument | null> {
      return this.delete(productId);
    },

    save(document: ProductDocument) {
      if (!document.tenant) document.tenant = tenantObjectId as never;
      return document.save(session ? { session } : undefined);
    },
  };
};

export type ProductRepository = ReturnType<typeof createProductRepository>;
