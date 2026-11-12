import mongoose from "mongoose";

import { communicationEmailLogSchema } from "./communication-email-log.schema.js";
import type {
  CommunicationEmailLog,
  CommunicationEmailLogMongooseModel,
} from "./communication-email-log.types.js";

export const CommunicationEmailLogModel =
  (mongoose.models.CommunicationEmailLog as
    CommunicationEmailLogMongooseModel | undefined) ||
  mongoose.model<CommunicationEmailLog, CommunicationEmailLogMongooseModel>(
    "CommunicationEmailLog",
    communicationEmailLogSchema,
  );

export default CommunicationEmailLogModel;
