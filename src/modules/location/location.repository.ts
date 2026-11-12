import mongoose, { type ClientSession } from "mongoose";

import { LocationModel as Location } from "./location.model.js";
import { buildLocationListQuery } from "./location.queries.js";
import type {
  LocationDocument,
  LocationListFilters,
} from "./location.types.js";
import type {
  CreateLocationInput,
  UpdateLocationInput,
} from "./location.validators.js";

type LocationRepositoryOptions = {
  session?: ClientSession | null;
};

type CreateLocationOptions = LocationRepositoryOptions & {
  isPrimary?: boolean;
};

type FindLocationOptions = LocationRepositoryOptions & {
  includePrivateAccess?: boolean;
};

const toObjectId = (value: string): mongoose.Types.ObjectId => {
  return new mongoose.Types.ObjectId(value);
};

const withSession = <
  T extends { session: (session: ClientSession | null) => T },
>(
  query: T,
  session?: ClientSession | null,
): T => {
  if (session) {
    query.session(session);
  }

  return query;
};

export const locationRepository = {
  async list(filters: LocationListFilters): Promise<LocationDocument[]> {
    const page = Math.max(Number(filters.page || 1), 1);
    const limit = Math.min(Math.max(Number(filters.limit || 50), 1), 100);
    const skip = (page - 1) * limit;

    return Location.find(buildLocationListQuery(filters))
      .sort({ isPrimary: -1, name: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();
  },

  async count(filters: LocationListFilters): Promise<number> {
    return Location.countDocuments(buildLocationListQuery(filters)).exec();
  },

  async countActive(
    tenantId: string,
    options: LocationRepositoryOptions = {},
  ): Promise<number> {
    return withSession(
      Location.countDocuments({
        tenant: toObjectId(tenantId),
        isActive: true,
      }),
      options.session,
    ).exec();
  },

  async findByIdForTenant(
    tenantId: string,
    locationId: string,
    options: FindLocationOptions = {},
  ): Promise<LocationDocument | null> {
    const query = Location.findOne({
      _id: toObjectId(locationId),
      tenant: toObjectId(tenantId),
    });

    if (options.includePrivateAccess) {
      query.select("+access.privateInstructions +access.doorCode");
    }

    return withSession(query, options.session).exec();
  },

  async findPrimary(
    tenantId: string,
    options: LocationRepositoryOptions = {},
  ): Promise<LocationDocument | null> {
    return withSession(
      Location.findOne({
        tenant: toObjectId(tenantId),
        isActive: true,
        isPrimary: true,
      }),
      options.session,
    ).exec();
  },

  async findFirstActive(
    tenantId: string,
    options: LocationRepositoryOptions = {},
  ): Promise<LocationDocument | null> {
    return withSession(
      Location.findOne({
        tenant: toObjectId(tenantId),
        isActive: true,
      }).sort({ createdAt: 1, _id: 1 }),
      options.session,
    ).exec();
  },

  async identityExists(
    tenantId: string,
    identity: { slug: string; code: string },
    options: LocationRepositoryOptions = {},
  ): Promise<boolean> {
    const location = await withSession(
      Location.exists({
        tenant: toObjectId(tenantId),
        $or: [{ slug: identity.slug }, { code: identity.code }],
      }),
      options.session,
    ).exec();

    return Boolean(location);
  },

  async create(
    tenantId: string,
    input: CreateLocationInput,
    options: CreateLocationOptions = {},
  ): Promise<LocationDocument> {
    const [location] = await Location.create(
      [
        {
          ...input,
          tenant: toObjectId(tenantId),
          isActive: true,
          isPrimary: Boolean(options.isPrimary),
        },
      ],
      options.session ? { session: options.session } : undefined,
    );

    return location;
  },

  async update(
    tenantId: string,
    input: UpdateLocationInput,
    options: LocationRepositoryOptions = {},
  ): Promise<LocationDocument | null> {
    const { id, access, firingSettings, ...patch } = input;
    // Partial location edits must not silently reset door-email opt-in or
    // private instructions that the editor did not submit.
    const accessPatch = Object.fromEntries(
      Object.entries(access ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [`access.${key}`, value]),
    );

    return Location.findOneAndUpdate(
      {
        _id: toObjectId(id),
        tenant: toObjectId(tenantId),
      },
      {
        $set: {
          ...patch,
          ...accessPatch,
        },
      },
      {
        returnDocument: "after",
        runValidators: true,
        session: options.session ?? undefined,
      },
    ).exec();
  },

  async clearPrimary(
    tenantId: string,
    options: LocationRepositoryOptions = {},
  ): Promise<void> {
    await Location.updateMany(
      {
        tenant: toObjectId(tenantId),
        isPrimary: true,
      },
      {
        $set: { isPrimary: false },
      },
      { session: options.session ?? undefined },
    ).exec();
  },

  async markPrimary(
    tenantId: string,
    locationId: string,
    options: LocationRepositoryOptions = {},
  ): Promise<LocationDocument | null> {
    return Location.findOneAndUpdate(
      {
        _id: toObjectId(locationId),
        tenant: toObjectId(tenantId),
        isActive: true,
      },
      {
        $set: { isPrimary: true },
      },
      {
        returnDocument: "after",
        runValidators: true,
        session: options.session ?? undefined,
      },
    ).exec();
  },

  async activate(
    tenantId: string,
    locationId: string,
    options: LocationRepositoryOptions = {},
  ): Promise<LocationDocument | null> {
    return Location.findOneAndUpdate(
      {
        _id: toObjectId(locationId),
        tenant: toObjectId(tenantId),
      },
      {
        $set: { isActive: true },
      },
      {
        returnDocument: "after",
        runValidators: true,
        session: options.session ?? undefined,
      },
    ).exec();
  },

  async archive(
    tenantId: string,
    locationId: string,
    options: LocationRepositoryOptions = {},
  ): Promise<LocationDocument | null> {
    return Location.findOneAndUpdate(
      {
        _id: toObjectId(locationId),
        tenant: toObjectId(tenantId),
      },
      {
        $set: { isActive: false, isPrimary: false },
      },
      {
        returnDocument: "after",
        runValidators: true,
        session: options.session ?? undefined,
      },
    ).exec();
  },
};
