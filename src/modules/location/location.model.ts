import mongoose from "mongoose";

import { locationSchema } from "./location.schema.js";
import type {
  Location,
  LocationMongooseModel,
} from "./location.types.js";

export const LocationModel =
  (mongoose.models.Location as LocationMongooseModel | undefined) ||
  mongoose.model<Location, LocationMongooseModel>("Location", locationSchema);

export default LocationModel;