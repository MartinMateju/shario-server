import type {
    ClientSession,
    HydratedDocument,
    InferSchemaType,
    Model,
    PopulateOptions,
    ProjectionType,
    SortOrder,
    Types,
} from "mongoose";

import { bookingSchema } from "./booking.schema.js";

import type {
    BookingLanguage,
    BookingStatus,
    BookingTag,
    BookingType,
    NotificationChannel,
    PaymentStatus,
    PlannedActivity,
} from "./booking.constants.js";

export type Booking = InferSchemaType<typeof bookingSchema>;

export type BookingDocument = HydratedDocument<Booking>;

export type BookingModel = Model<Booking>;

export interface BookingParticipant {
    participantId?: string;
    customer?: Types.ObjectId;
    name?: string;
    email?: string;
    phone?: string;
    unnamed?: boolean;
    source?: "paid" | "staff" | "legacy";
    attendanceStatus?: "active" | "removed";
    firstname: string;
    lastname: string;
    customId?: string;
    memberNumber?: number;
    order?: Types.ObjectId;
}

export interface BookingRef {
    booking?: Types.ObjectId;
    idx?: number;
}

export interface BookingAuthor {
    name: string;
    customId: string;
    memberNumber?: number;
}

export type {
    BookingLanguage,
    BookingStatus,
    BookingTag,
    BookingType,
    NotificationChannel,
    PaymentStatus,
    PlannedActivity,
};

export type IdLike = string | Types.ObjectId;

export type TenantId = IdLike;

export interface RepositoryContext {
    tenantId: TenantId;
    session?: ClientSession | null;
}

export interface FindOptions<T = Booking> {
    select?: ProjectionType<T> | string | Record<string, unknown>;
    sort?: Record<string, SortOrder>;
    skip?: number;
    limit?: number;
    populate?: PopulateOptions | PopulateOptions[];
    lean?: boolean;
}

export type MongoFilter<T = Booking> = Record<string, unknown> | Partial<T>;

export type MongoUpdate<T = Booking> = Record<string, unknown> | Partial<T>;

export type PlainObject = Record<string, unknown>;
