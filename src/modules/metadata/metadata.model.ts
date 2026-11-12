import mongoose from "mongoose";

import { metadataSchema } from "./metadata.schema.js";
import type { Metadata } from "./metadata.types.js";

export const MetadataModel =
  (mongoose.models.Metadata as mongoose.Model<Metadata> | undefined) ??
  mongoose.model<Metadata>("Metadata", metadataSchema);

export default MetadataModel;