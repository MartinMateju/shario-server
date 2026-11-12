import mongoose from "mongoose";

import { verificationTokenSchema } from "./user-verification.schema.js";
import type { VerificationToken as VerificationTokenAttributes } from "./user-verification.types.js";

export const VerificationToken =
  (mongoose.models.VerificationToken as
    | mongoose.Model<VerificationTokenAttributes>
    | undefined) ??
  mongoose.model<VerificationTokenAttributes>(
    "VerificationToken",
    verificationTokenSchema,
  );

export default VerificationToken;