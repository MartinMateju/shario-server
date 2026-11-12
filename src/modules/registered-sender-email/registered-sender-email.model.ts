import mongoose, { type Model } from "mongoose";

import { registeredSenderEmailSchema } from "./registered-sender-email.schema.js";
import type { RegisteredSenderEmail } from "./registered-sender-email.types.js";

export const RegisteredSenderEmailModel: Model<RegisteredSenderEmail> =
    mongoose.models.RegisteredSenderEmail ||
    mongoose.model<RegisteredSenderEmail>(
        "RegisteredSenderEmail",
        registeredSenderEmailSchema,
    );