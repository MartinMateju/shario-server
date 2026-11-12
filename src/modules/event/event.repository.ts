import mongoose from "mongoose";

import type { StudioCommerceCurrency } from "@/shared/money/currency.js";

import { Event as EventModel } from "./event.model.js";
import { buildEventListQuery } from "./event.queries.js";
import type {
  EventDocument,
  EventListFilters,
  EventModel as EventModelType,
} from "./event.types.js";
import type { CreateEventInput, UpdateEventInput } from "./event.validators.js";
import { toPagination } from "./event.utils.js";

const Event = EventModel as EventModelType;

type CreateEventPersistenceInput = CreateEventInput & {
  currency: StudioCommerceCurrency;
};

export type CreateEventPersistenceOptions = {
  aiActionId?: string;
};

type UpdateEventPersistenceInput = UpdateEventInput & {
  currency?: StudioCommerceCurrency;
};

const toObjectId = (value: string): mongoose.Types.ObjectId => {
  return new mongoose.Types.ObjectId(value);
};

const normalizePatchObjectIds = (input: Partial<CreateEventInput>) => {
  return {
    ...input,
    location: input.location ? toObjectId(input.location) : null,
    order: input.order ? toObjectId(input.order) : null,
    assignedStaff: input.assignedStaff?.map(toObjectId) ?? [],
    bookings: input.bookings?.map(toObjectId) ?? [],
  };
};

export const eventRepository = {
  async list(
    filters: EventListFilters,
  ): Promise<{ events: unknown[]; total: number; page: number; pages: number }> {
    const { page, limit, skip } = toPagination(filters.page, filters.limit);
    const query = buildEventListQuery(filters);
    const tenant = toObjectId(filters.tenantId);

    const [events, total] = await Promise.all([
      Event.find(query)
        .populate({ path: "order", match: { tenant } })
        .populate({
          path: "assignedStaff",
          match: { tenant },
          select: "firstname lastname email",
        })
        .sort({ date: 1, startTime: 1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      Event.countDocuments(query).exec(),
    ]);

    return {
      events,
      total,
      page,
      pages: Math.ceil(total / limit),
    };
  },

  async findByIdForTenant(
    tenantId: string,
    eventId: string,
  ): Promise<unknown | null> {
    const tenant = toObjectId(tenantId);

    return Event.findOne({
      _id: toObjectId(eventId),
      tenant,
    })
      .populate({ path: "order", match: { tenant } })
      .populate({ path: "bookings", match: { tenant } })
      .populate({
        path: "assignedStaff",
        match: { tenant },
        select: "firstname lastname email",
      })
      .populate({
        path: "createdBy",
        match: { tenant },
        select: "firstname lastname email",
      })
      .lean()
      .exec();
  },

  async create(
    tenantId: string,
    createdBy: string,
    input: CreateEventPersistenceInput,
    options: CreateEventPersistenceOptions = {},
  ): Promise<EventDocument> {
    return Event.create({
      ...normalizePatchObjectIds(input),
      tenant: toObjectId(tenantId),
      createdBy: toObjectId(createdBy),
      ...(options.aiActionId
        ? { aiActionId: toObjectId(options.aiActionId) }
        : {}),
    });
  },

  async update(
    tenantId: string,
    input: UpdateEventPersistenceInput,
  ): Promise<EventDocument | null> {
    const { id, ...patch } = input;

    const normalizedPatch: Record<string, unknown> = { ...patch };

    if ("location" in patch) {
      normalizedPatch.location = patch.location ? toObjectId(patch.location) : null;
    }

    if ("order" in patch) {
      normalizedPatch.order = patch.order ? toObjectId(patch.order) : null;
    }

    if ("assignedStaff" in patch && patch.assignedStaff) {
      normalizedPatch.assignedStaff = patch.assignedStaff.map(toObjectId);
    }

    if ("bookings" in patch && patch.bookings) {
      normalizedPatch.bookings = patch.bookings.map(toObjectId);
    }

    return Event.findOneAndUpdate(
      {
        _id: toObjectId(id),
        tenant: toObjectId(tenantId),
      },
      { $set: normalizedPatch },
      {
        returnDocument: "after",
        runValidators: true,
      },
    ).exec();
  },

  async findByAiActionIdForTenant(
    tenantId: string,
    aiActionId: string,
  ): Promise<EventDocument | null> {
    return Event.findOne({
      tenant: toObjectId(tenantId),
      aiActionId: toObjectId(aiActionId),
    })
      .select("+aiActionId title")
      .exec();
  },

  async findDocumentByIdForTenant(
    tenantId: string,
    eventId: string,
  ): Promise<EventDocument | null> {
    return Event.findOne({
      _id: toObjectId(eventId),
      tenant: toObjectId(tenantId),
    }).exec();
  },

  async delete(
    tenantId: string,
    eventId: string,
  ): Promise<EventDocument | null> {
    return Event.findOneAndDelete({
      _id: toObjectId(eventId),
      tenant: toObjectId(tenantId),
    }).exec();
  },
};
