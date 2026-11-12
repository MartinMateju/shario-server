import mongoose from "mongoose";

export function objectId(value) {
  return value ? new mongoose.Types.ObjectId(value) : new mongoose.Types.ObjectId();
}

export function objectIdString(value) {
  return String(objectId(value));
}
