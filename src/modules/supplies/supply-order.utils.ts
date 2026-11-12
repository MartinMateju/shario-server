import mongoose from "mongoose";

export const toObjectId = (value: string): mongoose.Types.ObjectId => {
  return new mongoose.Types.ObjectId(value);
};

export const escapeRegex = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

export const toNullableObjectId = (
  value?: string | null,
): mongoose.Types.ObjectId | null => {
  return value ? toObjectId(value) : null;
};
