import mongoose from "mongoose";

import { communicationAutomationSchema } from "./communication-automation.schema.js";
import type {
  CommunicationAutomationEntity,
  CommunicationAutomationModel,
} from "./communication-automation.types.js";

export const CommunicationAutomation =
  (mongoose.models.CommunicationAutomation as CommunicationAutomationModel | undefined) ||
  mongoose.model<CommunicationAutomationEntity, CommunicationAutomationModel>(
    "CommunicationAutomation",
    communicationAutomationSchema,
  );

export default CommunicationAutomation;
