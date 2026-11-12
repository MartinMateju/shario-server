import mongoose from "mongoose";

export type PopulatedRef<T> = mongoose.Types.ObjectId | T | null | undefined;

export const isPopulatedRef = <T extends { _id?: unknown }>(
  value: PopulatedRef<T>,
): value is T => {
  return Boolean(
    value &&
      typeof value === "object" &&
      "_id" in value &&
      !(value instanceof mongoose.Types.ObjectId),
  );
};

export const getRefId = (value: unknown): string | null => {
  if (!value) return null;

  if (value instanceof mongoose.Types.ObjectId) {
    return value.toString();
  }

  if (typeof value === "object" && "_id" in value) {
    return String(value._id);
  }

  return String(value);
};

export const toObjectId = (value: string): mongoose.Types.ObjectId => {
  return new mongoose.Types.ObjectId(value);
};