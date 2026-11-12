// user-guest.types.ts

import type { HydratedDocument, InferSchemaType, Model, Types } from "mongoose";

import { userGuestSchema } from "./user-guest.schema.js";

export type UserGuest = InferSchemaType<typeof userGuestSchema>;

export type UserGuestDocument = HydratedDocument<UserGuest>;

export type UserGuestModel = Model<UserGuest>;

export type CreateUserGuestInput = {
    firstname: string;
    lastname: string;
    email: string;
    phone?: string;
    note?: string;
};

export type UpdateUserGuestInput = Partial<CreateUserGuestInput> & {
    id: string;
};

export type UserGuestOwnerContext = {
    tenantId: string | Types.ObjectId;
    ownerId: string | Types.ObjectId;
};