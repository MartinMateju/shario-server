// staff.repository.ts

import type { ClientSession, PopulateOptions } from "mongoose";

import {
  DEFAULT_STAFF_LIMIT,
  MAX_STAFF_LIMIT,
  STAFF_TASK_STATUS,
} from "./staff.constants.js";
import StaffMemberModel from "./staff-member.model.js";
import StaffTaskModel from "./staff-task.model.js";
import type {
  ObjectIdLike,
  StaffMemberDocument,
  StaffMemberListFilters,
  StaffTaskDocument,
  StaffTaskListFilters,
} from "./staff.types.js";
import { escapeRegex, toObjectId } from "./staff.utils.js";
import type {
  CreateStaffMemberInput,
  CreateStaffTaskInput,
  UpdateStaffMemberInput,
  UpdateStaffTaskInput,
} from "./staff.validators.js";

type StaffMongoFilter = Record<string, any>;
type StaffMongoPatch = Record<string, any>;

type StaffRepositoryOptions = {
  tenantId: ObjectIdLike;
  session?: ClientSession | null;
};

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

const asObjectId = (value: ObjectIdLike) => toObjectId(String(value));

const asOptionalObjectId = (value: unknown) =>
  value ? toObjectId(String(value)) : null;

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

const getPagination = (page?: number, limit?: number) => {
  const safePage = Math.max(Number(page || 1), 1);
  const safeLimit = Math.min(
    Math.max(Number(limit || DEFAULT_STAFF_LIMIT), 1),
    MAX_STAFF_LIMIT,
  );

  return {
    page: safePage,
    limit: safeLimit,
    skip: (safePage - 1) * safeLimit,
  };
};

const normalizeMemberPatch = (
  input: CreateStaffMemberInput | UpdateStaffMemberInput,
): StaffMongoPatch => {
  const { user, firstname, lastname, locations, ...rest } = input;
  const patch: StaffMongoPatch = {
    ...rest,
    ...(firstname !== undefined ? { firstName: firstname } : {}),
    ...(lastname !== undefined ? { lastName: lastname } : {}),
    ...(user !== undefined ? { userId: asOptionalObjectId(user) } : {}),
    ...(locations !== undefined
      ? { locationIds: locations.map((id) => asObjectId(id)) }
      : {}),
  };

  return patch;
};

export const normalizeTaskPatch = (
  input: CreateStaffTaskInput | UpdateStaffTaskInput,
): StaffMongoPatch => {
  const { location, locationId, ...rest } = input;
  const normalizedLocation = locationId !== undefined ? locationId : location;
  const patch: StaffMongoPatch = {
    ...rest,
    ...(normalizedLocation !== undefined
      ? { locationId: asOptionalObjectId(normalizedLocation) }
      : {}),
  };

  if ("assignedTo" in input) {
    patch.assignedTo = asOptionalObjectId(input.assignedTo);
  }

  if (input.appliesToAllLocations) {
    patch.locationId = null;
  } else if (normalizedLocation) {
    patch.appliesToAllLocations = false;
  }

  if (input.status === STAFF_TASK_STATUS.DONE) {
    patch.completedAt = new Date();
  }

  if (input.status && input.status !== STAFF_TASK_STATUS.DONE) {
    patch.completedAt = null;
  }

  if (
    input.status &&
    input.status !== STAFF_TASK_STATUS.BLOCKED &&
    input.status !== STAFF_TASK_STATUS.WAITING &&
    input.blockerReason === undefined
  ) {
    patch.blockerReason = "";
  }

  return patch;
};

export const createStaffRepository = ({
  tenantId,
  session = null,
}: StaffRepositoryOptions) => {
  if (!tenantId) throw new Error("StaffRepository requires tenantId");

  const tenantObjectId = asObjectId(tenantId);

  const scope = (filter: StaffMongoFilter = {}): StaffMongoFilter => ({
    ...filter,
    tenantId: tenantObjectId,
  });

  return {
    scope,

    findMembers(filter: StaffMongoFilter = {}, options: FindOptions = {}) {
      const query = StaffMemberModel.find(scope(filter) as never);

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

    findMember(filter: StaffMongoFilter = {}, options: FindOptions = {}) {
      const query = StaffMemberModel.findOne(scope(filter) as never);

      if (options.select) query.select(options.select);

      for (const populate of asPopulateArray(options.populate)) {
        query.populate(populate);
      }

      applySession(query, session);

      return options.lean === false ? query.exec() : query.lean().exec();
    },

    findMemberById(id: ObjectIdLike, options: FindOptions = {}) {
      return this.findMember({ _id: asObjectId(id) }, options);
    },

    findMemberDocumentById(
      id: ObjectIdLike,
      options: FindOptions = {},
    ): Promise<StaffMemberDocument | null> {
      return this.findMember(
        { _id: asObjectId(id) },
        { ...options, lean: false },
      ) as Promise<StaffMemberDocument | null>;
    },

    async listMembers(filters: Omit<StaffMemberListFilters, "tenantId"> = {}) {
      const { page, limit, skip } = getPagination(filters.page, filters.limit);

      const filter: StaffMongoFilter = {};

      if (filters.role) filter.role = filters.role;
      if (filters.employmentType)
        filter.employmentType = filters.employmentType;
      if (filters.locationId) {
        filter.locationIds = asObjectId(filters.locationId);
      } else if (
        filters.allowedLocationIds !== null &&
        filters.allowedLocationIds !== undefined
      ) {
        filter.locationIds = {
          $in: filters.allowedLocationIds.map(asObjectId),
        };
      }

      if (typeof filters.isActive === "boolean") {
        filter.isActive = filters.isActive;
      }

      if (typeof filters.isBookable === "boolean") {
        filter.isBookable = filters.isBookable;
      }

      if (typeof filters.visibleOnWebsite === "boolean") {
        filter.visibleOnWebsite = filters.visibleOnWebsite;
      }

      if (filters.search?.trim()) {
        const search = escapeRegex(filters.search.trim());

        filter.$or = [
          { firstName: { $regex: search, $options: "i" } },
          { lastName: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
          { phone: { $regex: search, $options: "i" } },
          { bio: { $regex: search, $options: "i" } },
        ];
      }

      const populate: PopulateOptions[] = [
        { path: "userId", select: "firstname lastname email customId" },
        {
          path: "locationIds",
          select: "name slug code",
          ...(filters.allowedLocationIds !== null &&
          filters.allowedLocationIds !== undefined
            ? {
                match: {
                  _id: {
                    $in: filters.allowedLocationIds.map(asObjectId),
                  },
                },
              }
            : {}),
        },
        { path: "createdBy", select: "firstname lastname email customId" },
      ];

      const [staffMembers, total] = await Promise.all([
        this.findMembers(filter, {
          populate,
          sort: { isActive: -1, lastName: 1, firstName: 1 },
          skip,
          limit,
        }),
        this.countMembers(filter),
      ]);

      return {
        staffMembers,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      };
    },

    countMembers(filter: StaffMongoFilter = {}) {
      const query = StaffMemberModel.countDocuments(scope(filter) as never);
      applySession(query, session);
      return query.exec();
    },

    async createMember(createdBy: ObjectIdLike, input: CreateStaffMemberInput) {
      const document = new StaffMemberModel({
        ...normalizeMemberPatch(input),
        tenantId: tenantObjectId,
        createdBy: asObjectId(createdBy),
      });

      return document.save(session ? { session } : undefined);
    },

    updateMemberById(id: ObjectIdLike, input: UpdateStaffMemberInput) {
      const query = StaffMemberModel.findOneAndUpdate(
        scope({ _id: asObjectId(id) }) as never,
        { $set: normalizeMemberPatch(input) } as never,
        { returnDocument: "after", runValidators: true } as never,
      );

      applySession(query, session);

      return query.exec();
    },

    deleteMemberById(id: ObjectIdLike) {
      const query = StaffMemberModel.deleteOne(
        scope({ _id: asObjectId(id) }) as never,
      );

      applySession(query, session);

      return query.exec();
    },

    findTasks(filter: StaffMongoFilter = {}, options: FindOptions = {}) {
      const query = StaffTaskModel.find(scope(filter) as never);

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

    findTask(filter: StaffMongoFilter = {}, options: FindOptions = {}) {
      const query = StaffTaskModel.findOne(scope(filter) as never);

      if (options.select) query.select(options.select);

      for (const populate of asPopulateArray(options.populate)) {
        query.populate(populate);
      }

      applySession(query, session);

      return options.lean === false ? query.exec() : query.lean().exec();
    },

    findTaskById(id: ObjectIdLike, options: FindOptions = {}) {
      return this.findTask({ _id: asObjectId(id) }, options);
    },

    findTaskDocumentById(
      id: ObjectIdLike,
      options: FindOptions = {},
    ): Promise<StaffTaskDocument | null> {
      return this.findTask(
        { _id: asObjectId(id) },
        { ...options, lean: false },
      ) as Promise<StaffTaskDocument | null>;
    },

    async listTasks(filters: Omit<StaffTaskListFilters, "tenantId"> = {}) {
      const { page, limit, skip } = getPagination(filters.page, filters.limit);

      const filter: StaffMongoFilter = {};

      if (filters.startDate || filters.endDate) {
        filter.dueDate = {
          ...(filters.startDate ? { $gte: filters.startDate } : {}),
          ...(filters.endDate ? { $lte: filters.endDate } : {}),
        };
      }

      if (filters.locationId) {
        filter.$or = [
          { appliesToAllLocations: true },
          { locationId: asObjectId(filters.locationId) },
          { appliesToAllLocations: false, locationId: null },
        ];
      } else if (
        filters.allowedLocationIds !== null &&
        filters.allowedLocationIds !== undefined
      ) {
        if (filters.allowedLocationIds.length === 0) {
          filter._id = { $in: [] };
        } else {
          filter.$or = [
            { appliesToAllLocations: true },
            { appliesToAllLocations: false, locationId: null },
            {
              locationId: {
                $in: filters.allowedLocationIds.map(asObjectId),
              },
            },
          ];
        }
      }

      if (filters.status) filter.status = filters.status;
      if (filters.priority) filter.priority = filters.priority;
      if (filters.category) filter.category = filters.category;

      if (filters.assignedTo) {
        filter.assignedTo = asObjectId(filters.assignedTo);
      }

      const populate: PopulateOptions[] = [
        { path: "assignedTo", select: "firstname lastname email customId" },
        { path: "createdBy", select: "firstname lastname email customId" },
        { path: "locationId", select: "name slug code" },
      ];

      const [tasks, total] = await Promise.all([
        this.findTasks(filter, {
          populate,
          sort: { dueDate: 1, createdAt: -1 },
          skip,
          limit,
        }),
        this.countTasks(filter),
      ]);

      return {
        tasks,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      };
    },

    countTasks(filter: StaffMongoFilter = {}) {
      const query = StaffTaskModel.countDocuments(scope(filter) as never);
      applySession(query, session);
      return query.exec();
    },

    async createTask(
      createdBy: ObjectIdLike,
      input: CreateStaffTaskInput,
      metadata: {
        source?: "manual" | "communication" | "ai";
        communicationConversationId?: ObjectIdLike | null;
        aiActionId?: ObjectIdLike | null;
      } = {},
    ) {
      const document = new StaffTaskModel({
        ...normalizeTaskPatch(input),
        tenantId: tenantObjectId,
        createdBy: asObjectId(createdBy),
        ...(metadata.source ? { source: metadata.source } : {}),
        ...(metadata.communicationConversationId
          ? {
              communicationConversationId: asObjectId(
                metadata.communicationConversationId,
              ),
            }
          : {}),
        ...(metadata.aiActionId
          ? { aiActionId: asObjectId(metadata.aiActionId) }
          : {}),
      });

      return document.save(session ? { session } : undefined);
    },

    updateTaskById(id: ObjectIdLike, input: UpdateStaffTaskInput) {
      const query = StaffTaskModel.findOneAndUpdate(
        scope({ _id: asObjectId(id) }) as never,
        { $set: normalizeTaskPatch(input) } as never,
        { returnDocument: "after", runValidators: true } as never,
      );

      applySession(query, session);

      return query.exec();
    },

    deleteTaskById(id: ObjectIdLike) {
      const query = StaffTaskModel.deleteOne(
        scope({ _id: asObjectId(id) }) as never,
      );

      applySession(query, session);

      return query.exec();
    },
  };
};

export type StaffRepository = ReturnType<typeof createStaffRepository>;
