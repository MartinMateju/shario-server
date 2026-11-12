import type { ClientSession, PopulateOptions, UpdateQuery } from "mongoose";

import Booking from "./booking.model.js";
import type {
  Booking as BookingEntity,
  BookingDocument,
  IdLike,
  MongoFilter,
  RepositoryContext,
} from "./booking.types.js";

type BookingRepositoryOptions = RepositoryContext;

type SelectOption =
  | string
  | readonly string[]
  | Record<string, string | number | boolean | object>;

type SortDirection = 1 | -1;

type FindOptions = {
  select?: SelectOption;
  sort?: Record<string, SortDirection>;
  skip?: number;
  limit?: number;
  populate?: PopulateOptions | PopulateOptions[];
  lean?: boolean;
};

type WriteOptions = {
  ordered?: boolean;
};

const asPopulateArray = (
  populate?: PopulateOptions | PopulateOptions[],
): PopulateOptions[] => {
  if (!populate) return [];
  return Array.isArray(populate) ? populate : [populate];
};

const applySession = <TQuery extends { session: (session: ClientSession) => TQuery }>(
  query: TQuery,
  session: ClientSession | null,
): TQuery => (session ? query.session(session) : query);

export const findExpiredTempBookingsForCleanup = (
  filter: MongoFilter,
  options: FindOptions = {},
) => {
  const query = Booking.find(filter as never);

  if (options.select) query.select(options.select);
  if (options.sort) query.sort(options.sort);
  if (options.skip !== undefined) query.skip(options.skip);
  if (options.limit !== undefined) query.limit(options.limit);

  return query.lean().exec();
};

export const deleteBookingsForCleanup = (filter: MongoFilter) => {
  return Booking.deleteMany(filter as never).exec();
};

export const createBookingRepository = ({
  tenantId,
  session = null,
}: BookingRepositoryOptions) => {
  if (!tenantId) throw new Error("BookingRepository requires tenantId");

  const scope = (filter: MongoFilter = {}): MongoFilter => ({
    ...filter,
    tenant: tenantId,
  });

  return {
    scope,

    find(filter: MongoFilter = {}, options: FindOptions = {}) {
      const query = Booking.find(scope(filter) as never);

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

    findOne(filter: MongoFilter = {}, options: FindOptions = {}) {
      const query = Booking.findOne(scope(filter) as never);

      if (options.select) query.select(options.select);

      for (const populate of asPopulateArray(options.populate)) {
        query.populate(populate);
      }

      applySession(query, session);

      return options.lean === false ? query.exec() : query.lean().exec();
    },

    findById(id: IdLike, options: FindOptions = {}) {
      return this.findOne({ _id: id }, options);
    },

    findDocumentById(id: IdLike, options: FindOptions = {}): Promise<BookingDocument | null> {
      return this.findOne({ _id: id }, { ...options, lean: false }) as Promise<
        BookingDocument | null
      >;
    },

    findByIdWithProduct(id: IdLike) {
      return Booking.findOne(scope({ _id: id }) as never)
        .populate({
          path: "bookingProduct",
          select: "name type price currency",
        })
        .exec();
    },

    findDocuments(
      filter: MongoFilter = {},
      options: Omit<FindOptions, "lean"> = {},
    ): Promise<BookingDocument[]> {
      const query = Booking.find(scope(filter) as never);

      if (options.select) query.select(options.select);
      if (options.sort) query.sort(options.sort);
      if (options.skip !== undefined) query.skip(options.skip);
      if (options.limit !== undefined) query.limit(options.limit);

      for (const populate of asPopulateArray(options.populate)) {
        query.populate(populate);
      }

      applySession(query, session);

      return query.exec() as Promise<BookingDocument[]>;
    },

    count(filter: MongoFilter = {}) {
      const query = Booking.countDocuments(scope(filter) as never);
      applySession(query, session);
      return query.exec();
    },

    insertMany(records: Array<Partial<BookingEntity>>, options: WriteOptions = {}) {
      const docs = records.map((record) => ({
        ...record,
        tenant: tenantId,
      }));

      return Booking.insertMany(docs, {
        ordered: options.ordered ?? false,
        ...(session ? { session } : {}),
      });
    },

    updateMany(filter: MongoFilter, update: UpdateQuery<BookingEntity>) {
      return Booking.updateMany(scope(filter) as never, update, {
        ...(session ? { session } : {}),
      }).exec();
    },

    updateById(id: IdLike, update: UpdateQuery<BookingEntity>) {
      return Booking.findOneAndUpdate(scope({ _id: id }) as never, update, {
        returnDocument: "after",
        runValidators: true,
        ...(session ? { session } : {}),
      }).exec();
    },

    deleteMany(filter: MongoFilter) {
      return Booking.deleteMany(scope(filter) as never, {
        ...(session ? { session } : {}),
      }).exec();
    },

    deleteById(id: IdLike) {
      return Booking.deleteOne(scope({ _id: id }) as never, {
        ...(session ? { session } : {}),
      }).exec();
    },

    save(document: BookingDocument): Promise<BookingDocument> {
      if (!document.tenant) {
        document.tenant = tenantId as never;
      }

      return document.save(session ? { session } : undefined);
    },

  };
};

export type BookingRepository = ReturnType<typeof createBookingRepository>;
