import type { HydratedDocument, InferSchemaType, Model, Types } from "mongoose";

import type { eventSchema } from "./event.schema.js";

export type EventChecklistItem = {
  _id?: Types.ObjectId;
  title: string;
  done: boolean;
};

export type EventSchema = InferSchemaType<typeof eventSchema>;
export type EventDocument = HydratedDocument<EventSchema>;
export type EventModel = Model<EventSchema>;

export type EventListFilters = {
  tenantId: string;
  status?: string;
  type?: string;
  location?: string;
  search?: string;
  from?: Date;
  to?: Date;
  page: number;
  limit: number;
  allowedLocationIds?: readonly string[] | null;
};
